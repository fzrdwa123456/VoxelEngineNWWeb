// ===== THE WINDOWS CURSOR BACKEND (P1.79/P1.80) =====
//
// Everything in this file touches Win32 for the POINTER: it reads the state into a `CursorProbe`,
// applies a `CursorPlan`/`ClipRect`/shape, moves the pointer and owns the window-procedure
// subclass. It was `win.rs` before the seam existed; the rules it serves are in `cursor_model.rs`,
// the policy that drives it is in `cursor_session.rs`, and the contract it implements is
// `crate::platform::CursorBackend`.
//
// Copied from SDL3 (zlib) where noted: `WIN_UpdateClipCursor` / `WIN_SetCursorPos`
// (SDL_windowswindow.c), `SDL_RedrawCursor` (SDL_mouse.c) and `SDL_HINT_MOUSE_RELATIVE_MODE_CENTER`.
//
// The raw-input collector and the WebView2 half are siblings of this file (`rawinput.rs`,
// `webview.rs`); all three implement a trait from `crate::platform`.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use tauri::WebviewWindow;

use crate::cursor_model::{
    rect_is_empty, rect_is_zero, ClipPos, ClipRect, CursorModel, CursorProbe, CursorShape,
};
use crate::platform::{CursorBackend, NativeWindow};

mod rawinput;
mod webview;
pub use rawinput::WindowsRawInput;
pub use webview::WindowsWebview;

/// Is that window the FOREGROUND one right now? (the platform fact the policy keeps asking for)
pub fn is_foreground(hwnd: isize) -> bool {
    hwnd != 0 && unsafe { GetForegroundWindow() } == hwnd
}

/// A capture request ends any move/size session: a session that somehow ends without
/// `WM_EXITSIZEMOVE` (an aborted drag, a swallowed message) must not be able to wedge the clip off.
pub fn clear_clip_postponed() {
    CLIP_POSTPONED.store(false, Ordering::SeqCst);
}

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

