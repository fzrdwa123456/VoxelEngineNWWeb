// NW.js portable packaging: nwjs cache -> release\VoxelEngineNWWeb\game\core\
// (nw.exe renamed core.exe) + vite dist + manifest, forming the portable directory with launcher.exe
import { existsSync, mkdirSync, copyFileSync, cpSync, readdirSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

const root = path.resolve(".");
const nwDist = path.join(root, "nwjs", "nwjs-v0.115.0-win-x64");
const dist = path.join(root, "dist");
const release = path.join(root, "release", "VoxelEngineNWWeb");
const core = path.join(release, "game", "core");

if (!existsSync(path.join(nwDist, "nw.exe"))) {
    console.error("nwjs not downloaded, run first: npm run get-nw");
  process.exit(1);
}
if (!existsSync(path.join(dist, "index.html"))) {
    console.error("dist not built, run first: tsc && vite build");
  process.exit(1);
}

mkdirSync(release, { recursive: true });
if (existsSync(core)) rmSync(core, { recursive: true, force: true });
mkdirSync(core, { recursive: true });

// The whole NW.js set -> game\core\, nw.exe renamed core.exe
cpSync(nwDist, core, { recursive: true });
renameSync(path.join(core, "nw.exe"), path.join(core, "core.exe"));

// rcedit rename: core process -> VoxelEngine (shown in Task Manager)
const rceditBin = path.join(root, "node_modules", "rcedit", "bin", "rcedit-x64.exe");
const coreExe = path.join(core, "core.exe");
const { execSync } = await import("node:child_process");
execSync(`"${rceditBin}" "${coreExe}" --set-version-string ProductName "VoxelEngine" --set-version-string FileDescription "VoxelEngine" --set-version-string CompanyName "VoxelEngine"`, { stdio: "inherit" });

// vite dist + manifest -> game\core\ (sibling of core.exe; NW.js plain-file mode)
cpSync(dist, core, { recursive: true });
copyFileSync(path.join(root, "app", "package.json"), path.join(core, "package.json"));

// Raw mouse input native plugin (rawinput/ Rust build) -> game\core\rawinput.node
const rawNodeSrc = path.join(root, "rawinput", "target", "release", "rawinput.node");
if (existsSync(rawNodeSrc)) {
  copyFileSync(rawNodeSrc, path.join(core, "rawinput.node"));
} else {
    console.warn("warning: rawinput.node missing (cd rawinput && cargo build --release); the game will have no raw mouse input fallback");
}

// Resource directories (plan A: fully external, no built-in pack)
// - src\assets\ removed; the build no longer produces default.zip / defaultmod.zip
// - Resource packs/block mods are all placed manually by the player:
//     game\resourcepacks\<pack>\  or <pack>.zip   (assets\<ns>\<path> three-layer structure)
//     game\mods\<mod>\       or <mod>.zip    (blocks.json + block\*.png)
// - The directories are cleared and rebuilt at build time (mods/resource packs are rebuildable artifacts, not user data); engine fallbacks keep an empty environment runnable:
//     empty dictionary -> UI shows keys; no blocks -> registry falls back to missing (magenta/black checkerboard platform)
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
console.log("Plan A: no built-in pack (resources/blocks fully external; place them in resourcepacks\\ and mods\\ manually)");

console.log(`Packaging done -> ${release}`);
console.log("  Launch: release/VoxelEngineNWWeb/launcher.exe (core.exe auto-passes --user-data-dir=game\\data)");