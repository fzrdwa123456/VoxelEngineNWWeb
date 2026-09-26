// Window operations — the nw.Window.get() half of platform/shell.ts in the original NW.js build.
//
// Item-by-item mapping (NW.js -> Tauri v2):
//   win.show() / win.focus()          -> window.show() / window.set_focus()
//   win.close()                       -> app.exit(0)
//   win.on("focus"/"blur")            -> WindowEvent::Focused -> emit("win-focus"/"win-blur")
//   win.enterKioskMode()/leave        -> window.set_fullscreen(bool)
//   win.setAlwaysOnTop(false)         -> not needed: NW.js kiosk force-topped itself and had to
//                                        be undone, Tauri does not
//   cursor.exe / setCursorPos(x, y)   -> compute the window centre here + SetCursorPos
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

use tauri::WebviewWindow;

/// Put the system cursor at the exact centre of the window (so opening a menu/backpack returns
/// the cursor to the crosshair position).
/// The original was "JS computes the coordinates -> hands them to cursor.exe / a NAPI plugin";
/// here it is one step: the window geometry comes straight from Tauri.
pub fn center_cursor(window: &WebviewWindow) -> bool {
    let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    if hwnd == 0 || unsafe { GetForegroundWindow() } != hwnd {
        // SDL: "SetCursorPos outside of the bounds of the focus window appears not to do anything" - and
        // moving the cursor of whatever application the player switched to is the bug we just fixed.
        return false;
    }
    // The CLIENT area, not the outer rect: the outer one includes the title bar and borders, so the old
    // version centred on a point below the real crosshair.
    let rc = match unsafe { client_rect_on_screen(hwnd) } {
        Some(r) => r,
        None => return false,
    };
    let x = (rc.left + rc.right) / 2;
    let y = (rc.top + rc.bottom) / 2;
    // JITTERED (x, x+1, x): Windows coalesces and caches identical warps and then ignores them - SDL does
    // exactly this in WIN_SetCursorPos (SDL_windowsmouse.c).
    unsafe {
        let ok = crate::rawinput::SetCursorPos(x, y) != 0;
        let _ = crate::rawinput::SetCursorPos(x + 1, y);
        crate::rawinput::SetCursorPos(x, y) != 0 && ok
    }
}

/// Window mode switch (the original's kiosk fullscreen toggle, no restart at runtime)
pub fn set_fullscreen(window: &WebviewWindow, fullscreen: bool) -> bool {
    window.set_fullscreen(fullscreen).is_ok()
}

