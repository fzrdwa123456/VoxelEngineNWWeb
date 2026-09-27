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
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

use tauri::WebviewWindow;

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
    // **A CAPTURE REQUEST ENDS ANY MOVE/SIZE SESSION (P1.62).** The flag is set by `WM_ENTERSIZEMOVE` and
    // cleared by `WM_EXITSIZEMOVE`; a session that somehow ends without that message (an aborted drag, a
    // swallowed message) must not be able to wedge the clip OFF for the rest of the run. Asking for the mouse
    // is the one signal that says "the user is back in the game".
    CLIP_POSTPONED.store(false, Ordering::SeqCst);
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
    // **THE CLIP TARGET, NOT `decide` (P1.62c).** `decide` carries rule 2's "the pointer has left the window"
    // DROP, which is about an ONGOING capture. Applying it here REFUSED the capture whenever the pointer
    // happened to be outside the client at the moment of the request - and a pointer on the title bar is
    // exactly where it is right after the user has been dragging the window. The refusal sent the front end to
    // `requestPointerLock`, i.e. to Chromium's own client-area clip, which tows the pointer on a geometry
    // change just as happily AND brings back ESC-unlock and its cooldown (boot.log: `MOUSE CAPTURE native
    // refused, falling back to requestPointerLock`). Entering a capture may move the pointer into the window
    // ONCE - that is what capture means - and it is invisible, because we hide it first (below).
    let target = clip_target(&p);
    if rect_is_zero(target) {
        // Nothing visible to clip to (the window is off the screen): do NOT pretend to be capturing. The front
        // end sees `false` and falls back, instead of the cursor escaping the window while the game still
        // processes clicks.
        m.relative = false;
        arm_arrow_guard(&mut m);
        return false;
    }
    // **HIDE FIRST, THEN CLIP** (P1.57, one step earlier). `ClipCursor` clamps the pointer into the new
    // rectangle, and at CAPTURE time that clamp is a real move (the pointer may be on the title bar) - doing
    // it while the cursor is still visible would show a jump for a frame. So: hide, clip, and if the clip is
    // refused, hand the arrow straight back and give up.
    apply_shape(&mut m, CursorShape::Hidden);
    if !apply_clip(&mut m, Some(target)) {
        m.relative = false;
        arm_arrow_guard(&mut m);
        m.shape = CursorShape::Unknown; // force the push: the record already says Hidden
        apply_shape(&mut m, CursorShape::Arrow);
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
    // **NOT WHILE THE USER IS DRAGGING OR RESIZING (P1.62)**: recomputing the rectangle is what tows the
    // pointer along, and the geometry events of a drag arrive one per pixel. `reconcile` hands the pointer
    // back ONCE at the start of the session instead, and the sentinel re-clips from the settled geometry
    // after `WM_EXITSIZEMOVE`.
    if clip_is_postponed() {
        return false;
    }
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
    // **…and we now OWE the player an arrow** (P1.60): the ARROW GUARD goes up, so a system that reports no
    // cursor within the next second gets the arrow pushed back at it (see `CursorModel::arrow_guard` for the
    // boot.log that made "hand it back exactly once" insufficient).
    arm_arrow_guard(&mut m);
}

/// **THE FOREGROUND WAS LOST — the cursor SESSION is over** (P1.58). This is the ONE thing both paths that
/// detect "we are not the foreground window any more" call: the window event in `lib.rs`
/// (`WindowEvent::Focused(false)`) and `capture_foreground_check`'s ~32 ms backstop.
///
/// It does two things, and the SECOND one is the root cure of the focus-flap report:
///   1. the capture request goes and the clip we hold is released (`release_mouse_capture`), so a background
///      window never confines the cursor over another application's screen area;
///   2. the front end's HIDDEN INTENT is FORGOTTEN (`cursor_model::forget_intent`, rule 4). It used to
///      survive, and `decide`'s no-capture branch hides the cursor for `want == 2` - so the 8 ms sentinel put
///      the arrow away again on EVERY "focus gained" while Windows flip-flopped the foreground (press the Win
///      key: `focus LOST` -> `focus GAIN` -> `focus LOST` …). Forgetting it means a regained foreground
///      changes NOTHING until the front end says what it wants, and the front end no longer re-requests
///      capture on a focus event either (main.ts::onWinFocus) - the mouse is only captured when the PLAYER
///      asks for it.
pub fn on_foreground_lost() {
    release_mouse_capture();
    let mut m = model();
    forget_intent(&mut m);
}

