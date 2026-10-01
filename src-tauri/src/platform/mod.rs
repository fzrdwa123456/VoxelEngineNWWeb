// ===== THE PLATFORM SEAM (P1.79, traits since P1.80) =====
//
// Every operating-system call the engine needs lives behind this module. Today there are TWO
// backends - `platform/windows/` (the original) and `platform/android/` (the first port, P1.83, where
// almost every method is empty because a phone has no cursor to capture and no raw-input device) - and
// adding the second one was exactly the promised cost: one new folder and one `cfg` arm below.
// A new target adds `platform/<os>/` the same way.
//
// **THE CONTRACT IS THREE TRAITS, not prose - because a trait is what the compiler checks.**
// Implement the three for your target and forget nothing: the error names the method you left out.
//
//   CursorBackend    the POINTER: read the state into a `CursorProbe`, apply a clip / a shape,
//                    move the pointer, and the Windows fight-back helpers (it re-shows a cursor we
//                    hid, only `GetCursorInfo` can see the truth, `WM_SETCURSOR` has to be re-sent
//                    after a focus regain). A different OS may implement several as an empty
//                    function - that is expected, and they are kept in the seam rather than folded
//                    away because removing one changes Windows behaviour.
//   RawInputBackend  the DEVICE: spawn the collector that pushes relative deltas and button edges
//                    into `rawinput_session`'s accumulators, plus the two probes over it. The
//                    accumulators, the throttled event emission and every rule stay cross-platform;
//                    only "how do I get the packets" is per OS.
//   WebviewBackend   the WEBVIEW HOST: which launch arguments it needs before it is created, and
//                    the accelerator-key / context-menu switch. Mostly a no-op off Windows.
//
// The function-style accessors at the bottom (`platform::probe_of(..)`) are one-line delegations, so
// the shared layers (`cursor_session`, `rawinput_session`, `game`, `lib`) never name a platform and
// never see a handle type they should not. `cursor_session.rs` and `rawinput_session.rs` are
// therefore platform-free: they contain no `cfg`, no Win32 name and no `unsafe`.
//
// **A NEW PLATFORM**: write `platform/<os>/mod.rs` implementing these three traits, add its `cfg`
// arm here, and delete the `compile_error!` below. Nothing else in the crate changes - not
// `cursor_model.rs`, not `cursor_session.rs`, not `rawinput_session.rs`, not `src/`.
//
// (On a target with no backend the `compile_error!` is the FIRST and clearest error; the sessions
// then also report the imports they cannot resolve, which is the list of what is missing.)

use std::path::PathBuf;

use tauri::WebviewWindow;

use crate::cursor_model::{ClipRect, CursorModel, CursorProbe, CursorShape};

/// The handle type lives in `cursor_model` because the pure model stores one; this is a re-export so
/// a backend only ever has to name `crate::platform::NativeWindow`.
pub use crate::cursor_model::NativeWindow;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows::{WindowsCursor, WindowsRawInput, WindowsWebview};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
use android::{AndroidCursor, AndroidRawInput, AndroidWebview};

#[cfg(target_os = "windows")]
static CURSOR: WindowsCursor = WindowsCursor;
#[cfg(target_os = "windows")]
static RAWINPUT: WindowsRawInput = WindowsRawInput;
#[cfg(target_os = "windows")]
static WEBVIEW: WindowsWebview = WindowsWebview;

#[cfg(target_os = "android")]
static CURSOR: AndroidCursor = AndroidCursor;
#[cfg(target_os = "android")]
static RAWINPUT: AndroidRawInput = AndroidRawInput;
#[cfg(target_os = "android")]
static WEBVIEW: AndroidWebview = AndroidWebview;

#[cfg(not(any(target_os = "windows", target_os = "android")))]
compile_error!(
    "no backend for this target yet: implement CursorBackend + RawInputBackend + WebviewBackend in \
     platform/<os>/ (the three traits below are the whole contract), add its #[cfg] arm in \
     platform/mod.rs, and delete this compile_error!"
);

