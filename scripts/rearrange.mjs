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

// 默认贴图+语言 -> 内置资源包 game\resourcepacks\default.zip (MC 式: 资源封在压缩包里)
const rpDir = path.join(release, "game", "resourcepacks");
mkdirSync(rpDir, { recursive: true });
const entries = {};
const collect = (dir, base) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.join(base, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) collect(full, rel);
    else entries[rel] = readFileSync(full);
  }
};
collect(path.join(root, "src", "assets", "textures"), "");
collect(path.join(root, "src", "assets", "lang"), "lang"); // 语言文件 -> 包内 lang\, i18n.ts 经 resolveBytes 同链读取
writeFileSync(path.join(rpDir, "default.zip"), zipSync(entries, { level: 9 }));

console.log(`打包完成 -> ${release}`);
console.log("  启动: release/VoxelEngineNWWeb/launcher.exe (core.exe 自动带 --user-data-dir=game\\data)");