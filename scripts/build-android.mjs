// ===== Android: ONE command from "nothing built" to an APK in release\ =====
//
// WHY THIS SCRIPT EXISTS (the desktop chain needs no equivalent):
//
//   * An Android app is not one artifact but TWO build systems stacked. `cargo` compiles the Rust
//     library to `src-tauri/target/<triple>/<profile>/libvoxelengine_tauri_lib.so`, then **Gradle**
//     compiles the Java/Kotlin shell around it and packs the APK into
//     `src-tauri/gen/android/app/build/outputs/apk/<flavor>/<type>/`. Gradle's output path is fixed by
//     the Android Gradle Plugin, so - unlike the desktop exe, which `package-portable.mjs` copies into
//     `release\` - **nothing ever lands in `release\` unless a script puts it there**. This is that
//     script, and it makes `release\VoxelEngineTauri-android\` the mirror of the desktop's
//     `release\VoxelEngineTauri\`.
//
//   * **The symlink trap.** `tauri android build` places the `.so` in `app/src/main/jniLibs/` with a
//     **symbolic link**, and Windows refuses to create one unless Developer Mode is on (or you are an
//     administrator):
//       "Failed to create a symbolic link ... Creation symbolic link is not allowed for this system.
//        For Windows 10 or newer: You should use developer mode."
//     Rather than requiring a machine-wide setting, this script does what the link was for: it COPIES
//     the `.so` and neutralises the Gradle tasks that would call the CLI again (see the `PATCHED`
//     blocks it writes into `buildSrc/.../RustPlugin.kt`). The APK that comes out is the same one.
//
//   * **The network.** `services.gradle.org` crawls here (~20 KB/s for the Gradle distribution) and the
//     plugin portal / Maven Central stall, so the Gradle wrapper and every repository list get Chinese
//     mirrors FIRST with the originals kept as a fallback.
//
// Every patch is IDEMPOTENT (it looks for its own marker first) and every anchor is checked: if a
// future `tauri android init` changes the template, the script FAILS LOUDLY instead of leaving a
// half-patched project. `src-tauri/gen/` is git-ignored, which is exactly why the generated project and
// these patches are not in the repository - after a fresh clone run
// `npm run tauri -- android init` once, then this script.
//
// Environment (three variables; the script puts platform-tools/cmdline-tools on the child PATH itself):
//   ANDROID_HOME  the SDK root            e.g.  setx ANDROID_HOME E:\android
//   JAVA_HOME     a JDK 17                e.g.  setx JAVA_HOME    E:\android\jdk-17
//   NDK_HOME      optional - the newest NDK under %ANDROID_HOME%\ndk is used when unset
//
// Usage:
//   npm run app:android                   debug APK for arm64-v8a (the ABI every modern phone has)
//   npm run app:android -- --release      release APK (far smaller: no debug info in the .so)
//   npm run app:android -- --target all   every ABI (4 Rust builds + 4 APKs; slow)
//   npm run app:android -- --skip-frontend  trust the existing dist\ (fast re-package)
//   npm run app:android -- --skip-build   only re-publish an already-built APK into release\
//   npm run app:android -- --skip-patch   do not touch gen\android (when debugging the template itself)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { CARGO_TARGET, ROOT, SRC_TAURI } from "./paths.mjs";
import { buildFrontend, runCapture, runShell } from "./run.mjs";

/// The ABI table: Rust triple <-> NDK clang prefix <-> jniLibs directory <-> Gradle flavor.
const ABIS = {
  aarch64: { triple: "aarch64-linux-android", ndk: "aarch64-linux-android", jni: "arm64-v8a", flavor: "arm64" },
  armv7: { triple: "armv7-linux-androideabi", ndk: "armv7a-linux-androideabi", jni: "armeabi-v7a", flavor: "arm" },
  i686: { triple: "i686-linux-android", ndk: "i686-linux-android", jni: "x86", flavor: "x86" },
  x86_64: { triple: "x86_64-linux-android", ndk: "x86_64-linux-android", jni: "x86_64", flavor: "x86_64" },
};

const argv = process.argv.slice(2);
const wantRelease = argv.includes("--release");
const skipBuild = argv.includes("--skip-build");
const skipPatch = argv.includes("--skip-patch");
const skipFrontend = argv.includes("--skip-frontend");
const targetArg = argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : "aarch64";
const abiNames = targetArg === "all" ? Object.keys(ABIS) : [targetArg];
for (const n of abiNames) {
  if (!ABIS[n]) {
    console.error(`unknown --target ${n}: use one of ${Object.keys(ABIS).join(", ")} or "all"`);
    process.exit(1);
  }
}

