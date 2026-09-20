// ===== Tauri 壳：settings / 日志 / 窗口 / vsync（原 NW.js 版的 platform/shell.ts）=====
//
// 原版直接 `eval("require")("node:fs")` 同步读写文件、`nw.Window.get()` 操作窗口。
// Tauri 没有同步 IPC，所以这里的策略是：
//
//   * **读**：启动时 `preloadShell()` 一次 invoke 把 settings / 窗口模式 / vsync 开关
//     全部拿进内存，之后 `readSettings()` 读内存 —— 保持**同步**，调用点一个都不用改。
//   * **写**：`writeSettings()` 先更新内存、再 fire-and-forget 丢给 Rust。
//   * **日志**：攒批（64 行或 200ms）再发一次 `append_log`。原版是每行一次同步 appendFile，
//     照搬到 Tauri 会变成每帧一个 IPC —— 这是必需的一处行为改动，已在 README 里写明。
//   * **窗口**：全部走自定义命令（src-tauri/src/win.rs），所以不需要 window 插件的权限。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Rust `preload_shell` 返回的东西（字段名与 serde 的 camelCase 一一对应） */
export interface ShellSnapshot {
  gameRoot: string;
  dev: boolean;
  settings: Record<string, unknown>;
  settingsProblem: string | null;
  windowMode: string;
  vsyncDisabled: boolean;
  focused: boolean;
  browserArgs: string;
  platform: string;
}

let snapshot: ShellSnapshot = {
  gameRoot: "(未初始化)",
  dev: false,
  settings: {},
  settingsProblem: null,
  windowMode: "windowed",
  vsyncDisabled: true,
  focused: true,
  browserArgs: "",
  platform: "tauri",
};

/** 启动预载。**必须在 initShell() 之前 await 一次**，否则 readSettings() 读到的全是空。
 *  这就是原来的 `initShell()` 里"建目录 + 清日志"那段在 Tauri 里的位置：Rust 侧已经做完了。 */
export async function preloadShell(): Promise<ShellSnapshot> {
  const snap = await invoke<ShellSnapshot>("preload_shell");
  snapshot = snap;
  windowFocused = snap.focused;
  void listen("win-focus", () => {
    windowFocused = true;
    focusListeners.forEach((cb) => cb());
  });
  void listen("win-blur", () => {
    windowFocused = false;
    blurListeners.forEach((cb) => cb());
  });
  void listen("win-geometry", () => {
    geometryListeners.forEach((cb) => cb());
  });
  // Rust 侧的兜底：捕获开着但窗口不是前台（ClipCursor 不看前台），约 32ms 内就会被拆掉并通知这里。
  void listen("capture-lost", () => {
    captureLostListeners.forEach((cb) => cb());
  });
  flushSoon();
  return snap;
}

export function shellInfo(): ShellSnapshot {
  return snapshot;
}

/** 最早期诊断通道：**直接打 IPC 全局，不经过 @tauri-apps/api**。
 *
 *  用途是"前端还没起来就挂了"的那一瞬间 —— 那时 `invoke` 的封装、下面的日志攒批
 *  都还不可用，而 Tauri 里前端挂掉是**静默**的：没有窗口、debug.log 一行都没有，
 *  从外面看跟"卡在加载器"一模一样（这个坑真踩过两次）。
 *  它把消息写进 logs\boot.log；调用点见 main.ts 的 preload try/catch 和 index.html 的 inline 脚本。 */
export function bootReport(message: string): void {
  try {
    const internals = (
      globalThis as unknown as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => unknown };
      }
    ).__TAURI_INTERNALS__;
    void internals?.invoke?.("boot_report", { message });
  } catch {
    /* 连 IPC 都拿不到：那就只剩 index.html 里那个把消息写进标题的兜底了 */
  }
}

// ===== 日志攒批 =====
const pending: Record<string, string[]> = { debug: [], renderer: [] };
const FLUSH_LINES = 64;
const FLUSH_MS = 200;
let flushTimer: number | null = null;

function flush(channel: "debug" | "renderer"): void {
  const lines = pending[channel].splice(0, pending[channel].length);
  if (lines.length === 0) return;
  void invoke("append_log", { channel, lines }).catch(() => {});
}

function flushSoon(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush("debug");
    flush("renderer");
  }, FLUSH_MS) as unknown as number;
}

function queue(channel: "debug" | "renderer", line: string): void {
  pending[channel].push(line);
  if (pending[channel].length >= FLUSH_LINES) flush(channel);
  else flushSoon();
}

// 关窗前把剩下的日志吐出去（原版是同步写，不会有这个问题）
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    flush("debug");
    flush("renderer");
  });
}

// ===== 启动初始化：错误与 console 落 renderer.log / debug.log（原版 initShell 的后半段）=====
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