/// Whether we are fullscreen right now (the original read win.isFullscreen)
pub fn is_fullscreen(window: &WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

// ===== Native mouse capture (does not go through the Pointer Lock API) =====
//
// Why not the browser's pointer lock: ESC unlocking is a **browser security policy**, handled by
// the browser process ahead of the page (`render_widget_host_impl.cc`'s ForwardKeyboardEvent ->
// PreHandleKeyboardEvent; the Chrome layer's `exclusive_access_manager.cc:196` only looks at the
// keycode), and after unlocking there is a window during which **re-locking is refused** (Blink's
// `kUserEscapeCooldown`: "Pointer lock cannot be acquired immediately after the user has exited
// the lock."). The page has no right to turn it off, and Tauri/WebView2 exposes no switch either.
// NW.js could solve it back then only because it ships its own patched Chromium.
//
// So this uses the Win32 approach and captures the mouse itself:
//   ClipCursor(client area)  — **physically confines** the system cursor to the window (it cannot
//                               get out = no clicks on other windows, no lost focus)
//   SetCursorPos(centre)     — used together with it (Windows moves the cursor into the rectangle)
// Hiding the cursor is still left to CSS (`cursor: none` in `pointerlock.applyCursor()`): the
// cursor is confined inside the client area, so it is always over the webview and CSS is enough —
// there is no need to hook WM_SETCURSOR.
//
// **Losing focus must release it** (see the Focused(false) branch in lib.rs), otherwise the user's
// cursor stays locked inside the window after Alt-Tab.
/// Client-area rectangle in screen coordinates. Returns None on failure.
unsafe fn client_rect_on_screen(hwnd: isize) -> Option<Rect> {
    let mut rc = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if GetClientRect(hwnd, &mut rc) == 0 {
        return None;
    }
    let mut tl = Point { x: rc.left, y: rc.top };
    let mut br = Point { x: rc.right, y: rc.bottom };
    if ClientToScreen(hwnd, &mut tl) == 0 || ClientToScreen(hwnd, &mut br) == 0 {
        return None;
    }
    Some(Rect { left: tl.x, top: tl.y, right: br.x, bottom: br.y })
}

/// Turn native mouse capture on/off. Returns whether it worked (on failure the front end falls
/// back to the browser's requestPointerLock).
pub fn set_mouse_capture(hwnd: isize, on: bool) -> bool {
    if !on {
        release_mouse_capture();
        return true;
    }
    if hwnd == 0 {
        return false;
    }
    let mut m = model();
    m.hwnd = hwnd;
    // Capture while NOT the foreground window is refused: the clip would sit over somebody else is screen
    // area and the cursor would be hidden globally (see `capture_foreground_check`). The front end has the
    // same gate; this is the backstop. (SDL puts the same condition in WIN_UpdateClipCursor.)
    if unsafe { GetForegroundWindow() } != hwnd {
        return false;
    }
    m.relative = true;
    let p = probe_of(&m);
    if rect_is_empty(p.client) {
        m.relative = false;
        return false;
    }
    // The CLIP only. The shape (hidden) arrives through the cursor INTENT, because SetCursor has to run on
    // the thread that owns the window - and the POSITION is deliberately left alone: SDL calls this
    // "clip != warp", and warping here is what used to make the cursor jump into the middle and vanish.
    // It is also unnecessary: raw input deltas do not depend on where the cursor is, and the centre lock
    // keeps it on the crosshair by itself.
    let plan = decide(&m, &p);
    let held = apply_clip(&mut m, plan.clip);
    if !plan.confined || !held {
        // Nothing visible to clip to (the window is off the screen) or Windows refused the rectangle: do NOT
        // pretend to be capturing. The front end sees `false` and falls back, instead of the cursor escaping
        // the window while the game still processes clicks.
        apply_clip(&mut m, Some(ClipRect::ZERO));
        m.relative = false;
        return false;
    }
    true
}

/// **The window geometry changed: recompute the clip rectangle.**
///
/// Why this is required: `ClipCursor`'s rectangle is computed at "the moment capture starts", so
/// resizing/moving the window makes it **stale** — the cursor can then reach the border/title bar
/// (**non-client area**, which Chromium's `cursor:none` does not cover), and the player can drag
/// the window while turning the view, with the cursor still sliding all over the window after
/// letting go.
///
/// The front end now reacts to "a geometry change during capture" by **dropping capture outright
/// + (in a world and with no UI up) raising the pause menu** (main.ts's `onWinGeometry`), so in
/// most cases there is nothing to do here; but when **the program changes the window mode
/// itself** (fullscreen / windowed) the front end suppresses that pause — capture is still on
/// then and the rectangle must keep up. It also covers DPI changes, window snapping, being moved
/// by another program and other geometry changes. Returns whether it really re-clipped (for
/// diagnostics).
pub fn reclip_mouse_capture() -> bool {
    let mut m = model();
    if m.hwnd == 0 {
        return false;
    }
    let p = probe_of(&m);
    // The SAME decision the reconciler makes: a window that is not the foreground gets the clip RELEASED,
    // not recomputed from a stale (or minimized) rectangle.
    let clip = decide(&m, &p).clip;
    apply_clip(&mut m, clip);
    // "Did it really re-clip": a refused rectangle means we hold NOTHING (see `apply_clip`).
    !rect_is_zero(m.clipped)
}

/// Release capture unconditionally (the safety net for losing focus / exiting; repeated calls are
/// harmless)
pub fn release_mouse_capture() {
    let mut m = model();
    m.relative = false;
    // Rule 1 of the model: only a clip WE hold is cleared, so another application is clip is never touched.
    apply_clip(&mut m, Some(ClipRect::ZERO));
}

/// **Capture is only allowed to stay on in the foreground — this is the system-level backstop.**
///
/// Why this is required: `ClipCursor` does **not** look at whether the window is in the
/// foreground, and raw input uses `RIDEV_INPUTSINK` (**received in the background too**).
/// So "opening capture while in the background" has three simultaneous consequences — all of them
/// measured:
///   * the system cursor is confined to our window's rectangle while **another application** now
///     occupies that screen area — the cursor cannot get out;
///   * the view turns anyway (background raw input is still received);
///   * the cursor is hidden globally (CSS and the intent are both hidden, and the 8ms sentinel
///     keeps forcing it every 16ms).
///
/// The front end already added a focus gate (`PointerLock`'s `focused`) to block the normal paths
/// (the automatic relock on entering a world is the easiest one to hit); this one is the
/// **backstop**: any path that opens capture, or keeps it alive, while not in the foreground (UAC
/// stealing focus, a system-level switch, an event the front end missed) is torn down within
/// about 32ms.
///
/// Returning `true` means **just released**: the caller is responsible for emitting
/// `capture-lost` so the front end does its "release the mouse + (in a world and with no UI up)
/// pause" routine — releasing on the Rust side alone is not enough, the front end's
/// `INPUT_STATE.locked` is still true there (the view keeps turning, the cursor stays hidden),
/// which is as good as nothing. Both releasing and restoring the cursor are marshalled to the main
/// thread (the `SetCursor`/`ShowCursor`/`ClipCursor` rule; this function itself runs on the
/// raw-input push thread).
pub fn capture_foreground_check(app: &tauri::AppHandle) -> bool {
    {
        let mut m = model();
        if !m.relative || m.hwnd == 0 {
            m.fg_mismatch_ticks = 0;
            return false;
        }
        if unsafe { GetForegroundWindow() } == m.hwnd {
            m.fg_mismatch_ticks = 0;
            return false;
        }
        // A foreground switch is briefly inconsistent anyway: act after two ticks in a row.
        m.fg_mismatch_ticks = m.fg_mismatch_ticks.saturating_add(1);
        if m.fg_mismatch_ticks < 2 {
            return false;
        }
        m.fg_mismatch_ticks = 0;
    }
    release_mouse_capture();
    // Put the ARROW back with it: releasing the clip does not touch the shape, and the pointer is over
    // another application now (SDL_RedrawCursor: with no mouse focus the DEFAULT cursor is the answer).
    reconcile(app);
    true
}

/// After focus comes back, "kick" the cursor so it is **repainted onto the screen**.
///
/// Both failure modes have to be covered (the boot.log probes caught both, and they are different
/// diseases):
///
/// **(a) Chromium's cached cursor is still NULL** — it only ever answers our `WM_SETCURSOR` from
///     that cache: `focus GAIN before=showing=false hCursor=0` → `after` is still 0.
///     The Rust side cannot cure this one; the **front end must actually change the CSS once**
///     (see pointerlock.ts::reapplyCursor).
///
/// **(b) the system state is already right, but the on-screen cursor was not repainted**:
///     `focus GAIN before=showing=true hCursor=65539`, the system says "arrow, visible", yet it is
///     invisible and only appears after moving the mouse — the cursor overlay needs a position or
///     visibility change before it redraws.
///     This one is cured here: move 1px **and then move back** (net position change 0 — an
///     ASYMMETRIC move was what a previous version did, and it accumulated a permanent 1px shift
///     on every window focus) + toggle `ShowCursor` once. What forces the repaint is that the
///     position really did change once; moving back is what keeps it from drifting.
pub fn kick_cursor_repaint() {
    unsafe {
        let mut p = Point { x: 0, y: 0 };
        if GetCursorPos(&mut p) != 0 {
            // Move 1px **then move back** — the net position change is 0.
            // The original moved away without moving back, at the cost of **a permanent 1px shift
            // to the right that accumulated on every window focus**:
            //   focus GAIN before=pos=(1292,647) / after=pos=(1293,647)
            // Repeated Alt-Tab and clicking back into the window drifted it slowly. This keeps the
            // "the position really did change once" effect (the means originally used to force the
            // system to repaint the cursor overlay), but makes it symmetric, so the player cannot
            // see it and it never accumulates.
            let _ = crate::rawinput::SetCursorPos(p.x + 1, p.y);
            let _ = crate::rawinput::SetCursorPos(p.x, p.y);
        }
        // Then toggle the visibility once more: showing↔hiding itself forces a repaint, and
        // stacking the two means is the most reliable.
        // The reference count's net change is 0, so nothing else is affected.
        ShowCursor(0);
        ShowCursor(1);
    }
}

// ===== The cursor is ours to manage (the sentinel) =====
//
// Why not rely on Chromium: CSS's `cursor` is only an **intent**; what actually decides whether
// the cursor is visible on screen is the `SetCursor` push, and its timing is entirely
// unreliable — the probes caught two failures in boot.log:
//   * at the moment of losing focus the CSS goes from none to default, the push is dropped by the
//     system, and switching back it is still hidden (and Chromium's cache is still NULL, so
//     asking it through `WM_SETCURSOR` answers NULL as well);
//   * releasing capture (`ClipCursor(NULL)`) **does not touch the cursor shape at all**, so the
//     pause screen is up while the system still has it hidden.
// Besides, one press of Alt puts Windows into menu mode and sets the arrow cursor — during
// capture that makes the cursor suddenly visible to the player.
//
// So: the front end only tells us the **desired** state (visible/hidden), and Rust checks it every
// 8ms and corrects it directly when they disagree.
// This only corrects at the "visibility" level (`hCursor == 0` counts as hidden) and **never
// overrides Chromium's pointer shape** — the hand cursor shown while the mouse rests on a button
// is non-NULL, and the sentinel does nothing when it sees "visible".
// The RULES live in `cursor_model.rs` (pure data + one pure decision, testable without a window); this
// file is the PLATFORM half: it gathers the probe, applies the plan, and owns the one table.
use crate::cursor_model::{
    decide, rect_is_empty, rect_is_zero, ClipRect, CursorModel, CursorProbe, CursorShape,
};

/// The ONE table. A lock rather than five statics: the reconciler, the raw-input thread and the Tauri
/// commands all touch it, and "who owns the cursor" has to be one answer.
static MODEL: Mutex<CursorModel> = Mutex::new(CursorModel {
    hwnd: 0,
    want: 0,
    relative: false,
    centre_lock: true,
    clipped: ClipRect::ZERO,
    shape: CursorShape::Unknown,
    enforced: 0,
    fg_mismatch_ticks: 0,
});

fn model() -> std::sync::MutexGuard<'static, CursorModel> {
    // A poisoned lock must not wedge the game: the table is plain data, so take it anyway.
    MODEL.lock().unwrap_or_else(|e| e.into_inner())
}

