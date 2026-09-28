// ===== The process helper the two "one command" build scripts share =====
//
// `build-windows.mjs` and `build-android.mjs` run the same three kinds of child:
//   * the FRONTEND gate (`build-all.mjs`),
//   * `cargo`,
//   * a `.bat` shim (`gradlew.bat`).
//
// A single STRING command line through the shell (rather than an argv array) is deliberate: Node
// deprecates `shell: true` together with an argument list, because it concatenates the arguments
// without escaping them - and the quoting this needs (`C:\Program Files\...`, a repository path with
// spaces, `gradlew.bat`) is exactly what a shell understands. Every caller passes a fixed string, so
// there is no user input to escape.
import { spawnSync } from "node:child_process";
import path from "node:path";

import { ROOT } from "./paths.mjs";

/** The frontend gate: tsc (strict) + the ECS gate + `vite build` -> `dist\`. Exits non-zero if any
 *  step fails, and prints `RESULT: OK` at the end. */
export const BUILD_ALL = path.join(ROOT, "scripts", "build-all.mjs");

/** Run a command line through the shell. Returns whether it succeeded. */
export function runShell(cmdline, { cwd = ROOT, env = process.env, label } = {}) {
  if (label) console.log(`\n>> ${label}`);
  const r = spawnSync(cmdline, { cwd, env, stdio: "inherit", shell: true });
  return r.status === 0;
}

/** Run a program directly (NO shell), capturing its output, so a KNOWN failure can be told apart from
 *  a real one. No shell because the only caller passes `process.execPath`, and a shell would split
 *  `C:\Program Files\nodejs\node.exe` at the space. */
export function runCapture(file, args, { cwd = ROOT, env = process.env } = {}) {
  const r = spawnSync(file, args, { cwd, env, encoding: "utf8" });
  return { ok: r.status === 0, status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** **The frontend step BOTH chains need, and neither may skip silently.**
 *
 *  `tauri-codegen` embeds `dist\` into the binary with `include_bytes!`, so cargo does rebuild when
 *  those files change - but only once they HAVE changed: a chain that skips this step compiles the
 *  PREVIOUS frontend into the exe or the `.so`, and nothing downstream notices.
 *
 *  `npm run app:build` (= `tauri build`) gets it for free, because Tauri runs
 *  `tauri.conf.json`'s `beforeBuildCommand`; a bare `cargo build` and the Android chain do not, which
 *  is why it is step 1 here rather than a documented "remember to run verify first". */
export function buildFrontend(env) {
  return runShell(`"${process.execPath}" "${BUILD_ALL}"`, { env, label: "frontend: tsc + check:ecs + vite build" });
}
