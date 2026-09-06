// Download and extract NW.js v0.115.0 (normal flavor, no SDK/devtools) win-x64 into nwjs\ (idempotent: skipped when present; matches the directory name rearrange.mjs expects)
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.115.0";
const distName = `nwjs-v${version}-win-x64`;
const nwDir = path.join(root, "nwjs");
const outDir = path.join(nwDir, distName);

if (existsSync(path.join(outDir, "nw.exe"))) {
    console.log(`Already present: ${outDir}\\nw.exe, skipping`);
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
        console.log(`Downloading ${url}`);
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
        console.log("\nDownload complete");
    got = true;
    break;
  } catch (e) {
        console.log(`Failed: ${e.message}, trying the next mirror`);
  }
}
if (!got) {
    console.error("All download mirrors failed");
  process.exit(1);
}

console.log("Extracting...");
const tar = spawnSync("tar", ["-xf", zipPath, "-C", nwDir], { stdio: "inherit" });
if (tar.status !== 0) {
    console.error("tar extraction failed");
  process.exit(1);
}
if (!existsSync(path.join(outDir, "nw.exe"))) {
    console.error(`${outDir}\\nw.exe not found after extraction`);
  process.exit(1);
}
console.log(`Done -> ${outDir}`);