/// The Win32 RECT becomes the model own ClipRect here, at the boundary (and back again for ClipCursor).
fn as_clip_rect(r: Rect) -> ClipRect {
    ClipRect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

fn as_win_rect(c: ClipRect) -> Rect {
    Rect { left: c.left, top: c.top, right: c.right, bottom: c.bottom }
}

/// Win32 reads only. Thread-agnostic.
fn probe_of(m: &CursorModel) -> CursorProbe {
    let (showing, _) = cursor_info();
    let focused = m.hwnd != 0 && unsafe { GetForegroundWindow() } == m.hwnd;
    let client = if m.hwnd == 0 {
        ClipRect::ZERO
    } else {
        unsafe { client_rect_on_screen(m.hwnd) }.map(as_clip_rect).unwrap_or_default()
    };
    let screen = unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        ClipRect {
            left: x,
            top: y,
            right: x + GetSystemMetrics(SM_CXVIRTUALSCREEN),
            bottom: y + GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    };
    CursorProbe {
        focused,
        showing,
        client,
        remote_session: unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0,
        screen,
    }
}

/// Apply the clip. **The only place that calls ClipCursor**, and it never touches another application is
/// clip: it clears one only when the current one is the rect WE recorded (SDL WIN_UnclipCursorForWindow).
fn apply_clip(m: &mut CursorModel, clip: Option<ClipRect>) -> bool {
    let rect = match clip {
        Some(r) => r,
        None => return false,
    };
    if rect == m.clipped {
        return !rect_is_zero(rect); // already applied: report whether we really hold one
    }
    let release = rect_is_zero(rect) || rect_is_empty(rect);
    let ok = unsafe {
        if release {
            ClipCursor(std::ptr::null()) != 0
        } else {
            let win = as_win_rect(rect);
            ClipCursor(&win) != 0
        }
    };
    // **Honour the result.** ClipCursor REFUSES a rectangle that is not on the screen, and the first version
    // of this recorded the clip anyway - so the model believed it held the mouse while the cursor was free to
    // walk out of a half off-screen window (and clicks still reached the page). A refused clip is no clip.
    m.clipped = if release || !ok { ClipRect::ZERO } else { rect };
    if ok {
        m.enforced = m.enforced.wrapping_add(1);
    }
    ok && !release
}

/// Apply the shape. `SetCursor` belongs to the thread that owns the window, so this is only ever called
/// from the main thread (`reconcile`) or from the window event path.
fn apply_shape(m: &mut CursorModel, shape: CursorShape) -> bool {
    if shape == CursorShape::Unknown || shape == m.shape {
        return false;
    }
    apply_cursor(shape == CursorShape::Arrow);
    m.shape = shape;
    m.enforced = m.enforced.wrapping_add(1);
    true
}

/// Gather, decide, apply - ON THE MAIN THREAD. Idempotent: a tick that changes nothing makes no call.
fn reconcile(app: &tauri::AppHandle) {
    let (plan, system_disagrees) = {
        let m = model();
        let p = probe_of(&m);
        let plan = decide(&m, &p);
        // **The system can disagree with our own record.** `SetCursor` pushes are dropped while another
        // application owns the cursor, and Chromium answers NULL from its cached cursor for a while after
        // focus returns (both were caught by the boot.log probes) - so when we WANT the arrow, are focused,
        // and the system still reports a hidden cursor, the push has to be REPEATED: the plan alone would be
        // a no-op, because `m.shape` already says Arrow. Only while FOCUSED, though: a background window must
        // never fight the foreground application for the cursor (rule 1 of the model).
        let system_disagrees = p.focused && !p.showing && plan.shape == CursorShape::Arrow;
        (plan, system_disagrees)
    };
    let _ = app.run_on_main_thread(move || {
        let mut m = model();
        apply_clip(&mut m, plan.clip);
        if system_disagrees {
            m.shape = CursorShape::Unknown; // force the push through the idempotence check
        }
        apply_shape(&mut m, plan.shape);
    });
}

#[repr(C)]
struct CursorInfo {
    cb_size: u32,
    flags: u32,
    h_cursor: isize,
    pt_screen_pos: Point,
}

const CURSOR_SHOWING: u32 = 0x0000_0001;
/// MAKEINTRESOURCE(32512)
const IDC_ARROW: *const u16 = 32512 as *const u16;
/// `SM_REMOTESESSION`: a remote desktop session needs a larger centre lock (SDL adds the same 2px).
const SM_REMOTESESSION: i32 = 0x1000;
/// The VIRTUAL SCREEN (every monitor): `ClipCursor` refuses a rectangle that is not on it, so the model
/// intersects every clip target with this.
const SM_XVIRTUALSCREEN: i32 = 76;
const SM_YVIRTUALSCREEN: i32 = 77;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;

/// Whether the cursor is visible at the system level: `hCursor == 0` (a NULL shape) means hidden.
fn cursor_visible_now() -> bool {
    cursor_info().0
}

fn cursor_info() -> (bool, isize) {
    unsafe {
        let mut ci = CursorInfo {
            cb_size: std::mem::size_of::<CursorInfo>() as u32,
            flags: 0,
            h_cursor: 0,
            pt_screen_pos: Point { x: 0, y: 0 },
        };
        let ok = GetCursorInfo(&mut ci) != 0;
        let showing = ok && (ci.flags & CURSOR_SHOWING) != 0 && ci.h_cursor != 0;
        (showing, ci.h_cursor)
    }
}

/// Set the cursor once, straight to the desired value
fn apply_cursor(visible: bool) {
    unsafe {
        if visible {
            SetCursor(LoadCursorW(0, IDC_ARROW));
        } else {
            SetCursor(0); // NULL shape = not visible
        }
    }
}

// ===== Disable "pressing Alt alone opens the system menu" =====
//
// Why disable it: every window with a title bar carries a system menu, and Windows' rule is that
// **pressing Alt alone (on release) activates it**. Activating the menu cascades into three
// things (proven by the log: 109ms after `KBCAP keydown code=AltLeft` comes `WINFOCUS blur`):
//   1. the menu acts as a modal popup → the host window receives `WM_ACTIVATE(WA_INACTIVE)` →
//      Tauri reports it as `Focused(false)` → the game's onWinBlur **auto-pauses and releases
//      mouse capture by design** → canControl=false → the view cannot move;
//   2. menu mode runs a **nested modal message loop** that blocks the main thread — Tauri's event
//      delivery (`app.emit` for raw-input) and `run_on_main_thread` (the cursor sentinel's
//      corrections) all back up → the view stops dead and the cursor is not refreshed;
//   3. only a mouse click cancels menu mode → the main thread resumes and the backed-up events
//      flood out in one go → hence "it only works after a click".
//
// The fix is to **swallow SC_KEYMENU in the window procedure** (the system command for "the user
// pressed Alt and asked for the menu") and not call DefWindowProc, so menu mode never starts at
// all — and the three items above simply do not happen.
//
// **Alt+Tab is unaffected**: Alt+Tab is a system-level hotkey and does not go through
// WM_SYSCOMMAND.
// (By comparison, swallowing Alt with a low-level keyboard hook would break Alt+Tab as well, so
// that is not used.)
const WM_SYSCOMMAND: u32 = 0x0112;
const SC_KEYMENU: usize = 0xF100;
/// The keyboard's "context menu" gesture (the menu key / Shift+F10) also reaches the window as
/// WM_CONTEXTMENU at the system level: the default handling "gets ready to pop up a menu", and
/// before popping it up Windows makes the cursor visible — our 8ms cursor sentinel then presses it
/// back to hidden, so what the player sees is "the mouse flashes". Same trick as Alt's
/// SC_KEYMENU: swallow it in the window procedure without calling DefWindowProc.
/// (preventDefault on the page's contextmenu cannot block this step, and WebView2's own menu is
/// already disabled — neither of them is the culprit.)
const WM_CONTEXTMENU: u32 = 0x007B;
/// SC_MOUSEMENU: another form of the request to open the window menu (same family as SC_KEYMENU)
const SC_MOUSEMENU: usize = 0xF090;
const GWLP_WNDPROC: i32 = -4;
const WM_NCDESTROY: u32 = 0x0082;

/// The window procedure from before subclassing; everything except the menu messages above is
/// forwarded to it (that is, tao's own)
static OLD_WNDPROC: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn menu_suppressor_proc(
    hwnd: isize,
    msg: u32,
    w_param: usize,
    l_param: isize,
) -> isize {
    let sys_menu = msg == WM_SYSCOMMAND
        && ((w_param & 0xFFF0) == SC_KEYMENU || (w_param & 0xFFF0) == SC_MOUSEMENU);
    if sys_menu || msg == WM_CONTEXTMENU {
        // Swallow it: without calling DefWindowProc neither menu mode nor the context menu starts
        // (so the cursor is never lit up either)
        return 0;
    }
    let old = OLD_WNDPROC.load(Ordering::SeqCst);
    if msg == WM_NCDESTROY && old != 0 {
        // Restore (irrelevant when the process is exiting, but it is the rule)
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, old);
    }
    if old != 0 {
        return CallWindowProcW(old, hwnd, msg, w_param, l_param);
    }
    0
}

