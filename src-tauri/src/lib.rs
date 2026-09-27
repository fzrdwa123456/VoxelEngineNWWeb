// VoxelEngine / Tauri shell
//
// This file is the **command bus**: the frontend's src/platform/*.ts calls in through invoke(),
// and this side dispatches to game.rs (files/settings/logs), packs.rs (resource packs), win.rs
// (window) and rawinput.rs (raw input).
//
// Key design (why the frontend needed so few changes):
//   In the original NW.js build, readSettings()/logDebug() in src/platform/shell.ts were
//   **synchronous**, while Tauri's commands are asynchronous. So instead of trying to turn
//   synchronous IO asynchronous, this does the following:
//   at startup a single invoke("preload_shell") pulls settings / window mode / the vsync switch
//   into frontend memory once, after which readSettings() reads memory (synchronous, semantics
//   unchanged) and writes are fire-and-forget back this way.
//   The same trick is used for resource packs: invoke("preload_packs") takes all the pack bytes in
//   one go, so not a line of the normalisation/priority logic in rendering/textures.ts changes.
//
// As a result, apart from three files in src/ — platform/shell.ts, platform/rawinput.ts and
// rendering/textures.ts — the other 100+ call sites (main.ts, ui/*, ecs/*, blockregistry.ts ...)
// are untouched.
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

mod cursor_model;
mod game;
mod packs;
mod rawinput;
mod win;