const GEN = path.join(SRC_TAURI, "gen", "android");
const APP = path.join(GEN, "app");
const PROJECT = path.join(APP, "build", "outputs", "apk");
const OUT = path.join(ROOT, "release", "VoxelEngineTauri-android");
const API = 24; // must match `minSdk` in app/build.gradle.kts
const log = (m) => console.log(m);

// ---------- 0. the toolchain (where it lives is the user's business; that it exists is ours) ----------
const ANDROID_HOME = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
const JAVA_HOME = process.env.JAVA_HOME || "";
if (!ANDROID_HOME || !existsSync(ANDROID_HOME)) {
  console.error("ANDROID_HOME is not set (or does not exist):");
  console.error("  setx ANDROID_HOME <the SDK root>      e.g. setx ANDROID_HOME E:\\android");
  process.exit(1);
}
if (!JAVA_HOME || !existsSync(path.join(JAVA_HOME, "bin", "java.exe"))) {
  console.error("JAVA_HOME is not set (or has no bin\\java.exe). Android needs a JDK 17:");
  console.error("  setx JAVA_HOME <the JDK 17 root>      e.g. setx JAVA_HOME E:\\android\\jdk-17");
  process.exit(1);
}
/** The NDK: `NDK_HOME`, else the newest under `<ANDROID_HOME>\ndk\`. */
function findNdk() {
  const explicit = process.env.NDK_HOME || process.env.ANDROID_NDK_HOME;
  if (explicit && existsSync(explicit)) return explicit;
  const root = path.join(ANDROID_HOME, "ndk");
  if (!existsSync(root)) return null;
  const versions = readdirSync(root).sort();
  return versions.length ? path.join(root, versions[versions.length - 1]) : null;
}
const NDK_HOME = findNdk();
if (!NDK_HOME) {
  console.error(`no NDK under ${path.join(ANDROID_HOME, "ndk")}. Install one:`);
  console.error(`  "%ANDROID_HOME%\\cmdline-tools\\latest\\bin\\sdkmanager" --sdk_root=%ANDROID_HOME% "ndk;27.2.12479018"`);
  process.exit(1);
}
const LLVM_BIN = path.join(NDK_HOME, "toolchains", "llvm", "prebuilt", "windows-x86_64", "bin");
if (!existsSync(LLVM_BIN)) {
  console.error(`the NDK has no ${LLVM_BIN} - is this a Windows NDK?`);
  process.exit(1);
}
// What the children see: the SDK's own tools on PATH, so Gradle never has to guess where they are.
const childEnv = {
  ...process.env,
  PATH: [
    path.join(ANDROID_HOME, "platform-tools"),
    path.join(ANDROID_HOME, "cmdline-tools", "latest", "bin"),
    path.join(JAVA_HOME, "bin"),
    process.env.PATH,
  ].join(path.delimiter),
};

log("android toolchain:");
log(`  ANDROID_HOME  ${ANDROID_HOME}`);
log(`  JAVA_HOME     ${JAVA_HOME}`);
log(`  NDK           ${path.basename(NDK_HOME)}`);

// ---------- 1. the generated project ----------
if (!existsSync(APP)) {
  console.error(`\n${GEN} does not exist. Generate it once, then run this again:`);
  console.error("  npm run tauri -- android init");
  process.exit(1);
}

// ---------- 2. the patches ----------
/** The generated Gradle/Kotlin files are CRLF on Windows while the anchors below are written with
 *  plain `\n`, so every multi-line anchor and replacement goes through this. */
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const fit = (text, s) => s.split("\n").join(eolOf(text));

/** Replace `from` with `to`, or fail with the file name - a half-patched project is worse than none. */
function replaceIn(file, from, to, { all = false } = {}) {
  const text = readFileSync(file, "utf8");
  const fromF = fit(text, from);
  const toF = fit(text, to);
  if (!text.includes(fromF)) {
    throw new Error(`anchor not found in ${path.relative(ROOT, file)}:\n---\n${from}\n---`);
  }
  writeFileSync(file, all ? text.split(fromF).join(toF) : text.replace(fromF, toF));
}

