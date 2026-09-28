// ===== Windows: ONE command from "nothing built" to the portable release in release\ =====
//
// The desktop twin of `build-android.mjs`, and for the same reason: the desktop chain was three
// commands in a specific order (frontend -> cargo -> package) and two of them fail silently-ish when
// run out of order or with a stale `dist\`.
//
//   1. **the frontend gate** - tsc (strict) + the 69-group ECS gate + `vite build` -> `dist\`.
//      Not optional: `tauri-codegen` embeds that directory with `include_bytes!`, so cargo rebuilds
//      when it changes, but a chain that skips this step compiles the PREVIOUS frontend into the exe.
//   2. **cargo**, with the `custom-protocol` feature that does the embedding. A bare `cargo build`
//      produces an exe that looks for `tauri.conf.json`'s devUrl and shows a BLANK WINDOW (process
//      alive, WebView2 up, not one log line) - documented in README and Cargo.toml.
//   3. **package-portable.mjs**, which copies the exe + WebView2Loader.dll + `game\` + the tool
//      scripts into `release\VoxelEngineTauri\` and REFUSES to publish an exe with no frontend inside.
//
// Usage:
//   npm run app:windows                     release exe + release\VoxelEngineTauri\
//   npm run app:windows -- --debug          a DEBUG exe with the frontend embedded - the one that
//                                           runs by double-click (a bare `cargo build` does not).
//                                           Built but not packaged: package-portable only knows the
//                                           release profile.
//   npm run app:windows -- --skip-frontend  trust the existing dist\ (fast re-package)
//   npm run app:windows -- --skip-build     only re-package the exe that is already built
//   npm run app:windows -- --no-packs       ship no sample packs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CARGO_TARGET, ROOT, SRC_TAURI } from "./paths.mjs";
import { buildFrontend, runShell } from "./run.mjs";

const argv = process.argv.slice(2);
const wantDebug = argv.includes("--debug");
const skipFrontend = argv.includes("--skip-frontend");
const skipBuild = argv.includes("--skip-build");
const noPacks = argv.includes("--no-packs");

const profile = wantDebug ? "debug" : "release";
const EXE = path.join(CARGO_TARGET, profile, "voxelengine-tauri.exe");

if (!skipFrontend) {
  if (!buildFrontend(process.env)) {
    console.error("\nFAILED: the frontend gate did not pass, so nothing was built.");
    process.exit(1);
  }
} else {
  console.log("frontend: skipped (--skip-frontend) - the existing dist\\ will be embedded");
  if (!existsSync(path.join(ROOT, "dist", "index.html"))) {
    console.error(`\n${path.join("dist", "index.html")} does not exist: there is nothing to embed.`);
    console.error("Run without --skip-frontend.");
    process.exit(1);
  }
}

if (!skipBuild) {
  const flags = [`--manifest-path "${path.join(SRC_TAURI, "Cargo.toml")}"`, ...(wantDebug ? [] : ["--release"]), "--features custom-protocol"];
  if (!runShell(`cargo build ${flags.join(" ")}`, { label: `cargo build (${profile}, frontend embedded)` })) {
    console.error("\nFAILED: cargo build");
    process.exit(1);
  }
}

if (!existsSync(EXE)) {
  console.error(`\n${EXE} not found - build it first (drop --skip-build).`);
  process.exit(1);
}
console.log(`\nexe  ${EXE}  (${Math.round(statSync(EXE).size / 1024)} KB)`);

if (wantDebug) {
  // A debug build IS runnable here - that is the whole reason to pass --debug - but it stays out of
  // release\: `package-portable.mjs` reads the release profile, and a debug portable folder would be
  // a 10x-larger directory with the same name.
  //
  // `package-portable.mjs` also owns the "is the frontend really inside the exe" check, and this path
  // skips it, so repeat the essential part: an exe without the embedded assets looks for
  // `tauri.conf.json`'s devUrl and shows a BLANK WINDOW - process alive, WebView2 up, no logs, which
  // reads as "stuck in the loader". `tauri-codegen` stores each output path as plain text in the
  // binary, so the asset names are what to look for.
  const assetsDir = path.join(ROOT, "dist", "assets");
  const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const hay = readFileSync(EXE).toString("latin1");
  const missing = assets.filter((n) => !hay.includes(`assets/${n}`));
  if (assets.length === 0) {
    console.warn("warning: dist\\assets is empty, so the embedded frontend cannot be checked");
  } else if (missing.length === assets.length) {
    console.error("\n!! the exe has NO frontend output - it would open a BLANK window.");
    console.error("   Cause: built without the `custom-protocol` feature (see Cargo.toml).");
    process.exit(1);
  } else if (missing.length > 0) {
    console.warn(`warning: the exe is missing ${missing.length}/${assets.length} frontend assets; it may embed a stale dist`);
  }
  console.log("debug build: run this exe directly. Its data root is the repository (game_root() walks");
  console.log("three levels up from target\\debug), and it is NOT copied into release\\.");
  process.exit(0);
}

// The packager owns the release\ directory, its README and the embedded-frontend check.
const packager = path.join(ROOT, "scripts", "package-portable.mjs");
if (!runShell(`"${process.execPath}" "${packager}"${noPacks ? " --no-packs" : ""}`, { label: "package: release\\VoxelEngineTauri" })) {
  console.error("\nFAILED: package-portable.mjs");
  process.exit(1);
}
