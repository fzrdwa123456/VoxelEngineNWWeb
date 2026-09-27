// ===== THE CURSOR SESSION: the cross-platform half (P1.79) =====
//
// This file is what used to be two thirds of `win.rs`. It owns the ONE cursor table, the capture
// lifecycle, the reconciler, the diagnostics and the Tauri-facing entry points - and it contains
// **no platform call at all**. Everything that really talks to the operating system is behind the
// functions it imports from `crate::platform` (see `platform/mod.rs` for the list that seam
// promises). The RULES are one level further out, in `cursor_model.rs`.
//
// The three layers, and why they are three:
//   cursor_model.rs   pure data + one pure decision, table-tested without a window
//   cursor_session.rs THIS: when to ask, what to do with the answer, what to log
//   platform/*        how to ask and how to apply, per operating system
//
// A port therefore writes ONE new file under `platform/` and leaves this one alone.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::cursor_model::{
    arm_arrow_guard, centre_lock, decide, forget_intent, rect_is_zero, tick_arrow_guard, ClipRect,
    CursorModel, CursorShape, LOST_FIGHT_TICKS,
};
use crate::platform::{
    apply_clip, apply_cursor, apply_shape, clear_clip_postponed, clip_is_postponed,
    cursor_visible_now, is_foreground, kick_cursor_repaint, probe_of, refresh_cursor, trace_of,
    warp_to,
};

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
// The RULES live in `cursor_model.rs` (pure data + one pure decision, testable without a window); the
// PLATFORM half is `crate::platform` (it gathers the probe and applies the plan). This file is the
// middle: it owns the one table and decides WHEN to ask and what to do with the answer.
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
    lost_fight_ticks: 0,
    user_holding: false,
});

