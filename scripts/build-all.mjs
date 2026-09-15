// ===== One-command build: preflight -> orchestrate -> report =====
// `npm run build` is deliberately left untouched (it is the documented, minimal chain). This
// script adds the checks that `npm run build` silently assumes, does the preparations that are
// safe to automate, and — most importantly — tells you when the result is INCOMPLETE instead of
// printing a green success. It exists because a build that "succeeds" while the raw-input
// plugin is missing is the single easiest way to waste an hour.
//
// Exit codes:
//   0  every required step succeeded (may still be INCOMPLETE — see below)
//   1  a required step failed
// A missing OPTIONAL piece (the raw-input native plugin, or its import library) does NOT fail
// the build: the game is designed to run without it. It is reported as `RESULT: INCOMPLETE`,
// which is greppable, so a script or an agent can branch on it without parsing prose.
//
// Usage:
//   node scripts/build-all.mjs               full build
//   node scripts/build-all.mjs --check-only  reports state ONLY: never writes a file, never builds
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  CORE,
  LAUNCHER_C,
  LAUNCHER_EXE,
  NODE_MODULES,
  NW_DIST,
  NW_EXE,
  RAWINPUT_CARGO_CONFIG,
  RAWINPUT_DIR,
  RAWINPUT_LIB,
  RAWINPUT_LIB_DLL,
  RAWINPUT_LIB_IMPLIB,
  RAWINPUT_NODE,
  RELEASE,
  ROOT,
  TSC_BIN,
  VITE_BIN,
} from "./paths.mjs";

const CHECK_ONLY = process.argv.includes("--check-only");

const NODE = process.execPath;
const GET_NW = path.join(ROOT, "scripts", "get-nw.mjs");
const REARRANGE = path.join(ROOT, "scripts", "rearrange.mjs");

/** Things that make the result INCOMPLETE (the build itself still succeeded) */
const incomplete = [];
let failed = false;

const ok = (m) => console.log(`  [ok]    ${m}`);
const note = (m) => console.log(`  [note]  ${m}`);
const warn = (m) => {
  console.log(`  [warn]  ${m}`);
  incomplete.push(m);
};
const fail = (m) => {
  console.log(`  [FAIL]  ${m}`);
  failed = true;
};

