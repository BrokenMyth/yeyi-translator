/** 将后台错误还原为可展示的异常。@param {Object} message 扩展内部消息。@returns {Promise<any>} 后台返回的数据。 */
export async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error?.message || "插件连接已失效，请刷新网页后重试。");
    error.code = response?.error?.code || "CONNECTION";
    error.fatal = Boolean(response?.error?.fatal);
    throw error;
  }
  return response.data;
}

/** 填充目标语言下拉菜单。@param {HTMLSelectElement} select 下拉框。@param {Array<[string,string]>} languages 语言表。@returns {void} 无返回值。 */
export function populateLanguages(select, languages) {
  for (const [value, label] of languages) {
    select.add(new Option(label, value));
  }
}
