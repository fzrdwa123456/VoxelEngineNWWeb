// Download and extract the NW.js runtime into nwjs\ (idempotent: skipped when already present).
// The version and the distribution directory name live in scripts/paths.mjs — the single source
// of truth shared with rearrange.mjs and build-all.mjs. They used to be duplicated here, in
// rearrange.mjs and in README.md, and had drifted apart (the README pointed at an "sdk" flavor
// that this script never downloads).
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { NW_DIST, NW_DIST_NAME, NW_DIR, NW_EXE, NW_VERSION, NW_ZIP } from "./paths.mjs";

if (existsSync(NW_EXE)) {
    console.log(`Already present: ${NW_EXE}, skipping`);
  process.exit(0);
}

mkdirSync(NW_DIR, { recursive: true });

const urls = [
  `https://dl.nwjs.io/v${NW_VERSION}/${NW_DIST_NAME}.zip`,
  `https://registry.npmmirror.com/-/binary/nwjs/v${NW_VERSION}/${NW_DIST_NAME}.zip`,
];

let got = false;
for (const url of urls) {
  try {
        console.log(`Downloading ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") || 0);
    let done = 0;
    const file = createWriteStream(NW_ZIP);
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
const tar = spawnSync("tar", ["-xf", NW_ZIP, "-C", NW_DIR], { stdio: "inherit" });
if (tar.status !== 0) {
    console.error("tar extraction failed");
  process.exit(1);
}
if (!existsSync(NW_EXE)) {
    console.error(`${NW_EXE} not found after extraction`);
  process.exit(1);
}
console.log(`Done -> ${NW_DIST}`);