/// Install the "menu suppressor" on a top-level window. Returns whether it worked.
pub fn install_menu_suppressor(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let old = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, menu_suppressor_proc as isize);
        if old == 0 {
            return false;
        }
        OLD_WNDPROC.store(old, Ordering::SeqCst);
        true
    }
}

/// Called by the front end when the **desired value changes** (inside `pointerlock.applyCursor()`): record
/// the intent, then hand the whole question to the model.
///
/// **Nothing is MOVED here** (P1.51). This used to centre the cursor on the hidden -> visible transition,
/// which is part of how "press Win / Alt+Tab and the mouse snaps to the middle of the game window"
/// happened. With the centre lock the cursor never left the crosshair, so the product feel ("opening a
/// menu lands on the crosshair") follows from the CLIP instead of from a warp - and the explicit
/// `center_cursor` command still exists for the paths that really do want a move.
pub fn set_cursor_intent(app: &tauri::AppHandle, hwnd: isize, visible: bool) {
    {
        let mut m = model();
        m.hwnd = hwnd;
        m.want = if visible { 1 } else { 2 };
    }
    reconcile(app);
}

/// The RECONCILER: gather, decide, apply - and call nothing when the plan matches what is already there.
///
/// Called by rawinput on every second tick (8ms) as the self-healing path: SDL gets this for free from
/// `WM_SETCURSOR` on every mouse move, but Chromium owns our window, so the only way to notice "the system
/// and the intent disagree" is to ask. Rule 3 of the model is what makes that safe: a tick that changes
/// nothing makes NO Win32 call, so it neither fights the system nor touches anybody is cursor.
pub fn cursor_sentinel(app: &tauri::AppHandle) {
    if model().want == 0 {
        return;
    }
    reconcile(app);
}

