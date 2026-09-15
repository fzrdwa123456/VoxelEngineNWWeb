// ===== NW.js renderer-side direct Node access (replaces the old Electron preload.cjs + main.cjs; no IPC needed) =====
// The NW.js renderer ships Node: use fs/execFile directly; logging and cursor centering no longer go through a main process.
// Use eval("require") to obtain the Node require: prevents vite/rolldown from externalizing node: modules
// into empty objects (browser-compat handling), which would make fs undefined and crash at runtime. NW.js has no CSP, so eval works.
const req = eval("require") as (id: string) => any;
const fs = req("node:fs");
const path = req("node:path");
const { execFile } = req("node:child_process");

// game\ root: process.execPath = game\core\core.exe -> parent is game\
const gameRoot = path.join(path.dirname(process.execPath), "..");
const logsDir = path.join(gameRoot, "logs");
const coreDir = path.dirname(process.execPath);
const configPath = path.join(gameRoot, "config", "settings.json");

function ensureDirs(): void {
  for (const d of ["logs", "saves", "config", "mods"]) {
    fs.mkdirSync(path.join(gameRoot, d), { recursive: true });
  }
}

// Startup init: create dirs + truncate logs + attach error persistence (replaces old main.cjs logging)
export function initShell(): void {
  ensureDirs();
  trackWindowFocus();
  fs.writeFileSync(path.join(logsDir, "debug.log"), "", "utf8");
  fs.writeFileSync(path.join(logsDir, "renderer.log"), "", "utf8");

  window.addEventListener("error", (e) => {
    appendDebugLog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    appendDebugLog(`REJECT ${String(e.reason)}`);
  });

    // console error/warning levels go to logs\renderer.log (replaces old main.cjs console-message)
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a) => {
    appendRender(`[${new Date().toISOString()}] ${a.map(String).join(" ")}`);
    origError(...a);
  };
  console.warn = (...a) => {
    appendRender(`[${new Date().toISOString()}] ${a.map(String).join(" ")}`);
    origWarn(...a);
  };
}

// logs\debug.log only: the exact line, no timestamp (the shell's own error handlers)
export function appendDebugLog(line: string): void {
  try {
    fs.appendFileSync(path.join(logsDir, "debug.log"), `${line}\n`, "utf8");
  } catch {}
}

// User settings -> game\config\settings.json (empty object when missing; silent on read/write failure)
export function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeSettings(s: Record<string, unknown>): void {
  try {
    fs.writeFileSync(configPath, JSON.stringify(s, null, 2) + "\n", "utf8");
  } catch {}
}

// logs\debug.log with a [<ms>ms] prefix — the general-purpose logger every module uses
export function logDebug(line: string): void {
  appendDebugLog(`[${performance.now().toFixed(0)}ms] ${line}`);
}

function appendRender(line: string): void {
  try {
    fs.appendFileSync(path.join(logsDir, "renderer.log"), `${line}\n`, "utf8");
  } catch {}
}

// Center the cursor on screen center: nw.Window coords -> cursor.exe (SetCursorPos).
// The cursor lands on the crosshair when menus/inventory open (equivalent of the old Electron main-process setCursorPos)
export function centerCursor(): void {
  try {
    const win = nw.Window.get();
    const cx = String(Math.round(win.x + win.width / 2));
    const cy = String(Math.round(win.y + win.height / 2));
    execFile(path.join(coreDir, "cursor.exe"), [cx, cy], () => {});
  } catch {}
}

// Show window: manifest "show": false -> called after the first frame renders (replaces Electron ready-to-show; prevents startup white flash).
// The window does not take focus by default (NW.js behavior); show() then explicit focus() to align native/DOM focus state
export function showWindow(): void {
  try {
    const win = nw.Window.get();
    win.show();
    win.focus();
  } catch {}
}

// ===== Native window focus (NW.js official API: win.on('focus'/'blur') events; no isFocused property) =====
// The official Window reference has no isFocused property, only focus/blur events and focus()/blur() methods.
// We maintain a focus boolean from those events for diagnostics/gating.

let windowFocused = false;

// Init focus tracking (called by initShell): register native focus/blur events
export function trackWindowFocus(): void {
  try {
    const win = nw.Window.get();
    win.on("focus", () => {
      windowFocused = true;
    });
    win.on("blur", () => {
      windowFocused = false;
    });
        // showWindow already called win.focus(); optimistically start focused; later blur events correct it
    windowFocused = true;
  } catch {}
}

export function winFocused(): boolean {
  return windowFocused;
}

export function focusWindow(): void {
  try {
    nw.Window.get().focus();
  } catch {}
}

