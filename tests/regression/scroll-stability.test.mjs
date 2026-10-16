import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

let browser;
let source;
before(async () => {
  source = (
    await build({
      entryPoints: ["src/content/engine.js"],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "engineModule",
    })
  ).outputFiles[0].text;
  browser = await chromium.launch({ channel: "chromium", headless: true });
});
after(() => browser?.close());

/** 合成 Discord 式列表：关闭原生锚定，按距底部的距离响应消息高度变化。 */
async function chat(t, mode, { managed = true, bottom = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  t.after(() => page.close());
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>body{margin:0;overflow:hidden}#scroll{height:320px;width:400px;overflow:auto;overflow-anchor:none;position:relative}ol{margin:0;padding:0;list-style:none}li{padding:8px;font:16px/24px Arial}p{margin:0}</style><div id="app-mount"><div id="scroll"><ol data-list-id="chat-messages">${Array.from({ length: 45 }, (_, i) => `<li id="chat-messages-${i}"><p id="message-content-${i}">Cached source ${i}. This message keeps several lines of original text to measure reflow above the reading position.</p></li>`).join("")}</ol></div></div>`,
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: source });
  await page.evaluate(
    ({ mode, managed, bottom }) => {
      const scroller = document.querySelector("#scroll");
      const list = document.querySelector("ol");
      scroller.scrollTop = bottom
        ? scroller.scrollHeight
        : document.querySelector("#chat-messages-22").offsetTop;
      if (managed) {
        let height = list.offsetHeight;
        let distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        scroller.addEventListener("scroll", () => {
          distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        });
        globalThis.siteObserver = new ResizeObserver(() => {
          if (height === list.offsetHeight) return;
          height = list.offsetHeight;
          scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - distance;
        });
        siteObserver.observe(list);
      }
      globalThis.lookups = [];
      globalThis.requests = [];
      globalThis.releaseCache = false;
      globalThis.chrome = {
        runtime: {
          sendMessage(message) {
            if (message.type === "LOOKUP_CACHE") {
              const data = message.segments.map((segment) => ({
                id: segment.id,
                parts: segment.parts.map((text) => `缓存译文${text.match(/source (\d+)/)[1]}。`),
              }));
              if (releaseCache) return Promise.resolve({ ok: true, data });
              return new Promise((resolve) => lookups.push({ resolve, data }));
            }
            if (message.type === "TRANSLATE_BATCH") requests.push(message);
            return Promise.resolve({ ok: true, data: [] });
          },
        },
      };
      globalThis.engine = new engineModule.TranslationEngine(() => {});
      engine.start({
        signature: "scroll-stability",
        targetLanguage: "zh-CN",
        mode,
        cacheEnabled: true,
        visibleOnly: true,
      });
    },
    { mode, managed, bottom },
  );
  await expect.poll(() => page.evaluate(() => lookups.length)).toBeGreaterThan(0);
  return page;
}

/** 缓存返回前模拟用户上滚，译文必须以这个最新阅读位置为准。 */
async function scrollUp(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector("#scroll");
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    scroller.scrollTop -= 120;
    const rect = scroller.getBoundingClientRect();
    const anchor = [...document.querySelectorAll("ol > li")].find(
      (element) => element.getBoundingClientRect().bottom > rect.top,
    );
    return { id: anchor.id, top: anchor.getBoundingClientRect().top };
  });
}

async function release(page, selector = "#message-content-22") {
  await page.evaluate(() => {
    releaseCache = true;
    for (const lookup of lookups) lookup.resolve({ ok: true, data: lookup.data });
  });
  await expect(page.locator(selector)).toContainText("缓存译文");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }),
  );
}

test("缓存显示后继续上滚时，以新的阅读位置为准，不被延迟补偿拉回", async (t) => {
  const page = await chat(t, "replace", { managed: false });
  await scrollUp(page);
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector("#message-content-22").textContent.includes("缓存译文")) return;
      observer.disconnect();
      const scroller = document.querySelector("#scroll");
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      scroller.scrollTop -= 120;
      const anchor = [...document.querySelectorAll("ol > li")].find(
        (element) => element.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top,
      );
      globalThis.userAnchor = { id: anchor.id, top: anchor.getBoundingClientRect().top };
    });
    observer.observe(document.querySelector("ol"), { subtree: true, characterData: true });
  });
  await release(page);
  const shift = await page.evaluate(
    () => document.getElementById(userAnchor.id).getBoundingClientRect().top - userAnchor.top,
  );
  assert(Math.abs(shift) <= 1, `用户继续上滚后被拉回 ${shift}px`);
});

test("停止会话后不再执行旧批次的滚动补偿", async (t) => {
  const page = await chat(t, "replace", { managed: false });
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector("#message-content-22").textContent.includes("缓存译文")) return;
      observer.disconnect();
      engine.stop();
      const scroller = document.querySelector("#scroll");
      scroller.scrollTop -= 120;
      globalThis.stoppedTop = scroller.scrollTop;
    });
    observer.observe(document.querySelector("ol"), { subtree: true, characterData: true });
  });
  await release(page);
  assert.equal(
    await page.locator("#scroll").evaluate((element) => element.scrollTop),
    await page.evaluate(() => stoppedTop),
  );
});

test("停在聊天底部时保留站点自动跟随，不锁定旧消息位置", async (t) => {
  const page = await chat(t, "bilingual", { bottom: true });
  await release(page, "#message-content-44");
  const remaining = await page
    .locator("#scroll")
    .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  assert(remaining <= 1, `离开底部 ${remaining}px`);
  assert.equal(await page.locator("#scroll").getAttribute("style"), null);
});

test("浏览器原生滚动锚定开启时不会重复补偿", async (t) => {
  const page = await chat(t, "bilingual", { managed: false });
  await page.locator("#scroll").evaluate((element) => {
    element.style.overflowAnchor = "auto";
  });
  const anchor = await scrollUp(page);
  await release(page);
  const top = await page
    .locator(`#${anchor.id}`)
    .evaluate((element) => element.getBoundingClientRect().top);
  assert(Math.abs(top - anchor.top) <= 1, `原生锚定叠加偏移 ${top - anchor.top}px`);
  await expect(page.locator("#scroll")).toHaveCSS("overflow-anchor", "auto");
});

for (const mode of ["replace", "bilingual"]) {
  test(`缓存命中改变消息高度后保持上滚后的阅读位置（${mode}）`, async (t) => {
    const page = await chat(t, mode);
    const anchor = await scrollUp(page);
    await release(page);
    const top = await page
      .locator(`#${anchor.id}`)
      .evaluate((element) => element.getBoundingClientRect().top);
    assert(Math.abs(top - anchor.top) <= 1, `阅读位置偏移 ${top - anchor.top}px`);
    assert.equal(await page.evaluate(() => requests.length), 0);
  });
}
