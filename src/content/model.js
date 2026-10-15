const SKIP =
  'script,style,noscript,pre,code,kbd,samp,textarea,input,select,option,svg,math,canvas,video,audio,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-yeyi-owned]';
const BLOCK_DISPLAYS = new Set([
  "block",
  "flow-root",
  "flex",
  "grid",
  "list-item",
  "table-cell",
  "table-caption",
  "inline-block",
]);
const LEAF_BLOCKS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BUTTON",
  "LABEL",
  "TD",
  "TH",
  "DT",
  "DD",
  "FIGCAPTION",
  "CAPTION",
  "SUMMARY",
]);

/** 把长文本按句子边界分片，避免切断 Unicode 码点。@param {string} text 原文。@param {number} [limit] 每片 UTF-16 字符上限。@returns {string[]} 无损分片。 */
export function splitText(text, limit = 1200) {
  if (text.length <= limit) return [text];
  const sentences =
    typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)].map(
          (entry) => entry.segment,
        )
      : [text];
  const parts = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) {
      parts.push(current);
      current = "";
    }
    if (sentence.length <= limit) {
      current += sentence;
      continue;
    }
    for (const character of sentence) {
      if (current.length + character.length > limit) {
        parts.push(current);
        current = "";
      }
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** 收集当前可渲染的文本，按最近段落边界分组；不要求位于视口内。@param {Document} doc 网页文档。@param {WeakMap} ownership 节点原文记录。@returns {Map<Element,Object[]>} 段落与原文节点。 */
export function collectGroups(doc, ownership) {
  const groups = new Map();
  if (!doc.body) return groups;
  const styles = new Map();
  const visibility = new Map();
  /** 在一次扫描内复用样式查询。@param {Element} element 页面元素。@returns {CSSStyleDeclaration} 计算样式。 */
  function styleOf(element) {
    if (!styles.has(element)) styles.set(element, doc.defaultView.getComputedStyle(element));
    return styles.get(element);
  }
  /** 检查祖先的隐藏与排除规则。@param {Element} element 文本父元素。@returns {boolean} 是否适合翻译。 */
  function visible(element) {
    if (visibility.has(element)) return visibility.get(element);
    const style = styleOf(element);
    const ownVisible =
      !element.matches(SKIP) &&
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.contentVisibility !== "hidden";
    const result =
      ownVisible &&
      (element === doc.body || !element.parentElement || visible(element.parentElement));
    visibility.set(element, result);
    return result;
  }
  /** 寻找段落容器，内联链接和加粗不会被拆为独立段落。@param {Element} element 文本父元素。@returns {Element} 段落容器。 */
  function ownerOf(element) {
    let current = element;
    while (current.parentElement && current !== doc.body) {
      if (LEAF_BLOCKS.has(current.tagName) || BLOCK_DISPLAYS.has(styleOf(current).display))
        return current;
      current = current.parentElement;
    }
    return current;
  }
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !visible(parent)) continue;
    const previous = ownership.get(node);
    const original = previous && node.data === previous.lastWritten ? previous.original : node.data;
    if (!original) continue;
    const owner = ownerOf(parent);
    if (!owner.getClientRects().length) continue;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push({ node, original });
  }
  // 标点、空白、数字必须跟随同段正文；只有整段没有语言文字时才跳过。
  for (const [owner, records] of groups) {
    const text = records.map((record) => record.original).join("");
    if (!/\p{L}/u.test(text) || /^(?:https?:\/\/|www\.)\S+$/i.test(text.trim()))
      groups.delete(owner);
  }
  return groups;
}

/** 为段落构造有界 API 任务，并记录每片属于哪个文本节点。@param {Object} unit 段落。@returns {Object[]} 每项含 id、parts 和索引。 */
export function createChunks(unit) {
  const chunks = [];
  let parts = [];
  let locations = [];
  let length = 0;
  /** 结束当前 API 片段。@returns {void} 无返回值。 */
  function flush() {
    if (!parts.length) return;
    chunks.push({
      id: `${unit.id}:${chunks.length}`,
      parts,
      locations,
      state: "pending",
      translated: null,
    });
    parts = [];
    locations = [];
    length = 0;
  }
  unit.nodes.forEach((record, nodeIndex) => {
    splitText(record.original).forEach((part) => {
      if (parts.length >= 40 || length + part.length > 2800) flush();
      parts.push(part);
      locations.push(nodeIndex);
      length += part.length;
    });
  });
  flush();
  return chunks;
}

/** 衡量段落与当前视口的距离，用于优先翻译正在阅读的内容。@param {Element} element 段落元素。@returns {number} 像素距离，视口内为零。 */
export function viewportDistance(element) {
  const rect = element.getBoundingClientRect();
  return rect.bottom < 0 ? -rect.bottom : rect.top > innerHeight ? rect.top - innerHeight : 0;
}
