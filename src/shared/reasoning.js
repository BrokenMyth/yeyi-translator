/** 推理档位仅保存稳定的接口值；不同服务的可选范围分别展示。 */
export const REASONING_LEVELS = [
  ["default", "接口默认"],
  ["none", "关闭思考"],
  ["minimal", "极低"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "极高"],
  ["max", "最高"],
];

/** 根据实际端点识别 DeepSeek 官方协议，代理接口只使用通用的推理参数。 */
function isOfficialDeepSeek(baseUrl) {
  try {
    return new URL(baseUrl).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

/** 旧配置缺少字段时保留原行为：DeepSeek 官方关闭思考，其他接口不传参数。 */
export function normalizeReasoningEffort(value, baseUrl) {
  const effort = value ?? (isOfficialDeepSeek(baseUrl) ? "none" : "default");
  if (!REASONING_LEVELS.some(([id]) => id === effort))
    throw new Error("推理级别无效，请从下拉框重新选择。");
  return effort;
}

/** 生成请求参数；选择接口默认时完全省略，DeepSeek 的开关与档位保持一致。 */
export function reasoningParameters(provider) {
  const effort = normalizeReasoningEffort(provider.reasoningEffort, provider.baseUrl);
  if (effort === "default") return {};
  if (isOfficialDeepSeek(provider.baseUrl)) {
    if (effort === "none") return { thinking: { type: "disabled" } };
    return { thinking: { type: "enabled" }, reasoning_effort: effort };
  }
  return { reasoning_effort: effort };
}

/**
 * 原有行为保持空签名，兼容现有缓存键；用户选择的其他档位独立复用译文。
 * 只改变缓存身份，不迁移、清空或覆盖旧缓存，切回原档位仍能命中原条目。
 */
export function reasoningSignature(provider) {
  const effort = normalizeReasoningEffort(provider.reasoningEffort, provider.baseUrl);
  const legacy = isOfficialDeepSeek(provider.baseUrl) ? "none" : "default";
  return effort === legacy ? "" : effort;
}
