// 开发期的"建目录 + 装示例包"。
//
// 原版 rearrange.mjs 是 NW.js 的**打包器**（搬 nwjs 运行时 + dist + manifest，再用 rcedit 改名）。
// Tauri 版这些活全部由 `tauri build` 自己干了（前端产物、图标、版本信息、NSIS 安装包），
// 所以这里只剩下"开发时数据目录"这一件事，反而变简单了。
//
// 用法：
//   node scripts/rearrange.mjs               只建目录（对应原版的 plan A：引擎不内置任何资源包）
//   node scripts/rearrange.mjs --with-packs  再把 packs\ 里那两个示例包按 MC 布局装进去
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";

import { GAME, GAME_DIRS, PACKS, SAMPLE_MOD, SAMPLE_RP } from "./paths.mjs";

const withPacks = process.argv.includes("--with-packs");

// 数据根目录 + 那几个固定子目录（Rust 侧 game.rs 的 ensure_dirs 也会建，这里提前建好方便看）
mkdirSync(GAME, { recursive: true });
for (const d of GAME_DIRS) mkdirSync(path.join(GAME, d), { recursive: true });
console.log(`game\\ ready -> ${GAME}`);

if (!withPacks) {
  console.log("plan A: 不内置任何资源包（要装示例包就加 --with-packs）");
  process.exit(0);
}

/** 把一个示例包拷进目标目录（先删再拷，保证可重复执行） */
function installPack(sampleName, targetDir) {
  const src = path.join(PACKS, sampleName);
  if (!existsSync(src)) {
    console.warn(`warning: ${path.relative(process.cwd(), src)} 不存在，跳过`);
    return;
  }
  const dst = path.join(GAME, targetDir, sampleName);
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  let files = 0;
  for (const _ of walk(dst)) files++;
  console.log(`  installed ${targetDir}\\${sampleName}  (${files} files)`);
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

console.log("installing sample packs:");
installPack(SAMPLE_MOD, "mods");
installPack(SAMPLE_RP, "resourcepacks");

console.log("\n示例内容已就位。启动：npm run app:dev");
