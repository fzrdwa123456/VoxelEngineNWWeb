// ===== The Tauri shell: settings / logs / window / vsync (the NW.js version's platform/shell.ts) =====
//
// The original read and wrote files synchronously through `eval("require")("node:fs")` and drove the
// window through `nw.Window.get()`. Tauri has no synchronous IPC, so the strategy here is:
//
//   * **Read**: at startup `preloadShell()` pulls settings / window mode / the vsync switch into memory
//     in ONE invoke, and `readSettings()` reads memory afterwards — it stays **synchronous**, so not one
//     call site changes.
//   * **Write**: `writeSettings()` updates memory first, then fire-and-forgets to Rust.
//   * **Logs**: batch (64 lines or 200ms) and send one `append_log`. The original did one synchronous
//     appendFile per line; carried over to Tauri that becomes one IPC per frame — a necessary behaviour
//     change, written down in the README.
//   * **Window**: everything goes through custom commands (src-tauri/src/win.rs), so the window plugin's
//     permissions are not needed.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { shellState, FLUSH_LINES, FLUSH_MS, type ShellSnapshot } from "../../data/globals/shell";
// The diagnostic-probe prefix table (which lines the switch may suppress) is data.
import { PROBE_PREFIXES } from "../../data/globals/probes";

// The snapshot shape and the host state live in data/globals/shell.ts; re-exported so no call site
// changes (the value is the world's SHELL_STATE either way).
export type { ShellSnapshot, ShellState } from "../../data/globals/shell";

/** The HOST state (data/globals/shell.ts): the settings snapshot, the log-flush deadline, the
 *  diagnostic-probe switch and the foreground flag. This module — the one that reads the files and talks
 *  to Rust — only holds a POINTER to that object, which the composition root also inserts as SHELL_STATE. */
const state = shellState();

/** The startup preload. **It must be awaited ONCE before initShell()**, or readSettings() reads nothing
 *  but empties. This is where the original `initShell()`'s "make the directories + clear the log" now
 *  belongs in Tauri: the Rust side has already done it. */
export async function preloadShell(): Promise<ShellSnapshot> {
  const snap = await invoke<ShellSnapshot>("preload_shell");
  state.snapshot = snap;
  state.windowFocused = snap.focused;
  void listen("win-focus", () => {
    state.windowFocused = true;
    focusListeners.forEach((cb) => cb());
  });
  void listen("win-blur", () => {
    state.windowFocused = false;
    blurListeners.forEach((cb) => cb());
  });
  void listen("win-geometry", () => {
    geometryListeners.forEach((cb) => cb());
  });
  // The Rust-side backstop: capture is on but the window is not foreground (`ClipCursor` does not look
  // at the foreground), so within ~32ms it is torn down and this side is notified.
  void listen("capture-lost", () => {
    captureLostListeners.forEach((cb) => cb());
  });
  flushSoon();
  return snap;
}

export function shellInfo(): ShellSnapshot {
  return state.snapshot;
}

/** The earliest diagnostic channel: **it hits the IPC global directly, bypassing @tauri-apps/api**.
 *
 *  It exists for the moment "the front end died before it was up" — the `invoke` wrapper and the log
 *  batching below are both still unavailable then, and in Tauri a dead front end is **silent**: no
 *  window, not one line in debug.log, indistinguishable from outside from "stuck in the loader" (this
 *  trap was really hit twice).
 *  It writes the message to logs\boot.log; call sites are main.ts's preload try/catch and index.html's
 *  inline script. */
export function bootReport(message: string): void {
  try {
    const internals = (
      globalThis as unknown as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => unknown };
      }
    ).__TAURI_INTERNALS__;
    void internals?.invoke?.("boot_report", { message });
  } catch {
    /* Not even the IPC is reachable: index.html's title-writing fallback is all that is left */
  }
}

// ===== Log batching =====
// The QUEUE and the two thresholds are data too: they live in `data/globals/shell.ts` (SHELL_STATE.pending
// + FLUSH_LINES/FLUSH_MS), and this module only drives them.
function flush(channel: "debug" | "renderer"): void {
  const lines = state.pending[channel].splice(0, state.pending[channel].length);
  if (lines.length === 0) return;
  void invoke("append_log", { channel, lines }).catch(() => {});
}

function flushSoon(): void {
  if (state.flushTimer !== null) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    flush("debug");
    flush("renderer");
  }, FLUSH_MS) as unknown as number;
}

