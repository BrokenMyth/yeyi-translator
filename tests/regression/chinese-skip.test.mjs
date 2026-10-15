import { test } from "node:test";
import assert from "node:assert/strict";
import { createChunks, isChineseText, textFragments } from "../../src/content/model.js";
import { validateSegments } from "../../src/background/api.js";

test("中文段落允许品牌、链接和数字，纯中文及已有品牌无需 API 任务", () => {
  for (const original of [
    "这是中文正文。",
    "這是繁體中文說明。",
    "支持 Windows、Linux 和 macOS，版本 2026。",
    "请参考 https://example.com/path/to/docs 查看设置。",
  ]) {
    assert(isChineseText(original));
    const unit = { id: "chinese", nodes: [{ original }] };
    assert.deepEqual(createChunks(unit), []);
    assert.equal(unit.nodes[0].fragments.map((fragment) => fragment.text).join(""), original);
  }
});

test("同一文本节点内的中文本地保留，外文按原位置翻译并带有界中文上下文", () => {
  const original = "中文开头。 Read the guide before starting. 中文结尾。";
  const unit = { id: "mixed", nodes: [{ original }] };
  const chunks = createChunks(unit);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].parts, ["Read the guide before starting. "]);
  assert(chunks[0].context.includes("中文开头"));
  assert(chunks[0].context.includes("中文结尾"));
  const restored = unit.nodes[0].fragments.map((fragment) =>
    fragment.preserve ? fragment.text : "",
  );
  const { nodeIndex, fragmentIndex } = chunks[0].locations[0];
  assert.equal(nodeIndex, 0);
  restored[fragmentIndex] = "开始前阅读指南。 ";
  assert.equal(restored.join(""), "中文开头。 开始前阅读指南。 中文结尾。");
  assert.equal(
    textFragments(original)
      .map((fragment) => fragment.text)
      .join(""),
    original,
  );
});

test("中文参考只在混排单元中附带且不超过上下文上限，不将日文韩文误作中文", () => {
  const chinese = "这是较长的中文上下文。".repeat(200);
  const unit = {
    id: "context",
    nodes: [{ original: chinese }, { original: "Read the guide before starting." }],
  };
  const chunks = createChunks(unit);
  assert(chunks.length);
  assert(chunks[0].context.length <= 1000);
  assert(chunks[0].parts.every((part) => !/\p{Script=Han}/u.test(part)));
  validateSegments(chunks.map(({ id, parts, context }) => ({ id, parts, context })));
  for (const text of [
    "日本語の説明です。",
    "한국어 설명입니다.",
    "Read the guide before starting.",
  ]) {
    assert.equal(isChineseText(text), false);
    assert(textFragments(text).some((fragment) => !fragment.preserve));
  }
});

test("中文上下文计入批次限额，超长或非文本上下文不会进入 API", () => {
  for (const context of ["中".repeat(1001), { text: "中文" }])
    assert.throws(
      () => validateSegments([{ id: "context", parts: ["Read the guide"], context }]),
      (error) => error.code === "BAD_INPUT",
    );
  assert.throws(
    () =>
      validateSegments(
        Array.from({ length: 7 }, (_, index) => ({
          id: String(index),
          parts: ["Read"],
          context: "中".repeat(1000),
        })),
      ),
    (error) => error.code === "BAD_INPUT",
  );
});
