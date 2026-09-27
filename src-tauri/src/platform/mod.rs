// ===== THE PLATFORM SEAM (P1.79) =====
//
// Every operating-system call the cursor mechanism needs lives behind this module. Today there is
// exactly ONE backend (`platform/windows.rs`, the code that used to be `win.rs`), and that is
// deliberate: the interface was derived from what Windows really needed rather than guessed ahead
// of a second implementation. A port adds `platform/<os>.rs` and one `cfg` arm below.
//
// WHAT A BACKEND MUST PROVIDE - and nothing else, because nothing else is called:
//
//   probe_of(&CursorModel) -> CursorProbe    the platform state snapshot the decision reads
//   trace_of(&CursorModel) -> String         the ONE boot.log line describing that state
//   is_foreground(hwnd) -> bool              "is that window the foreground one right now"
//   apply_clip(&mut CursorModel, Option<ClipRect>) -> bool
//   apply_shape(&mut CursorModel, CursorShape) -> bool
//   apply_cursor(visible: bool)              set the pointer shape once, straight to the value
//   warp_to(x, y)                            move the pointer (callers hide it first)
//   cursor_visible_now() -> bool             is the system really SHOWING a pointer
//   refresh_cursor() -> bool                 make the OS re-decide the shape (Windows: WM_SETCURSOR)
//   kick_cursor_repaint()                    force the overlay to be drawn again
//   clip_is_postponed() -> bool              is the user moving/resizing the window (SDL's postpone)
//   clear_clip_postponed()                   a capture request ends any move/size session
//   install_menu_suppressor(hwnd) -> bool    swallow the system menu gestures (may be a no-op)
//   disable_browser_accelerator_keys(window, log_root)
//
// Several of those exist ONLY because of Windows fight-back (it re-shows a cursor we hid, only
// `GetCursorInfo` can see the truth, `WM_SETCURSOR` has to be re-sent after a focus regain). A
// different OS may implement some of them as an empty function - that is expected, and it is why
// they are kept in the seam instead of being folded away: removing one changes Windows behaviour.

use tauri::WebviewWindow;

/// Window mode switch (the original's kiosk fullscreen toggle, no restart at runtime)
pub fn set_fullscreen(window: &WebviewWindow, fullscreen: bool) -> bool {
    window.set_fullscreen(fullscreen).is_ok()
}

/// Whether we are fullscreen right now (the original read win.isFullscreen)
pub fn is_fullscreen(window: &WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(not(target_os = "windows"))]
compile_error!(
    "no cursor backend for this target yet: implement platform/<os>.rs against the interface \
     documented at the top of platform/mod.rs, then add its #[cfg] arm here"
);
