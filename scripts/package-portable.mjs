// The portable release directory: a folder that runs by double-clicking it.
//
// ⚠️ **WebView2Loader.dll MUST sit next to the exe.**
// Without it Windows gives you no window at all, only a
//   "voxelengine-tauri.exe - System Error: cannot run because WebView2Loader.dll was not found"
// system error box — and **csrss.exe** draws that box, so killing the app process does not dismiss it
// either; the symptom then reads as a hang: "process alive, 0 CPU, 2 threads, no window, not one log
// line".
// (This one was actually hit: `tauri build` leaves WebView2Loader.dll in target\release\, so copying
//   only the exe by hand misses it.)
//
// Usage:
//   node scripts/package-portable.mjs              install the sample packs in the repo (the default)
//   node scripts/package-portable.mjs --no-packs   install no sample packs (the original's plan A: no bundles)
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
  console.error(`release exe not found: ${EXE_SRC}`);
  console.error("Build it first: npm run app:build   (or npm run app:exe)");
  process.exit(1);
}
if (!existsSync(LOADER_SRC)) {
  console.error(`!! WebView2Loader.dll not found (${LOADER_SRC})`);
  console.error("   Without it the exe in the release directory will not start (a missing-DLL system error box).");
  console.error("   tauri build / cargo build --release produce it under target\\release\\.");
  process.exit(1);
}

/** Verify that the exe **really has the frontend output embedded**.
 *
 *  Tauri only embeds dist into the binary when the `tauri/custom-protocol` feature is on:
 *  `tauri build` enables it, but a bare `cargo build --release` **does not** — that exe looks for
 *  tauri.conf.json's devUrl and gives a **blank window** (process alive, every WebView2 component
 *  up, but the page never loads and logs have not one line). From outside it looks nearly like
 *  "stuck in the loader", and it is very hard to pin down, so this checks the asset table's keys
 *  directly (tauri-codegen stores each output's path as plain text in the binary). */
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
  console.error("!! the exe has **NO frontend output** — it is an empty shell that opens a blank window.");
  console.error("   Cause: the build did not enable the tauri/custom-protocol feature.");
  console.error("   Correct ways to build it:");
  console.error("     npm run app:build    (= tauri build, enables the feature itself)");
  console.error("     npm run app:exe      (= cargo build --release --features custom-protocol)");
  console.error("   ✗ Do NOT use a bare `cargo build --release`.");
  process.exit(1);
}
if (embed.missing.length > 0) {
  console.warn(`   warning: the exe is missing ${embed.missing.length}/${embed.total} frontend assets; it may embed a stale dist`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

copyFileSync(EXE_SRC, path.join(OUT, "voxelengine-tauri.exe"));
copyFileSync(LOADER_SRC, path.join(OUT, "WebView2Loader.dll"));

// The plugin TOGGLE scripts (tools\*.bat) ride along: they are what a tester double-clicks to turn one of the
// optional surfaces off (they write game\resourcepacks\<pack>\plugins.json) or to restore the default list.
// They are COPIED here rather than kept in release\ because this script REBUILDS that directory — the first
// time they existed only there, one repackage silently deleted them.
const TOOLS = path.join(ROOT, "tools");
let toggleScripts = 0;
if (existsSync(TOOLS)) {
  for (const entry of readdirSync(TOOLS, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".bat")) continue;
    copyFileSync(path.join(TOOLS, entry.name), path.join(OUT, entry.name));
    toggleScripts++;
  }
}

// The portable data directory: in a release build the Rust side's game_root() looks for game\ beside the exe
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

Start:  double-click voxelengine-tauri.exe
Quit:   in game ESC -> main.quit, or just close the window
Fullscreen: the window mode entry in the settings panel

This directory is self-contained: the frontend output is compiled into the exe, so it needs
neither Node nor a dev server.
**WebView2Loader.dll must stay in this directory** — delete it and the program refuses to start
with a "WebView2Loader.dll was not found" system error box.

The data lives in the game\\ directory next to it:
  game\\config\\settings.json      settings (language/font/UI scale/keybinds/window mode/FPS cap)
  game\\config\\vsync.json         GPU vsync switch (restart to apply)
  game\\config\\settings.bad.json  backup of an unreadable settings file
  game\\logs\\debug.log            engine log (look here first when the startup misbehaves)
  game\\logs\\renderer.log         console.error / warn
  game\\resourcepacks\\            resource packs (folder or .zip; restart to apply)
  game\\mods\\                     block mods (assets/<ns>/data/blocks.json + textures)
  game\\saves\\

Environment variable: VOXEL_GAME_ROOT forces the data root (handy when diagnosing).

Plugin toggles (double-click one, then RESTART the game — the manifest is read at boot):
  plugins-status.bat               show the current plugins.json and the PLUGIN lines of the log
  plugins-default.bat              restore the default list (deletes plugins.json)
  plugins-no-ui-debug.bat          off: the F3 debug panel and the F3+F4 mode chord
  plugins-no-ui-toast.bat          off: every HUD message (including the F8/F9/F10 feedback)
  plugins-no-ui-keybind.bat        off: the key bind page in both menus
  plugins-no-ui-inventory.bat      off: the hotbar element and the backpack
  plugins-no-optional-surfaces.bat off: all FOUR optional surfaces at once
  lang-demo.bat                    write a FOURTH language (fr) into the sample pack, then restart
While the game runs, F8 / F10 / F11 / F9 install or uninstall those same surfaces live (the result appears as a
HUD message and in game\\logs\\debug.log).
`;

writeFileSync(path.join(OUT, "README.txt"), readme, "utf8");

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
console.log(`  WebView2Loader.dll     ${Math.round(statSync(LOADER_SRC).size / 1024)} KB  (required)`);
if (installed.length) console.log(`  sample packs installed under game\\: ${installed.join(", ")}`);
else console.log("  no resource packs under game\\ (plan A: assets are fully external)");
if (toggleScripts) console.log(`  ${toggleScripts} plugin-toggle .bat scripts (plugins-default / plugins-no-ui-*)`);
console.log(`  ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB`);
