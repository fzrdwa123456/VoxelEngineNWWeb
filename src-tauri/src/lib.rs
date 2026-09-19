// VoxelEngine / Tauri 壳
//
// 这个文件是**命令总线**：前端 src/platform/*.ts 通过 invoke() 调这里，
// 这里再分发给 game.rs（文件/设置/日志）、packs.rs（资源包）、win.rs（窗口）、rawinput.rs（原始输入）。
//
// 关键设计（为什么前端改动这么小）：
//   原 NW.js 版里 src/platform/shell.ts 的 readSettings()/logDebug() 是**同步**的，
//   而 Tauri 的命令是异步的。所以这里不试图把同步 IO 变异步，而是：
//   启动时用一次 invoke("preload_shell") 把 settings / 窗口模式 / vsync 开关一次性取到前端内存里，
//   之后 readSettings() 读内存（同步，语义不变），写操作 fire-and-forget 回来。
//   同一招用在资源包上：invoke("preload_packs") 一次拿走所有包字节，
//   rendering/textures.ts 里那套归一化/优先级逻辑一行都不用改。
//
// 于是 src/ 里除了 platform/shell.ts、platform/rawinput.ts、rendering/textures.ts 三个文件，
// 其余 100+ 处调用点（main.ts、ui/*、ecs/*、blockregistry.ts ...）全都没动。
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

mod game;
mod packs;
mod rawinput;
mod win;

struct AppState {
    root: PathBuf,
    /// settings.json 的内存副本（前端 readSettings() 的同步来源）
    settings: Mutex<Value>,
    /// 启动时检查出来的问题（坏 JSON / 不是对象），交给前端做启动修复
    problem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellSnapshot {
    /// 游戏数据根目录（日志里会显示，排查问题时一眼看到）
    game_root: String,
    dev: bool,
    settings: Value,
    settings_problem: Option<String>,
    window_mode: String,
    vsync_disabled: bool,
    focused: bool,
    browser_args: String,
    platform: String,
}

/// 启动预载：设置 + 窗口状态。前端在 main.ts 顶部 await 一次。
#[tauri::command]
fn preload_shell(state: State<'_, AppState>, window: tauri::WebviewWindow) -> ShellSnapshot {
    let root = state.root.clone();
    game::ensure_dirs(&root);
    let settings = state.settings.lock().unwrap().clone();
    let window_mode = settings
        .get("windowMode")
        .and_then(Value::as_str)
        .filter(|m| *m == "fullscreen")
        .unwrap_or("windowed")
        .to_string();
    ShellSnapshot {
        game_root: root.display().to_string(),
        dev: cfg!(debug_assertions),
        settings,
        settings_problem: state.problem.clone(),
        window_mode,
        vsync_disabled: game::read_vsync_disabled(&root),
        focused: window.is_focused().unwrap_or(false),
        browser_args: std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default(),
        platform: format!("tauri/{} {}", tauri::VERSION, std::env::consts::OS),
    }
}

#[tauri::command]
fn write_settings(state: State<'_, AppState>, value: Value) -> bool {
    *state.settings.lock().unwrap() = value.clone();
    game::write_settings(&state.root, &value)
}

#[tauri::command]
fn backup_settings(state: State<'_, AppState>) -> String {
    game::backup_settings(&state.root)
}

#[tauri::command]
fn append_log(state: State<'_, AppState>, channel: String, lines: Vec<String>) {
    game::append_log(&state.root, &channel, &lines);
}

/// 最早期诊断通道：前端（包括 index.html 里那个 inline 脚本）在**任何东西就绪之前**
/// 就能调它，把"我起来了 / 我挂了，原因是 X"写进 logs\boot.log。
/// 存在的理由：Tauri 里前端挂掉是静默的 —— 没有窗口、debug.log 一行都没有，
/// 从外面看跟"卡在加载器"一模一样（这个坑真踩过两次）。
#[tauri::command]
fn boot_report(state: State<'_, AppState>, message: String) {
    game::append_boot(&state.root, &message);
}

#[tauri::command]
fn preload_packs(state: State<'_, AppState>) -> packs::PackSnapshot {
    packs::snapshot(&state.root)
}

#[tauri::command]
fn show_window(window: tauri::WebviewWindow) -> bool {
    let ok = window.show().is_ok();
    let _ = window.set_focus();
    ok
}

#[tauri::command]
fn focus_window(window: tauri::WebviewWindow) {
    let _ = window.set_focus();
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    rawinput::stop();
    app.exit(0);
}

#[tauri::command]
fn center_cursor(window: tauri::WebviewWindow) -> bool {
    win::center_cursor(&window)
}

#[tauri::command]
fn set_window_mode(window: tauri::WebviewWindow, fullscreen: bool) -> bool {
    win::set_fullscreen(&window, fullscreen)
}

/// 原生鼠标捕获开关（**不走 Pointer Lock API**）。见 win.rs 的说明：
/// ClipCursor + SetCursorPos 把系统光标夹在窗口里，于是没有 ESC 解锁手势、没有解锁后的冷却期、
/// 没有"锁被浏览器拿走"这一整类问题。返回 false 时前端会退回 requestPointerLock。
/// 前端告诉我们**期望**光标可见还是隐藏（`pointerlock.applyCursor()` 的值变化时调一次）。
/// 之后由 `win::cursor_sentinel()` 每 8ms 校对并纠正 —— 见 win.rs 里那段说明。
#[tauri::command]
fn cursor_intent(app: AppHandle, window: tauri::WebviewWindow, visible: bool) {
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => 0,
    };
    win::set_cursor_intent(&app, hwnd, visible);
}