struct AppState {
    root: PathBuf,
    /// In-memory copy of settings.json (the synchronous source for the frontend's readSettings())
    settings: Mutex<Value>,
    /// Problem detected at startup (bad JSON / not an object), handed to the frontend for startup repair
    problem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellSnapshot {
    /// Game data root directory (shown in the log so it is visible at a glance when diagnosing)
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

/// Startup preload: settings + window state. The frontend awaits it once at the top of main.ts.
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

/// The earliest diagnostic channel: the frontend (including the inline script in index.html) can
/// call it **before anything is ready** to write "I am up / I died because of X" into logs\boot.log.
/// Why it exists: in Tauri a frontend crash is silent — no window, not a single line in debug.log,
/// and from the outside it looks exactly like "stuck in the loader" (this trap was hit twice).
#[tauri::command]
fn boot_report(state: State<'_, AppState>, message: String) {
    game::append_boot(&state.root, &message);
}

/// **One boot.log line from the PLATFORM half** (P1.59): `win.rs` owns the cursor table and the
/// reconciler, but the LOG PATHS belong to this file — so it hands its diagnostics here instead of
/// duplicating `AppState`. The `[cursor]` prefix is what keeps them together with the front end's own
/// `cursorBoot()` lines, which land in the same file on purpose: one file then tells the whole story of
/// a focus change or a capture, including which side acted first.
pub fn boot_line(app: &AppHandle, message: &str) {
    let root = app.state::<AppState>().root.clone();
    game::append_boot(&root, message);
}

/// Diagnostics for the front end's timeline probes: the whole cursor state as ONE line (see
/// `win::cursor_trace`). Read-only, so a probe can never change what it measures.
#[tauri::command]
fn cursor_trace() -> String {
    win::cursor_trace()
}

/// **Is the user moving or resizing the window right now?** (P1.62f)
///
/// The front end is told about it as it changes (`win-session`), but a PUSH is only current if the JS event
/// loop has been idle since it happened - and the world entry's last stages generate and mesh the spawn
/// window in long synchronous stretches, so the push can still be sitting in the queue when the entry takes
/// its decision. That is exactly what happened: the platform's own log said `moving=true` 158ms before the
/// entry captured the mouse anyway. The entry therefore ASKS (this command) at the instant it decides. The
/// lock manager keeps using the pushed flag: it only ever decides from an idle event loop (a click, ESC,
/// closing the backpack). Read-only.
#[tauri::command]
fn window_session_active() -> bool {
    win::clip_is_postponed()
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
fn set_window_mode(window: tauri::WebviewWindow, fullscreen: bool) -> bool {
    win::set_fullscreen(&window, fullscreen)
}

/// Native mouse capture switch (**does not go through the Pointer Lock API**). See the notes in
/// win.rs: ClipCursor + SetCursorPos pin the system cursor inside the window, so there is no ESC
/// unlock gesture, no cooldown after an unlock, and none of the "the browser took the lock away"
/// class of problems. When it returns false the frontend falls back to requestPointerLock.
/// The frontend tells us the **desired** cursor visibility (called once whenever
/// `pointerlock.applyCursor()`'s value changes).
/// After that `win::cursor_sentinel()` reconciles and corrects it every 8 ms — see that note in
/// win.rs.
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
    // Diagnostics: measure the native cursor state before and after capture (whether the shape
    // really follows)
    let before = win::cursor_trace();
    let ok = win::set_mouse_capture(hwnd, on);
    game::append_boot(
        &state.root,
        &format!(
            "[cursor] capture on={on} ok={ok} before=[{before}] after=[{}]",
            win::cursor_trace()
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
    // The original initShell(): truncate both logs at startup
    game::truncate_logs(&root);
    // Must run before the Builder: WebView2 arguments can only be supplied before the webview is created
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
            set_window_mode,
            mouse_capture,
            cursor_intent,
            cursor_trace,
            window_session_active,
            window_is_fullscreen,
            set_vsync_disabled,
            rawinput_start,
            rawinput_stats,
            game_root_of,
        ])
        .setup(|app| {
            // Forward native focus events to the frontend (the counterpart of the original
            // win.on("focus"/"blur"))
            if let Some(w) = app.get_webview_window("main") {
                // Option A: turn off WebView2's browser accelerator keys (F3 no longer opens "Find")
                win::disable_browser_accelerator_keys(&w, app.state::<AppState>().root.clone());

                // Disable "a bare Alt opens the system menu": otherwise menu mode deactivates the
                // window (the game auto-pauses) and runs a nested modal loop that blocks the main
                // thread (every Tauri event piles up: the view stops turning, the cursor stops
                // refreshing).
                let diag_root0 = app.state::<AppState>().root.clone();
                match w.hwnd() {
                    Ok(h) => {
                        let ok = win::install_menu_suppressor(h.0 as isize);
                        game::append_boot(
                            &diag_root0,
                            &format!(
                                "win32: Alt system-menu suppression {}",
                                if ok { "installed" } else { "FAILED to install" }
                            ),
                        );
                    }
                    Err(e) => game::append_boot(
                        &diag_root0,
                        &format!("win32: no HWND, Alt menu suppression NOT installed: {e}"),
                    ),
                }

                let handle = app.handle().clone();
                // Diagnostics: evidence gathering for the cursor-shape problem (see the note on
                // win.rs::cursor_probe)
                let diag_root = app.state::<AppState>().root.clone();
                w.on_window_event(move |event| match event {
                    WindowEvent::Focused(focused) => {
                        if !*focused {
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] focus LOST  before=[{}]", win::cursor_trace()),
                            );
                            // **Losing focus must release the native mouse capture**, otherwise after
                            // an Alt-Tab the user's cursor is shut inside the window by ClipCursor and
                            // cannot get out. This is a safety net: the frontend's onWinBlur releases
                            // it too, so both sides do it, idempotently.
                            // **…and it must also FORGET the hidden intent** (P1.58): with the intent
                            // still standing, the 8 ms sentinel re-hid the cursor on every "focus
                            // gained", which is the Win-key focus flap (see
                            // win.rs::on_foreground_lost).
                            win::on_foreground_lost();
                            // **…and hand the ARROW back in the same breath** (P1.60). `on_foreground_lost`
                            // releases the clip but does not touch the shape, so the cursor stayed NULL
                            // until the 8 ms sentinel got to it — the `after` probe below used to read
                            // `shape=Hidden showing=false`, i.e. one tick of "no cursor" on exactly the path
                            // the Win-key report is about. Main thread: this is the window-event handler.
                            // (P1.70) NO `restore_arrow()` here any more: the centring of a hidden -> visible
                            // transition is the PROJECTION's job, and having a second path do it from the event
                            // made the cursor appear at the crosshair at an unpredictable moment (the reported
                            // "it centres itself a few hundred ms later for no reason").
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] focus LOST  after =[{}]", win::cursor_trace()),
                            );
                        } else {
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] focus GAIN  before=[{}]", win::cursor_trace()),
                            );
                            // Only **after** focus returns does the webview get to decide the cursor
                            // shape again (by sending WM_SETCURSOR) — it must come after the focus,
                            // otherwise the system discards it just like the one at focus loss.
                            // Diagnostics (P1.60): the ROOT-window ownership test means this now really
                            // fires in a WebView2 app (it never did while it compared PROCESS ids, because
                            // the child window under the pointer belongs to msedgewebview2.exe) — so the
                            // line says whether Chromium was actually asked to re-decide the shape.
                            let refreshed = win::refresh_cursor();
                            // One more kick to force the system to **repaint the cursor on screen**
                            // (the case where the system state is right but the picture was not
                            // redrawn)
                            win::kick_cursor_repaint();
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] focus GAIN  after =[{}]", win::cursor_trace()),
                            );
                            game::append_boot(
                                &diag_root,
                                &format!("[cursor] refresh sent={refreshed} (WM_SETCURSOR -> Chromium)"),
                            );
                        }
                        let name = if *focused { "win-focus" } else { "win-blur" };
                        let _ = handle.emit(name, ());
                    }
                    WindowEvent::Destroyed => {
                        win::release_mouse_capture();
                        rawinput::stop();
                    }
                    // Window geometry changed (resize / move / DPI). **This is the only reliable
                    // signal that "the user is fiddling with the window".**
                    //
                    // Why not "the mouse left the application": while dragging the window's
                    // **border/title bar** the window **is still the focused window**, and the cursor
                    // is still inside the window rectangle (it merely lands in the **non-client
                    // area**) — so there is no blur and no mouseleave. And `ClipCursor`'s rectangle
                    // is computed at the moment capture starts, so it goes stale if the drag changes
                    // it midway: the cursor can reach the border (the non-client area is beyond
                    // `cursor:none`'s reach), so the player turns the view **while dragging the
                    // window**, and after letting go the cursor still slides all over inside the
                    // window (this is exactly how it was hit: dragging the window during
                    // loading/entry, with capture switching on at the moment of world entry).
                    //
                    // Two actions:
                    //   1. Rust recomputes the clip rectangle — the frontend **suppresses** the pause
                    //      for its own window-mode change (fullscreen/windowed); capture is still on
                    //      there, so the rectangle must keep up;
                    //   2. Notify the frontend: drop capture and, in a world with no UI up, raise the
                    //      pause menu (the same path as ESC/blur).
                    WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => {
                        let h = handle.clone();
                        let _ = h.run_on_main_thread(|| {
                            win::reclip_mouse_capture();
                        });
                        let _ = handle.emit("win-geometry", ());
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