// Quit the game: close the window (the app exits when its only window closes)
export function quitApp(): void {
  try {
    nw.Window.get().close();
  } catch {}
}

export function onWinFocus(cb: () => void): void {
  try {
    nw.Window.get().on("focus", cb);
  } catch {}
}

export function onWinBlur(cb: () => void): void {
  try {
    nw.Window.get().on("blur", cb);
  } catch {}
}

// ===== GPU vsync switch (--disable-gpu-vsync) =====
// Rewrites chromium-args in its own manifest (game\core\package.json); takes effect after a game restart
const manifestPath = path.join(coreDir, "package.json");

// Whether vsync is currently disabled (manifest contains --disable-gpu-vsync)
export function isGpuVsyncDisabled(): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return String(pkg["chromium-args"] ?? "").includes("--disable-gpu-vsync");
  } catch {
    return false;
  }
}

// ===== Window mode: windowed / fullscreen (NW.js runtime kiosk switch, no restart) =====
// Mirrors the Electron menu F11 (togglefullscreen role = win.setFullScreen switch):
// no window-state save/restore; windowed geometry and maximized state are left entirely to Chromium
export type WindowMode = "windowed" | "fullscreen";

const modeListeners = new Set<() => void>();

// Current window mode (from persisted settings, default windowed)
export function getWindowMode(): WindowMode {
  return readSettings().windowMode === "fullscreen" ? "fullscreen" : "windowed";
}

export function onWindowModeChange(cb: () => void): void {
  modeListeners.add(cb);
}

function notifyWindowMode(): void {
  modeListeners.forEach((cb) => cb());
}

// At startup: enter fullscreen if settings say so (called after showWindow).
// ESC inside fullscreen does not exit it (the game ESC opens the menu); exiting fullscreen goes through the settings panel "windowed" button
export function applyWindowModeAtStart(): void {
  try {
        // NW.js Window API typings lack isFullscreen/enterFullscreen; call via any
    const win = nw.Window.get() as any;
    if (getWindowMode() === "fullscreen" && !win.isFullscreen) {
      win.enterKioskMode();
      unTopmost();
    }
  } catch {}
}

// Whether the window was maximized before entering fullscreen (win.width/height while maximized = screen size incl. frame)
let wasMaximizedBeforeFullscreen = false;

// kiosk fullscreen auto-sets TOPMOST (HWND_TOPMOST); cancel immediately to restore normal fullscreen Z-order behavior.
// Prefer NW.js's own JS API setAlwaysOnTop(false) (the chrome.windows.update alwaysOnTop branch,
// without touching state logic). Fallback: winctl.exe topmost 0 (SetWindowPos, synchronous native, verified reliable)
function unTopmost(): void {
  try {
    const win = nw.Window.get() as any;
    if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(false);
    // execFile(path.join(coreDir, "winctl.exe"), ["topmost", "0"], () => {});
  } catch {}
}

// Switch window mode: write settings + notify UI + switch the window at runtime (no restart).
// Mirrors Electron togglefullscreen (win.setFullScreen switch): flip directly, no preprocessing.
// Note: under NW.js kNWNewWin, win.enterFullscreen() -> chrome.windows.update({state:"fullscreen"})
// internally Restores the maximized window before going fullscreen (WindowsUpdateFunction), producing a 1280x720 intermediate frame and losing maximized.
// Use kiosk instead: enterKioskMode/leaveKioskMode go through the C++ BrowserWidget::SetFullscreen direct path
// (ProcessFullscreen saves/restores the full style incl. WS_MAXIMIZE); no intermediate frame and exit restores maximized, matching Electron.
export function setWindowMode(mode: WindowMode): void {
  try {
    const s = readSettings();
    s.windowMode = mode;
    writeSettings(s);
    notifyWindowMode();
    const win = nw.Window.get() as any;
    if (mode === "fullscreen") {
      wasMaximizedBeforeFullscreen =
        win.width >= screen.width || win.height >= screen.height;
      if (!win.isFullscreen) {
        win.enterKioskMode();
        unTopmost();
      }
    } else {
      if (win.isFullscreen) win.leaveKioskMode();
    }
  } catch {}
}

// Write the switch: disabled=true adds --disable-gpu-vsync, false removes it; returns success
export function setGpuVsyncDisabled(disabled: boolean): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const args = String(pkg["chromium-args"] ?? "")
      .split(/\s+/)
      .filter((s) => s.length > 0 && s !== "--disable-gpu-vsync");
    if (disabled) args.push("--disable-gpu-vsync");
    pkg["chromium-args"] = args.join(" ");
    fs.writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}