pub fn cursor_enforced_count() -> u32 {
    model().enforced
}

/// Diagnostics (RAWMON line): the desired cursor state (0 unknown / 1 visible / 2 hidden) and
/// whether the system is **really showing** the cursor right now.
/// Reading the two numbers together settles whether "the sentinel is fighting the system": a
/// repeating `desired=2 showing=1` = the system keeps showing the cursor and the sentinel keeps
/// pressing it back — every round marshals to the main thread, and the main thread is the one
/// running rendering.
pub fn cursor_state() -> (u8, bool) {
    (model().want, cursor_visible_now())
}

/// Diagnostics (RAWMON line): whether mouse capture (ClipCursor) is currently on
pub fn capture_active() -> bool {
    // The REQUEST (relative mode), which is what RAWMON needs to spot "capturing while backgrounded".
    model().relative
}

/// Make WebView2 **decide the cursor shape once more** — send a `WM_SETCURSOR` to the window under
/// the cursor.
///
/// This is what Windows does **before handling real mouse input**, so Chromium takes exactly the
/// same path (read the current CSS → `SetCursor`), and this call happens **after the window has
/// regained focus**, so the system will not drop it.
///
/// Why moving 1px with `SetCursorPos` does not work (the first version was written that way and
/// did nothing): MSDN's wording for `WM_SETCURSOR` is *"Sent to a window if **the mouse** causes
/// the cursor to move within a window"* — a program calling `SetCursorPos` does not count as "the
/// mouse": Windows sends `WM_MOUSEMOVE` but does **not** re-run the "decide the cursor shape" path
/// because of it.
///
/// The concrete bug this fixes (with log evidence): when the pause is triggered by Alt-Tab / the
/// Win key instead of ESC, the loss of focus **itself** is what brings the pause menu up, so the
/// CSS goes from `none` to `default` at **the very same instant** — at that moment the window is
/// losing focus, the cursor Chromium pushes down is dropped by the system, and switching back you
/// get the hidden cursor from before the focus loss, restored only by moving the mouse (or by
/// pressing Alt into menu mode, which also forces a cursor reset). The ESC-first case is fine,
/// because there the CSS change happens while the window still has focus and takes effect
/// immediately.
pub fn refresh_cursor() {
    unsafe {
        let mut p = Point { x: 0, y: 0 };
        if GetCursorPos(&mut p) == 0 {
            return;
        }
        let under = WindowFromPoint(p);
        if under == 0 {
            return;
        }
        // Only for our own window — if the cursor is over another program there is nothing to
        // refresh
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(under, &mut pid);
        if pid == 0 || pid != GetCurrentProcessId() {
            return;
        }
        // lParam = MAKELPARAM(HTCLIENT, WM_MOUSEMOVE): exactly the payload of a real mouse move
        let lparam = ((WM_MOUSEMOVE as isize) << 16) | (HTCLIENT as isize);
        SendMessageW(under, WM_SETCURSOR, under as usize, lparam);
    }
}

