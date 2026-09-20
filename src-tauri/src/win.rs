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
use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicU8, Ordering};

use tauri::WebviewWindow;

/// Put the system cursor at the exact centre of the window (so opening a menu/backpack returns
/// the cursor to the crosshair position).
/// The original was "JS computes the coordinates -> hands them to cursor.exe / a NAPI plugin";
/// here it is one step: the window geometry comes straight from Tauri.
pub fn center_cursor(window: &WebviewWindow) -> bool {
    let pos = match window.outer_position() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let size = match window.outer_size() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let x = pos.x + (size.width as i32) / 2;
    let y = pos.y + (size.height as i32) / 2;
    unsafe { crate::rawinput::SetCursorPos(x, y) != 0 }
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
    unsafe {
        if !on {
            CAPTURE_HWND.store(0, Ordering::Relaxed);
            return ClipCursor(std::ptr::null()) != 0;
        }
        if hwnd == 0 {
            return false;
        }
        let rc = match client_rect_on_screen(hwnd) {
            Some(r) => r,
            None => return false,
        };
        if rc.right <= rc.left || rc.bottom <= rc.top {
            return false;
        }
        let ok = ClipCursor(&rc) != 0;
        if ok {
            CAPTURE_HWND.store(hwnd, Ordering::Relaxed);
        }
        // **The cursor position is deliberately left alone**. Capture is the "go hidden" step, and
        // the rule is that **the hiding path does not centre and does not move the cursor** —
        // this used to call SetCursorPos(window centre), so on entering a world / clicking "back
        // to game" the player saw the cursor jump towards the middle of the window and then
        // vanish (the "hidden but centred" defect).
        // It is also entirely unnecessary: raw input's relative deltas do not depend on the cursor
        // position, and ClipCursor confines the cursor to the rectangle by itself.
        ok
    }
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
    let hwnd = CAPTURE_HWND.load(Ordering::Relaxed);
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let rc = match client_rect_on_screen(hwnd) {
            Some(r) => r,
            None => return false,
        };
        if rc.right <= rc.left || rc.bottom <= rc.top {
            return false;
        }
        ClipCursor(&rc) != 0
    }
}

