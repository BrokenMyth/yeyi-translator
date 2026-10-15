/**
 * 判断文字是否与视口及所有滚动/裁剪祖先相交，适用于 Discord 的内部滚动列表。
 * 使用文本 Range 而非段落容器的高度，避免空白占位和大容器触发屏幕外请求。
 * 部分露出的文本节点按完整节点翻译，以保留完整语义和原有内联结构。
 * @param {Object[]} records 含 node 的原文记录。
 * @returns {boolean} 是否有实际可见的文字。
 */
export function hasVisibleText(records) {
  return records.some(({ node }) => {
    if (!node.isConnected || (node.nodeType === Node.TEXT_NODE && !node.data.trim())) return false;
    const doc = node.ownerDocument;
    const view = doc.defaultView;
    const range = doc.createRange();
    if (node.nodeType === Node.TEXT_NODE) range.selectNodeContents(node);
    else range.selectNode(node);
    const bounds = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
    for (
      let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      element;
      element = element.parentElement
    ) {
      const style = view.getComputedStyle(element);
      if (
        element.hidden ||
        element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility) ||
        style.contentVisibility === "hidden" ||
        Number(style.opacity) === 0
      )
        return false;
      const rect = element.getBoundingClientRect();
      const clipX = /hidden|clip|scroll|auto/.test(style.overflowX);
      const clipY = /hidden|clip|scroll|auto/.test(style.overflowY);
      if (clipX) {
        bounds.left = Math.max(bounds.left, rect.left + element.clientLeft);
        bounds.right = Math.min(bounds.right, rect.left + element.clientLeft + element.clientWidth);
      }
      if (clipY) {
        bounds.top = Math.max(bounds.top, rect.top + element.clientTop);
        bounds.bottom = Math.min(
          bounds.bottom,
          rect.top + element.clientTop + element.clientHeight,
        );
      }
      if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return false;
    }
    // 同源子帧也检查外层页面，防止屏幕外或隐藏的 iframe 提前翻译。
    try {
      if (view.frameElement && !hasVisibleText([{ node: view.frameElement }])) return false;
    } catch {
      // 跨域 frame 的 DOM 由浏览器隔离，内部仍按自己的视口裁剪。
    }
    return [...range.getClientRects()].some(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > bounds.left &&
        rect.left < bounds.right &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom,
    );
  });
}
