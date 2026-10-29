import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

let browser;
let source;
before(async () => {
  const bundle = await build({
    entryPoints: ["src/content/engine.js"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "engineModule",
  });
  source = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
});
after(async () => browser?.close());

/** 缓存查询独立控制，网络请求始终挂起，直接验证命中显示不依赖任何 API 响应。 */
async function startPage(t, html, { deferLookup = false, cacheEnabled = true } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body><main>${html}</main></body></html>`,
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: source });
  await page.evaluate(
    ({ deferLookup, cacheEnabled }) => {
      globalThis.lookups = [];
      globalThis.requests = [];
      globalThis.chrome = {
        runtime: {
          sendMessage(message) {
            if (message.type === "LOOKUP_CACHE") {
              const data = message.segments
                .filter((segment) => segment.parts.every((part) => part.startsWith("Cached")))
                .map((segment) => ({
                  id: segment.id,
                  parts: segment.parts.map((part) => `缓存译文：${part}`),
                }));
              if (deferLookup)
                return new Promise((resolve) => lookups.push({ message, data, resolve }));
              lookups.push({ message });
              return Promise.resolve({ ok: true, data });
            }
            if (message.type === "TRANSLATE_BATCH")
              return new Promise((resolve) => requests.push({ message, resolve }));
            return Promise.resolve({ ok: true, data: null });
          },
        },
      };
      globalThis.engine = new engineModule.TranslationEngine(() => {});
      engine.start({
        signature: "cache-priority",
        targetLanguage: "zh-CN",
        mode: "bilingual",
        cacheEnabled,
      });
    },
    { deferLookup, cacheEnabled },
  );
  return page;
}

const requestTexts = (page) =>
  page.evaluate(() =>
    requests.flatMap(({ message }) => message.segments.flatMap((segment) => segment.parts)),
  );
const releaseLookup = (page, index) =>
  page.evaluate((index) => {
    const lookup = lookups[index];
    lookup.resolve({ ok: true, data: lookup.data });
  }, index);

test("缓存命中跨越多个批次立即显示，翻译队列和请求只含缺项", async (t) => {
  const page = await startPage(
    t,
    `<p id="missing">Uncached top source.</p>${Array.from({ length: 40 }, (_, index) => `<p class="cached">Cached paragraph ${index}.</p>`).join("")}`,
  );
  await expect(page.locator(".cached [data-yeyi-owned=translation]")).toHaveCount(40);
  await expect.poll(() => requestTexts(page)).toEqual(["Uncached top source."]);
  assert((await page.evaluate(() => lookups.length)) > 1);
  assert.equal(
    await page.evaluate(() =>
      [...engine.units.values()]
        .filter((unit) => unit.nodes[0].original.startsWith("Cached"))
        .flatMap((unit) => unit.chunks)
        .every((chunk) => chunk.state === "done"),
    ),
    true,
  );
  await expect(page.locator("#missing [data-yeyi-owned=translation]")).toHaveCount(0);
});

test("全部命中不进入待翻译队列，不创建任何翻译请求", async (t) => {
  const page = await startPage(t, "<p>Cached first source.</p><p>Cached second source.</p>");
  await expect(page.locator("p [data-yeyi-owned=translation]")).toHaveCount(2);
  assert.deepEqual(await requestTexts(page), []);
  assert.equal(await page.evaluate(() => engine.getState().phase), "watching");
  assert.equal(await page.evaluate(() => engine.nextBatch().tasks.length), 0);
});

test("网络批次未结束时，新出现的缓存命中仍可独立显示", async (t) => {
  const page = await startPage(t, "<p>Uncached slow source.</p>");
  await expect.poll(() => page.evaluate(() => requests.length)).toBe(1);
  await page.evaluate(() => {
    const paragraph = document.createElement("p");
    paragraph.id = "dynamic";
    paragraph.textContent = "Cached dynamic source.";
    document.querySelector("main").append(paragraph);
  });
  await expect(page.locator("#dynamic [data-yeyi-owned=translation]")).toHaveText(
    "缓存译文：Cached dynamic source.",
  );
  assert.deepEqual(await requestTexts(page), ["Uncached slow source."]);
});

test("恢复并重启后忽略旧缓存查询，未完成查询不会进入翻译队列", async (t) => {
  const page = await startPage(t, "<p>Cached source.</p>", { deferLookup: true });
  assert.deepEqual(await requestTexts(page), []);
  await page.evaluate(() => {
    engine.restore();
    engine.start({
      signature: "cache-priority",
      targetLanguage: "zh-CN",
      mode: "bilingual",
      cacheEnabled: true,
    });
  });
  await releaseLookup(page, 0);
  await expect(page.locator("[data-yeyi-owned=translation]")).toHaveCount(0);
  await releaseLookup(page, 1);
  await expect(page.locator("[data-yeyi-owned=translation]")).toHaveCount(1);
  assert.deepEqual(await requestTexts(page), []);
});

test("清理期间忽略旧缓存命中，缺项正常翻译且保留原文恢复能力", async (t) => {
  const page = await startPage(t, "<p>Cached source.</p>", { deferLookup: true });
  await page.evaluate(() => engine.clearCache());
  await expect.poll(() => requestTexts(page)).toEqual(["Cached source."]);
  await releaseLookup(page, 0);
  await expect(page.locator("[data-yeyi-owned=translation]")).toHaveCount(0);
  await page.evaluate(() => {
    requests[0].resolve({
      ok: true,
      data: requests[0].message.segments.map((segment) => ({
        id: segment.id,
        parts: ["清理后的新译文"],
      })),
    });
  });
  await expect(page.locator("[data-yeyi-owned=translation]")).toHaveText("清理后的新译文");
  await page.evaluate(() => engine.restore());
  await expect(page.locator("p")).toHaveText("Cached source.");
});

test("查询失败回退到正常翻译，停用缓存不发起预检", async (t) => {
  const page = await startPage(t, "<p>Uncached source.</p>", { deferLookup: true });
  await page.evaluate(() =>
    lookups[0].resolve({ ok: false, error: { code: "CONNECTION", message: "暂时无法读取缓存" } }),
  );
  await expect.poll(() => page.evaluate(() => requests.length)).toBe(1);
  assert.deepEqual(await requestTexts(page), ["Uncached source."]);
  const disabled = await startPage(t, "<p>Cached source.</p>", { cacheEnabled: false });
  assert.equal(await disabled.evaluate(() => lookups.length), 0);
  await expect.poll(() => requestTexts(disabled)).toEqual(["Cached source."]);
});

/** 比较用户可见的段落来源，避免把请求次数或拆分片段当成段落数。 */
const sourceCounts = (page) =>
  page.evaluate(() => {
    const { done, cached, translated, skipped } = engine.getState();
    return { done, cached, translated, skipped };
  });

test("来源统计区分缓存、新译和无需翻译，暂停与扫描不重复计数，恢复后本页缓存可复用", async (t) => {
  const page = await startPage(t, "<p>Cached source.</p><p>Fresh source.</p><p>这是中文原文。</p>");
  await expect.poll(() => page.evaluate(() => requests.length)).toBe(1);
  assert.deepEqual(await sourceCounts(page), { done: 2, cached: 1, translated: 0, skipped: 1 });
  await page.evaluate(() =>
    requests[0].resolve({
      ok: true,
      data: requests[0].message.segments.map((segment) => ({
        id: segment.id,
        parts: ["新译正文"],
        cacheHit: false,
      })),
    }),
  );
  await expect
    .poll(() => sourceCounts(page))
    .toEqual({ done: 3, cached: 1, translated: 1, skipped: 1 });
  await page.evaluate(() => {
    engine.scan();
    engine.scan();
    engine.stop();
    engine.start(engine.config);
    engine.setMode("replace");
  });
  assert.deepEqual(await sourceCounts(page), { done: 3, cached: 1, translated: 1, skipped: 1 });
  await page.evaluate(() => engine.restore());
  assert.deepEqual(await sourceCounts(page), { done: 0, cached: 0, translated: 0, skipped: 0 });
  await page.evaluate(() => engine.start({ ...engine.config, cacheEnabled: false }));
  await expect
    .poll(() => sourceCounts(page))
    .toEqual({ done: 3, cached: 2, translated: 0, skipped: 1 });
  assert.equal(await page.evaluate(() => requests.length), 1);
});

test("后台二次命中仍算缓存，动态节点回收后按当前段落重新统计", async (t) => {
  const page = await startPage(
    t,
    '<p id="late">Previously uncached source.</p><p id="fresh">Fresh source.</p>',
  );
  await expect.poll(() => page.evaluate(() => requests.length)).toBe(1);
  await page.evaluate(() =>
    requests[0].resolve({
      ok: true,
      data: requests[0].message.segments.map((segment, index) => ({
        id: segment.id,
        parts: ["正文译文"],
        cacheHit: index === 0,
      })),
    }),
  );
  await expect
    .poll(() => sourceCounts(page))
    .toEqual({ done: 2, cached: 1, translated: 1, skipped: 0 });
  await page.evaluate(() => {
    document.querySelector("#late").remove();
    document.querySelector("#fresh").outerHTML = '<p id="fresh">Fresh source.</p>';
    engine.scan();
  });
  assert.deepEqual(await sourceCounts(page), { done: 1, cached: 1, translated: 0, skipped: 0 });
  assert.equal(await page.evaluate(() => requests.length), 1);
});

test("同段部分分片缓存、部分新译只算一段新翻译，未完成时不提前计数", async (t) => {
  const page = await startPage(
    t,
    `<p>${Array.from({ length: 40 }, (_, index) => `<span>Cached fragment ${index}.</span>`).join("")}<span>Fresh tail.</span></p>`,
  );
  await expect.poll(() => page.evaluate(() => requests.length)).toBe(1);
  assert.deepEqual(await sourceCounts(page), { done: 0, cached: 0, translated: 0, skipped: 0 });
  assert.deepEqual(await requestTexts(page), ["Fresh tail."]);
  await page.evaluate(() =>
    requests[0].resolve({
      ok: true,
      data: requests[0].message.segments.map((segment) => ({
        id: segment.id,
        parts: ["新译尾句"],
        cacheHit: false,
      })),
    }),
  );
  await expect
    .poll(() => sourceCounts(page))
    .toEqual({ done: 1, cached: 0, translated: 1, skipped: 0 });
});

test("失败和迟到响应不计入完成来源，重试成功只计一次", async (t) => {
  const page = await startPage(t, "<p>Fresh source.</p>");
  await expect.poll(() => page.evaluate(() => requests.length)).toBe(1);
  await page.evaluate(() =>
    requests[0].resolve({ ok: false, error: { code: "NETWORK", message: "测试网络失败" } }),
  );
  await expect.poll(() => page.evaluate(() => requests.length)).toBe(2);
  assert.deepEqual(await sourceCounts(page), { done: 0, cached: 0, translated: 0, skipped: 0 });
  await page.evaluate(() => {
    engine.stop();
    engine.start(engine.config);
    requests[1].resolve({
      ok: true,
      data: requests[1].message.segments.map((segment) => ({
        id: segment.id,
        parts: ["过期响应"],
        cacheHit: false,
      })),
    });
  });
  await expect.poll(() => page.evaluate(() => requests.length)).toBe(3);
  assert.deepEqual(await sourceCounts(page), { done: 0, cached: 0, translated: 0, skipped: 0 });
  await page.evaluate(() =>
    requests[2].resolve({
      ok: true,
      data: requests[2].message.segments.map((segment) => ({
        id: segment.id,
        parts: ["重试成功"],
        cacheHit: false,
      })),
    }),
  );
  await expect
    .poll(() => sourceCounts(page))
    .toEqual({ done: 1, cached: 0, translated: 1, skipped: 0 });
});
