// ===== NW.js 渲染层 Node 直连 (替代旧 Electron 的 preload.cjs + main.cjs, 无需 IPC) =====
// NW.js 渲染层自带 Node: 直接 fs/execFile, 日志与光标居中不再走主进程。
// 用 eval("require") 拿 Node require: 避免 vite/rolldown 把 node: 模块 externalize
// 成空对象(浏览器兼容处理), 那会导致 fs 为 undefined 运行时崩溃。NW.js 无 CSP, eval 可用。
const req = eval("require") as (id: string) => any;
const fs = req("node:fs");
const path = req("node:path");
const { execFile } = req("node:child_process");

// game\ 根目录: process.execPath = game\core\core.exe -> 上级即 game\
const gameRoot = path.join(path.dirname(process.execPath), "..");
const logsDir = path.join(gameRoot, "logs");
const coreDir = path.dirname(process.execPath);
const configPath = path.join(gameRoot, "config", "settings.json");

function ensureDirs(): void {
  for (const d of ["logs", "saves", "config", "mods"]) {
    fs.mkdirSync(path.join(gameRoot, d), { recursive: true });
  }
}

// 启动初始化: 建目录 + 清空日志 + 挂错误落盘 (对应旧 main.cjs 的日志功能)
export function initShell(): void {
  ensureDirs();
  trackWindowFocus();
  fs.writeFileSync(path.join(logsDir, "debug.log"), "", "utf8");
  fs.writeFileSync(path.join(logsDir, "renderer.log"), "", "utf8");

  window.addEventListener("error", (e) => {
    appendLog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    appendLog(`REJECT ${String(e.reason)}`);
  });

  // console error/warning 级写 logs\renderer.log (对应旧 main.cjs console-message)
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

// 调试日志 -> game\logs\debug.log (启动已清空), 失败静默 (不打断游戏)
export function appendLog(line: string): void {
  try {
    fs.appendFileSync(path.join(logsDir, "debug.log"), `${line}\n`, "utf8");
  } catch {}
}

// 用户设置 -> game\config\settings.json (不存在返回空对象, 读写失败静默)
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

// 带相对启动时刻时间戳的调试日志 (各模块共用)
export function sendLog(line: string): void {
  appendLog(`[${performance.now().toFixed(0)}ms] ${line}`);
}

function appendRender(line: string): void {
  try {
    fs.appendFileSync(path.join(logsDir, "renderer.log"), `${line}\n`, "utf8");
  } catch {}
}

// 光标居中到屏幕中心: nw.Window 坐标 -> cursor.exe (SetCursorPos)。
// 菜单/背包打开时光标落在准星位置 (旧 Electron 主进程 setCursorPos 的等价物)
export function centerCursor(): void {
  try {
    const win = nw.Window.get();
    const cx = String(Math.round(win.x + win.width / 2));
    const cy = String(Math.round(win.y + win.height / 2));
    execFile(path.join(coreDir, "cursor.exe"), [cx, cy], () => {});
  } catch {}
}

// 显示窗口: manifest "show": false -> 首帧渲染后调用 (对应旧 Electron ready-to-show, 防启动闪白)。
// 窗口默认不获取焦点 (NW.js 特性), show 后显式 focus 对齐原生/DOM 焦点状态
export function showWindow(): void {
  try {
    const win = nw.Window.get();
    win.show();
    win.focus();
  } catch {}
}

// ===== 原生窗口焦点 (NW.js 官方 API: win.on('focus'/'blur') 事件, 无 isFocused 属性) =====
// 官方 Window 参考文档没有 isFocused 属性, 只有 focus/blur 事件与 focus()/blur() 方法。
// 这里用事件维护一个窗口焦点布尔, 供诊断/门控使用。

let windowFocused = false;

// 初始化焦点追踪 (initShell 调用): 注册原生 focus/blur 事件
export function trackWindowFocus(): void {
  try {
    const win = nw.Window.get();
    win.on("focus", () => {
      windowFocused = true;
    });
    win.on("blur", () => {
      windowFocused = false;
    });
    // showWindow 已调用 win.focus(), 乐观初始为聚焦; 后续 blur 事件会纠正
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

// 退出游戏: 关闭窗口 (唯一窗口关闭后应用退出)
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

// ===== GPU 垂直同步开关 (--disable-gpu-vsync) =====
// 直接改写自身 manifest (game\core\package.json) 的 chromium-args, 重启游戏生效
const manifestPath = path.join(coreDir, "package.json");

// 当前是否关闭了垂直同步 (manifest 含 --disable-gpu-vsync)
export function getGpuVsyncState(): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return String(pkg["chromium-args"] ?? "").includes("--disable-gpu-vsync");
  } catch {
    return false;
  }
}

// ===== 窗口模式: 窗口化 / 全屏 (NW.js 运行时 kiosk 切换, 免重启) =====
// 对齐 Electron 菜单 F11 (togglefullscreen role = win.setFullScreen 切换):
// 不做任何窗口状态保存/恢复, 窗口化几何与最大化状态全部交给 Chromium 自行管理
export type WindowMode = "windowed" | "fullscreen";

const modeListeners = new Set<() => void>();

// 当前窗口模式 (来自设置持久化, 默认窗口化)
export function getWindowMode(): WindowMode {
  return readSettings().windowMode === "fullscreen" ? "fullscreen" : "windowed";
}

export function onWindowModeChange(cb: () => void): void {
  modeListeners.add(cb);
}

function notifyWindowMode(): void {
  modeListeners.forEach((cb) => cb());
}

// 启动应用: 设置存的是全屏则进入全屏 (showWindow 后调用)。
// 全屏内 ESC 不退出全屏 (游戏 ESC 用于弹菜单), 退出全屏走设置面板"窗口化"按钮
export function applyWindowModeAtStart(): void {
  try {
    // NW.js Window API 类型定义缺失 isFullscreen/enterFullscreen, 用 any 调用
    const win = nw.Window.get() as any;
    if (getWindowMode() === "fullscreen" && !win.isFullscreen) {
      win.enterKioskMode();
      unTopmost();
    }
  } catch {}
}

// 进入全屏前的窗口是否处于最大化 (win.width/height 在最大化时=含边框的屏幕尺寸)
let wasMaximizedBeforeFullscreen = false;

// kiosk 进全屏会自动置顶 (HWND_TOPMOST), 立即取消, 恢复普通全屏 Z 序行为。
// 优先用 NW.js 自带 JS 接口 setAlwaysOnTop(false) (chrome.windows.update alwaysOnTop 分支,
// 不碰 state 逻辑)。备用: winctl.exe topmost 0 (SetWindowPos 同步原生, 已测可靠)
function unTopmost(): void {
  try {
    const win = nw.Window.get() as any;
    if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(false);
    // execFile(path.join(coreDir, "winctl.exe"), ["topmost", "0"], () => {});
  } catch {}
}

// 切换窗口模式: 写设置 + 通知 UI + 运行时切换窗口 (免重启)。
// 对齐 Electron togglefullscreen (win.setFullScreen 切换): 直接切换, 不做任何预处理。
// 注意: NW.js kNWNewWin 下 win.enterFullscreen() → chrome.windows.update({state:"fullscreen"})
// 内部会先 Restore() 取消最大化再全屏 (WindowsUpdateFunction), 产生 1280x720 中间帧且丢失最大化。
// 改用 kiosk 模式: enterKioskMode/leaveKioskMode 走 C++ BrowserWidget::SetFullscreen 直连路径
// (ProcessFullscreen 保存/恢复完整样式含 WS_MAXIMIZE), 无中间帧且退出自动恢复最大化, 与 Electron 一致。
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

// 写入开关状态: on=true 加旗标(关闭垂直同步), false 移除; 返回是否成功
export function setGpuVsyncState(on: boolean): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const args = String(pkg["chromium-args"] ?? "")
      .split(/\s+/)
      .filter((s) => s.length > 0 && s !== "--disable-gpu-vsync");
    if (on) args.push("--disable-gpu-vsync");
    pkg["chromium-args"] = args.join(" ");
    fs.writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}