function queue(channel: "debug" | "renderer", line: string): void {
  state.pending[channel].push(line);
  if (state.pending[channel].length >= FLUSH_LINES) flush(channel);
  else flushSoon();
}

// Flush the remaining log lines before the window closes (the original wrote synchronously, so it never
// had this problem)
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    flush("debug");
    flush("renderer");
  });
}

// ===== Startup init: errors and console go to renderer.log / debug.log (the second half of the original
// initShell) =====
export function initShell(): void {
  window.addEventListener("error", (e) => {
    appendDebugLog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    appendDebugLog(`REJECT ${String(e.reason)}`);
  });

  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => {
    queue("renderer", `[${new Date().toISOString()}] ${a.map(String).join(" ")}`);
    origError(...a);
  };
  console.warn = (...a: unknown[]) => {
    queue("renderer", `[${new Date().toISOString()}] ${a.map(String).join(" ")}`);
    origWarn(...a);
  };
}

// ===== The "Diagnostic log" switch (the settings panel toggle) =====
// Why: to chase "the view is not smooth while a key is held", probe lines were hung off the
// input / frame / cursor / key-bind paths (`FRAME`/`LOOK`/`RAWLAG`/`RAWMON`/`STALL`/`PHYS`/`SPACE#`/
// `MOUSE#`/`HOOKPROBE`/`KBCAP`/`RAWINPUT takeover`). They are useful (next time this class of problem
// comes up, read the log), but several of them fire on ordinary mouse activity and write to disk forever.
// So there is a switch, **on by default**; with it off debug.log keeps only the real event records
// (BOOT / SETTINGS / WORLD / LOCK / CURSOR / GEOMETRY / ERROR / REJECT / DIAGLOG …).
//
// WHICH lines are probes is DATA — the prefix table and the diagnostic-vs-event rule it draws live in
// `data/globals/probes.ts`. The switch's **one filter point is inside logDebug** (every probe line passes
// through there), so adding a probe means adding its prefix to that table and nothing else. Everything
// outside `logDebug` is unaffected: `appendDebugLog` is the error/console channel and always writes.
export function isDiagLogEnabled(): boolean {
  return state.diagLogEnabled;
}
export function setDiagLogEnabled(on: boolean): void {
  state.diagLogEnabled = on;
}
function isProbeLine(line: string): boolean {
  for (const p of PROBE_PREFIXES) if (line.startsWith(p)) return true;
  return false;
}

// logs\debug.log only: the exact line, no timestamp (the shell's own error handlers)
export function appendDebugLog(line: string): void {
  queue("debug", line);
}

// logs\debug.log with a [<ms>ms] prefix — the general-purpose logger every module uses
export function logDebug(line: string): void {
  // probes off: stay off disk (event records still write)
  if (!state.diagLogEnabled && isProbeLine(line)) return;
  appendDebugLog(`[${performance.now().toFixed(0)}ms] ${line}`);
}

// ===== settings.json (the values live in memory, the file is written by Rust) =====
export function readSettings(): Record<string, unknown> {
  return { ...state.snapshot.settings };
}

export function writeSettings(s: Record<string, unknown>): void {
  state.snapshot.settings = { ...s };
  void invoke("write_settings", { value: s }).catch(() => {});
}

// ===== The settings FILE's own health (the judgement is made by Rust, the shape matches the original) =====
export interface SettingsRead {
  readonly settings: Record<string, unknown>;
  /** Why the file cannot be used, or null when it is usable (or simply absent). */
  readonly problem: string | null;
}

export function readSettingsChecked(): SettingsRead {
  return { settings: { ...state.snapshot.settings }, problem: state.snapshot.settingsProblem };
}

/** Keep a copy of the file that is about to be replaced. A broken hand-edit is exactly the case where
 *  the user wants to see what was in there, and the boot repair is the only code that overwrites a file
 *  it could not read — so it is the only code that owes a backup. Returns the path for the report. */
export function backupSettingsFile(): string {
  void invoke<string>("backup_settings").catch(() => {});
  return "config/settings.bad.json";
}

// The settings repair is a PURE comparison that the Node gate drives directly, so it lives in its own
// dependency-free module (this file imports @tauri-apps/api, which Node's CJS require cannot load).
// Re-exported here so no call site changes.
export { diffSettings } from "../../core/services/settings-diff";
export type { SettingsDiff } from "../../core/services/settings-diff";