/// **Hand the arrow back RIGHT NOW** (P1.60) — the symmetric of P1.57's "opening the capture hides the cursor
/// in the SAME call".
///
/// Why: releasing the clip does NOT touch the shape, so the cursor stayed NULL until the 8 ms sentinel got
/// to it — the boot.log line `[cursor] focus LOST after =[… shape=Hidden … showing=false …]` was taken with
/// the pointer still invisible, one tick before the arrow came back. That tick is a visible flash of "no
/// cursor" on the exact path the Win-key report is about.
///
/// **MAIN THREAD ONLY**: `SetCursor` belongs to the thread that owns the window (see `apply_shape`), so this
/// is called from the window-event path in `lib.rs`; the raw-input path (`capture_foreground_check`) lets
/// `reconcile` marshal it instead.
pub fn restore_arrow() {
    let mut m = model();
    m.shape = CursorShape::Unknown; // force `apply_shape` to push even when our record already says Arrow
    let (showing, _) = cursor_info();
    if showing {
        // The system already shows one: nothing to do, and the record is right again.
        m.shape = CursorShape::Arrow;
        return;
    }
    apply_shape(&mut m, CursorShape::Arrow);
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
    // The whole "we are not the foreground" treatment, including forgetting the hidden intent (P1.58): a
    // background window must not re-hide the cursor the moment it is foreground again.
    on_foreground_lost();
    // Diagnostics (P1.59): this path is otherwise SILENT (it only emits an event), and "the Rust net tore a
    // background capture down" is exactly the moment whose aftermath we are hunting.
    crate::boot_line(app, &format!("[cursor] fgcheck tore down a background capture [{}]", trace_of(&model())));
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
        // **ONE mechanism for the shape** (P1.55): this used to also toggle `ShowCursor(0)/(1)`, a SECOND,
        // counter-based hide mechanism next to `SetCursor` - two ways to say "hidden" is one too many. The
        // symmetric 1px jog above is what forces the repaint, and the shape is re-applied by the reconciler.
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
    arm_arrow_guard, clip_target, decide, forget_intent, rect_is_empty, rect_is_zero, tick_arrow_guard,
    ClipPos, ClipRect, CursorModel, CursorProbe, CursorShape,
};

