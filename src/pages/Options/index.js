import { LANGUAGES, normalizeSettings } from "../../shared/settings.js";
import { sendMessage, populateLanguages } from "../../shared/messaging.js";
import { ModelPicker } from "./components/ModelPicker/index.js";

const form = document.querySelector("#settingsForm");
const status = document.querySelector("#saveStatus");
const saveButton = document.querySelector("#saveButton");
const modelPickers = new Map();
populateLanguages(form.elements.targetLanguage, LANGUAGES);

/** 从表单读取并校验可保存配置。@returns {Object} 配置对象。 */
function readForm() {
  return normalizeSettings({
    provider: form.elements.provider.value,
    providers: Object.fromEntries(
      ["deepseek", "openai"].map((id) => [
        id,
        {
          apiKey: form.elements[`${id}Key`].value,
          model: form.elements[`${id}Model`].value,
          baseUrl: form.elements[`${id}Url`].value,
        },
      ]),
    ),
    targetLanguage: form.elements.targetLanguage.value,
    mode: form.elements.mode.value,
    showFloatingButton: form.elements.showFloatingButton.checked,
    autoTranslateSites: form.elements.autoTranslateSites.value,
  });
}

/** 标记选中的服务配置卡片。@returns {void} 无返回值。 */
function markProvider() {
  document
    .querySelectorAll("[data-provider]")
    .forEach((card) =>
      card.classList.toggle("active", card.dataset.provider === form.elements.provider.value),
    );
}

/** 保存表单，只有明确保存才写入本机配置。@param {SubmitEvent} event 表单提交。@returns {Promise<void>} 保存完成。 */
async function save(event) {
  event.preventDefault();
  saveButton.disabled = true;
  try {
    const settings = readForm();
    await sendMessage({ type: "SAVE_SETTINGS", settings });
    status.textContent = "已保存，可以返回网页开始翻译";
    status.className = "success";
  } catch (error) {
    status.textContent = error.message;
    status.className = "error";
  } finally {
    saveButton.disabled = false;
  }
}

/** 验证指定服务的当前表单配置，无需先保存。@param {string} provider 服务标识。@returns {Promise<void>} 测试结束。 */
async function testConnection(provider) {
  const button = document.querySelector(`[data-test="${provider}"]`);
  const result = document.querySelector(`[data-result="${provider}"]`);
  button.disabled = true;
  button.textContent = "正在测试…";
  result.textContent = "正在发送短文本验证连接…";
  result.className = "hint test-result";
  try {
    const picker = modelPickers.get(provider);
    await picker.refresh({ automatic: true });
    const current = picker.readProvider();
    const settings = normalizeSettings({ provider, providers: { [provider]: current } });
    const { elapsedMs } = await sendMessage({ type: "TEST_PROVIDER", settings });
    result.textContent = `连接成功 · ${(elapsedMs / 1000).toFixed(1)} 秒 · 记得保存设置`;
    result.classList.add("success");
  } catch (error) {
    result.textContent = error.message;
    result.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "测试连接 ↗";
  }
}

form.addEventListener("submit", save);
/** 将用户输入及自动匹配的模型变更标记为未保存。@returns {void} 无返回值。 */
function markDirty() {
  status.textContent = "有未保存的修改";
  status.className = "";
  markProvider();
}
form.addEventListener("input", markDirty);
document
  .querySelectorAll("[data-test]")
  .forEach((button) => button.addEventListener("click", () => testConnection(button.dataset.test)));
document.querySelectorAll("[data-key]").forEach((button) =>
  button.addEventListener("click", () => {
    const input = form.elements[button.dataset.key];
    input.type = input.type === "password" ? "text" : "password";
    button.textContent = input.type === "password" ? "显示" : "隐藏";
  }),
);

/** 载入本机配置，不在任何控制台输出密钥。@returns {Promise<void>} 初始化完成。 */
async function initialize() {
  const settings = await sendMessage({ type: "GET_SETTINGS" });
  for (const id of ["deepseek", "openai"]) {
    form.elements[`${id}Key`].value = settings.providers[id].apiKey;
    form.elements[`${id}Model`].value = settings.providers[id].model;
    form.elements[`${id}Url`].value = settings.providers[id].baseUrl;
  }
  form.elements.provider.value = settings.provider;
  form.elements.targetLanguage.value = settings.targetLanguage;
  form.elements.mode.value = settings.mode;
  form.elements.showFloatingButton.checked = settings.showFloatingButton;
  form.elements.autoTranslateSites.value = settings.autoTranslateSites.join("\n");
  markProvider();
  for (const provider of ["deepseek", "openai"]) {
    const picker = new ModelPicker(
      provider,
      document.querySelector(`[data-provider="${provider}"]`),
      markDirty,
    );
    modelPickers.set(provider, picker);
    if (settings.providers[provider].apiKey) void picker.refresh({ automatic: true });
  }
}
initialize().catch((error) => {
  status.textContent = error.message;
  status.className = "error";
});