function patchGradle() {
  // (a) the Gradle distribution itself.
  const wrap = path.join(GEN, "gradle", "wrapper", "gradle-wrapper.properties");
  const wrapText = readFileSync(wrap, "utf8");
  const official = /https\\:\/\/services\.gradle\.org\/distributions\/(gradle-[\d.]+-bin\.zip)/.exec(wrapText);
  if (official && !wrapText.includes("mirrors.cloud.tencent.com")) {
    replaceIn(wrap, `https\\://services.gradle.org/distributions/${official[1]}`, `https\\://mirrors.cloud.tencent.com/gradle/${official[1]}`);
    log("  gradle-wrapper.properties  -> Tencent mirror");
  }

  // (b) the plugin portal. `pluginManagement` must be the FIRST block in settings.gradle.
  const settings = path.join(GEN, "settings.gradle");
  if (!readFileSync(settings, "utf8").includes("aliyun")) {
    const text = readFileSync(settings, "utf8");
    writeFileSync(
      settings,
      fit(
        text,
        `// PATCHED by scripts/build-android.mjs: plugins.gradle.org / Maven Central stall on this network,
// so the Chinese mirrors go first and the originals stay as a fallback.
pluginManagement {
    repositories {
        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
        maven { url 'https://maven.aliyun.com/repository/google' }
        maven { url 'https://maven.aliyun.com/repository/public' }
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

`,
      ) + text,
    );
    log("  settings.gradle            -> Aliyun pluginManagement");
  }

  // (c) the repositories that resolve AGP / Kotlin (root project) and the buildSrc plugin.
  const rootGradle = path.join(GEN, "build.gradle.kts");
  if (!readFileSync(rootGradle, "utf8").includes("aliyun")) {
    replaceIn(
      rootGradle,
      `    repositories {
        google()
        mavenCentral()
    }`,
      `    repositories {
        // PATCHED by scripts/build-android.mjs: Chinese mirrors first.
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
    }`,
      { all: true },
    );
    log("  build.gradle.kts           -> Aliyun repositories");
  }
  const buildSrc = path.join(GEN, "buildSrc", "build.gradle.kts");
  if (!readFileSync(buildSrc, "utf8").includes("aliyun")) {
    replaceIn(
      buildSrc,
      `repositories {
    google()
    mavenCentral()
}`,
      `repositories {
    // PATCHED by scripts/build-android.mjs: Chinese mirrors first.
    maven { url = uri("https://maven.aliyun.com/repository/google") }
    maven { url = uri("https://maven.aliyun.com/repository/public") }
    google()
    mavenCentral()
}`,
    );
    log("  buildSrc/build.gradle.kts  -> Aliyun repositories");
  }
}

function patchSymlinkWorkaround() {
  // The `merge*JniLibFolders` tasks are what pull the .so into the APK. They depend on the CLI tasks
  // that create the symlink; dropping that dependency lets Gradle package the copy this script makes.
  const kt = path.join(GEN, "buildSrc", "src", "main", "java", "com", "voxelengine", "tauri", "kotlin", "RustPlugin.kt");
  const text = readFileSync(kt, "utf8");
  // Any PATCHED marker counts: this file may have been patched by hand before this script existed.
  if (text.includes("PATCHED")) return;

  const one = 'tasks["mergeUniversal${profileCapitalized}JniLibFolders"].dependsOn(buildTask)';
  const two = /(\s*)tasks\["merge\$targetArchCapitalized\$\{profileCapitalized\}JniLibFolders"\]\.dependsOn\(\r?\n\s*targetBuildTask\r?\n\s*\)/;
  if (!text.includes(one) || !two.test(text)) {
    throw new Error(
      "RustPlugin.kt does not match the template this script knows, so the symlink workaround cannot\n" +
        "be applied. Either enable Windows Developer Mode (Settings -> Privacy & security -> For\n" +
        "developers) and use `npm run tauri -- android build`, or update this script.",
    );
  }
  let out = text.replace(
    one,
    fit(text, `// PATCHED by scripts/build-android.mjs (this machine cannot create the symlink the Tauri CLI uses):
                // ${one}`),
  );
  const E = eolOf(text);
  out = out.replace(
    two,
    (_m, indent) =>
      `${indent}// PATCHED by scripts/build-android.mjs: the .so is copied into jniLibs by hand, so nothing may${E}` +
      `${indent}// depend on the CLI task that would symlink it.${E}` +
      `${indent}// tasks["merge$targetArchCapitalized\${profileCapitalized}JniLibFolders"].dependsOn(${E}` +
      `${indent}//     targetBuildTask${E}` +
      `${indent}// )`,
  );
  writeFileSync(kt, out);
  log("  RustPlugin.kt              -> package the hand-copied .so (no symlink)");
}