fn model() -> std::sync::MutexGuard<'static, CursorModel> {
    // A poisoned lock must not wedge the game: the table is plain data, so take it anyway.
    MODEL.lock().unwrap_or_else(|e| e.into_inner())
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
/// Turn native mouse capture on/off. Returns whether it worked (P1.72: a failure means the mouse simply
/// stays free — there is no second mechanism to fall back to).
pub fn set_mouse_capture(hwnd: isize, on: bool) -> bool {
    if !on {
        // **SET THE ONE INPUT THE PROJECTION READS (P1.63).** `mouse_capture` and `cursor_intent` are two
        // views of the same boolean now, and writing it here means the hand-back (visible + centred, via the
        // projection's `was_hidden` warp) happens on the next tick even if the intent push is still in
        // flight - the ordering that used to matter no longer can.
        model().want = 1;
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
    clear_clip_postponed();
    let mut m = model();
    m.hwnd = hwnd;
    // Capture while NOT the foreground window is refused: the clip would sit over somebody else is screen
    // area and the cursor would be hidden globally (see `capture_foreground_check`). The front end has the
    // same gate; this is the backstop. (SDL puts the same condition in WIN_UpdateClipCursor.)
    if !is_foreground(hwnd) {
        return false;
    }
    m.want = 2; // …and the request sets want=2 (see the note above)
    m.relative = true;
    let p = probe_of(&m);
    // **THE CENTRE LOCK, NOT `decide` (P1.62c/P1.76).** Entering a capture wants the same target the projection
    // uses every tick - the 3x1 box at the crosshair - and NOT `decide`'s release/drop branch (that one is about
    // an ONGOING capture that has nothing to lock to). Using the pointer-following client rect here is what once
    // refused the capture whenever the pointer happened to be on the title bar, and the refusal sent the front
    // end to `requestPointerLock` (deleted in P1.72); now it would simply leave the player with no mouse.
    let target = centre_lock(&p);
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
        if is_foreground(m.hwnd) {
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
/// A "at most one line per `gap` ms" guard, for the diagnostics that describe a STATE rather than an action.
fn trace_gap_ok(gap_ms: u64) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let last = LAST.load(Ordering::Relaxed);
    if now.saturating_sub(last) < gap_ms {
        return false;
    }
    LAST.store(now, Ordering::Relaxed);
    true
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
/// Gather, decide, apply - ON THE MAIN THREAD. Idempotent: a tick that changes nothing makes no call.
fn reconcile(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut m = model();
        // **PUSH THE WINDOW-SESSION FACT TO THE FRONT END (P1.62e).** A held title-bar press produces NO
        // geometry event, so the front end cannot tell "a hand is on the frame" from "the user is waiting" -
        // and a world entered in that state captured the mouse and paused only once the window moved. The
        // flag itself is set inside the window procedure (which has no AppHandle), so the TRANSITION is
        // noticed and emitted here, on the main thread, before the session branch below returns.
        // **THE FOREGROUND IS A MEASURED FACT, SO LET THE PLATFORM SPEAK (P1.67).**
        //
        // Windows does NOT deliver `WM_KILLFOCUS` / Tauri's `Focused(false)` for every way we can lose the
        // foreground: locking the session (Win+L, the secure desktop), the emoji/symbol overlay (Win+;), a UAC
        // prompt and others leave the front end believing it is still in front - so it never ran its "hand the
        // mouse back + pause" policy, while this side (which asks `GetForegroundWindow` every tick) already knew.
        // The two reported shapes were exactly that: after Win+L the cursor came back hidden (the projection
        // re-hid it on unlock, with no pause menu to keep it visible), and Win+; showed the cursor with no
        // pause at all.
        //
        // The fix is not another event to miss: the POLLED transition is what notifies. One `capture-lost` per
        // loss, which the front end already handles (release + pause when a world is running), and that covers
        // Win+L, Win+;, UAC, the task manager, the task view and anything else that becomes foreground.
        let focused_now = is_foreground(m.hwnd);
        if LAST_FOCUSED.swap(focused_now, Ordering::SeqCst) != focused_now {
            if !focused_now {
                crate::boot_line(
                    &handle,
                    &format!("[cursor] foreground LOST (measured) -> telling the front end [{}]", trace_of(&m)),
                );
                let _ = tauri::Emitter::emit(&handle, "capture-lost", ());
            } else {
                // **THE REGAIN NEEDS THE SAME TREATMENT (P1.68).** After a session lock (Win+L) the cursor was
                // hidden until the mouse moved: the LOSS was announced (P1.67) but the REGAIN was not, and
                // neither the window event nor the repaint nudges ran - so the cursor was never REPAINTED
                // (the system can report `showing=true` while the desktop still shows nothing; see the note
                // on `kick_cursor_repaint`). Do exactly what the window-event focus branch does here, and tell
                // the front end too (`win-focus`): its focus policy re-asserts the intent and runs the
                // two-step CSS nudge, which is what turns the intent back into a shape.
                crate::boot_line(
                    &handle,
                    &format!("[cursor] foreground REGAINED (measured) -> refreshing + telling the front end [{}]", trace_of(&m)),
                );
                let refreshed = refresh_cursor();
                kick_cursor_repaint();
                crate::boot_line(&handle, &format!("[cursor] refresh sent={refreshed} (measured regain)"));
                let _ = tauri::Emitter::emit(&handle, "win-focus", ());
            }
        }
        let moving = clip_is_postponed();
        if moving != SESSION_PUSHED.load(Ordering::SeqCst) {
            SESSION_PUSHED.store(moving, Ordering::SeqCst);
            crate::boot_line(&handle, &format!("[cursor] window session moving={moving} [{}]", trace_of(&m)));
            let _ = tauri::Emitter::emit(&handle, "win-session", moving);
        }
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
        // **THE PROBE IS KEPT** (it used to be scoped to the `decide` call): the stuck-cursor repair at the
        // bottom of this function needs the same measurements the plan was built from (P1.73).
        let p = probe_of(&m);
        let plan = decide(&m, &p);
        // **The system can disagree with our own record.** `SetCursor` pushes are dropped while another
        // application owns the cursor, and Chromium answers NULL from its cached cursor for a while after
        // focus returns (both were caught by the boot.log probes) - so when we WANT the arrow, are focused,
        // and the system still reports a hidden cursor, the push has to be REPEATED: the plan alone would be
        // a no-op, because `m.shape` already says Arrow. Only while FOCUSED, though: a background window must
        // never fight the foreground application for the cursor (rule 1 of the model).
        let before = (m.clipped, m.shape, m.want, m.relative);
        apply_clip(&mut m, plan.clip);
        // **DIAGNOSTICS (P1.65): "we WANT the mouse and we hold no clip".** That is the reported state where
        // the game enters (or resumes) with a visible cursor and a view that cannot turn. One line names the
        // branch that refused: nothing visible to clip to, or the pointer is outside our window. Rate-limited
        // to one line per 500 ms - it repeats for as long as the state lasts, and the repetition is the
        // symptom's shape.
        if m.want == 2 && m.hwnd != 0 && rect_is_zero(m.clipped) && trace_gap_ok(500) {
            let p = probe_of(&m);
            let why = if rect_is_zero(centre_lock(&p)) {
                "nothing to lock to (no visible part of the window)"
            } else {
                "the window is not foreground"
            };
            crate::boot_line(&handle, &format!("[cursor] want=hidden but NOT confined: {why} [{}]", trace_of(&m)));
        }
        // **THE CAPTURE IS OVER WHEN THE POINTER HAS LEFT THE WINDOW (P1.62).** `decide` says so because a
        // capture whose window no longer contains the pointer cannot be honoured without clamping it back
        // in - and clamping is what towed the cursor along with a window being dragged. Clearing the
        // request here is the platform half; the event below is what tells the FRONT END (releasing on this
        // side alone would leave it believing it still holds the mouse, which is the trap
        // `capture_foreground_check` documents).
        //
        // **It is the ONLY thing that drops a capture (P1.75).** The overlay case used to come through here too
        // (P1.69's "cannot hide the cursor -> handing the mouse back"), which is what made Win+; pause the game;
        // it now keeps the capture and only stops pushing the shape (see `decide`).
        if plan.drop_capture {
            m.relative = false;
            m.lost_fight_ticks = 0;
            arm_arrow_guard(&mut m);
        }
        // **"SOMEBODY ELSE IS DRAWING THE CURSOR: WE ARE NOT FIGHTING AND NOT LETTING GO" (P1.75).** One
        // rate-limited line for a state that lasts as long as the overlay does, so the log says what the code
        // decided (the alternative - the old `cannot hide the cursor -> handing the mouse back` - is gone).
        if m.want == 2 && p.focused && p.showing && m.lost_fight_ticks >= LOST_FIGHT_TICKS && trace_gap_ok(500) {
            crate::boot_line(
                &handle,
                &format!(
                    "[cursor] an overlay is showing the cursor: keeping the capture and pausing nothing (P1.75) [{}]",
                    trace_of(&m)
                ),
            );
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
        // **NO CURSOR REPAIR IS FORCED HERE ANY MORE (P1.78).** The last piece the boot.log exposed was that after
        // a Win+L unlock the system reports `showing=false hCursor=65539` for a while - the arrow IS set, the
        // pointer IS on the crosshair, and the desktop simply does not draw it until real mouse input arrives.
        // P1.73 "fixed" that by injecting a net-zero move, which made the cursor appear with the first tick
        // instead of the first mouse move - and the report's verdict is that this is Windows' own behaviour and
        // should be left alone. So it is gone (see the note where the FFI used to be): after an unlock the cursor
        // waits for the mouse, exactly as it does everywhere else. Nothing here replaces it.
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
        // **COUNT THE TICKS WE SPEND FIGHTING A CURSOR SOMEBODY ELSE SHOWS (P1.69).** `want` hidden + focused +
        // the system still showing one is the overlay state; `decide` gives up on it after ~250 ms.
        {
            // …and mirror the other platform fact the pure rule asks for (`user_holding`, P1.70).
            m.user_holding = clip_is_postponed();
            let q = probe_of(&m);
            if m.want == 2 && q.focused && q.showing {
                m.lost_fight_ticks = m.lost_fight_ticks.saturating_add(1);
            } else {
                m.lost_fight_ticks = 0;
            }
        }
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
/// The value last PUSHED to the front end (`win-session`), so the transition is emitted once (P1.62e).
static SESSION_PUSHED: AtomicBool = AtomicBool::new(false);

/// Was our window the FOREGROUND one on the previous tick? (P1.67) The polled mirror that lets the platform
/// TELL the front end about a foreground loss it would otherwise never hear about.
static LAST_FOCUSED: AtomicBool = AtomicBool::new(false);
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
        if m.want == 0 && !m.relative && m.arrow_guard == 0 && !clip_is_postponed() {
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
