import { zipSync, strToU8 } from "fflate";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

/** 收集已构建文件，ZIP 根目录直接包含 manifest.json。@param {string} directory 构建目录。@param {string} base 根路径。@returns {Promise<Object>} ZIP 文件表。 */
async function collect(directory, base = directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await collect(full, base));
    else result[relative(base, full).replaceAll("\\", "/")] = new Uint8Array(await readFile(full));
  }
  return result;
}
const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
const files = await collect(resolve("dist"));
files["安装说明.txt"] = strToU8(
  "页译 · Chrome / Edge 整页翻译\r\n\r\n1. 将 ZIP 解压到一个固定目录。\r\n2. Chrome 打开 chrome://extensions；Edge 打开 edge://extensions。\r\n3. 打开开发者模式，选择“加载已解压的扩展程序”，选择包含 manifest.json 的目录。\r\n4. 打开插件设置，填写 DeepSeek 或 OpenAI 的 Key，保存后回到普通网页。\r\n5. 刷新已打开的网页，从工具栏或网页右下角启动翻译。\r\n\r\n支持换行双语、替换原文、恢复原文及指定网站自动翻译。Key 仅保存在本机，译文只在当前页面内存缓存。API 费用由你配置的服务收取。\r\n",
);
await mkdir("release", { recursive: true });
const target = `release/yeyi-translator-${manifest.version}.zip`;
await writeFile(target, zipSync(files, { level: 9 }));
console.log(`已打包 → ${target}`);
