// 便携发布目录：一个能直接双击跑的文件夹。
//
// ⚠️ **WebView2Loader.dll 必须跟 exe 放在一起。**
// 少了它，Windows 不会给你任何窗口，只会弹一个
//   "voxelengine-tauri.exe - 系统错误：由于找不到 WebView2Loader.dll，无法继续执行代码"
// 的系统错误框；而且那个框是 **csrss.exe** 画的 —— 杀掉应用进程它也不会消失，
// 于是现象看起来像"进程活着、0 CPU、2 个线程、没有窗口、一行日志都不写"的假死。
// （这个坑真踩过：tauri build 会把 WebView2Loader.dll 放在 target\release\ 里，
//   手动只拷 exe 就会漏。）
//
// 用法：
//   node scripts/package-portable.mjs              装仓库里的示例包（默认）
//   node scripts/package-portable.mjs --no-packs   不装示例包（对应原版 plan A：引擎不内置资源）
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { CARGO_TARGET, GAME_DIRS, PACKS, ROOT, SAMPLE_MOD, SAMPLE_RP } from "./paths.mjs";

const withPacks = !process.argv.includes("--no-packs");
const RELEASE_DIR = path.join(CARGO_TARGET, "release");
const EXE_SRC = path.join(RELEASE_DIR, "voxelengine-tauri.exe");
const LOADER_SRC = path.join(RELEASE_DIR, "WebView2Loader.dll");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "release", "VoxelEngineTauri");

if (!existsSync(EXE_SRC)) {
  console.error(`release exe 不存在：${EXE_SRC}`);
  console.error("先跑一次：npm run app:build   （或 npm run app:exe）");
  process.exit(1);
}
if (!existsSync(LOADER_SRC)) {
  console.error(`!! 找不到 WebView2Loader.dll（${LOADER_SRC}）`);
  console.error("   没有它发布目录里的 exe 起不来（缺 DLL 的系统错误框）。");
  console.error("   它由 tauri build / cargo build --release 生成在 target\\release\\ 里。");
  process.exit(1);
}

/** 校验 exe 里**真的嵌了前端产物**。
 *
 *  Tauri 只在开了 `tauri/custom-protocol` feature 时才把 dist 嵌进二进制：
 *  `tauri build` 自己会开，但裸 `cargo build --release` **不会** —— 后者出来的 exe
 *  会去找 tauri.conf.json 的 devUrl，结果是**空白窗口**（进程活着、WebView2 各组件都起、
 *  但页面根本没加载，logs 一行都没有）。从外面看跟"卡在加载器"几乎一样，极难定位，
 *  所以这里直接检查资产表的 key（tauri-codegen 会把每个产物的路径作为明文存进二进制）。 */
function checkEmbeddedFrontend(exePath, distDir) {
  const haystack = readFileSync(exePath).toString("latin1");
  const assetsDir = path.join(distDir, "assets");
  const needles = existsSync(assetsDir)
    ? readdirSync(assetsDir).map((n) => `assets/${n}`)
    : [];
  const missing = needles.filter((n) => !haystack.includes(n));
  return { total: needles.length, missing };
}

const embed = checkEmbeddedFrontend(EXE_SRC, DIST);
if (embed.total === 0 || embed.missing.length === embed.total) {
  console.error("!! exe 里**没有前端产物** —— 它是个会开空白窗口的空壳。");
  console.error("   原因：构建时没启用 tauri/custom-protocol feature。");
  console.error("   正确做法：");
  console.error("     npm run app:build    (= tauri build，自己会开这个 feature)");
  console.error("     npm run app:exe      (= cargo build --release --features custom-protocol)");
  console.error("   ✗ 不要用裸 `cargo build --release`。");
  process.exit(1);
}
if (embed.missing.length > 0) {
  console.warn(`   warning: exe 里缺少 ${embed.missing.length}/${embed.total} 个前端产物，可能嵌的是旧的 dist`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

copyFileSync(EXE_SRC, path.join(OUT, "voxelengine-tauri.exe"));
copyFileSync(LOADER_SRC, path.join(OUT, "WebView2Loader.dll"));

// 便携数据目录：Rust 侧 game_root() 在 release 下就是找 exe 旁边的 game\
for (const d of GAME_DIRS) mkdirSync(path.join(OUT, "game", d), { recursive: true });

function installPack(sampleName, targetDir) {
  const src = path.join(PACKS, sampleName);
  if (!existsSync(src)) return null;
  cpSync(src, path.join(OUT, "game", targetDir, sampleName), { recursive: true });
  return `${targetDir}\\${sampleName}`;
}

const installed = [];
if (withPacks) {
  for (const [sample, dir] of [
    [SAMPLE_MOD, "mods"],
    [SAMPLE_RP, "resourcepacks"],
  ]) {
    const r = installPack(sample, dir);
    if (r) installed.push(r);
  }
}

const readme = `VoxelEngine (Tauri v2 / WebView2)

启动：双击 voxelengine-tauri.exe
退出：游戏里 ESC -> main.quit，或直接关窗口
全屏：设置面板里的窗口模式

这个目录是自包含的：前端产物已经编进 exe，不需要 Node，也不需要 dev server。
**WebView2Loader.dll 必须留在这个目录里** —— 删了会弹
"找不到 WebView2Loader.dll" 的系统错误框，程序起不来。

数据都在旁边的 game\\ 里：
  game\\config\\settings.json      设置（语言/字体/UI 缩放/按键/窗口模式/FPS 上限）
  game\\config\\vsync.json         GPU vsync 开关（改完重启生效）
  game\\config\\settings.bad.json  读不动的设置文件的备份
  game\\logs\\debug.log            引擎日志（启动有问题先看这个）
  game\\logs\\renderer.log         console.error / warn
  game\\resourcepacks\\            资源包（文件夹或 .zip，放进去重启即生效）
  game\\mods\\                     方块 mod（assets/<ns>/data/blocks.json + 贴图）
  game\\saves\\

环境变量：VOXEL_GAME_ROOT 可以强制指定数据根目录（排查问题用）。
`;

writeFileSync(path.join(OUT, "启动说明.txt"), readme, "utf8");

function walk(dir, base = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, size: statSync(full).size });
  }
  return out;
}

const files = walk(OUT);
const total = files.reduce((a, f) => a + f.size, 0);
console.log(`portable -> ${OUT}`);
console.log(`  voxelengine-tauri.exe  ${Math.round(statSync(EXE_SRC).size / 1024)} KB`);
console.log(`  WebView2Loader.dll     ${Math.round(statSync(LOADER_SRC).size / 1024)} KB  (必须有)`);
if (installed.length) console.log(`  game\\ 里装了示例包: ${installed.join(", ")}`);
else console.log("  game\\ 里没有资源包（plan A：资源完全外置）");
console.log(`  ${files.length} 个文件，共 ${(total / 1024 / 1024).toFixed(1)} MB`);
