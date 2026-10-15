export const NAME_DICTIONARY_KEY = "nameDictionary";
export const MAX_DICTIONARY_BYTES = 8 * 1024 * 1024;

/**
 * 完整校验 AiNiee 的 src/dst/info 列表，再返回独立副本；任一行错误都拒绝整份文件。
 * 空译文可作为待补充条目保存，但不参与翻译。正则采用不同引擎，明确拒绝以免静默改变人名。
 */
export function normalizeNameEntries(data) {
  if (!Array.isArray(data) || data.length > 10000)
    throw new Error("人名字典格式无效：需要 AiNiee JSON 列表，最多 10000 条。");
  const entries = data.map((row, index) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.src !== "string" ||
      !row.src.trim() ||
      row.src.length > 500 ||
      typeof row.dst !== "string" ||
      row.dst.length > 500 ||
      (row.info !== undefined && (typeof row.info !== "string" || row.info.length > 2000)) ||
      (row.regex !== undefined && typeof row.regex !== "boolean")
    )
      throw new Error(
        `人名字典第 ${index + 1} 行格式无效，请检查原文、译文和描述；已有数据未修改。`,
      );
    if (row.regex === true)
      throw new Error(
        `人名字典第 ${index + 1} 行启用了正则；请先在 AiNiee 改为普通人名。已有数据未修改。`,
      );
    return { src: row.src.trim(), dst: row.dst.trim(), info: row.info || "" };
  });
  if (new TextEncoder().encode(JSON.stringify(entries)).length > MAX_DICTIONARY_BYTES)
    throw new Error("人名字典超过 8 MB，已有数据未修改，请拆分文件。");
  return entries;
}

/** 人名按字面、不区分大小写匹配，不将用户输入解释为正则。 */
export function nameKey(source) {
  return source.trim().toLowerCase();
}

/** 只提取本次原文及上下文中出现的条目，较长人名优先，减少提示词开销。 */
export function matchingNames(entries, segments, contextParts = []) {
  const text = [
    ...segments.flatMap((item) => [item.parts.join(""), item.context || ""]),
    contextParts.join(""),
  ]
    .join("\n")
    .toLowerCase();
  return entries
    .filter((entry) => entry.dst && text.includes(nameKey(entry.src)))
    .sort((a, b) => b.src.length - a.src.length);
}

/** 整个文本节点为人名时直接使用约定译名，保留原来的首尾空白。 */
export function translateNamePart(part, entries) {
  const entry = entries.find((item) => item.dst && nameKey(item.src) === nameKey(part));
  if (!entry) return null;
  return (
    part.slice(0, part.length - part.trimStart().length) +
    entry.dst +
    part.slice(part.trimEnd().length)
  );
}

/** 全部节点均为人名或纯标点时在本地完成；正文仍交给翻译接口。 */
export function localNameTranslations(segments, entries) {
  return segments.flatMap((segment) => {
    let matched = false;
    const parts = segment.parts.map((part) => {
      const translated = translateNamePart(part, entries);
      if (translated !== null) matched = true;
      return translated ?? (/\p{L}/u.test(part) ? null : part);
    });
    return matched && parts.every((part) => part !== null) ? [{ id: segment.id, parts }] : [];
  });
}

/** 对有效条目生成稳定摘要；排序变化、禁用和空译文不使既有无字典缓存失效。 */
export async function nameDictionarySignature(dictionary) {
  const entries = dictionary.enabled
    ? dictionary.entries
        .filter((entry) => entry.dst)
        .sort((a, b) =>
          nameKey(a.src) < nameKey(b.src) ? -1 : nameKey(a.src) > nameKey(b.src) ? 1 : 0,
        )
    : [];
  if (!entries.length) return "";
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
