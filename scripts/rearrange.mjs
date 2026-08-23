// NW.js 绿色版打包: nwjs 缓存 -> release\VoxelEngineNWWeb\game\core\
// (nw.exe 改名 core.exe) + vite dist + manifest, 与 launcher.exe 构成绿色目录
import { existsSync, mkdirSync, copyFileSync, cpSync, readdirSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

const root = path.resolve(".");
const nwDist = path.join(root, "nwjs", "nwjs-sdk-v0.115.0-win-x64");
const dist = path.join(root, "dist");
const release = path.join(root, "release", "VoxelEngineNWWeb");
const core = path.join(release, "game", "core");

if (!existsSync(path.join(nwDist, "nw.exe"))) {
  console.error("nwjs 未下载, 先运行: npm run get-nw");
  process.exit(1);
}
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("dist 未构建, 先运行: tsc && vite build");
  process.exit(1);
}

mkdirSync(release, { recursive: true });
if (existsSync(core)) rmSync(core, { recursive: true, force: true });
mkdirSync(core, { recursive: true });

// NW.js 全家 -> game\core\, nw.exe 改名 core.exe
cpSync(nwDist, core, { recursive: true });
renameSync(path.join(core, "nw.exe"), path.join(core, "core.exe"));

// rcedit 改名: 核心进程 -> VoxelEngine (任务管理器显示)
const rceditBin = path.join(root, "node_modules", "rcedit", "bin", "rcedit-x64.exe");
const coreExe = path.join(core, "core.exe");
const { execSync } = await import("node:child_process");
execSync(`"${rceditBin}" "${coreExe}" --set-version-string ProductName "VoxelEngine" --set-version-string FileDescription "VoxelEngine" --set-version-string CompanyName "VoxelEngine"`, { stdio: "inherit" });

// vite dist + manifest -> game\core\ (与 core.exe 同级, NW.js 纯文件模式)
cpSync(dist, core, { recursive: true });
copyFileSync(path.join(root, "app", "package.json"), path.join(core, "package.json"));

// 原始鼠标输入原生插件 (rawinput/ Rust 构建) -> game\core\rawinput.node
const rawNodeSrc = path.join(root, "rawinput", "target", "release", "rawinput.node");
if (existsSync(rawNodeSrc)) {
  copyFileSync(rawNodeSrc, path.join(core, "rawinput.node"));
} else {
  console.warn("警告: rawinput.node 不存在 (cd rawinput && cargo build --release), 游戏将无原始鼠标输入兜底");
}

// 资源目录 (A 方案: 全外部化, 不打内置包)
// - src\assets\ 已移除, 构建不再生成 default.zip / defaultmod.zip
// - 资源包/方块 mod 全部由玩家手动放:
//     game\resourcepacks\<包名>\  或 <包名>.zip   (assets\<ns>\<路径> 三层结构)
//     game\mods\<mod名>\       或 <mod名>.zip    (blocks.json + block\*.png)
// - 目录构建时清空重建 (mod/资源包属用户数据之外的可重建产物); 引擎兜底保证空环境可运行:
//     词典空 -> 界面显示 key; 无方块 -> 注册表兜底 missing (紫黑棋盘格平台)
const rpDir = path.join(release, "game", "resourcepacks");
mkdirSync(rpDir, { recursive: true });
for (const e of readdirSync(rpDir, { withFileTypes: true })) {
  const full = path.join(rpDir, e.name);
  if (e.isDirectory()) rmSync(full, { recursive: true, force: true });
  else if (/\.zip$/i.test(e.name)) rmSync(full, { force: true });
}
const modsOut = path.join(release, "game", "mods");
if (existsSync(modsOut)) rmSync(modsOut, { recursive: true, force: true });
mkdirSync(modsOut, { recursive: true });
console.log("A 方案: 不打内置包 (资源/方块全外部, 玩家手动放 resourcepacks\\ 与 mods\\)");

console.log(`打包完成 -> ${release}`);
console.log("  启动: release/VoxelEngineNWWeb/launcher.exe (core.exe 自动带 --user-data-dir=game\\data)");