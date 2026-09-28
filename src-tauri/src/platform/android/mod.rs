// ===== THE ANDROID BACKEND (P1.83) =====
//
// The FIRST port through the seam, and the answer to "what does a new platform actually cost": one
// file, three trait impls, and **no change anywhere else** - `cursor_model.rs`, both `*_session.rs`
// files, `lib.rs` and the whole front end are untouched by it.
//
// What Android does NOT have, and why almost every method here is empty:
//
//   * **No system cursor to manage.** There is no `ClipCursor`, no `SetCursor`, and no "capture the
//     pointer" concept at all: the finger IS the pointer, and a touch is a DOM event. So the whole
//     `CursorBackend` collapses to "there is no window handle" (`native_window` -> `None`), which the
//     seam already models: a capture request with no handle is REFUSED, and the mouse - here, the
//     touch - simply stays free. Nothing in `cursor_session.rs` had to learn about Android.
//   * **No raw input device.** `RIDEV_INPUTSINK` is a Win32 concept. `start_collector` reports the
//     failure honestly and `rawinput_session::start` passes it on; the front end already treats "raw
//     input is not running" as "no capture, use the DOM events", which is exactly right for touch.
//   * **No browser launch arguments and no accelerator keys.** The system WebView takes none.
//
// The one thing a touch port DOES need is a front-end interaction model (a stick, a look-drag, on
// screen buttons) - that is presentation, not platform, and it lives in `src/`, not here.

use std::path::PathBuf;

use tauri::WebviewWindow;

use crate::cursor_model::{ClipPos, ClipRect, CursorModel, CursorProbe, CursorShape};
use crate::platform::{CursorBackend, NativeWindow, RawInputBackend, WebviewBackend};

/// The Android pointer backend. A unit struct: there is no state to keep, because there is no cursor.
pub struct AndroidCursor;

impl CursorBackend for AndroidCursor {
    /// **No native window handle**, and that is the whole design: `cursor_session::set_mouse_capture`
    /// refuses a request without one, so "capture" can never be entered on Android - which is correct,
    /// because there is nothing to capture.
    fn native_window(&self, _window: &WebviewWindow) -> Option<NativeWindow> {
        None
    }

    /// Nothing is focused in the Win32 sense and there is no cursor overlay to report.
    fn probe_of(&self, _m: &CursorModel) -> CursorProbe {
        CursorProbe {
            focused: false,
            showing: false,
            client: ClipRect::ZERO,
            pos: ClipPos { x: 0, y: 0 },
            screen: ClipRect::ZERO,
            remote: false,
        }
    }

    fn trace_of(&self, m: &CursorModel) -> String {
        format!(
            "android: want={} relative={} (touch input; no cursor to manage)",
            m.want, m.relative
        )
    }

    fn is_foreground(&self, _window: NativeWindow) -> bool {
        false
    }
    fn apply_clip(&self, _m: &mut CursorModel, _clip: Option<ClipRect>) -> bool {
        false
    }
    fn apply_shape(&self, _m: &mut CursorModel, _shape: CursorShape) -> bool {
        false
    }
    fn apply_cursor(&self, _visible: bool) {}
    fn warp_to(&self, _x: i32, _y: i32) {}
    fn cursor_visible_now(&self) -> bool {
        false
    }
    fn refresh_cursor(&self) -> bool {
        false
    }
    fn kick_cursor_repaint(&self) {}
    fn clip_is_postponed(&self) -> bool {
        false
    }
    fn clear_clip_postponed(&self) {}
    fn install_menu_suppressor(&self, _window: NativeWindow) -> bool {
        false
    }
}

/// The Android device backend: no raw input, on purpose.
pub struct AndroidRawInput;

impl RawInputBackend for AndroidRawInput {
    fn start_collector(&self) -> Result<(NativeWindow, bool), String> {
        Err("raw input is not available on Android: the view comes from DOM touch events".into())
    }
    fn stop_collector(&self) {}
    fn hook_probe_line(&self) -> String {
        String::new()
    }
    fn hook_seen(&self) -> i32 {
        0
    }
    fn foreground_is_ours(&self) -> bool {
        false
    }
    fn menu_hook_installed(&self) -> bool {
        false
    }
}

/// The Android webview host: it takes no launch arguments and has no accelerator keys to disable.
pub struct AndroidWebview;

impl WebviewBackend for AndroidWebview {
    fn browser_args_base(&self) -> &'static str {
        ""
    }
    fn publish_browser_args(&self, _args: &str) {}
    fn browser_args_in_force(&self) -> String {
        String::new()
    }
    fn disable_browser_accelerator_keys(&self, _window: &WebviewWindow, _log_root: PathBuf) {}
}
