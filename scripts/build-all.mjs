// The local verification gate: type check -> ECS gate -> frontend output (optionally a cargo check).
//
// The original build-all.mjs also checked that the NW.js runtime was there and that rawinput's
// libnode.dll had been staged — the Tauri port has neither (raw input is an ordinary module inside
// src-tauri), so these three steps are all that is left.
//
//   node scripts/build-all.mjs --check-only   static checks only (produces no dist)
//   node scripts/build-all.mjs                static checks + vite build
//   node scripts/build-all.mjs --cargo        also runs cargo check (may fail on the toolchain, see README)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { CARGO_TOML, ROOT, SRC_TAURI, TSC_BIN, VITE_BIN } from "./paths.mjs";

const checkOnly = process.argv.includes("--check-only");
const withCargo = process.argv.includes("--cargo");

let failed = false;

function step(label, cmd, args, cwd = ROOT) {
  process.stdout.write(`\n>> ${label}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  if (r.status !== 0) {
    console.error(`!! ${label} FAILED (exit ${r.status})`);
    failed = true;
  }
  return r.status === 0;
}

step("tsc --noEmit (strict, zero errors)", process.execPath, [TSC_BIN, "--noEmit", "-p", "tsconfig.json"]);
step("check:ecs (ECS gate, ends with RESULT: OK)", process.execPath, [path.join(ROOT, "scripts", "check-ecs.mjs")]);

if (!checkOnly) {
  step("vite build", process.execPath, [VITE_BIN, "build"]);
}

if (withCargo) {
  if (!existsSync(CARGO_TOML)) {
    console.error("!! src-tauri/Cargo.toml is missing");
    failed = true;
  } else {
    const ok = step("cargo check (the Tauri shell)", "cargo", ["check"], SRC_TAURI);
    if (!ok) {
      console.error(
        "   Tauri needs MSVC on Windows (Visual Studio's \"Desktop development with C++\" workload).\n" +
          "   This machine only has the mingw toolchain, so this step will most likely fail — the\n" +
          "   frontend output is unaffected either way.",
      );
    }
  }
}

console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: OK");
process.exit(failed ? 1 : 0);