/** Is an executable reachable? (`where` first: some tools reject --version with a non-zero exit) */
function hasCommand(name) {
  try {
    execFileSync("where", [name], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync(name, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

/** Run one build step; a non-zero exit or a spawn error is a hard failure.
 *  stdio is always "inherit" so output streams live and no child pipes are involved. */
function run(label, cmd, args, cwd = ROOT) {
  console.log(`\n>>> ${label}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.error) {
    fail(`${label} — ${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    fail(`${label} — exited ${r.status}`);
    console.log(`      command: ${cmd} ${args.join(" ")}`);
    return false;
  }
  ok(label);
  return true;
}

function bytes(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** The LIBNODE_PATH that rawinput\.cargo\config.toml feeds to napi-build (it is machine-specific
 *  and therefore the most likely reason a fresh clone cannot compile the plugin). */
function readLibnodePath() {
  if (!existsSync(RAWINPUT_CARGO_CONFIG)) return null;
  const text = readFileSync(RAWINPUT_CARGO_CONFIG, "utf8");
  const m = /LIBNODE_PATH\s*=\s*\{[^}]*?value\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return null;
  return m[1].replace(/\\\\/g, "\\"); // TOML basic string: "\\" is one backslash
}

// ===== 1. Preflight: everything the build assumes, checked out loud =====
function preflight() {
  console.log("=== preflight ===");

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok(`node ${process.versions.node}`);
  else if (major >= 20) note(`node ${process.versions.node} (README asks for >= 22; vite 8 needs >= 20.19)`);
  else fail(`node ${process.versions.node} is too old — vite 8 needs >= 20.19, README asks for >= 22`);

  if (existsSync(NODE_MODULES)) ok("node_modules present");
  else fail("node_modules missing — run `npm install` first");

  if (hasCommand("gcc")) ok("gcc on PATH (needed for launcher.exe)");
  else fail("gcc not on PATH — install MinGW-w64 and add its bin\\ to PATH");

  if (existsSync(NW_EXE)) {
    ok(`NW.js runtime present (${path.relative(ROOT, NW_EXE)})`);
  } else if (CHECK_ONLY) {
    warn(`NW.js runtime missing (${path.relative(ROOT, NW_EXE)}) — a real build would download it via scripts/get-nw.mjs`);
  } else {
    // Not a warning: it is a normal first-run state and this script can fix it. Only a FAILED
    // download is a hard failure (nothing downstream works without the runtime).
    note(`NW.js runtime missing — downloading it now (scripts/get-nw.mjs)`);
    if (!run("get-nw (download NW.js)", NODE, [GET_NW])) {
      fail("NW.js download failed — nothing else can proceed without the runtime");
    } else if (!existsSync(NW_EXE)) {
      fail("get-nw reported success but nw.exe is still missing");
    }
  }
}

// ===== 2. Raw-input native plugin (optional — the game degrades gracefully without it) =====
function preparePlugin() {
  console.log("\n=== raw-input native plugin (optional: the game runs without it) ===");
  // Under --check-only this section only REPORTS state: no directory, no copy, no cargo run.
  const fix = !CHECK_ONLY;

  if (fix && !existsSync(RAWINPUT_LIB)) mkdirSync(RAWINPUT_LIB, { recursive: true });

  // Safe to automate: libnode.dll is a byte copy of the NW.js runtime's own node.dll.
  if (existsSync(RAWINPUT_LIB_DLL)) {
    ok("rawinput\\lib\\libnode.dll present");
  } else if (!fix) {
    warn("rawinput\\lib\\libnode.dll missing — a real build would copy it from the NW.js runtime");
  } else {
    const src = path.join(NW_DIST, "node.dll");
    if (existsSync(src)) {
      copyFileSync(src, RAWINPUT_LIB_DLL);
      ok(`rawinput\\lib\\libnode.dll copied from ${path.relative(ROOT, src)}`);
    } else {
      warn(`rawinput\\lib\\libnode.dll missing and ${path.relative(ROOT, src)} not found — run \`npm run get-nw\` first`);
    }
  }

  // NOT automatised on purpose: the import library's recorded DLL name is load-bearing
  // (the .node module resolves its symbols from node.dll next to core.exe), and getting it
  // wrong yields a plugin that links but fails at runtime. Reported with the exact recipe.
  if (existsSync(RAWINPUT_LIB_IMPLIB)) {
    ok("rawinput\\lib\\libnode.dll.a present");
  } else {
    warn("rawinput\\lib\\libnode.dll.a (import library) is missing — the ONE step that must be done by hand:");
    console.log("        cd rawinput\\lib");
    console.log("        gendef libnode.dll");
    console.log("        dlltool -d libnode.def -D libnode.dll -l libnode.dll.a");
    console.log("        (README documents the same recipe; rawinput\\lib\\ is git-ignored on purpose)");
  }

  const libPath = readLibnodePath();
  if (libPath === null) {
    note("rawinput\\.cargo\\config.toml has no LIBNODE_PATH — cargo cannot locate libnode (needed only to rebuild the plugin)");
  } else if (existsSync(libPath)) {
    ok(`LIBNODE_PATH -> ${libPath}`);
  } else {
    warn(`LIBNODE_PATH points at a directory that does not exist on this machine: ${libPath}`);
    console.log("        edit rawinput\\.cargo\\config.toml (it is written as an absolute path on purpose)");
  }

  if (existsSync(RAWINPUT_NODE)) {
    ok("rawinput.node built (kept as-is; delete it to force a rebuild)");
    return;
  }
  if (!fix) {
    warn("rawinput.node is missing — a real build would run `cargo build --release` here");
    return;
  }
  if (!existsSync(RAWINPUT_LIB_IMPLIB)) {
    warn("skipped building rawinput.node (no import library) — the raw mouse fallback will be unavailable");
    return;
  }
  if (!hasCommand("cargo")) {
    warn("cargo not on PATH — skipped building rawinput.node; the raw mouse fallback will be unavailable");
    return;
  }
  if (!run("cargo build --release (rawinput)", "cargo", ["build", "--release"], RAWINPUT_DIR)) {
    warn("cargo build failed — the raw mouse fallback will be unavailable");
    return;
  }
  if (existsSync(RAWINPUT_NODE)) ok("rawinput.node built");
  else warn("cargo reported success but rawinput.node is still missing");
}

// ===== 3. The build itself (same steps as `npm run build`) =====
function build() {
  console.log("\n=== build ===");
  if (!run("tsc (type gate only: tsconfig has noEmit, vite does the emitting)", NODE, [TSC_BIN])) return false;
  if (!run("vite build", NODE, [VITE_BIN, "build"])) return false;

  console.log("\n  ! rearrange.mjs CLEARS game\\mods and game\\resourcepacks, then rebuilds game\\core from scratch");
  note("re-copy mods/resource packs from packs\\ into the release after every build");
  if (!run("rearrange (assemble the portable release)", NODE, [REARRANGE])) return false;

  if (!run("gcc (launcher.exe)", "gcc", ["-O2", "-municode", "-mwindows", "-o", LAUNCHER_EXE, LAUNCHER_C])) return false;
  return true;
}

// ===== 4. Report: a greppable verdict, never a bare "done" =====
function report() {
  console.log("\n=== BUILD REPORT ===");
  if (CHECK_ONLY) {
    note("--check-only: artifact status not inspected (nothing was built)");
  } else {
    const artifacts = [
      ["launcher.exe", LAUNCHER_EXE],
      ["game\\core\\core.exe", path.join(CORE, "core.exe")],
      ["game\\core\\index.html", path.join(CORE, "index.html")],
      ["game\\core\\rawinput.node", path.join(CORE, "rawinput.node")],
    ];
    for (const [label, p] of artifacts) {
      const n = bytes(p);
      console.log(n > 0 ? `  [ok]    ${label} (${n.toLocaleString()} B)` : `  [MISS]  ${label}`);
    }
  }

  if (failed) {
    console.log("\nRESULT: FAILED (a required step failed — see [FAIL] above)");
  } else if (CHECK_ONLY) {
    console.log(`\nRESULT: CHECK ONLY (nothing was built)${incomplete.length > 0 ? " — not ready:" : ""}`);
    for (const m of incomplete) console.log(`  - ${m}`);
  } else if (incomplete.length > 0) {
    console.log("\nRESULT: INCOMPLETE");
    for (const m of incomplete) console.log(`  - ${m}`);
  } else {
    console.log("\nRESULT: OK");
  }

  if (!CHECK_ONLY && !failed) console.log(`\nRun: ${path.join(RELEASE, "launcher.exe")}`);
}

console.log("===== build-all: preflight -> build -> report =====");
preflight();
if (!failed) preparePlugin();
if (!CHECK_ONLY && !failed) build();
report();
process.exit(failed ? 1 : 0);