/// For diagnostics: measure directly "is the cursor showing or hidden right now".
///
/// `GetCursorInfo`'s `CURSOR_SHOWING` flag is a **system-level** fact — not CSS, not our guess.
/// It settles whether "the cursor is gone after Alt-Tab back" is:
///   * the CSS already saying default while the system still says hidden (= the shape was not
///     repainted, my nudge mechanism is wrong), or
///   * the system already saying showing, in which case the problem is elsewhere.
pub fn cursor_probe() -> String {
    unsafe {
        let mut p = Point { x: 0, y: 0 };
        let _ = GetCursorPos(&mut p);
        let mut ci = CursorInfo {
            cb_size: std::mem::size_of::<CursorInfo>() as u32,
            flags: 0,
            h_cursor: 0,
            pt_screen_pos: Point { x: 0, y: 0 },
        };
        let ok = GetCursorInfo(&mut ci) != 0;
        let showing = ok && (ci.flags & CURSOR_SHOWING) != 0;
        format!(
            "showing={} pos=({},{}) hCursor={} getInfoOk={}",
            showing, p.x, p.y, ci.h_cursor, ok
        )
    }
}

/// Payload constants for `WM_SETCURSOR` (see refresh_cursor)
const WM_SETCURSOR: u32 = 0x0020;
const WM_MOUSEMOVE: u32 = 0x0200;
const HTCLIENT: u32 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