/// The pointer's platform half. See the module header for why each method exists.
pub trait CursorBackend: Sync {
    /// The native handle of a Tauri window, or `None` when the platform cannot give one (in which
    /// case the capture is refused and the mouse simply stays free).
    fn native_window(&self, window: &WebviewWindow) -> Option<NativeWindow>;
    /// The platform state snapshot the pure decision reads. Callers may call it as often as they
    /// like: on Windows it only READS.
    fn probe_of(&self, m: &CursorModel) -> CursorProbe;
    /// The ONE boot.log line describing that state (what we want / what we did / what we saw).
    fn trace_of(&self, m: &CursorModel) -> String;
    /// Is that window the FOREGROUND one right now?
    fn is_foreground(&self, window: NativeWindow) -> bool;
    /// Apply the clip, and report whether we really hold one. This is the only place that clips,
    /// and it must never clear another application's clip.
    fn apply_clip(&self, m: &mut CursorModel, clip: Option<ClipRect>) -> bool;
    /// Apply the pointer shape (hidden / arrow), skipping a push that would change nothing.
    fn apply_shape(&self, m: &mut CursorModel, shape: CursorShape) -> bool;
    /// Set the shape once, straight to the value. On Windows `SetCursor` belongs to the thread that
    /// owns the window, so this is only ever called from the main thread or the window-event path.
    fn apply_cursor(&self, visible: bool);
    /// Move the pointer. **Callers must have it hidden** - that is what makes the move invisible.
    fn warp_to(&self, x: i32, y: i32);
    /// Is the system really SHOWING a pointer right now? (Windows: `GetCursorInfo`; a null shape
    /// counts as hidden.)
    fn cursor_visible_now(&self) -> bool;
    /// Make the OS decide the shape once more (Windows: a synthetic `WM_SETCURSOR`). Returns whether
    /// it was really done, for diagnostics.
    fn refresh_cursor(&self) -> bool;
    /// Force the cursor overlay to be drawn again without changing its visibility.
    fn kick_cursor_repaint(&self);
    /// Is the user moving or resizing the window right now? (`postpone_clipcursor` in SDL terms -
    /// re-clipping during that window is what tows the pointer along.)
    fn clip_is_postponed(&self) -> bool;
    /// A capture REQUEST ends any move/size session: one that somehow ends without its exit message
    /// must not be able to wedge the clip off for the rest of the run.
    fn clear_clip_postponed(&self);
    /// Swallow the system menu gestures in the window procedure (Windows). May be a no-op.
    fn install_menu_suppressor(&self, window: NativeWindow) -> bool;
}

/// The device's platform half: it PUSHES into `rawinput_session`'s accumulators, and never decides
/// anything.
pub trait RawInputBackend: Sync {
    /// Start the collector and block until it has reported what it created:
    /// `(native handle, did raw input really register)`, or the reason it failed. The context-menu
    /// hook may still be running when this returns an Err - the two paths are independent.
    fn start_collector(&self) -> Result<(NativeWindow, bool), String>;
    /// Stop the collector: remove hooks, wake its message loop, join its thread.
    fn stop_collector(&self);
    /// The context-menu hook's probe line (`HOOKPROBE ...`). Windows-specific content, worded so a
    /// port may return an empty string.
    fn hook_probe_line(&self) -> String;
    /// How many times that hook has been CALLED (the RAWMON line's `hookSeen`; always 0 means the
    /// hook never reaches the input path). A port with no hook returns 0.
    fn hook_seen(&self) -> i32;
    /// Does the foreground window belong to this process? (The menu gestures are only swallowed
    /// then; the shared RAWMON line prints it either way.)
    fn foreground_is_ours(&self) -> bool;
    /// Is the context-menu hook installed? (false = fail open: the gesture reaches the page.)
    fn menu_hook_installed(&self) -> bool;
}

/// The webview host's platform half.
pub trait WebviewBackend: Sync {
    /// The launch arguments this host needs BEFORE the webview is created. Empty when it has none.
    fn browser_args_base(&self) -> &'static str;
    /// Hand the host the arguments it must be launched with. A no-op when it takes none.
    fn publish_browser_args(&self, args: &str);
    /// What the host will actually be launched with (diagnostics / the preload report).
    fn browser_args_in_force(&self) -> String;
    /// Turn off the host's own accelerated keys and default context menus.
    fn disable_browser_accelerator_keys(&self, window: &WebviewWindow, log_root: PathBuf);
}

// ===== THE SEAM'S FUNCTIONS: one-line delegations, so nothing above names a platform =====

