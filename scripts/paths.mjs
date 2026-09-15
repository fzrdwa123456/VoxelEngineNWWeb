// ===== Single source of truth for the build chain: the NW.js identity + every path =====
// Why this file exists: the NW.js version and its distribution directory name used to be
// written in three places (scripts/get-nw.mjs, scripts/rearrange.mjs, README.md) and they
// drifted apart — the README pointed at an "nwjs-sdk-..." directory that get-nw.mjs never
// downloads. Every script now imports the value from here, so a version bump is a one-line
// change and no two files can disagree again.
//
// All paths resolve from THIS file's own URL, never from process.cwd(), so every script
// behaves identically no matter which directory it is launched from.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** NW.js release: version + distribution. `nwjs-v<version>-win-x64` is the NORMAL build
 *  (no DevTools / SDK tools) — deliberately NOT the "sdk" flavor. */
export const NW_VERSION = "0.115.0";
export const NW_DIST_NAME = `nwjs-v${NW_VERSION}-win-x64`;
export const NW_EXE_NAME = "nw.exe";

/** Repository root = the directory containing scripts/ (and package.json) */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ===== NW.js download target (scripts/get-nw.mjs) =====
export const NW_DIR = path.join(ROOT, "nwjs");
export const NW_DIST = path.join(NW_DIR, NW_DIST_NAME);
export const NW_EXE = path.join(NW_DIST, NW_EXE_NAME);
export const NW_ZIP = path.join(NW_DIR, `${NW_DIST_NAME}.zip`);

// ===== Build outputs =====
/** vite output (the game itself) */
export const DIST = path.join(ROOT, "dist");
/** The portable release directory: launcher.exe + game\ */
export const RELEASE = path.join(ROOT, "release", "VoxelEngineNWWeb");
export const GAME = path.join(RELEASE, "game");
/** NW.js runtime + built game + manifest (rearrange.mjs assembles this) */
export const CORE = path.join(GAME, "core");
/** NW.js manifest source; only package.json is copied into CORE (NOT app/index.html — that is a standalone self-check page) */
export const APP_DIR = path.join(ROOT, "app");
export const APP_MANIFEST = path.join(APP_DIR, "package.json");

export const NODE_MODULES = path.join(ROOT, "node_modules");
export const VITE_BIN = path.join(NODE_MODULES, "vite", "bin", "vite.js");
export const TSC_BIN = path.join(NODE_MODULES, "typescript", "bin", "tsc");

// ===== C launcher (gcc) =====
export const LAUNCHER_C = path.join(ROOT, "launcher", "launcher.c");
export const LAUNCHER_EXE = path.join(RELEASE, "launcher.exe");

// ===== Rust raw-input native plugin (optional: the game degrades gracefully without it) =====
export const RAWINPUT_DIR = path.join(ROOT, "rawinput");
export const RAWINPUT_CARGO_CONFIG = path.join(RAWINPUT_DIR, ".cargo", "config.toml");
/** Build inputs in rawinput\lib\ (git-ignored; must be prepared on a fresh clone — see build-all.mjs) */
export const RAWINPUT_LIB = path.join(RAWINPUT_DIR, "lib");
export const RAWINPUT_LIB_DLL = path.join(RAWINPUT_LIB, "libnode.dll");
export const RAWINPUT_LIB_IMPLIB = path.join(RAWINPUT_LIB, "libnode.dll.a");
/** cargo build --release artifact, copied into game\core\ by rearrange.mjs */
export const RAWINPUT_NODE = path.join(RAWINPUT_DIR, "target", "release", "rawinput.node");
