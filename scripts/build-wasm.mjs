// ===== Build the WASM collision kernel: cargo → wasm-bindgen → wasm-opt =====
//
//   1. `cargo build --release --target wasm32-unknown-unknown` produces the raw .wasm;
//   2. `wasm-bindgen --target web` generates the ESM glue + `.d.ts` (and re-emits the .wasm);
//   3. `wasm-opt -Oz` (Binaryen) optimises that .wasm for size.
//
// Output goes into `src/host/browser/wasm/`, so Vite treats the glue as a normal module and emits the .wasm
// next to it; Tauri then embeds the built assets. The directory is generated and gitignored.
//
// Tooling (one-time):
//   rustup target add wasm32-unknown-unknown
//   cargo install wasm-bindgen-cli --version <the version in wasm/collision/Cargo.toml>
//   npm i -D binaryen            (provides node_modules/.bin/wasm-opt)
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = path.join(ROOT, "wasm", "collision");
const TARGET = "wasm32-unknown-unknown";
// Cargo insists on writing `Cargo.lock` next to the manifest, and this repository's `wasm/` tree is not
// writable for spawned processes here. So the crate is COPIED into the workspace cache and built there; the
// source of truth stays in `wasm/collision`, and the artifact is copied back out by wasm-bindgen.
const BUILD_SRC = path.join(ROOT, "node_modules", ".cache", "wasm-collision-src");
const MANIFEST = path.join(BUILD_SRC, "Cargo.toml");
const TARGET_DIR = path.join(ROOT, "node_modules", ".cache", "wasm-collision-target");
const ARTIFACT = path.join(TARGET_DIR, TARGET, "release", "voxel_collision_wasm.wasm");
const OUT_DIR = path.join(ROOT, "src", "host", "browser", "wasm");
const OUT_WASM = path.join(OUT_DIR, "collision_bg.wasm");

function fail(message) {
  console.error(`\nbuild-wasm: ${message}\n`);
  process.exit(1);
}

// 0. copy the crate into the cache (source of truth stays in wasm/collision)
rmSync(BUILD_SRC, { recursive: true, force: true });
mkdirSync(BUILD_SRC, { recursive: true });
cpSync(path.join(CRATE, "Cargo.toml"), MANIFEST);
cpSync(path.join(CRATE, "src"), path.join(BUILD_SRC, "src"), { recursive: true });
// A lock file is required for reproducible dependency versions; an empty one is not valid, so it is not
// pre-created — cargo writes it in the cache on the first build.
writeFileSync(path.join(BUILD_SRC, ".gitignore"), "target/\nCargo.lock\n");

// 1. cargo
try {
  execFileSync("cargo", ["build", "--release", "--target", TARGET, "--manifest-path", MANIFEST], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: TARGET_DIR },
  });
} catch {
  fail(
    "cargo failed. If the target is missing, run:\n  rustup target add wasm32-unknown-unknown",
  );
}
if (!existsSync(ARTIFACT)) fail(`cargo did not produce ${ARTIFACT}`);

// 2. wasm-bindgen
mkdirSync(OUT_DIR, { recursive: true });
try {
  execFileSync(
    "wasm-bindgen",
    ["--target", "web", "--out-dir", OUT_DIR, "--out-name", "collision", ARTIFACT],
    { cwd: ROOT, stdio: "inherit" },
  );
} catch {
  fail(
    "wasm-bindgen failed. Install the CLI matching wasm/collision/Cargo.toml:\n" +
      "  cargo install wasm-bindgen-cli --version 0.2.130 --locked",
  );
}
if (!existsSync(OUT_WASM)) fail(`wasm-bindgen did not produce ${OUT_WASM}`);

// 3. wasm-opt (Binaryen, from the npm `binaryen` devDependency)
const wasmOpt =
  process.platform === "win32"
    ? path.join(ROOT, "node_modules", ".bin", "wasm-opt.cmd")
    : path.join(ROOT, "node_modules", ".bin", "wasm-opt");
if (!existsSync(wasmOpt)) {
  fail("wasm-opt is missing. Install Binaryen:\n  npm i -D binaryen");
}
// `--all-features` makes Binaryen accept (and emit) proposals V8/Node do not load yet; this is the set
// wasm-bindgen's own output uses.
const WASM_FEATURES = [
  "--enable-bulk-memory",
  "--enable-bulk-memory-opt",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
  "--enable-mutable-globals",
  "--enable-reference-types",
  "--enable-multivalue",
];
const optimised = spawnSync(wasmOpt, ["-Oz", ...WASM_FEATURES, "-o", OUT_WASM, OUT_WASM], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (optimised.status !== 0) fail("wasm-opt failed");

const size = readdirSync(OUT_DIR)
  .filter((name) => name.startsWith("collision"))
  .map((name) => `  ${name}`)
  .join("\n");
console.log(`build-wasm: ${path.relative(ROOT, OUT_DIR)}\n${size}`);