/// Window mode switch (the original's kiosk fullscreen toggle, no restart at runtime).
/// Pure Tauri API - this one is NOT platform code, it only lives here because `lib.rs` should not
/// have to know which module a window call came from.
///
/// **Desktop-only, and that is a Tauri fact, not a choice**: `WebviewWindow::set_fullscreen` does not
/// exist in a mobile build (the window IS the screen there), so the mobile arm answers honestly -
/// "there is nothing to switch" - and `is_fullscreen` says `true`, because a mobile window does cover
/// the screen. Both are one-liners next to the real implementation so the caller in `lib.rs` stays
/// platform-free.
#[cfg(desktop)]
pub fn set_fullscreen(window: &WebviewWindow, fullscreen: bool) -> bool {
    window.set_fullscreen(fullscreen).is_ok()
}

#[cfg(mobile)]
pub fn set_fullscreen(_window: &WebviewWindow, _fullscreen: bool) -> bool {
    false
}

/// Whether we are fullscreen right now (the original read win.isFullscreen)
#[cfg(desktop)]
pub fn is_fullscreen(window: &WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[cfg(mobile)]
pub fn is_fullscreen(_window: &WebviewWindow) -> bool {
    true
}

/// **The display's refresh rate in milli-Hz, or 0 when the platform cannot answer** (P1.86).
///
/// The frame pacing locks to this number, so it is the platform's answer rather than a measurement the page
/// makes (a rAF delta cannot see the panel any more: the launch arguments lift Chromium's display-rate
/// limit), and it is EXACT to the ratio where the platform knows one — a 59.94Hz panel answered as "60" is a
/// duplicated frame every ~16 seconds. 0 is a legal answer: the front end paces at a plain 60 then.
#[cfg(target_os = "windows")]
pub fn display_refresh_milli_hz() -> u32 {
    windows::display_refresh_milli_hz()
}

/// No other backend answers yet: 0 = "unknown", which the pacing treats as 60Hz.
#[cfg(not(target_os = "windows"))]
pub fn display_refresh_milli_hz() -> u32 {
    0
}

pub fn native_window(window: &WebviewWindow) -> Option<NativeWindow> {
    CURSOR.native_window(window)
}

pub fn probe_of(m: &CursorModel) -> CursorProbe {
    CURSOR.probe_of(m)
}

pub fn trace_of(m: &CursorModel) -> String {
    CURSOR.trace_of(m)
}

pub fn is_foreground(window: NativeWindow) -> bool {
    CURSOR.is_foreground(window)
}

pub fn apply_clip(m: &mut CursorModel, clip: Option<ClipRect>) -> bool {
    CURSOR.apply_clip(m, clip)
}

pub fn apply_shape(m: &mut CursorModel, shape: CursorShape) -> bool {
    CURSOR.apply_shape(m, shape)
}

pub fn apply_cursor(visible: bool) {
    CURSOR.apply_cursor(visible)
}

pub fn warp_to(x: i32, y: i32) {
    CURSOR.warp_to(x, y)
}

pub fn cursor_visible_now() -> bool {
    CURSOR.cursor_visible_now()
}

pub fn refresh_cursor() -> bool {
    CURSOR.refresh_cursor()
}

pub fn kick_cursor_repaint() {
    CURSOR.kick_cursor_repaint()
}

pub fn clip_is_postponed() -> bool {
    CURSOR.clip_is_postponed()
}

pub fn clear_clip_postponed() {
    CURSOR.clear_clip_postponed()
}

pub fn install_menu_suppressor(window: NativeWindow) -> bool {
    CURSOR.install_menu_suppressor(window)
}

pub fn rawinput_start_collector() -> Result<(NativeWindow, bool), String> {
    RAWINPUT.start_collector()
}

pub fn rawinput_stop_collector() {
    RAWINPUT.stop_collector()
}

pub fn rawinput_hook_probe_line() -> String {
    RAWINPUT.hook_probe_line()
}

pub fn rawinput_hook_seen() -> i32 {
    RAWINPUT.hook_seen()
}

pub fn foreground_is_ours() -> bool {
    RAWINPUT.foreground_is_ours()
}

pub fn menu_hook_installed() -> bool {
    RAWINPUT.menu_hook_installed()
}

pub fn browser_args_base() -> &'static str {
    WEBVIEW.browser_args_base()
}

pub fn publish_browser_args(args: &str) {
    WEBVIEW.publish_browser_args(args)
}

pub fn browser_args_in_force() -> String {
    WEBVIEW.browser_args_in_force()
}

pub fn disable_browser_accelerator_keys(window: &WebviewWindow, log_root: PathBuf) {
    WEBVIEW.disable_browser_accelerator_keys(window, log_root)
}