// (`window_rect` and the `GetWindowRect` declaration lived here: the whole-window rect was the fallback clip
// target while the pointer sat on the frame (P1.62d). The centre lock made that unnecessary (P1.76) and the
// probe no longer reads it, so both are gone.)
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
            let _ = SetCursorPos(p.x + 1, p.y);
            let _ = SetCursorPos(p.x, p.y);
        }
        // Then toggle the visibility once more: showing↔hiding itself forces a repaint, and
        // stacking the two means is the most reliable.
        // **ONE mechanism for the shape** (P1.55): this used to also toggle `ShowCursor(0)/(1)`, a SECOND,
        // counter-based hide mechanism next to `SetCursor` - two ways to say "hidden" is one too many. The
        // symmetric 1px jog above is what forces the repaint, and the shape is re-applied by the reconciler.
    }
}
/// The Win32 RECT becomes the model own ClipRect here, at the boundary (and back again for ClipCursor).
fn as_clip_rect(r: Rect) -> ClipRect {
    ClipRect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

fn as_win_rect(c: ClipRect) -> Rect {
    Rect { left: c.left, top: c.top, right: c.right, bottom: c.bottom }
}
/// The same, for a caller that already holds the table (`reconcile` runs under the guard - taking it again
/// would deadlock, so the guard is passed in instead).
pub fn trace_of(m: &CursorModel) -> String {
    let (showing, hcursor) = cursor_info();
    let focused = m.hwnd != 0 && unsafe { GetForegroundWindow() } == m.hwnd;
    let mut pt = Point { x: 0, y: 0 };
    let _ = unsafe { GetCursorPos(&mut pt) };
    let under = unsafe {
        // A fresh Point: the Win32 `Point` is not `Copy`, and the position is still needed for the trace.
        let w = WindowFromPoint(Point { x: pt.x, y: pt.y });
        if w == 0 {
            "none"
        } else {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(w, &mut pid);
            if pid == GetCurrentProcessId() {
                "ours"
            } else {
                "other"
            }
        }
    };
    format!(
        "want={} relative={} shape={:?} clipped=({},{},{},{}) focused={} showing={} hCursor={} pos=({},{}) under={} enforced={}",
        m.want,
        m.relative,
        m.shape,
        m.clipped.left,
        m.clipped.top,
        m.clipped.right,
        m.clipped.bottom,
        focused,
        showing,
        hcursor,
        pt.x,
        pt.y,
        under,
        m.enforced
    )
}
/// Win32 reads only. Thread-agnostic.
pub fn probe_of(m: &CursorModel) -> CursorProbe {
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
    // Where the cursor is right now: the model needs it to decide whether becoming visible has anything to
    // move (P1.55 - with the centre lock it normally does not).
    let mut pt = Point { x: 0, y: 0 };
    let _ = unsafe { GetCursorPos(&mut pt) };
    // (The whole-window rect used to be probed here too: it was the fallback clip target while the pointer sat
    // on the frame, which the centre lock made unnecessary in P1.76 - and dropping it removes a
    // `GetWindowRect` from every 4 ms tick.)
    CursorProbe {
        focused,
        showing,
        client,
        screen,
        pos: ClipPos { x: pt.x, y: pt.y },
        remote: remote_session(),
    }
}

/// **Is this a remote-desktop session?** — read ONCE and cached (P1.77), because the centre lock's width depends
/// on it (SDL: `remote_desktop_adjustment = GetSystemMetrics(SM_REMOTESESSION) ? 2 : 0`,
/// `SDL_windowswindow.c:397`). A probe runs every 4 ms, so the answer is kept: it cannot change while the
/// process lives without the session being re-established.
fn remote_session() -> bool {
    use std::sync::atomic::AtomicU8;
    static REMOTE: AtomicU8 = AtomicU8::new(2); // 2 = not asked yet, 1 = yes, 0 = no
    match REMOTE.load(Ordering::Relaxed) {
        0 => false,
        1 => true,
        _ => {
            let remote = unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0;
            REMOTE.store(if remote { 1 } else { 0 }, Ordering::Relaxed);
            remote
        }
    }
}
/// Move the cursor, JITTERED (x, x+1, x): Windows coalesces and caches identical warps and then ignores
/// them (SDL does exactly this in WIN_SetCursorPos). **Callers must have the cursor HIDDEN**: that is what
/// makes the move invisible (P1.55).
pub fn warp_to(x: i32, y: i32) {
    unsafe {
        let _ = SetCursorPos(x, y);
        let _ = SetCursorPos(x + 1, y);
        let _ = SetCursorPos(x, y);
    }
}

/// Apply the clip. **The only place that calls ClipCursor**, and it never touches another application is
/// clip: it clears one only when the current one is the rect WE recorded (SDL WIN_UnclipCursorForWindow).
pub fn apply_clip(m: &mut CursorModel, clip: Option<ClipRect>) -> bool {
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
pub fn apply_shape(m: &mut CursorModel, shape: CursorShape) -> bool {
    if shape == CursorShape::Unknown || shape == m.shape {
        return false;
    }
    apply_cursor(shape == CursorShape::Arrow);
    m.shape = shape;
    m.enforced = m.enforced.wrapping_add(1);
    true
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

/// The VIRTUAL SCREEN (every monitor): `ClipCursor` refuses a rectangle that is not on it, so the model
/// intersects every clip target with this.
const SM_XVIRTUALSCREEN: i32 = 76;
const SM_YVIRTUALSCREEN: i32 = 77;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;
/// Remote Desktop session (P1.77): it widens the centre lock from 1 px to 5 px, as SDL does.
const SM_REMOTESESSION: i32 = 0x1000;

/// Whether the cursor is visible at the system level: `hCursor == 0` (a NULL shape) means hidden.
pub fn cursor_visible_now() -> bool {
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
pub fn apply_cursor(visible: bool) {
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
/// **The user is MOVING or RESIZING the window** (P1.62): `WM_ENTERSIZEMOVE` opens Windows' modal move/size
/// loop (and is also the moment the system starts drawing the move/size cursor itself), `WM_EXITSIZEMOVE`
/// closes it. A title-bar click without a move sets/clears the same flag, so a click that ends up snapping
/// (Aero Snap) is covered too.
///
/// Why the cursor code cares: `ClipCursor` CLAMPS the pointer into the rectangle it is given, and our
/// rectangle is computed from the CLIENT rect - so re-clipping while the window is being dragged tows the
/// pointer along by the same delta the window moved, which the player SEES (Windows is drawing its own
/// cursor during that loop) and which the input pipeline receives as a teleport-sized jump. SDL refuses to
/// touch the clip for exactly this window of time: `WIN_UpdateClipCursor` returns early while
/// `in_title_click || focus_click_pending || postpone_clipcursor` (SDL_windowswindow.c:1543, set on
/// `WM_ENTERSIZEMOVE`, cleared on `WM_EXITSIZEMOVE`).
///
/// Only a FLAG is set here: the release itself happens in `reconcile` (main thread, under the model lock),
/// because a window procedure must not take that lock - it runs during message dispatch, including the
/// dispatch that `ClipCursor`/`SetCursor` can trigger.
const WM_ENTERSIZEMOVE: u32 = 0x0231;
const WM_EXITSIZEMOVE: u32 = 0x0232;
const WM_NCLBUTTONDOWN: u32 = 0x00A1;
const WM_NCLBUTTONUP: u32 = 0x00A2;
/// The system cancelling the move/size modal loop (see the match arm) - P1.66.
const WM_CANCELMODE: u32 = 0x001F;
/// `GetAsyncKeyState(VK_LBUTTON)`: the polled truth about "a hand on the frame" (P1.66).
const VK_LBUTTON: i32 = 0x01;

/// See `WM_ENTERSIZEMOVE`: true while the window is in a title-click / move / size session.
static CLIP_POSTPONED: AtomicBool = AtomicBool::new(false);

/// Is the user moving or resizing the window right now? Read by `reclip_mouse_capture` and `reconcile`, and
/// PUSHED to the front end (`win-session`, P1.62e) - a held title-bar press produces no geometry event, so
/// this is the only way the front end can know that a hand is on the frame.
///
/// **AND IT HEALS ITSELF (P1.66).** The flag is set by `WM_NCLBUTTONDOWN` and cleared by
/// `WM_EXITSIZEMOVE`/`WM_NCLBUTTONUP` - and clicking the window's MINIMISE or MAXIMISE button sets it while
/// the matching release never reaches the window procedure (Windows hands the modal loop to the system
/// around the state change). A stuck flag then made every rule downstream behave "correctly": the world
/// entry PAUSED (it queries this flag), and every Resume was refused (`LOCK skipped [menu resume]: the
/// window is being moved or resized`) - so the game came up with a visible cursor and a dead view, and the
/// only thing that worked was ESC. Both boot logs showed `WINSESSION pushed moving=true` with no
/// `moving=false` for the rest of the run.
///
/// So the truth is POLLED as well: a hand on the frame always means the LEFT BUTTON IS DOWN, and a click on
/// a caption button releases it immediately. `GetAsyncKeyState` cannot miss a message, so no path can wedge
/// this flag any more. (The old self-heal - clearing it in `set_mouse_capture(on = true)` - could never run:
/// the gate that reads the flag refuses the request before that command is ever called.)
pub fn clip_is_postponed() -> bool {
    if CLIP_POSTPONED.load(Ordering::SeqCst) && !left_button_down() {
        CLIP_POSTPONED.store(false, Ordering::SeqCst);
    }
    CLIP_POSTPONED.load(Ordering::SeqCst)
}

/// Is the left mouse button down right now? (`GetAsyncKeyState`'s high bit.) The one fact that cannot be
/// missed: a title-bar drag or a border resize holds it, anything else does not.
fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 }
}
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
    // The move/size session (P1.62). Only the FLAG is touched here - see `WM_ENTERSIZEMOVE`: taking the model
    // lock inside a window procedure could deadlock against the dispatch that `ClipCursor` itself triggers.
    // These messages are still FORWARDED (the window needs them to move at all).
    match msg {
        WM_ENTERSIZEMOVE | WM_NCLBUTTONDOWN => CLIP_POSTPONED.store(true, Ordering::SeqCst),
        // `WM_CANCELMODE` is the system's "that modal loop is over" (it is the partner of
        // `WM_ENTERSIZEMOVE` for every way the loop can end, including the caption buttons that used to
        // leave the flag set - P1.66). The polled `left_button_down` covers anything still missed.
        WM_EXITSIZEMOVE | WM_NCLBUTTONUP | WM_CANCELMODE => CLIP_POSTPONED.store(false, Ordering::SeqCst),
        _ => {}
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
/// **Make WebView2 decide the cursor shape once more** — send a `WM_SETCURSOR` to the window under the
/// cursor. Returns whether it was really sent (for diagnostics).
///
/// **The ownership test is by ROOT WINDOW, not by process (P1.60).** The old version asked whether the window
/// under the pointer belongs to OUR process, and in this application it never does: WebView2 is
/// **multi-process**, so the render child window under the pointer belongs to `msedgewebview2.exe`. The
/// boot.log probes show it plainly (`under=other` on every trace taken with the pointer over the game, and
/// the only `under=ours` one at a point that happened to be over the host window) — which means this whole
/// path, the documented cure for "Chromium answers `WM_SETCURSOR` from its stale NULL cache", **never ran**.
/// The child's ROOT window is our top-level HWND, and that is what identifies our content.
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
pub fn refresh_cursor() -> bool {
    unsafe {
        let mut p = Point { x: 0, y: 0 };
        if GetCursorPos(&mut p) == 0 {
            return false;
        }
        let under = WindowFromPoint(p);
        if under == 0 {
            return false;
        }
        // **OUR content is identified by the ROOT window** (see the note above): WebView2's render child
        // belongs to another process, so the old `pid == GetCurrentProcessId()` test refused every window we
        // actually own. A foreign application's window still has a foreign root - the test stays honest.
        let root = GetAncestor(under, GA_ROOT);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(root, &mut pid);
        if root == 0 || pid == 0 || pid != GetCurrentProcessId() {
            return false;
        }
        // lParam = MAKELPARAM(HTCLIENT, WM_MOUSEMOVE): exactly the payload of a real mouse move
        let lparam = ((WM_MOUSEMOVE as isize) << 16) | (HTCLIENT as isize);
        SendMessageW(under, WM_SETCURSOR, under as usize, lparam);
        true
    }
}

/// Payload constants for `WM_SETCURSOR` (see refresh_cursor)
const WM_SETCURSOR: u32 = 0x0020;
const WM_MOUSEMOVE: u32 = 0x0200;
const HTCLIENT: u32 = 1;
/// `GetAncestor`'s `GA_ROOT`: the top-level window a child belongs to.
const GA_ROOT: u32 = 2;
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
// ===== (the injected-input cursor repair lived here from P1.73 to P1.77 - see the note further down) =====

extern "system" {
    fn ClipCursor(rect: *const Rect) -> i32;
    fn GetClientRect(hwnd: isize, rect: *mut Rect) -> i32;
    fn ClientToScreen(hwnd: isize, point: *mut Point) -> i32;
    fn GetCursorPos(point: *mut Point) -> i32;
    fn GetCursorInfo(info: *mut CursorInfo) -> i32;
    fn GetForegroundWindow() -> isize;
    fn GetAncestor(hwnd: isize, flags: u32) -> isize;
    fn GetAsyncKeyState(v_key: i32) -> i16;
    fn GetSystemMetrics(index: i32) -> i32;
    fn WindowFromPoint(point: Point) -> isize;
    fn SendMessageW(hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
    // These two are also declared in rawinput.rs (not pub there, so they are declared again here;
    // separate modules declaring the same Win32 symbol is legal and links to the same import)
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn GetCurrentProcessId() -> u32;
    fn SetCursor(cursor: isize) -> isize;
    fn SetCursorPos(x: i32, y: i32) -> i32;
    fn LoadCursorW(hinst: isize, name: *const u16) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    fn CallWindowProcW(prev: isize, hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
}

// (`SendInput` and the net-zero injected move lived here from P1.73 to P1.77: they were the only way found to
// make Windows DRAW a cursor it had the handle for but was not displaying, which is what a Win+L unlock leaves
// behind - the cursor came back with the first tick instead of the first mouse move. **P1.78 removed it BY
// REQUEST**: the post-unlock hiding is Windows' own behaviour and the report prefers it left alone, so the
// cursor after an unlock now waits for the mouse exactly as it does in every other application. The repaint
// nudges that predate it - `refresh_cursor` (a synthetic `WM_SETCURSOR`) and `kick_cursor_repaint` (the
// symmetric `SetCursorPos` jog) - are still here and change nothing about visibility: the P1.73 boot.log shows
// the cursor staying undrawn for 1.5 s with both of them running.)

// ===== THE TRAIT: one implementation of the seam's pointer contract =====
/// The Windows cursor backend. A unit struct: the state lives in the model table and in this
/// module's flags, so there is nothing to construct.
pub struct WindowsCursor;

impl CursorBackend for WindowsCursor {
    fn native_window(&self, window: &WebviewWindow) -> Option<NativeWindow> {
        // The HWND is what every Win32 call in this backend needs; `isize` is how the model stores
        // it, so the shared layer only ever passes an opaque handle around.
        window.hwnd().ok().map(|h| NativeWindow(h.0 as isize))
    }

    fn probe_of(&self, m: &CursorModel) -> CursorProbe {
        probe_of(m)
    }

    fn trace_of(&self, m: &CursorModel) -> String {
        trace_of(m)
    }

    fn is_foreground(&self, hwnd: isize) -> bool {
        is_foreground(hwnd)
    }

    fn apply_clip(&self, m: &mut CursorModel, clip: Option<ClipRect>) -> bool {
        apply_clip(m, clip)
    }

    fn apply_shape(&self, m: &mut CursorModel, shape: CursorShape) -> bool {
        apply_shape(m, shape)
    }

    fn apply_cursor(&self, visible: bool) {
        apply_cursor(visible)
    }

    fn warp_to(&self, x: i32, y: i32) {
        warp_to(x, y)
    }

    fn cursor_visible_now(&self) -> bool {
        cursor_visible_now()
    }

    fn refresh_cursor(&self) -> bool {
        refresh_cursor()
    }

    fn kick_cursor_repaint(&self) {
        kick_cursor_repaint()
    }

    fn clip_is_postponed(&self) -> bool {
        clip_is_postponed()
    }

    fn clear_clip_postponed(&self) {
        clear_clip_postponed()
    }

    fn install_menu_suppressor(&self, hwnd: isize) -> bool {
        install_menu_suppressor(hwnd)
    }
}