if (!skipPatch) {
  log("patching gen\\android (idempotent):");
  try {
    patchGradle();
    patchSymlinkWorkaround();
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
}

// ---------- 2. the FRONTEND, once, before anything is compiled ----------
// `tauri-codegen` embeds `dist\` with `include_bytes!`, so cargo recompiles when it changes - but only
// once it HAS changed. A chain that skips this step builds the APK around the PREVIOUS frontend, which
// is why it is step 2 and not a "remember to run verify first" note. (The CLI call that generates the
// glue below would run `npm run build` itself, but only when the glue is missing and once per ABI - it
// is switched off for that call instead.)
if (!skipFrontend) {
  if (!buildFrontend(childEnv)) {
    console.error("\nFAILED: the frontend gate did not pass, so nothing was built.");
    process.exit(1);
  }
} else {
  log("frontend: skipped (--skip-frontend) - the existing dist\\ will be embedded");
  if (!existsSync(path.join(ROOT, "dist", "index.html"))) {
    console.error(`\n${path.join("dist", "index.html")} does not exist: there is nothing to embed.`);
    console.error("Run without --skip-frontend.");
    process.exit(1);
  }
}

// ---------- 3..5 per ABI: (glue) -> cargo -> copy the .so -> Gradle ----------
/** The shared `runShell` reports failure; every child in this script is fatal, so this wraps it. */
function mustRun(cmdline, cwd) {
  if (!runShell(cmdline, { cwd, env: childEnv })) {
    console.error(`\nFAILED: ${cmdline}`);
    process.exit(1);
  }
}

/** **The Android glue is NOT part of `tauri android init`.** The CLI writes these during a build:
 *  `tauri.settings.gradle` (which points Gradle at the tauri crate's own Android project in the cargo
 *  registry), `app/tauri.build.gradle.kts`, `app/tauri.properties` and ten Kotlin files under
 *  `app/src/main/java/.../generated/` (WryActivity, RustWebView, Ipc, ...). They are version-specific
 *  templates, so this script must NOT hand-write them - it asks the CLI, which is the only thing that
 *  knows the current shape.
 *
 *  Two things about that call:
 *    * It has to be the OUTER `tauri android build`. The inner `android-studio-script` (which the
 *      Gradle plugin runs) is not standalone: it panics with "failed to read missing addr file
 *      ...-server-addr", because that file only exists under `tauri android dev`.
 *    * It ALSO tries to place the `.so` with a symbolic link, which Windows refuses without Developer
 *      Mode, so it exits non-zero - AFTER the project has been generated and the Rust library built.
 *      The failure is therefore tolerated as long as the project came out complete; the `.so` is
 *      copied by hand in the next step, and Gradle never reaches its own CLI step because
 *      `patchSymlinkWorkaround` removed that dependency. */
const GLUE = path.join(APP, "src", "main", "java", "com", "voxelengine", "tauri", "generated", "WryActivity.kt");
function ensureGeneratedProject(name) {
  if (existsSync(GLUE) && existsSync(path.join(GEN, "tauri.settings.gradle"))) return;
  log(`[${name}] generating the Android glue (Tauri CLI; it is expected to fail on the symlink)`);
  const cli = path.join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
  // `beforeBuildCommand` is emptied for this call: the frontend is built once by `buildFrontend`
  // before any of this, and letting the CLI run `npm run build` again would just repeat it per ABI.
  const r = runCapture(
    process.execPath,
    [cli, "android", "build", "--apk", "--debug", "--target", name, "-f", "custom-protocol", "-c", '{"build":{"beforeBuildCommand":""}}'],
    { cwd: ROOT, env: childEnv },
  );
  if (!existsSync(GLUE) || !existsSync(path.join(GEN, "tauri.settings.gradle"))) {
    console.error(`\nthe CLI did not generate the Android project, so the build cannot continue:\n${r.out.slice(-4000)}`);
    process.exit(1);
  }
  log(
    r.status === 0 || /symbolic link|CreateSymbolicLink/i.test(r.out)
      ? "  generated (the symlink failure is expected - the .so is copied by hand below)"
      : "  generated (the CLI exited non-zero for another reason - check its output if the APK is wrong)",
  );
}

const built = [];
for (const name of abiNames) {
  const abi = ABIS[name];
  const profile = wantRelease ? "release" : "debug";
  const so = path.join(CARGO_TARGET, abi.triple, profile, "libvoxelengine_tauri_lib.so");

  ensureGeneratedProject(name);

  if (!skipBuild) {
    // The NDK's clang wrapper has to reach cargo: the link step needs a linker, and the `cc` crate
    // (pulled in by rustls/ring) reads the CC_/AR_ variables.
    const clang = (() => {
      const exact = path.join(LLVM_BIN, `${abi.ndk}${API}-clang.cmd`);
      if (existsSync(exact)) return exact;
      const any = readdirSync(LLVM_BIN)
        .filter((f) => f.startsWith(abi.ndk) && f.endsWith("-clang.cmd"))
        .sort();
      if (!any.length) throw new Error(`no clang wrapper for ${abi.ndk} in ${LLVM_BIN}`);
      return path.join(LLVM_BIN, any[0]);
    })();
    const upper = abi.triple.toUpperCase().replace(/-/g, "_");
    childEnv[`CARGO_TARGET_${upper}_LINKER`] = clang;
    childEnv[`CC_${abi.triple}`] = clang;
    childEnv[`AR_${abi.triple}`] = path.join(LLVM_BIN, "llvm-ar.exe");
    childEnv[`RANLIB_${abi.triple}`] = path.join(LLVM_BIN, "llvm-ranlib.exe");

    log(`\n[${name}] cargo rustc --crate-type cdylib --target ${abi.triple} (${profile})`);
    // `cargo rustc --crate-type cdylib` and NOT a manifest `crate-type`, because a manifest crate-type
    // belongs to the PACKAGE: declaring cdylib there would make every DESKTOP build link a .dll as
    // well, and Windows + the GNU toolchain cannot link the debug one
    // (`ld.exe: error: export ordinal too large: 90913` - the release profile survives it, `tauri dev`
    // does not). See the note in src-tauri/Cargo.toml.
    mustRun(
      [
        "cargo rustc",
        `--manifest-path "${path.join(SRC_TAURI, "Cargo.toml")}"`,
        `--target ${abi.triple}`,
        "--lib",
        "--crate-type cdylib",
        ...(wantRelease ? ["--release"] : []),
        "--features custom-protocol",
      ].join(" "),
      ROOT,
    );
  }
  if (!existsSync(so)) {
    console.error(`\n${so} not found - build it first (drop --skip-build)`);
    process.exit(1);
  }

  const jniDir = path.join(APP, "src", "main", "jniLibs", abi.jni);
  mkdirSync(jniDir, { recursive: true });
  copyFileSync(so, path.join(jniDir, "libvoxelengine_tauri_lib.so"));
  log(`[${name}] .so -> jniLibs\\${abi.jni}  (${(statSync(so).size / 1024 / 1024).toFixed(1)} MB)`);

  const task = `assemble${abi.flavor[0].toUpperCase()}${abi.flavor.slice(1)}${wantRelease ? "Release" : "Debug"}`;
  log(`[${name}] gradlew ${task}`);
  mustRun(`"${path.join(GEN, "gradlew.bat")}" ${task} --no-daemon --console=plain`, GEN);

  const apk = path.join(PROJECT, abi.flavor, profile, `app-${abi.flavor}-${profile}.apk`);
  if (!existsSync(apk)) {
    console.error(`\nGradle reported success but ${apk} is missing (did the flavor naming change?)`);
    process.exit(1);
  }
  built.push({ name, abi, apk, profile });
}

// ---------- 6. publish to release\ (the mirror of package-portable.mjs) ----------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const published = [];
for (const b of built) {
  const dest = path.join(OUT, `VoxelEngine-${b.abi.jni}-${b.profile}.apk`);
  copyFileSync(b.apk, dest);
  published.push(dest);
}

writeFileSync(
  path.join(OUT, "README.txt"),
  `VoxelEngine (Tauri v2 / Android)

Install: copy the .apk to the phone and tap it (allow "install unknown apps"), or
         adb install -r VoxelEngine-<abi>-<profile>.apk

Pick the file that matches the phone's CPU - every modern phone is arm64-v8a:
  arm64-v8a    almost every device since ~2016
  armeabi-v7a  32-bit ARM (old / low-end)
  x86 / x86_64 emulators only

Needs Android 7.0 (API 24) or newer, AND **WebGPU**: the renderer has no WebGL fallback, so a device
without it shows a black screen instead of the main menu. Check the phone's Chrome at chrome://gpu -
"WebGPU" has to be enabled there (Chrome and the system WebView share one Chromium).

This is a ${wantRelease ? "RELEASE" : "DEBUG"} build. Debug keeps the Java/Kotlin debug info and an
unstripped .so, which is why the file is large.

What works today: the loading screen, the main menu and every DOM surface (a tap is a click).
What does NOT: there is no touch interaction yet - no stick, no look-drag, no on-screen buttons - so a
world can be entered but not played.

Logs: on Android the game data root is not writable (the directory next to the executable is
read-only), so game\\logs\\ stays empty. Use "adb logcat" for now.
`,
  "utf8",
);

log(`\nandroid -> ${OUT}`);
for (const p of published) log(`  ${path.basename(p).padEnd(38)} ${(statSync(p).size / 1024 / 1024).toFixed(1)} MB`);
log("  README.txt");