/// Release capture unconditionally (the safety net for losing focus / exiting; repeated calls are
/// harmless)
pub fn release_mouse_capture() {
    CAPTURE_HWND.store(0, Ordering::Relaxed);
    unsafe {
        ClipCursor(std::ptr::null());
    }
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
    let hwnd = CAPTURE_HWND.load(Ordering::Relaxed);
    if hwnd == 0 {
        FG_MISMATCH_TICKS.store(0, Ordering::Relaxed);
        return false;
    }
    if unsafe { GetForegroundWindow() } == hwnd {
        FG_MISMATCH_TICKS.store(0, Ordering::Relaxed);
        return false;
    }
    if FG_MISMATCH_TICKS.fetch_add(1, Ordering::Relaxed) + 1 < 2 {
        return false; // a foreground switch is briefly inconsistent anyway: act only after two in a row (≈32ms)
    }
    FG_MISMATCH_TICKS.store(0, Ordering::Relaxed);
    let h = app.clone();
    let _ = h.run_on_main_thread(move || {
        release_mouse_capture();
        apply_cursor(true); // release the cursor with it, do not leave it in the hidden state
    });
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
static DESIRED_CURSOR: AtomicU8 = AtomicU8::new(0); // 0=unknown 1=visible 2=hidden
static CURSOR_HWND: AtomicIsize = AtomicIsize::new(0);
static CURSOR_ENFORCED: AtomicU32 = AtomicU32::new(0); // correction count (diagnostics)
/// The window that currently **has** capture open (0 = no capture). `set_mouse_capture` records
/// it and `release_mouse_capture` clears it, so "does the clip have to be recomputed after a
/// geometry change" has a cheap answer (see `reclip_mouse_capture`).
static CAPTURE_HWND: AtomicIsize = AtomicIsize::new(0);
/// How many ticks in a row found "capture is open but the window is not in the foreground"
/// (debounce: a foreground switch is briefly inconsistent anyway)
static FG_MISMATCH_TICKS: AtomicU8 = AtomicU8::new(0);

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
        CURSOR_ENFORCED.fetch_add(1, Ordering::Relaxed);
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

/// Put the cursor back at the centre of the window's client area (the original "opening a
/// menu/backpack lands the cursor on the crosshair" behaviour)
unsafe fn center_on(hwnd: isize) {
    let mut rc = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if GetClientRect(hwnd, &mut rc) == 0 {
        return;
    }
    let mut tl = Point { x: rc.left, y: rc.top };
    let mut br = Point { x: rc.right, y: rc.bottom };
    if ClientToScreen(hwnd, &mut tl) == 0 || ClientToScreen(hwnd, &mut br) == 0 {
        return;
    }
    let _ = crate::rawinput::SetCursorPos((tl.x + br.x) / 2, (tl.y + br.y) / 2);
}

/// Called by the front end when the **desired value changes** (inside
/// `pointerlock.applyCursor()`): record the desire + correct once immediately; on switching to
/// "visible" it also puts the cursor back at the window centre (this is the "does not centre"
/// clause).
///
/// **`SetCursor` must run on the thread that owns the window (the main thread)**, and Tauri
/// commands execute on a thread pool by default — hence the marshal back with
/// `run_on_main_thread`.
pub fn set_cursor_intent(app: &tauri::AppHandle, hwnd: isize, visible: bool) {
    let prev = DESIRED_CURSOR.swap(if visible { 1 } else { 2 }, Ordering::Relaxed);
    CURSOR_HWND.store(hwnd, Ordering::Relaxed);
    // **Centre only on the "hidden -> visible" transition** — that is, the moment "capture is
    // dropped and the menu opens", matching the original feel of "opening a menu/backpack lands
    // the cursor on the crosshair".
    //
    // **Centring on every switch to visible is not allowed**: the applyCursor() at the end of
    // boot() on startup (the main menu has just appeared) reaches here too, and at that point
    // prev == 0 (no intent has ever been set) — the result is the mouse being yanked to the middle
    // of the screen the instant you double-click the exe. Only prev == 2 means "the last state was
    // hidden", i.e. we really did leave the game.
    let was_hidden = prev == 2;
    let _ = app.run_on_main_thread(move || {
        apply_cursor(visible);
        if visible && was_hidden && hwnd != 0 {
            unsafe { center_on(hwnd) };
        }
    });
}

/// The sentinel: correct the cursor whenever the desire and the reality disagree. Called by
/// rawinput's 4ms thread on every second tick (≈8ms).
///
/// It handles three things:
///   * Windows is pushed into menu mode by Alt during capture and sets the arrow → **press it back
///     to NULL immediately** ("disable Alt summoning the mouse");
///   * the cursor is stuck hidden during pause/menu → set it to the arrow immediately;
///   * any moment some other timing path missed.
///
/// Polling `GetCursorInfo` is thread-agnostic, so any thread will do; it marshals back to the main
/// thread **only when they really disagree**, so there is no extra cost in the steady state.
pub fn cursor_sentinel(app: &tauri::AppHandle) {
    let want = DESIRED_CURSOR.load(Ordering::Relaxed);
    if want == 0 {
        return;
    }
    let visible = want == 1;
    if cursor_visible_now() == visible {
        return;
    }
    let hwnd = CURSOR_HWND.load(Ordering::Relaxed);
    let _ = app.run_on_main_thread(move || {
        apply_cursor(visible);
        if visible && hwnd != 0 {
            unsafe { center_on(hwnd) };
        }
    });
}

pub fn cursor_enforced_count() -> u32 {
    CURSOR_ENFORCED.load(Ordering::Relaxed)
}

/// Diagnostics (RAWMON line): the desired cursor state (0 unknown / 1 visible / 2 hidden) and
/// whether the system is **really showing** the cursor right now.
/// Reading the two numbers together settles whether "the sentinel is fighting the system": a
/// repeating `desired=2 showing=1` = the system keeps showing the cursor and the sentinel keeps
/// pressing it back — every round marshals to the main thread, and the main thread is the one
/// running rendering.
pub fn cursor_state() -> (u8, bool) {
    (DESIRED_CURSOR.load(Ordering::Relaxed), cursor_visible_now())
}

/// Diagnostics (RAWMON line): whether mouse capture (ClipCursor) is currently on
pub fn capture_active() -> bool {
    CAPTURE_HWND.load(Ordering::Relaxed) != 0
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
