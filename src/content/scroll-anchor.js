/**
 * 只在译文同步写入这一批 DOM 的前后，补偿 Discord 可见消息的实际位移。
 * 不跨动画帧固定旧位置，避免把平滑滚动、惯性滚动或站点后续定位抵消为回弹。
 * 停在底部时保留站点跟随行为；不改消息高度、滚动样式或存储数据。
 */
export class TranslationScrollAnchor {
  /** 记录当前可见消息的位置，同步写入结束后立即丢弃。 */
  capture() {
    const positions = [];
    for (const list of document.querySelectorAll('[data-list-id="chat-messages"]')) {
      let scroller = list.parentElement;
      while (scroller) {
        if (
          /auto|scroll/.test(getComputedStyle(scroller).overflowY) &&
          scroller.scrollHeight > scroller.clientHeight
        )
          break;
        scroller = scroller.parentElement;
      }
      if (!scroller || positions.some((position) => position.scroller === scroller)) continue;
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2) continue;
      const rect = scroller.getBoundingClientRect();
      const top = Math.max(0, rect.top + scroller.clientTop);
      const bottom = Math.min(innerHeight, rect.top + scroller.clientTop + scroller.clientHeight);
      if (bottom <= top) continue;
      const anchor = [...list.querySelectorAll('[id^="chat-messages-"]')].find((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.height > 0 && bounds.bottom > top && bounds.top < bottom;
      });
      if (anchor)
        positions.push({
          scroller,
          list,
          anchor,
          id: anchor.id,
          top: anchor.getBoundingClientRect().top - rect.top,
        });
    }
    return positions;
  }

  /**
   * JS 同步批次中用户滚动不会插入；只补偿此次写入造成的真实几何变化。
   * 浏览器已经完成原生锚定、或文字/字体更新后位置未变时，不写入 scrollTop。
   */
  preserve(mutation) {
    const positions = this.capture();
    try {
      return mutation();
    } finally {
      for (const position of positions) {
        const { scroller, list } = position;
        const anchor = position.anchor.isConnected
          ? position.anchor
          : document.getElementById(position.id);
        if (
          !scroller.isConnected ||
          !scroller.contains(list) ||
          !anchor ||
          !list.contains(anchor) ||
          anchor.id !== position.id
        )
          continue;
        const delta =
          anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.top;
        if (Math.abs(delta) >= 0.5) scroller.scrollTop += delta;
      }
    }
  }
}