// ===== 诊断探针的开关（设置面板里的"日志检测"）=====
// 原因：为了查"按住键转视角不顺滑"，输入/帧/光标这几条路都挂上了周期性的探针行（`FRAME`/`LOOK`/
// `RAWLAG`/`RAWMON`/`STALL`/`PHYS`/`SPACE#`/`MOUSE#`/`HOOKPROBE`）。它们很有用（以后再查这类问题
// 直接看日志），但一秒好几行、会一直写盘。所以给一个开关，**默认开**，关掉后 debug.log 只留真正的
// 事件记录（BOOT / SETTINGS / LOCK / CURSOR / GEOMETRY / ERROR / REJECT / KBCAP…）。
//
// 开关的**唯一过滤点在 logDebug 里**（所有探针行都从那里过），所以加探针只需要把前缀加进这张表。
// `loadDebugLog` 之外的东西不受影响：`appendDebugLog` 是错误/console 的通道，永远写。
let diagLogEnabled = true;
/** 探针行的前缀（`SPACE#`/`MOUSE#`/`LOOK#` 带序号，所以按前缀判）。 */
const PROBE_PREFIXES = [
  "PHYS ",
  "FRAME ",
  "STALL ",
  "LOOK#",
  "RAWLAG ",
  "RAWMON ",
  "HOOKPROBE ",
  "SPACE#",
  "MOUSE#",
];
export function isDiagLogEnabled(): boolean {
  return diagLogEnabled;
}
export function setDiagLogEnabled(on: boolean): void {
  diagLogEnabled = on;
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
  if (!diagLogEnabled && isProbeLine(line)) return; // 探针关掉：不写盘（事件记录照写）
  appendDebugLog(`[${performance.now().toFixed(0)}ms] ${line}`);
}

// ===== settings.json（值在内存里，文件由 Rust 写）=====
export function readSettings(): Record<string, unknown> {
  return { ...snapshot.settings };
}

export function writeSettings(s: Record<string, unknown>): void {
  snapshot.settings = { ...s };
  void invoke("write_settings", { value: s }).catch(() => {});
}

// ===== The settings FILE's own health（判定由 Rust 做，形状与原版一致）=====
export interface SettingsRead {
  readonly settings: Record<string, unknown>;
  /** Why the file cannot be used, or null when it is usable (or simply absent). */
  readonly problem: string | null;
}

export function readSettingsChecked(): SettingsRead {
  return { settings: { ...snapshot.settings }, problem: snapshot.settingsProblem };
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
export { diffSettings } from "./settings-diff";
export type { SettingsDiff } from "./settings-diff";

// ===== 光标 / 窗口 =====
// 菜单和背包打开时把光标放回准星位置（原版走 cursor.exe 子进程，这里 Rust 一步算完）
export function centerCursor(): void {
  void invoke("center_cursor").catch(() => {});
}

// Show window: 配置里 "visible": false -> 第一帧渲染完之后才显示（避免启动白屏）
export function showWindow(): void {
  void invoke("show_window").catch(() => {});
}

// ===== 原生窗口焦点 =====
// 焦点事件由 Rust 的 WindowEvent::Focused 转发成 win-focus / win-blur
let windowFocused = false;
const focusListeners = new Set<() => void>();
const blurListeners = new Set<() => void>();
/** 窗口几何变化（缩放 / 移动 / DPI）。注意它**不是**"鼠标离开应用"：拖边框时窗口仍然有焦点、
 *  光标也还在窗口矩形内（只是在非客户区），所以 blur/mouseleave 都不会来 —— 见 main.ts 的
 *  onWinGeometry 和 win.rs::reclip_mouse_capture 里那段说明。 */
const geometryListeners = new Set<() => void>();
/** 捕获被 Rust 侧拆掉了（"捕获开着但窗口不是前台"的系统级兜底）：前端据此放鼠标、必要时暂停。 */
const captureLostListeners = new Set<() => void>();

export function trackWindowFocus(): void {
  windowFocused = snapshot.focused;
}

export function winFocused(): boolean {
  return windowFocused;
}

export function focusWindow(): void {
  void invoke("focus_window").catch(() => {});
}

/** Quit the game: 关掉进程（Rust 侧会先停掉原始输入线程） */
export function quitApp(): void {
  void invoke("quit_app").catch(() => {});
}

export function onWinFocus(cb: () => void): void {
  focusListeners.add(cb);
}

export function onWinBlur(cb: () => void): void {
  blurListeners.add(cb);
}

/** 窗口几何变了（缩放 / 移动 / DPI）。它**不是**"鼠标离开应用"：拖边框/标题栏时窗口仍然是焦点窗口，
 *  光标也还在窗口矩形里（只是落在非客户区），所以既没有 blur 也不会 mouseleave —— 想抓"用户在弄窗口"
 *  只能靠这个信号（见 main.ts 的 onWinGeometry）。 */
export function onWinGeometry(cb: () => void): void {
  geometryListeners.add(cb);
}

/** 捕获被 Rust 侧拆掉了：`capture-foreground-check` 发现"捕获开着但窗口不是前台"就会释放并发这个事件。
 *  前端要把它当"丢了窗口"处理（放鼠标 + 世界里且无 UI 时暂停）—— 只在 Rust 侧释放不够，前端的
 *  `INPUT_STATE.locked` 还是 true。 */
export function onCaptureLost(cb: () => void): void {
  captureLostListeners.add(cb);
}

// ===== GPU vsync 开关 =====
// 原版改写自己的 package.json 的 chromium-args；这里落一个 config\vsync.json，
// run() 在创建窗口之前读它决定要不要加 --disable-gpu-vsync。同样是**重启生效**。
export function isGpuVsyncDisabled(): boolean {
  return snapshot.vsyncDisabled;
}

export function setGpuVsyncDisabled(disabled: boolean): boolean {
  snapshot.vsyncDisabled = disabled;
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

/** 启动时按设置进全屏（原版在 showWindow 之后调）。
 *  原版用的是 NW.js 的 kiosk 全屏（进出都不掉最大化状态），Tauri 走自己的 set_fullscreen，
 *  没有 kiosk 那套 HWND_TOPMOST 副作用，所以原版那个 unTopmost() 补丁在这里不需要。 */
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
