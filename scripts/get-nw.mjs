// 下载并解压 NW.js v0.115.0 sdk win-x64 到 nwjs\（幂等：已存在则跳过; 与 rearrange.mjs 期望的目录名一致）
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.115.0";
const distName = `nwjs-sdk-v${version}-win-x64`;
const nwDir = path.join(root, "nwjs");
const outDir = path.join(nwDir, distName);

if (existsSync(path.join(outDir, "nw.exe"))) {
  console.log(`已存在: ${outDir}\\nw.exe, 跳过`);
  process.exit(0);
}

mkdirSync(nwDir, { recursive: true });
const zipPath = path.join(nwDir, `${distName}.zip`);

const urls = [
  `https://dl.nwjs.io/v${version}/${distName}.zip`,
  `https://registry.npmmirror.com/-/binary/nwjs/v${version}/${distName}.zip`,
];

let got = false;
for (const url of urls) {
  try {
    console.log(`下载 ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") || 0);
    let done = 0;
    const file = createWriteStream(zipPath);
    const reader = res.body.getReader();
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      file.write(Buffer.from(value));
      done += value.length;
      process.stdout.write(`\r  ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
    }
    file.end();
    await new Promise((r) => file.on("finish", r));
    console.log("\n下载完成");
    got = true;
    break;
  } catch (e) {
    console.log(`失败: ${e.message}, 换下一个源`);
  }
}
if (!got) {
  console.error("所有下载源均失败");
  process.exit(1);
}

console.log("解压...");
const tar = spawnSync("tar", ["-xf", zipPath, "-C", nwDir], { stdio: "inherit" });
if (tar.status !== 0) {
  console.error("tar 解压失败");
  process.exit(1);
}
if (!existsSync(path.join(outDir, "nw.exe"))) {
  console.error(`解压后未找到 ${outDir}\\nw.exe`);
  process.exit(1);
}
console.log(`完成 -> ${outDir}`);