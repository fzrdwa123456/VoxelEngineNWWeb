# PORT-TAURI.md — NW.js -> Tauri v2, file by file

This document covers the **port** only: what each original file did, who does it now, and why the cut is where it is.
The game's own design (the ECS, the three lanes, UI-as-data, the resource-pack format) is unchanged -- see `AGENTS.md`.

## 1. Why the cut is where it is

The original's coupling surface is **very narrow**. Searching the whole repository for `nw.` / `require(` / `process.` yields exactly three files:

```
src/platform/shell.ts        nw.Window.get() + eval("require")("node:fs") + execFile(cursor.exe)
src/platform/rawinput.ts     require("rawinput.node") (a NAPI native plug-in)
src/rendering/textures.ts    node:fs directory listing/file reads + path
```

The remaining 100+ files only `import { logDebug, readSettings, ... } from "./platform/shell"`.
So the key to the port is not "changing code" but **preserving the shape of those three files' exported API**, so that no call site has to move.

There is exactly one obstacle: **the original's `readSettings()` / `resolveTexture()` / `logDebug()` are all synchronous**,
while Tauri's commands (`invoke`) are asynchronous. Three countermeasures:

| Synchronous read | Countermeasure |
|---|---|
| `readSettings()` / `readSettingsChecked()` / `isGpuVsyncDisabled()` / `getWindowMode()` | `await preloadShell()` once at startup, into memory; memory is read afterwards |
| `resolveTexture()` / `resolveBytes()` / `resolveAllBytes()` / `listPacks()` | `await preloadPacks()` once at startup, pulling all the pack bytes into memory |
| `logDebug()` / `appendDebugLog()` | batched (64 lines / 200ms) and sent asynchronously; the API is still synchronous `void` |
| `startRawInput()` | Rust pushes events, the front end hands each one to `input.rawDelta()` (the decisions stay on the event side), and `frameLook()` applies them once per frame |

So `main.ts` gains two `await` lines at the top -- that is the **only change to the startup order**.

## 2. Command reference (Rust -> front end)

`src-tauri/src/lib.rs` is the command bus; the names the front end passes to `invoke()` live here:

| Command | Arguments | Returns | Purpose |
|---|---|---|---|
| `preload_shell` | — | `ShellSnapshot` | settings + window mode + the vsync switch + game root |
| `write_settings` | `value` | `bool` | writes settings.json (and updates the Rust-side cache) |
| `backup_settings` | — | `String` | saves the settings.json about to be overwritten as settings.bad.json |
| `append_log` | `channel`, `lines` | — | appends to logs\debug.log / renderer.log |
| `preload_packs` | — | `PackSnapshot` | scans resourcepacks\ + mods\ and returns every pack's bytes |
| `show_window` / `focus_window` | — | `bool` / — | reveals the window after the first frame; an explicit focus |
| `quit_app` | — | — | quits (stopping the raw-input thread first) |
| `center_cursor` | — | `bool` | SetCursorPos to the centre of the window |
| `set_window_mode` | `fullscreen` | `bool` | windowed / fullscreen |
| `window_is_fullscreen` | — | `bool` | whether it is fullscreen right now |
| `set_vsync_disabled` | `disabled` | `bool` | writes config\vsync.json (takes effect on restart) |
| `rawinput_start` | — | `RawStats` | starts the collector thread + the pusher thread |
| `rawinput_stats` | — | `RawStats` | diagnostic counters |
| `game_root_of` | — | `String` | the data directory (for troubleshooting) |

Events (Rust -> front end):

| Event | Payload | Original equivalent |
|---|---|---|
| `raw-input` | `{dx, dy}` | the atomics `pollDelta()` used to pull, throttled into 4ms batches |
| `win-focus` / `win-blur` | — | the original `win.on("focus"/"blur")` |

## 3. Files on the Rust side

```
src-tauri/src/boot/main.rs      entry point (release carries no console, matching the original launcher.c -mwindows)
src-tauri/src/lib.rs       the command bus + Builder + focus-event forwarding
src-tauri/src/game.rs      game root / settings.json / logs / the vsync switch / WebView2 arguments
src-tauri/src/packs.rs     resource-pack and mod scanning (lists directories and reads bytes only, no normalisation)
src-tauri/src/win.rs       the window: show / focus / fullscreen / center_cursor
src-tauri/src/rawinput.rs  raw mouse input (a direct translation of the original rawinput/src/lib.rs, NAPI -> Tauri events)
```