extern "system" {
    fn ClipCursor(rect: *const Rect) -> i32;
    fn GetClientRect(hwnd: isize, rect: *mut Rect) -> i32;
    fn ClientToScreen(hwnd: isize, point: *mut Point) -> i32;
    fn GetCursorPos(point: *mut Point) -> i32;
    fn GetCursorInfo(info: *mut CursorInfo) -> i32;
    fn GetForegroundWindow() -> isize;
fn GetSystemMetrics(index: i32) -> i32;
    fn WindowFromPoint(point: Point) -> isize;
    fn SendMessageW(hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
    // These two are also declared in rawinput.rs (not pub there, so they are declared again here;
    // separate modules declaring the same Win32 symbol is legal and links to the same import)
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn GetCurrentProcessId() -> u32;
    fn ShowCursor(show: i32) -> i32;
    fn SetCursor(cursor: isize) -> isize;
    fn LoadCursorW(hinst: isize, name: *const u16) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    fn CallWindowProcW(prev: isize, hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
}

/// ===== Option A: turn off WebView2's **browser accelerator keys** =====
///
/// WebView2 defaults to `AreBrowserAcceleratorKeysEnabled = true`, so these keys are taken over by
/// the browser:
///   F3 -> pops up "Find" (in this project F3 is the debug panel / the F3+F4 game-mode picker hotkey!)
///   Ctrl+F -> find bar, F5 -> reload, F12 -> DevTools, Ctrl+P -> print ...
///
/// Tauri 2.11 does **not** expose this switch (in `tauri-2.11.5/src` there is only the menu
/// accelerator, no `accelerator_keys`). wry does (`with_browser_accelerator_keys`, landing on
/// `SetAreBrowserAcceleratorKeysEnabled(false)`), so this goes through Tauri's official
/// `with_webview` to obtain `ICoreWebView2Controller` and set it once.
///
/// The cost (informed consent): **Ctrl+C / Ctrl+V / Ctrl+A and the like are disabled with it**.
/// The game does not need them.
/// The result is written to logs\boot.log, so it is easy to confirm whether it was set or not.
pub fn disable_browser_accelerator_keys(window: &WebviewWindow, log_root: std::path::PathBuf) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    // The closure must be 'static, so root has to be moved in; the outer Err branch still needs
    // it, so keep a copy first.
    let root_for_outer_log = log_root.clone();
    match window.with_webview(move |webview| {
        // SAFETY: with_webview guarantees this callback runs while the webview is alive, and on
        // the right thread.
        // On Windows `PlatformWebview::controller()` **returns** ICoreWebView2Controller directly
        // (not a raw pointer — that is the macOS branch's signature).
        let result = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings3| settings3.SetAreBrowserAcceleratorKeysEnabled(false))
                // **WebView2's own context menu must be disabled as well**. It is popped up by the
                // **host** (not by the page), so preventDefault on the page's `contextmenu` cannot
                // block it; and it pops a window on the menu key / Shift+F10 / right-click —
                // Windows gives that popup a **visible cursor**, our 8ms cursor sentinel then
                // presses it back to hidden, and what the player sees is "the mouse flashes".
                // In the game right-click is "place a block", so no context menu is needed at all.
                .and_then(|_| {
                    webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|core| core.Settings())
                        .and_then(|settings| settings.SetAreDefaultContextMenusEnabled(false))
                })
        };
        let line = match result {
            Ok(()) => "webview2: browser accelerator keys + DEFAULT CONTEXT MENUS disabled".to_string(),
            Err(e) => format!("webview2: FAILED to disable browser accelerator keys / context menus: {e}"),
        };
        crate::game::append_boot(&log_root, &line);
    }) {
        Ok(()) => {}
        Err(e) => crate::game::append_boot(
            &root_for_outer_log,
            &format!("webview2: with_webview failed: {e}"),
        ),
    }
}
