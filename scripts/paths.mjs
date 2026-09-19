// ===== Single source of truth for the build chain: paths =====
// (原版的 paths.mjs 里还有 NW.js 的版本号与分发目录名 —— Tauri 版没有这些东西了，
//  运行时由 tauri build 自己带，所以这里只剩路径。)
//
// All paths resolve from THIS file's own URL, never from process.cwd(), so every script
// behaves identically no matter which directory it is launched from.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root = the directory containing scripts/ (and package.json) */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ===== Frontend build =====
/** vite output (the game itself) — tauri.conf.json 的 frontendDist 指向它 */
export const DIST = path.join(ROOT, "dist");
export const NODE_MODULES = path.join(ROOT, "node_modules");
export const VITE_BIN = path.join(NODE_MODULES, "vite", "bin", "vite.js");
export const TSC_BIN = path.join(NODE_MODULES, "typescript", "bin", "tsc");

// ===== Tauri shell =====
export const SRC_TAURI = path.join(ROOT, "src-tauri");
export const CARGO_TOML = path.join(SRC_TAURI, "Cargo.toml");
export const TAURI_CONF = path.join(SRC_TAURI, "tauri.conf.json");
export const CARGO_TARGET = path.join(SRC_TAURI, "target");

// ===== 开发期的游戏数据根目录 =====
// Rust 侧 src/game.rs 的规则：debug 构建下 exe 在 src-tauri\target\debug\，
// 往上数三级就是仓库根，所以开发时 game\ 就在仓库根下 —— 与这里一致。
export const GAME = path.join(ROOT, "game");
export const GAME_DIRS = ["logs", "saves", "config", "mods", "resourcepacks"];

/** 示例资源包 / mod（原版叫 packs\，保持同名） */
export const PACKS = path.join(ROOT, "packs");
/** 这两份是仓库里自带的示例内容，装包时按 MC 布局放到对应目录 */
export const SAMPLE_MOD = "VoxelEngineNWWebmod";
export const SAMPLE_RP = "VoxelEngineNWWebrp";
