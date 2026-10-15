import { test } from "node:test";
import assert from "node:assert/strict";
import { translateBatch } from "../../src/background/api.js";
import * as api from "../../src/background/api.js";

test("README 表格中的表情、逗号和数字即使被模型清空也不会拖累整批译文", () => {
  const segments = [{ id: "readme", parts: ["🎨 ", "Modern UI", ", ", "2026", "8K"] }];
  const content = JSON.stringify({
    translations: [{ id: "readme", parts: ["", "现代界面", "", "", "8K"] }],
  });
  assert.deepEqual(api.parseTranslations(content, segments), [
    { id: "readme", parts: ["🎨 ", "现代界面", ", ", "2026", "8K"] },
  ]);
});

test("正文被清空或缺少片段时仍拒绝响应，避免用空白覆盖原文", () => {
  const segments = [{ id: "readme", parts: ["🎨 ", "Modern UI"] }];
  for (const parts of [["", ""], ["现代界面"], [null, "现代界面"]])
    assert.throws(
      () =>
        api.parseTranslations(
          JSON.stringify({ translations: [{ id: "readme", parts }] }),
          segments,
        ),
      (error) => error.code === "OUTPUT_INVALID",
    );
});

test("HTTP 400 的模型不存在错误保留可诊断的信息并引导获取模型", async () => {
  await assert.rejects(
    () =>
      translateBatch({
        provider: {
          apiKey: "test-only-secret",
          baseUrl: "https://api.deepseek.com",
          model: "DeepSeek-V41-Flash",
        },
        targetLanguage: "zh-CN",
        segments: [{ id: "connection", parts: ["Hello, world!"] }],
        signal: new AbortController().signal,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "model_not_found",
                param: "model",
                message:
                  "Model 'DeepSeek-V41-Flash' does not exist. Query /models to find available models.",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
      }),
    (error) => {
      assert.match(error.message, /DeepSeek-V41-Flash/);
      assert.match(error.message, /获取模型/);
      assert(!error.message.includes("test-only-secret"));
      return true;
    },
  );
});

test("模型列表从 GET /models 返回真实 ID，兼容根地址、/v1 和完整端点", async () => {
  for (const [baseUrl, expected] of [
    ["https://api.deepseek.com", "https://api.deepseek.com/models"],
    ["https://api.openai.com/v1/", "https://api.openai.com/v1/models"],
    ["https://proxy.example/v1/chat/completions", "https://proxy.example/v1/models"],
  ]) {
    const models = await api.listModels({
      provider: { apiKey: "test-only-secret", baseUrl },
      fetchImpl: async (url, request) => {
        assert.equal(url, expected);
        assert.equal(request.method, "GET");
        assert.equal(request.headers.Authorization, "Bearer test-only-secret");
        assert.equal(request.body, undefined);
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "deepseek-flash",
                name: "DeepSeek-V4.1-Flash",
                object: "model",
                owned_by: "deepseek",
              },
              { id: "custom-chat", object: "model", owned_by: "custom" },
              { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    assert.deepEqual(models, [
      { id: "custom-chat", name: "custom-chat" },
      { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
    ]);
  }
});

test("连接错误保留参数原因，同时脱敏 Key、编码后的 Key 和原文", async () => {
  const key = "sk-test/key+with=digits";
  const source = "Private original paragraph.";
  await assert.rejects(
    () =>
      translateBatch({
        provider: { apiKey: key, baseUrl: "https://proxy.example/v1", model: "custom-chat" },
        targetLanguage: "zh-CN",
        segments: [{ id: "private", parts: [source] }],
        signal: new AbortController().signal,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "unsupported_parameter",
                param: "response_format",
                message: `response_format is unsupported; key=${key}; encoded=${encodeURIComponent(key)}; source=${source}; Authorization: Bearer sk-another-private-key-1234`,
              },
            }),
            { status: 400 },
          ),
      }),
    (error) => {
      assert.match(error.message, /response_format is unsupported/);
      assert(!error.message.includes(key));
      assert(!error.message.includes(encodeURIComponent(key)));
      assert(!error.message.includes(source));
      assert(!error.message.includes("sk-another-private-key-1234"));
      return true;
    },
  );
});

test("接口未提供模型列表时明确允许手动配置，鉴权失败不会重试", async () => {
  for (const [status, body, expected] of [
    [404, { error: { message: "Not Found" } }, /手动填写模型 ID/],
    [401, { error: { message: "Invalid key test-only-secret" } }, /API Key 无效/],
  ]) {
    let requests = 0;
    await assert.rejects(
      () =>
        api.listModels({
          provider: { apiKey: "test-only-secret", baseUrl: "https://proxy.example/v1" },
          fetchImpl: async () => {
            requests++;
            return new Response(JSON.stringify(body), { status });
          },
        }),
      (error) => {
        assert.match(error.message, expected);
        assert(!error.message.includes("test-only-secret"));
        return true;
      },
    );
    assert.equal(requests, 1);
  }
});
