// Development-time "create the directories + install the sample packs".
//
// The original rearrange.mjs was NW.js's **packager** (copy the nwjs runtime + dist + manifest, then
// rename it with rcedit). The Tauri port hands all of that to `tauri build` (frontend output, icons,
// version info, the NSIS installer), so the only job left here is the "development data directory" —
// which made this script simpler rather than harder.
//
// Usage:
//   node scripts/rearrange.mjs               create directories only (original's plan A: nothing bundled)
//   node scripts/rearrange.mjs --with-packs  also install the two sample packs under packs\ (MC layout)
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";

import { GAME, GAME_DIRS, PACKS, SAMPLE_MOD, SAMPLE_RP } from "./paths.mjs";

const withPacks = process.argv.includes("--with-packs");

// The data root plus the fixed subdirectories — the Rust side's game.rs `ensure_dirs` creates them too,
// so this only builds them early, where they are easy to see.
mkdirSync(GAME, { recursive: true });
for (const d of GAME_DIRS) mkdirSync(path.join(GAME, d), { recursive: true });
console.log(`game\\ ready -> ${GAME}`);

if (!withPacks) {
  console.log("plan A: nothing bundled (add --with-packs to install the sample packs)");
  process.exit(0);
}

/** Copy one sample pack into its target directory (delete first, so re-running is safe) */
function installPack(sampleName, targetDir) {
  const src = path.join(PACKS, sampleName);
  if (!existsSync(src)) {
    console.warn(`warning: ${path.relative(process.cwd(), src)} does not exist, skipping`);
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

console.log("\nSample content is in place. Start with: npm run app:dev");