#[tauri::command]
fn mouse_capture(state: State<'_, AppState>, window: tauri::WebviewWindow, on: bool) -> bool {
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => 0,
    };
    // 诊断：捕获前后各量一次原生光标状态（形状是否真的跟着变了）
    let before = win::cursor_probe();
    let ok = win::set_mouse_capture(hwnd, on);
    game::append_boot(
        &state.root,
        &format!(
            "[cursor] capture on={on} ok={ok} before={before} after={}",
            win::cursor_probe()
        ),
    );
    ok
}

#[tauri::command]
fn window_is_fullscreen(window: tauri::WebviewWindow) -> bool {
    win::is_fullscreen(&window)
}

#[tauri::command]
fn set_vsync_disabled(state: State<'_, AppState>, disabled: bool) -> bool {
    game::write_vsync_disabled(&state.root, disabled)
}

#[tauri::command]
fn rawinput_start(app: AppHandle) -> Result<rawinput::RawStats, String> {
    rawinput::start(app)?;
    Ok(rawinput::stats())
}

#[tauri::command]
fn rawinput_stats() -> rawinput::RawStats {
    rawinput::stats()
}

#[tauri::command]
fn game_root_of(state: State<'_, AppState>) -> String {
    state.root.display().to_string()
}

pub fn run() {
    let root = game::game_root();
    game::ensure_dirs(&root);
    // 原版 initShell()：启动即把两个日志清空
    game::truncate_logs(&root);
    // 必须在 Builder 之前：WebView2 的参数只能在创建 webview 之前给
    game::apply_browser_args(&root);

    let read = game::read_settings_checked(&root);

    tauri::Builder::default()
        .manage(AppState {
            root,
            settings: Mutex::new(read.settings),
            problem: read.problem,
        })
        .invoke_handler(tauri::generate_handler![
            preload_shell,
            write_settings,
            backup_settings,
            append_log,
            boot_report,
            preload_packs,
            show_window,
            focus_window,
            quit_app,
            center_cursor,
            set_window_mode,
            mouse_capture,
            cursor_intent,
            window_is_fullscreen,
            set_vsync_disabled,
            rawinput_start,
            rawinput_stats,
            game_root_of,
        ])
        .setup(|app| {
            // 原生焦点事件转发给前端（对应原版 win.on("focus"/"blur")）
            if let Some(w) = app.get_webview_window("main") {
                // 方案 A：关掉 WebView2 的浏览器加速键（F3 不再弹"查找"）
                win::disable_browser_accelerator_keys(&w, app.state::<AppState>().root.clone());

                // 禁掉"单按 Alt 打开系统菜单"：否则菜单模式会让窗口去激活（游戏自动暂停）
                // 并跑一个嵌套模态循环卡住主线程（Tauri 事件全积压：视角不动、光标不刷新）。
                let diag_root0 = app.state::<AppState>().root.clone();
                match w.hwnd() {
                    Ok(h) => {
                        let ok = win::install_menu_suppressor(h.0 as isize);
                        game::append_boot(
                            &diag_root0,
                            &format!(
                                "win32: Alt 系统菜单抑制 {}",
                                if ok { "已安装" } else { "安装失败" }
                            ),
                        );
                    }
                    Err(e) => game::append_boot(
                        &diag_root0,
                        &format!("win32: 拿不到 HWND，Alt 菜单抑制未安装: {e}"),
                    ),
                }

                let handle = app.handle().clone();
                // 诊断：光标形状问题的取证用（见 win.rs::cursor_probe 的说明）
                let diag_root = app.state::<AppState>().root.clone();
                w.on_window_event(move |event| match event {
                    WindowEvent::Focused(focused) => {
                        if !*focused {
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] focus LOST  before={}", win::cursor_probe()),
                            );
                            // **失焦必须释放原生鼠标捕获**，否则 Alt-Tab 之后用户的光标
                            // 被 ClipCursor 关在窗口里出不来。这是安全网：
                            // 前端 onWinBlur 也会主动释放，两边都做且都幂等。
                            win::release_mouse_capture();
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] focus LOST  after ={}", win::cursor_probe()),
                            );
                        } else {
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] focus GAIN  before={}", win::cursor_probe()),
                            );
                            // 切回来**之后**才让 webview 重新决定光标形状（发 WM_SETCURSOR）——
                            // 必须在聚焦之后，否则和失焦时那次一样会被系统丢掉。
                            win::refresh_cursor();
                            // 再踢一下，逼系统把光标**重画到屏幕上**（系统状态对但画面没重绘那种）
                            win::kick_cursor_repaint();
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] focus GAIN  after ={}", win::cursor_probe()),
                            );
                        }
                        let name = if *focused { "win-focus" } else { "win-blur" };
                        let _ = handle.emit(name, ());
                    }
                    WindowEvent::Destroyed => {
                        win::release_mouse_capture();
                        rawinput::stop();
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
