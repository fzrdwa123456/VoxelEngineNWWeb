// ===== Single source of truth for the build chain: paths =====
// (The original paths.mjs also carried the NW.js version and the distribution directory name — the
//  Tauri port has neither: `tauri build` brings its own runtime, so only paths are left here.)
//
// All paths resolve from THIS file's own URL, never from process.cwd(), so every script
// behaves identically no matter which directory it is launched from.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root = the directory containing scripts/ (and package.json) */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ===== Frontend build =====
/** vite output (the game itself) — this is what tauri.conf.json's `frontendDist` points at */
export const DIST = path.join(ROOT, "dist");
export const NODE_MODULES = path.join(ROOT, "node_modules");
export const VITE_BIN = path.join(NODE_MODULES, "vite", "bin", "vite.js");
export const TSC_BIN = path.join(NODE_MODULES, "typescript", "bin", "tsc");

// ===== Tauri shell =====
export const SRC_TAURI = path.join(ROOT, "src-tauri");
export const CARGO_TOML = path.join(SRC_TAURI, "Cargo.toml");
export const TAURI_CONF = path.join(SRC_TAURI, "tauri.conf.json");
export const CARGO_TARGET = path.join(SRC_TAURI, "target");

// ===== Game data root during development =====
// The rule in the Rust side's `src/game.rs`: in a debug build the exe sits in src-tauri\target\debug\,
// so the repository root is three levels up and development's `game\` is there too — the same as here.
export const GAME = path.join(ROOT, "game");
export const GAME_DIRS = ["logs", "saves", "config", "mods", "resourcepacks"];

/** Sample resource packs / mods (packs\ in the original — the name is kept) */
export const PACKS = path.join(ROOT, "packs");
/** The two samples shipped in the repo, placed into their matching dirs (MC layout) when installing */
export const SAMPLE_MOD = "VoxelEngineNWWebmod";
export const SAMPLE_RP = "VoxelEngineNWWebrp";
