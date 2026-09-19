// 本地验证闸门：类型检查 -> ECS 门禁 -> 前端产物（可选再 cargo check）。
//
// 原版 build-all.mjs 还要检查 NW.js 运行时在不在、rawinput 的 libnode.dll 有没有备好 ——
// Tauri 版那些都没有了（原始输入现在是 src-tauri 里的一个普通模块），所以只剩这三步。
//
//   node scripts/build-all.mjs --check-only   只做静态检查（不产出 dist）
//   node scripts/build-all.mjs                静态检查 + vite build
//   node scripts/build-all.mjs --cargo        再跑一次 cargo check（可能因工具链失败，见 README）
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

step("tsc --noEmit（strict，零错误）", process.execPath, [TSC_BIN, "--noEmit", "-p", "tsconfig.json"]);
step("check:ecs（ECS 门禁，ends with RESULT: OK）", process.execPath, [path.join(ROOT, "scripts", "check-ecs.mjs")]);

if (!checkOnly) {
  step("vite build", process.execPath, [VITE_BIN, "build"]);
}

if (withCargo) {
  if (!existsSync(CARGO_TOML)) {
    console.error("!! src-tauri/Cargo.toml 不存在");
    failed = true;
  } else {
    const ok = step("cargo check（Tauri 壳）", "cargo", ["check"], SRC_TAURI);
    if (!ok) {
      console.error(
        "   Tauri 在 Windows 上需要 MSVC（Visual Studio 的「使用 C++ 的桌面开发」工作负载）。\n" +
          "   本机只有 mingw 工具链，这一步大概率会失败 —— 前端产物不受影响。",
      );
    }
  }
}

console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: OK");
process.exit(failed ? 1 : 0);
