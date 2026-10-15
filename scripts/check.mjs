import { readdir, readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** 递归列出文件。@param {string} directory 路径。@returns {Promise<string[]>} 文件列表。 */
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? files(resolve(directory, entry.name))
        : [resolve(directory, entry.name)],
    ),
  );
  return nested.flat();
}
const source = (await Promise.all(["src", "scripts", "tests"].map(files)))
  .flat()
  .filter((file) => /\.[cm]?js$/.test(file));
for (const file of source) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts.flatMap((item) => item.js),
  ...Object.values(manifest.icons),
];
await Promise.all(referenced.map((file) => access(resolve("dist", file))));
const bundled = (await files("dist")).filter((file) => file.endsWith(".js"));
for (const file of bundled) {
  const code = await readFile(file, "utf8");
  if (/\beval\s*\(|new Function\s*\(/.test(code))
    throw new Error(`扩展 CSP 不允许动态代码：${file}`);
  if (/tests\/|fixture-secret|mock-api-key/.test(code))
    throw new Error(`测试数据混入产物：${file}`);
}
console.log(`检查通过：${source.length} 个脚本、扩展入口、MV3 CSP 与测试隔离。`);