// ===== Cursor / window =====
// Put the cursor back on the crosshair position when a menu or the backpack opens (the original spawned
// a cursor.exe child process; here Rust computes it in one step)
export function centerCursor(): void {
  void invoke("center_cursor").catch(() => {});
}

// Show window: "visible": false in the config -> only show it after the first frame is rendered (avoids a
// white startup screen)
export function showWindow(): void {
  void invoke("show_window").catch(() => {});
}

// ===== Native window focus =====
// Focus events are forwarded by Rust's WindowEvent::Focused as win-focus / win-blur
const focusListeners = new Set<() => void>();
const blurListeners = new Set<() => void>();
/** The window's geometry changed (resize / move / DPI). Note that it is **not** "the mouse left the
 *  application": while a border is dragged the window still has focus and the cursor is still inside the
 *  window rectangle (merely in the non-client area), so neither blur nor mouseleave arrives — see
 *  main.ts's onWinGeometry and the note in win.rs::reclip_mouse_capture. */
const geometryListeners = new Set<() => void>();
/** Capture was torn down by the Rust side (the system-level backstop for "capture is on but the window is
 *  not foreground"): on this signal the front end releases the mouse and pauses when needed. */
const captureLostListeners = new Set<() => void>();

export function trackWindowFocus(): void {
  state.windowFocused = state.snapshot.focused;
}

export function winFocused(): boolean {
  return state.windowFocused;
}

export function focusWindow(): void {
  void invoke("focus_window").catch(() => {});
}

/** Quit the game: kill the process (the Rust side stops the raw-input thread first) */
export function quitApp(): void {
  void invoke("quit_app").catch(() => {});
}

export function onWinFocus(cb: () => void): void {
  focusListeners.add(cb);
}

export function onWinBlur(cb: () => void): void {
  blurListeners.add(cb);
}

/** The window's geometry changed (resize / move / DPI). It is **not** "the mouse left the application":
 *  while a border or the title bar is dragged the window is still the focused window and the cursor is
 *  still inside the window rectangle (it merely sits in the non-client area), so there is neither blur
 *  nor mouseleave — "the user is fiddling with the window" can only be caught from this signal (see
 *  main.ts's onWinGeometry). */
export function onWinGeometry(cb: () => void): void {
  geometryListeners.add(cb);
}

/** Capture was torn down by the Rust side: `capture-foreground-check` finds "capture is on but the window
 *  is not foreground", releases, and emits this event. The front end must treat it as "the window was
 *  lost" (release the mouse + pause when in a world with no UI) — releasing on the Rust side alone is not
 *  enough, the front end's `INPUT_STATE.locked` would still be true. */
export function onCaptureLost(cb: () => void): void {
  captureLostListeners.add(cb);
}

// ===== The GPU vsync switch =====
// The original rewrote its own package.json's chromium-args; here it lands in config\vsync.json, which
// run() reads before creating the window to decide whether to add --disable-gpu-vsync. Likewise it
// **takes effect on restart**.
export function isGpuVsyncDisabled(): boolean {
  return state.snapshot.vsyncDisabled;
}

export function setGpuVsyncDisabled(disabled: boolean): boolean {
  state.snapshot.vsyncDisabled = disabled;
  void invoke("set_vsync_disabled", { disabled }).catch(() => {});
  return true;
}

// ===== Window mode: windowed / fullscreen =====
export type WindowMode = "windowed" | "fullscreen";

const modeListeners = new Set<() => void>();

export function getWindowMode(): WindowMode {
  return readSettings().windowMode === "fullscreen" ? "fullscreen" : "windowed";
}

export function onWindowModeChange(cb: () => void): void {
  modeListeners.add(cb);
}

function notifyWindowMode(): void {
  modeListeners.forEach((cb) => cb());
}

/** Enter fullscreen per the setting at startup (the original called this after showWindow).
 *  The original used NW.js's kiosk fullscreen (entering and leaving it both keep the maximised state);
 *  Tauri goes through its own set_fullscreen, which has none of kiosk's HWND_TOPMOST side effects, so the
 *  original's unTopmost() patch is not needed here. */
export function applyWindowModeAtStart(): void {
  if (getWindowMode() === "fullscreen") {
    void invoke("set_window_mode", { fullscreen: true }).catch(() => {});
  }
}

export function setWindowMode(mode: WindowMode): void {
  const s = readSettings();
  s.windowMode = mode;
  writeSettings(s);
  notifyWindowMode();
  void invoke("set_window_mode", { fullscreen: mode === "fullscreen" }).catch(() => {});
}