### How rawinput.rs changed

The collection half is **copied line for line** from the original `rawinput/src/lib.rs`: an `HWND_MESSAGE` hidden window +
`RegisterRawInputDevices(RIDEV_INPUTSINK)` + `WM_INPUT` -> `RAWMOUSE.lLastX/Y` -> `AtomicI32`.
The Win32 functions are still declared by hand as `extern "system"` (**deliberately without pulling in the `windows` crate**,
one less dependency, and one less place to fight the toolchain).

Only the exit changed:

```rust
// before: JS called NAPI's poll_delta() synchronously every frame
#[napi] pub fn poll_delta(&self) -> MouseDelta { ACC_DX.swap(0, ...), ACC_DY.swap(0, ...) }

// now: one extra throttling thread takes the accumulator, clears it and emits an event every 4ms
std::thread::spawn(move || loop {
    sleep(4ms);
    let (dx, dy) = (ACC_DX.swap(0), ACC_DY.swap(0));
    if dx != 0 || dy != 0 { app.emit("raw-input", MouseDelta { dx, dy }); }
});
```

The front end hands that event straight to `PlayerInputSystem.rawDelta(dx, dy)`: the takeover/grace/spike decisions still live there (event time,
rule 3), but it **accumulates only, never applies**; `frame()` calls `input.frameLook()` once per frame, turning the frame's whole displacement into **one**
`look` intent. The throttling (4 ms batches) is still necessary: `WM_INPUT` fires several hundred times a second, and one IPC event per line would drown the webview.

> This used to be "events accumulate into the local `accDx/accDy`, and the front end takes them once every 8 ms via `setInterval`". That timer was
> **the culprit behind "turning the view while holding a key is not smooth"**: Chromium queues input tasks such as keydown ahead of timer tasks, and holding a key
> (auto-repeat ~30 times a second) squeezed the 8 ms sampling into a 9~12 ms bracket, so "how many samples a frame gets" jumped erratically between 0/1/2/3
> (measured: with no key held 122~127 samples/s and 90% of frames exactly 2 samples; with a key held it dropped to 84~110 samples/s and only ~40% of frames got 2 samples).
> After switching to one take per frame, the per-frame turn angle = that frame's real mouse displacement, independent of what the main thread is busy with. This was the project's **last
> `setInterval`**, and the front end now has none left.

### Mouse capture: native ClipCursor + a foreground gate + an ESC bridge

The original used the browser's pointer lock (`requestPointerLock`); the Tauri version **does not touch it**, and uses Win32 `ClipCursor` to pin the system
cursor physically inside the window's client area, paired with `SetCursorPos(centre)` and a 4 ms "cursor sentinel" (`win::cursor_sentinel`,
which corrects only when "the expected visibility and the system's actual state disagree", zero cost in steady state). Visually equivalent, but it buys three responsibilities the original did not have:

1. **Foreground gate**: `ClipCursor` **does not check whether the window is foreground** (the browser's `requestPointerLock` refuses by itself),
   while the back-end raw input is `RIDEV_INPUTSINK` (it receives in the background too). So "capture only while foreground" has to be done explicitly, in three layers:
   `PointerLockDeps.focused` (the normal path refuses), the automatic relock when `enterWorld` enters a world (if not in the foreground, open the pause
   menu instead), and `win::capture_foreground_check` (the system-level backstop: two consecutive ticks with the foreground not ours -> release the mouse + restore
   the cursor + emit `capture-lost`, which the front end handles as a blur).
2. **ESC's default unlock action**: the browser's "ESC unlocks" happens in the **browser process**, before the page receives the event, and `preventDefault()`
   cannot stop it. The Rust side installs a `WH_KEYBOARD_LL` hook to swallow ESC (and the menu key / Shift+F10 context-menu gesture),
   then synthesises a real `KeyboardEvent` from the `esc` event and dispatches it to the page. **But in practice that hook was never called**
   (`logs\debug.log` shows `HOOKPROBE seen=0`, consistent across several runs) -- so what actually works today is the three pieces "native capture + front-end
   `preventDefault` + cursor sentinel"; the hook belongs to the part that is "installed but ineffective, and lets the event through on failure".
3. **Cursor visibility belongs to Rust**: CSS `cursor` is only an intent; what actually decides that the cursor is invisible on screen is the `SetCursor` push,
   and its timing is unreliable (a push at the moment of losing focus is dropped by the system). So the front end only tells Rust "expect visible/hidden"
   (the `cursor_intent` command), and the sentinel reconciles it every 4 ms.

### How packs.rs and textures.ts divide the work

```
Rust (packs.rs)                             TS (textures.ts)
  lists resourcepacks\ and mods\              normalizeKey(): assets/<ns>/textures/x -> x
  folder packs -> {rel: base64} recursively   priority: mods first, resourcepacks after
  .zip packs -> base64 of the whole zip       one Map per layer, a later write overrides an earlier one
  (does not unpack zips)                      zips are unpacked with fflate (already a front-end dependency)
```

Why not move it all to Rust: normalisation and priority are **pure logic**, and they are covered by `check:ecs`, so
moving them would only introduce risk; why zips are not unpacked in Rust: that would pull in `zip` + `flate2`,
while the front end already has `fflate`.

The ordering semantics are aligned strictly with the original: Rust returns each directory's entries in **ascending name order**, and the TS side iterates
from the back (the original `scanPackDir` was exactly `for (let i = entries.length - 1; i >= 0; i--)`).
The built-in `default.zip` still enters the layers first (lowest priority).

### Why settings-diff.ts is a file of its own

`diffSettings()` (which repairs settings.json into "the values actually in force") is a **pure function**, and
`check:ecs` has to be able to `require` it and run it directly in Node. The Tauri version of `shell.ts` imports
`@tauri-apps/api` at the top (pure ESM), which blows up Node's CJS `require` -- so that part is
cut into the dependency-free `src/platform/settings-diff.ts`, and `shell.ts` only forwards it with `export { diffSettings } from ...`.
The call sites and the assertions are still where they were; only `check-ecs.mjs`'s compile list changed to this one file.

## 4. What was deleted

| Deleted | Why |
|---|---|
| `src/nw.d.ts` | the NW.js/Node global declarations -- not one of them exists any more |
| `app/` (the NW manifest) | window size / title / chromium-args all moved into `src-tauri/tauri.conf.json` |
| `launcher/*.c` | `launcher.exe`'s responsibilities (setting `--user-data-dir`, hiding the console, forwarding arguments) are carried by the Tauri binary itself |
| `scripts/get-nw.mjs` | the NW.js runtime no longer has to be downloaded |
| `scripts/rearrange.mjs` (the original) | the packager is not needed at all; the new file of the same name only does "create game\ + optionally install the example packs" |
| `rawinput/lib/libnode.dll` (29MB) and the like | the NAPI plug-in no longer exists, so no Node headers or import libraries are needed |
| `rcedit` / `resedit` devDependencies | version info and the icon are embedded by `tauri build` itself |

## 5. The actual build record

| Step | Command | Result |
|---|---|---|
| type check | `tsc --noEmit -p tsconfig.json` | 0 errors |
| ECS gate | `node scripts/check-ecs.mjs` | 54 assertion groups passed / RESULT: OK |
| front-end bundle | `vite build` | ✓ 67 modules transformed, 456ms |
| Rust check | `cargo check` (`x86_64-pc-windows-gnu`) | exit 0, 3m42s |
| Rust link | `cargo build` (after the `crate-type` change) | **exit 0, 17s -> `voxelengine-tauri.exe` (208MB debug)** |
| actual run | vite(1420) + the debug exe | **the `VoxelEngine` window shows, the main menu renders, `BOOT ready in 835ms`** |

The raw text of `game\logs\debug.log` from that run (proof that every link in the chain works):

```
[418ms] PACKS not installed yet (preloadPacks() has not finished) — falling back to the engine's built-ins for this resolution, not caching it
[833ms] PACKS installed: builtin=0 mods=1 resourcepacks=1 files=11
[833ms] I18N dictionaries loaded (lang/*.json layered merge): zh=0 en=0 ja=0 entries (1 layer(s) of zh.json)
[834ms] BLOCKREG registry loaded: 6 blocks (1 layers of blocks.json) -> [grass, default, missing, ruby, stone, gold]
[848ms] SCHEDULE fixed: 6 systems, 5 batches, 1 parallel pair(s) [...]
[848ms] BOOT render=rAF(60Hz) winFocused=true
[903ms] SETTINGS ok
[921ms] RAWINPUT listener started (Rust thread + raw-input events)
[1487ms] BOOT graphics ready at 639ms
[1683ms] BOOT ready in 835ms
```

Three key lines: `PACKS installed ... files=11` = the chain Rust pack scan + front-end fflate unpack works;
`BLOCKREG ... [grass, default, missing, ruby, stone, gold]` = the mod's blocks.json was read;
`RAWINPUT listener started` = Rust's raw-input thread really did start.

### Toolchain: this machine has no MSVC, and **the GNU toolchain built it anyway**

Tauri's official documentation requires the Visual Studio "Desktop development with C++" workload (MSVC + Windows SDK) on Windows.
This machine only has mingw-w64's `x86_64-pc-windows-gnu` (`rustc 1.98.0`, gcc 16.1.0), and **it passed end to end in testing**:
the whole dependency set -- `tauri` / `tauri-runtime-wry` / `wry` / `webview2-com` / `windows-targets` --
plus `tauri-build`'s icon and resource embedding (the `ico` crate) all compiled, and the final link produced a runnable exe.
`webview2-com-sys` uses dynamic linking by default, taking the `WebView2Loader.dll` import library from its own
`OUT_DIR` (the link command shows `-L .../webview2-com-sys-*/out/x64`),
and mingw's `ld` accepts it.

The **only** real pitfall in the process had nothing to do with MSVC:

```
error: linking with `x86_64-w64-mingw32-gcc` failed: exit code: 1
ld.exe: error: export ordinal too large: 90414
```

Cause: Tauri v2's template writes `[lib] crate-type` as `["staticlib", "cdylib", "rlib"]`
(that is meant for iOS/Android). On Windows, `cdylib` generates an "export every symbol"
`.def` (the `list.def` in the link command); mingw's `ld` caps export ordinals at 65535,
and this crate has far more symbols than that, so it overflows. A desktop build does not need `cdylib` at all:

```toml
[lib]
crate-type = ["rlib"]     # was: ["staticlib", "cdylib", "rlib"]
```

After the change the link completed in 17 seconds.

### The third pitfall: a portable directory must carry WebView2Loader.dll

`tauri build` / `cargo build --release` produce **two** files in `target\release\` that have to ship together:

```
voxelengine-tauri.exe     8372 KB
WebView2Loader.dll         157 KB   <- without this one it will not start
```

The consequence of copying only the exe is highly misleading: the process comes up, something reports it "alive", but

* the window count is **0** (not even a hidden one)
* the thread count is **2** and CPU time is **0**
* loaded modules stop at 24 (the static imports USER32/ole32/comctl32), and **WebView2Loader.dll is absent**
* `game\logs\debug.log` gets **not a single byte** (the log-truncation step in `run()` never ran at all)

It looks exactly like "stuck in the loader stage". The real culprit is a **system error box** Windows pops up:

```
voxelengine-tauri.exe - System Error
The code execution cannot proceed because WebView2Loader.dll was not found.
```

The key point is that **that box is drawn by `csrss.exe`** (in `tasklist /v` the window title hangs off csrss),
and it **does not disappear together with the failing process** -- so after killing the app process the box is still there, and a second and third look show the same apparent hang.
It was pinned down by a controlled experiment: the same exe (byte-identical SHA256) runs perfectly from `target\release\`,
and appears hung when run from a directory holding only the exe -- the only difference is that one DLL.

`npm run app:portable` (`scripts/package-portable.mjs`) copies both files together,
and, when the DLL is missing, **errors out immediately** instead of producing a directory that cannot run.

### The fifth pitfall: a bare `cargo build --release` does not embed the front end

Tauri embeds `dist\` into the binary only when the **`tauri/custom-protocol`** feature is enabled.
`tauri build` turns it on itself; a bare `cargo build --release` **does not**.

I switched to bare cargo to work around an NSIS download timeout, and the result was:

```
exe = 4216 KB   (the correct size is 8376 KB)
```

The symptoms are **extremely hard to pin down**, because they look almost identical to "stuck in the loader":

* the process is alive, **10 threads**, and `msedgewebview2.exe`'s gpu/network/storage/renderer child processes are all up
  (that is, the webview is fine)
* the window is hidden (`show_window` waits forever) and `MainWindowTitle` is empty
* `logs\debug.log` has **not one line** -- but `debug.log` and `renderer.log` are **0-byte files**,
  which shows that the Rust side's `run()` did reach the log-truncation step
* `logs\boot.log` is empty too -- **even the classic inline script in `index.html` never ran**,
  which proves the problem is not JS but that **the page was never loaded at all**

It was pinned down by searching the binary directly: the Rust-side strings are all there (`preload_shell` / `boot_report` /
`tauri://localhost`), but **not one front-end artifact path** such as `assets/index-*.js` can be found.

Two fixes, either one:

```powershell
npm run app:build     # = tauri build (turns the feature on itself; the NSIS step may fail on a download timeout, which does not affect the exe)
npm run app:exe       # = cargo build --release --features custom-protocol
```

And `scripts/package-portable.mjs` now **verifies actively**: it reads the exe as binary and checks whether the names of
`dist\assets\*` appear inside it, erroring out immediately if not -- this class of error can no longer pass silently.

### The sixth pitfall (a regression I introduced myself): packs arrive asynchronously, so an "empty result" must not be cached

The original `fs.readFileSync` was synchronous, so all three "read the packs" sites cached boldly:

| Site | The original's approach | The consequence of copying it into Tauri |
|---|---|---|
| `ui/i18n.ts` | builds the three dictionaries at module scope | `zh=0 en=0 ja=0`, and the interface shows the raw key (`main.single`) |
| `blockregistry.ts` | builds the registry on first call and sets `loaded` | permanently left with `FALLBACK_DEFS` only |
| `ui/background.ts` | decides the menu background on first call and memoises it | permanently recorded as `"checker"` |

Root cause: the packs arrive only after `await preloadPacks()`, and **ESM `import`s are evaluated before the module body** --
the two await lines at the top of `main.ts` cannot save code that already ran during the import phase.

The evidence is right there in the log, and it contradicts itself blatantly (I did not spot it in the first version):

```
[105ms] PACKS not installed yet (preloadPacks() has not finished) — falling back to the engine's built-ins for this resolution, not caching it
[244ms] I18N dictionaries loaded: zh=0 en=0 ja=0 entries (1 layer(s) of zh.json)
                                         ^^^^^^ 0 entries, and yet 1 layer was found
```

Now `rendering/textures.ts`'s `packsInstalled()` gates all of them uniformly: **if the packs are not installed, nothing is built and nothing is cached**.
After the fix:

```
[230ms] I18N dictionaries loaded: zh=88 en=88 ja=88 entries (1 layer(s) of zh.json)
```

### The earliest diagnostic channel: `logs\boot.log`

In Tauri the front end dying is **silent**, which wasted the most time in the troubleshooting above. So there are now three layers of net:

1. a **classic inline script** in `index.html` (it must come before the module) that installs `error` /
   `unhandledrejection` listeners and calls `window.__TAURI_INTERNALS__.invoke("boot_report", ...)`
   directly -- deliberately bypassing `@tauri-apps/api`, because that may be exactly what is broken. Its first line is `html loaded`.
2. the two `await`s at the top of `main.ts` are wrapped in try/catch, and on failure they `bootReport` + write into `document.title`
   (visible in the process list).
3. the Rust side's `boot_report` command appends them to `logs\boot.log`.

**The first step in diagnosing "the window does not come up" is to look at `game\logs\boot.log`**:
empty = the page was not loaded (most likely the fifth pitfall); only `html loaded` = the page loaded but the module died;
`preload failed: ...` present = a problem in the IPC layer.


A debug exe from `cargo build` **cannot be run by double-clicking it**: when Tauri is in `debug` and the
`custom-protocol` feature is off, the webview loads `tauri.conf.json`'s `devUrl`
(`http://localhost:1420`) rather than the embedded `dist\`. So running the debug exe bare gives a
blank window -- the symptoms are "the process is alive, there is a window handle, `debug.log` is 0 bytes".

There are two correct ways to run it:

```powershell
npm run app:dev         # = tauri dev, which starts vite(1420) itself and then runs the debug exe
npm run app:build       # = tauri build, release + embedded dist, the artifact runs standalone
```

Manually, the equivalent of the first:

```powershell
npm run dev             # vite in one terminal
src-tauri\target\debug\voxelengine-tauri.exe
```

