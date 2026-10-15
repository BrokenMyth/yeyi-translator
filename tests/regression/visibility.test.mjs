import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

let browser;
let source;
before(async () => {
  const result = await build({
    entryPoints: ["src/content/engine.js"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "engineModule",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
});
after(async () => browser?.close());

/** 在真实布局中运行引擎，记录发往后台的原文，不调用外部 API。 */
async function startPage(t, html, visibleOnly = true) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  t.after(() => page.close());
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>${html}</body></html>`,
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: source });
  await page.evaluate((visibleOnly) => {
    globalThis.requests = [];
    globalThis.chrome = {
      runtime: {
        sendMessage(message) {
          if (message.type !== "TRANSLATE_BATCH") return Promise.resolve({ ok: true, data: null });
          requests.push(message);
          return Promise.resolve({
            ok: true,
            data: message.segments.map((item) => ({
              id: item.id,
              parts: item.parts.map((part) => `译文：${part}`),
            })),
          });
        },
      },
    };
    globalThis.engine = new engineModule.TranslationEngine(() => {});
    engine.start({
      signature: "visibility-test",
      targetLanguage: "zh-CN",
      mode: "bilingual",
      visibleOnly,
    });
  }, visibleOnly);
  return page;
}

const sentTexts = (page) =>
  page.evaluate(() =>
    requests.flatMap((request) => request.segments.flatMap((segment) => segment.parts)),
  );

test("可视区域默认关闭时仍翻译屏幕外已加载的段落", async (t) => {
  const page = await startPage(
    t,
    '<p>First visible paragraph.</p><div style="height:1500px"></div><p id="below">Below the viewport.</p>',
    false,
  );
  await expect(page.locator("#below [data-yeyi-owned=translation]")).toHaveCount(1);
  assert((await sentTexts(page)).includes("Below the viewport."));
});

test("可视区域模式推迟屏幕外内容，滚动后立即翻译并保留前面的译文", async (t) => {
  const page = await startPage(
    t,
    '<p id="first">First visible paragraph.</p><div style="height:1500px"></div><p id="below">Below the viewport.</p>',
  );
  await expect(page.locator("#first [data-yeyi-owned=translation]")).toHaveCount(1);
  assert(!(await sentTexts(page)).includes("Below the viewport."));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator("#below [data-yeyi-owned=translation]")).toHaveCount(1);
  await expect(page.locator("#first [data-yeyi-owned=translation]")).toHaveCount(1);
});

test("Discord 内部滚动容器裁剪的内容先不翻译，内部滚动事件触发新内容", async (t) => {
  const page = await startPage(
    t,
    '<div id="scroll" style="height:160px;overflow:auto"><p id="first">Top chat message.</p><div style="height:700px"></div><p id="last">New chat message.</p></div>',
  );
  await expect(page.locator("#first [data-yeyi-owned=translation]")).toHaveCount(1);
  assert(!(await sentTexts(page)).includes("New chat message."));
  await page.evaluate(() => {
    const scroller = document.querySelector("#scroll");
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(page.locator("#last [data-yeyi-owned=translation]")).toHaveCount(1);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("隐藏、透明、裁剪、可编辑区域不发送，展开和新插入的内容会翻译", async (t) => {
  const page = await startPage(
    t,
    `<main><p id="visible">Visible source.</p><p hidden id="hidden">Hidden source.</p><p style="display:none">Display hidden.</p><p style="visibility:hidden">Visibility hidden.</p><p style="opacity:0">Transparent source.</p><p style="position:absolute;clip:rect(0,0,0,0)">Screen reader source.</p><div style="height:0;overflow:hidden"><p>Clipped source.</p></div><div contenteditable="true">Private input.</div></main>`,
  );
  await expect(page.locator("#visible [data-yeyi-owned=translation]")).toHaveCount(1);
  assert.deepEqual(await sentTexts(page), ["Visible source."]);
  await page.evaluate(() => {
    document.querySelector("#hidden").hidden = false;
    const paragraph = document.createElement("p");
    paragraph.id = "new";
    paragraph.textContent = "Newly inserted source.";
    document.querySelector("main").append(paragraph);
  });
  await expect(page.locator("#hidden [data-yeyi-owned=translation]")).toHaveCount(1);
  await expect(page.locator("#new [data-yeyi-owned=translation]")).toHaveCount(1);
});

test("调整窗口使新内容可见后自动翻译，暂停后不发送新请求", async (t) => {
  const page = await startPage(
    t,
    '<p>Top source.</p><p id="resized" style="position:absolute;top:700px">Source after resize.</p>',
  );
  assert(!(await sentTexts(page)).includes("Source after resize."));
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator("#resized [data-yeyi-owned=translation]")).toHaveCount(1);
  const count = (await sentTexts(page)).length;
  await page.evaluate(() => {
    engine.stop();
    const paragraph = document.createElement("p");
    paragraph.textContent = "Paused new source.";
    document.body.prepend(paragraph);
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(450);
  assert.equal((await sentTexts(page)).length, count);
});

test("Discord 作者、回复作者、成员名与昵称不进入请求，正文和普通网站同类名仍翻译", async (t) => {
  const page = await startPage(
    t,
    `<div id="app-mount"><ol data-list-id="chat-messages"><li id="chat-messages-1"><h3><span id="message-username-1"><span class="username_c19a55">Example Author</span></span></h3><div class="repliedMessage_c19a55"><span class="username_otherHash">Reply Author</span></div><div id="message-content-1"><span>Read the message body.</span></div></li></ol><aside><span class="displayName_newHash">Member Display Name</span><span class="nickname_newHash">Member Nickname</span></aside></div>`,
  );
  await expect(page.locator("#message-content-1 [data-yeyi-owned=translation]")).toHaveCount(1);
  assert.deepEqual(await sentTexts(page), ["Read the message body."]);
  await page.evaluate(() => {
    engine.restore();
    document.body.innerHTML = '<p class="username_c19a55">Ordinary article label.</p>';
    engine.start({
      signature: "visibility-test",
      targetLanguage: "zh-CN",
      mode: "replace",
      visibleOnly: true,
    });
  });
  await expect(page.locator("p")).toHaveText("译文：Ordinary article label.");
});
