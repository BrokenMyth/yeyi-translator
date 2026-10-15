import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

let browser;
let source;

before(async () => {
  const result = await build({
    entryPoints: ["src/content/model.js"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "translationModel",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
});

after(async () => browser?.close());

/** 在真实布局中扫描正文，保留归属段落与 code 身份用于断言。@param {string} html 页面夹具。@returns {Promise<Object[]>} 实际收集到的分组及原文。 */
async function collect(html) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await page.addScriptTag({ content: source });
    return await page.evaluate(() =>
      [...translationModel.collectGroups(document, new WeakMap())].map(([owner, records]) => ({
        owner: owner.id || owner.tagName,
        ownerTag: owner.tagName,
        originals: records.map((record) => record.original),
        codes: records
          .filter((record) => record.node.parentElement.closest("code"))
          .map((record) => record.original),
      })),
    );
  } finally {
    await page.close();
  }
}

test("真实 README 收集 inline code 中的自然语言功能名，并保留整格分组", async () => {
  const html = await readFile(new URL("../browser/readme.html", import.meta.url), "utf8");
  const groups = await collect(html);
  const labels = [
    "Standard Videos",
    "Bangumi",
    "Movies",
    "Courses",
    "Interactive Videos",
    "Audio (au/am)",
    "User Space",
    "Favorites",
    "Weekly Must-Watch",
    "Subscriptions",
    "Watch Later",
    "History",
  ];
  const group = groups.find((entry) =>
    entry.originals.some((text) => text.includes("Fully supports:")),
  );
  assert(group, "功能描述单元格应收集为段落");
  assert.equal(group.ownerTag, "TD");
  assert.deepEqual(group.codes, labels, "这些 code 是内容分类名称，应随正文送去翻译");
});

test("自然语言识别不限于该站分类词典", async () => {
  const groups = await collect(`
    <main><article>
      <p id="tips">Select <code>Automatic Updates</code> or <code>Privacy Settings</code>.</p>
      <p id="categories">Browse <code>Recent Articles</code>, <code>Tutorials</code>, <code>News</code>.</p>
    </article></main>`);
  assert.deepEqual(groups.find((group) => group.owner === "tips").codes, [
    "Automatic Updates",
    "Privacy Settings",
  ]);
  assert.deepEqual(groups.find((group) => group.owner === "categories").codes, [
    "Recent Articles",
    "Tutorials",
    "News",
  ]);
});

test("技术代码、命令、API 标识符、路径、版本、格式名及 pre 保持排除", async () => {
  const technical = [
    "xml",
    "ass",
    "json",
    "mp4",
    "mkv",
    "AVC",
    "HEVC",
    "AV1",
    "HTML",
    "UTF-8",
    "Promise",
    "String",
    "UserService",
    "userId",
    "get_user",
    "getUser()",
    "API_KEY",
    "npm install",
    "git status",
    "const answer = 42;",
    "src/main.js",
    "C:\\Users\\test",
    "v1.2.3",
    ".webp",
    "https://example.org",
    "HTTP GET",
  ];
  const groups = await collect(`<article><p id="technical">Formats and APIs: ${technical
    .map((text) => `<code>${text}</code>`)
    .join(", ")}.</p><pre><code>Standard Videos</code></pre>
    <p><code class="language-js">Automatic Updates</code></p>
    <p><code class="hljs">Privacy Settings</code></p></article>`);
  assert.deepEqual(
    groups.flatMap((group) => group.codes),
    [],
  );
});

test("技术项混入自然语言分类列表时依然排除", async () => {
  const groups = await collect(`<article><table><tr><td id="mixed">Choose
    <code>Recent Articles</code>, <code>News</code>, <code>mp4</code>, <code>AVC</code>,
    <code>getUser()</code>, <code>src/main.js</code>, <code>v1.2.3</code>.
    </td></tr></table></article>`);
  assert.deepEqual(groups.find((group) => group.owner === "mixed").codes, [
    "Recent Articles",
    "News",
  ]);
});

test("正文中同段出现自然语言词组不会使独立 API 名称误入枚举列表", async () => {
  const groups = await collect(`<article><p id="api">Read <code>Getting Started</code>
    using <code>Promise</code> and <code>String</code>.</p>
    <p id="styled">Select <code style="display:inline-block">Automatic Updates</code>.</p>
    </article>`);
  assert.deepEqual(groups.find((group) => group.owner === "api").codes, ["Getting Started"]);
  assert.deepEqual(groups.find((group) => group.owner === "styled").codes, ["Automatic Updates"]);
});

test("隐藏、显式排除与非正文代码不因自然语言规则重新开放", async () => {
  const groups = await collect(`<article>
    <p hidden><code>Automatic Updates</code></p>
    <p aria-hidden="true"><code>Privacy Settings</code></p>
    <p translate="no"><code>Recent Articles</code></p>
    <p class="notranslate"><code>Account Settings</code></p>
    <p contenteditable="true"><code>History Settings</code></p>
    <p style="display:none"><code>Saved Articles</code></p>
    <p><code style="display:block">Reading Settings</code></p>
    </article><nav><code>Application Settings</code></nav>`);
  assert.deepEqual(
    groups.flatMap((group) => group.codes),
    [],
  );
});

test("替换译文后重扫仍按节点原文识别，并保持段落归属", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<article><p id="labels">Choose <code>Recent Articles</code>, <code>News</code>.</p></article>`,
    );
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(() => {
      const ownership = new WeakMap();
      const first = translationModel.collectGroups(document, ownership);
      for (const records of first.values())
        for (const record of records) {
          const lastWritten = /\p{L}/u.test(record.original) ? "译文" : record.original;
          ownership.set(record.node, { original: record.original, lastWritten });
          record.node.data = lastWritten;
        }
      return [...translationModel.collectGroups(document, ownership)].map(([owner, records]) => ({
        owner: owner.id,
        codes: records
          .filter((record) => record.node.parentElement.closest("code"))
          .map((record) => record.original),
      }));
    });
    assert.deepEqual(result, [{ owner: "labels", codes: ["Recent Articles", "News"] }]);
  } finally {
    await page.close();
  }
});