/// The ONE table. A lock rather than five statics: the reconciler, the raw-input thread and the Tauri
/// commands all touch it, and "who owns the cursor" has to be one answer.
static MODEL: Mutex<CursorModel> = Mutex::new(CursorModel {
    hwnd: 0,
    want: 0,
    relative: false,
    clipped: ClipRect::ZERO,
    shape: CursorShape::Unknown,
    enforced: 0,
    fg_mismatch_ticks: 0,
    centre_on_show: true,
    arrow_guard: 0,
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

/// **THE CURSOR TRACE (P1.59) — everything about the cursor in ONE line.**
///
/// A boot.log line that carries this settles, without guessing, which of the three possible reasons left
/// the cursor invisible:
///   * `want=2 relative=false` + `showing=false` → **the INTENT** hid it while no capture was held (the
///     front end asked for hidden - the `[cursor] intent` line right above says which call did);
///   * `want=1 relative=false` + `showing=false` → nobody asked for hidden and we hold no clip, so the NULL
///     cursor is **Chromium's** (its cached shape answers `WM_SETCURSOR`): read the front end's
///     `computed=` CSS in its own probe line;
///   * `showing=true` while the player sees NO cursor → the state is right and the desktop simply did not
///     repaint the overlay (the "appears only after I move the mouse" report; the 8 ms reconciler cannot see
///     that, because `GetCursorInfo` agrees with us).
/// `under=` adds who owns the window under the pointer (`ours`/`other`/`none`): a foreign owner means
/// Chromium is not even being asked for a shape, so nothing we push matters while the pointer is there.
pub fn cursor_trace() -> String {
    trace_of(&model())
}

/// The same, for a caller that already holds the table (`reconcile` runs under the guard - taking it again
/// would deadlock, so the guard is passed in instead).
fn trace_of(m: &CursorModel) -> String {
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

/// A flood guard for the APPLY trace below: at most 8 lines per 500 ms. The reconciler ticks every 8 ms, and
/// the very loop we are hunting (a stale intent fighting the system: `desired=2 showing=1`) would otherwise
/// write 125 lines a second - the repetition IS the symptom, so it is capped, not silenced.
fn trace_budget_ok() -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static WINDOW: AtomicU64 = AtomicU64::new(0);
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let window = now / 500;
    if WINDOW.swap(window, Ordering::Relaxed) != window {
        COUNT.store(0, Ordering::Relaxed);
    }
    COUNT.fetch_add(1, Ordering::Relaxed) < 8
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
    // Where the cursor is right now: the model needs it to decide whether becoming visible has anything to
    // move (P1.55 - the centre lock normally means it does not).
    let mut pt = Point { x: 0, y: 0 };
    let _ = unsafe { GetCursorPos(&mut pt) };
    CursorProbe {
        focused,
        showing,
        client,
        screen,
        pos: ClipPos { x: pt.x, y: pt.y },
    }
}

/// Move the cursor, JITTERED (x, x+1, x): Windows coalesces and caches identical warps and then ignores
/// them (SDL does exactly this in WIN_SetCursorPos). **Callers must have the cursor HIDDEN**: that is what
/// makes the move invisible (P1.55).
fn warp_to(x: i32, y: i32) {
    unsafe {
        let _ = crate::rawinput::SetCursorPos(x, y);
        let _ = crate::rawinput::SetCursorPos(x + 1, y);
        let _ = crate::rawinput::SetCursorPos(x, y);
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
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut m = model();
        // **THE USER IS MOVING OR RESIZING THE WINDOW (P1.62).** Hand the pointer back ONCE, then leave the
        // cursor completely alone until the session ends:
        //   * re-clipping during the session is what tows the pointer (see `WM_ENTERSIZEMOVE`), and Windows is
        //     drawing its own move/size cursor anyway;
        //   * the clip must NOT stay where it was either: a stale 1px lock freezes the pointer, i.e. the window
        //     could not be dragged at all. Releasing it is what makes the drag behave like a normal window drag;
        //   * the ARROW GUARD is armed but NOT ticked (we return before the tick), so it is still armed when the
        //     session ends and the cursor must be visible again;
        //   * `relative` goes false with it, so nothing downstream believes we are capturing a window the user
        //     is currently moving. The FRONT END separately treats the geometry change as "hand the mouse back
        //     and pause" (main.ts::onWinGeometry) - this is the platform half of the same decision.
        // The 8 ms sentinel picks the settled geometry up on its first tick after `WM_EXITSIZEMOVE`.
        if clip_is_postponed() {
            if m.relative || !rect_is_zero(m.clipped) {
                m.relative = false;
                apply_clip(&mut m, Some(ClipRect::ZERO));
                arm_arrow_guard(&mut m);
                crate::boot_line(
                    &handle,
                    &format!("[cursor] window session -> clip released [{}]", trace_of(&m)),
                );
            }
            return;
        }
        // **THE PLAN IS DECIDED HERE, UNDER THE SAME LOCK THAT APPLIES IT (P1.61).**
        //
        // It used to be computed on the CALLER's thread and applied later on the main thread, so two
        // reconciles queued back to back could land out of order: a plan built while a capture was still on
        // (`shape=Hidden`, rule 2) could arrive AFTER the release that switched it off and put a hidden
        // cursor on screen for one tick that nobody had asked for. The boot.log caught it exactly -
        // `apply … shape=Arrow forced=true` → `apply … shape=Hidden forced=false` → `apply … shape=Arrow` -
        // and `forced=false` on the middle line is the tell: that plan was computed when `relative` was
        // still true, and nothing in the model's CURRENT state could have produced it.
        //
        // Deciding here costs nothing: `probe_of` only READS Win32, and the main thread is where
        // `SetCursor`/`ClipCursor` have to run anyway. The state a plan is built from is now the state it is
        // applied to, so the "one writer" claim covers the DECISION and not just the calls.
        let plan = {
            let p = probe_of(&m);
            decide(&m, &p)
            // **The system can disagree with our own record.** `SetCursor` pushes are dropped while another
            // application owns the cursor, and Chromium answers NULL from its cached cursor for a while after
            // focus returns (both were caught by the boot.log probes) - so when we WANT the arrow, are focused,
            // and the system still reports a hidden cursor, the push has to be REPEATED: the plan alone would be
            // a no-op, because `m.shape` already says Arrow. Only while FOCUSED, though: a background window must
            // never fight the foreground application for the cursor (rule 1 of the model).
        };
        let before = (m.clipped, m.shape, m.want, m.relative);
        apply_clip(&mut m, plan.clip);
        // **THE CAPTURE IS OVER WHEN THE POINTER HAS LEFT THE WINDOW (P1.62).** `decide` says so because a
        // capture whose window no longer contains the pointer cannot be honoured without clamping it back
        // in - and clamping is what towed the cursor along with a window being dragged. Clearing the
        // request here is the platform half; the event below is what tells the FRONT END (releasing on this
        // side alone would leave it believing it still holds the mouse, which is the trap
        // `capture_foreground_check` documents).
        if plan.drop_capture {
            m.relative = false;
            arm_arrow_guard(&mut m);
        }
        // **WARP WHILE HIDDEN** (P1.55). The product wants "opening a menu lands the cursor on the
        // crosshair", and the only way to make that move invisible is to do it with a NULL shape. It is also
        // why the old separate `center_cursor` command could still flash: it raced the visible intent through
        // the IPC thread pool, so the arrow could be back on screen before the warp happened.
        if let Some(pos) = plan.warp {
            if m.shape != CursorShape::Hidden {
                apply_cursor(false);
                m.shape = CursorShape::Hidden;
            }
            warp_to(pos.x, pos.y);
        }
        // The model compared the plan with the SYSTEM (`GetCursorInfo`), not with our own record: a dropped
        // push or a stale Chromium cache has to be corrected in BOTH directions.
        if plan.force_shape {
            m.shape = CursorShape::Unknown;
        }
        apply_shape(&mut m, plan.shape);
        if plan.drop_capture {
            crate::boot_line(
                &handle,
                &format!("[cursor] capture dropped: the pointer left the client [{}]", trace_of(&m)),
            );
            let _ = tauri::Emitter::emit(&handle, "capture-lost", ());
        }
        // The ARROW GUARD counts down once per reconciler tick (P1.60). It lives here, not in `decide`, so
        // that the rule set stays pure.
        tick_arrow_guard(&mut m);
        // **WHAT THE RECONCILER REALLY DID (P1.59).** Only ticks that CHANGED something are logged (rule 3:
        // a tick whose plan changes nothing makes no Win32 call either), so this line answers "who pushed the
        // cursor away, and how many times". `forced=true` is the disagreement loop - the system keeps showing
        // a cursor we want hidden, or keeps hiding one we want shown - and the budget in `trace_budget_ok`
        // caps it at 8 lines per 500 ms, because that repetition IS the symptom being hunted.
        let changed = before != (m.clipped, m.shape, m.want, m.relative);
        if (changed || plan.force_shape) && trace_budget_ok() {
            crate::boot_line(
                &handle,
                &format!(
                    "[cursor] apply clip={:?} shape={:?} forced={} warp={} drop={} [{}]",
                    plan.clip,
                    plan.shape,
                    plan.force_shape,
                    plan.warp.is_some(),
                    plan.drop_capture,
                    trace_of(&m)
                ),
            );
        }
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

/// See `WM_ENTERSIZEMOVE`: true while the window is in a title-click / move / size session.
static CLIP_POSTPONED: AtomicBool = AtomicBool::new(false);

/// Is the user moving or resizing the window right now? Read by `reclip_mouse_capture` and `reconcile`.
fn clip_is_postponed() -> bool {
    CLIP_POSTPONED.load(Ordering::SeqCst)
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
        WM_EXITSIZEMOVE | WM_NCLBUTTONUP => CLIP_POSTPONED.store(false, Ordering::SeqCst),
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

/// Called by the front end when the **desired value changes** (inside `pointerlock.applyCursor()`): record
/// the intent, then hand the whole question to the model.
///
/// **Nothing is MOVED here** (P1.51). This used to centre the cursor on the hidden -> visible transition,
/// which is part of how "press Win / Alt+Tab and the mouse snaps to the middle of the game window"
/// happened. With the centre lock the cursor never left the crosshair, so the product feel ("opening a
/// menu lands on the crosshair") follows from the CLIP instead of from a warp - and the explicit
/// `center_cursor` command still exists for the paths that really do want a move.
pub fn set_cursor_intent(app: &tauri::AppHandle, hwnd: isize, visible: bool) {
    let new_want = if visible { 1 } else { 2 };
    {
        let mut m = model();
        m.hwnd = hwnd;
        m.want = new_want;
    }
    // **WHO ASKED FOR WHAT, AND WHEN (P1.59).** This is the line that names the culprit when the cursor is
    // hidden with no capture behind it: `want=…->2 relative=false` means the FRONT END ordered the cursor
    // hidden (the matching `[cursor] JS …` probe line right above/below carries its inputs: canControl,
    // locked, freeMouse, modal, computed CSS). A `want` that does not change still logs, because the
    // re-assert path sends the same value on purpose.
    crate::boot_line(
        app,
        &format!("[cursor] intent visible={visible} want->{new_want} [{}]", trace_of(&model())),
    );
    reconcile(app);
}

/// The RECONCILER: gather, decide, apply - and call nothing when the plan matches what is already there.
///
/// Called by rawinput on every second tick (8ms) as the self-healing path: SDL gets this for free from
/// `WM_SETCURSOR` on every mouse move, but Chromium owns our window, so the only way to notice "the system
/// and the intent disagree" is to ask. Rule 3 of the model is what makes that safe: a tick that changes
/// nothing makes NO Win32 call, so it neither fights the system nor touches anybody is cursor.
pub fn cursor_sentinel(app: &tauri::AppHandle) {
    {
        let m = model();
        // **A LIVE CAPTURE IS HEALED EVEN WHEN THE INTENT IS UNKNOWN (P1.58)**, and so is the ARROW GUARD
        // (P1.60) - that is the whole point of it: after a release the front end may never speak again, and
        // the arrow must still be pushed until it sticks (or the guard runs out). Cost of asking: nothing,
        // because a tick whose plan changes nothing makes no Win32 call (rule 3).
        if m.want == 0 && !m.relative && m.arrow_guard == 0 {
            return;
        }
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

extern "system" {
    fn ClipCursor(rect: *const Rect) -> i32;
    fn GetClientRect(hwnd: isize, rect: *mut Rect) -> i32;
    fn ClientToScreen(hwnd: isize, point: *mut Point) -> i32;
    fn GetCursorPos(point: *mut Point) -> i32;
    fn GetCursorInfo(info: *mut CursorInfo) -> i32;
    fn GetForegroundWindow() -> isize;
    fn GetAncestor(hwnd: isize, flags: u32) -> isize;
fn GetSystemMetrics(index: i32) -> i32;
    fn WindowFromPoint(point: Point) -> isize;
    fn SendMessageW(hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
    // These two are also declared in rawinput.rs (not pub there, so they are declared again here;
    // separate modules declaring the same Win32 symbol is legal and links to the same import)
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn GetCurrentProcessId() -> u32;
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
