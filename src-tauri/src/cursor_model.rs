// ===== THE CURSOR MODEL (DOD, P1.51) =====
//
// Pure data + one pure decision. NO Win32, NO tauri, no globals: this file is the RULES, `win.rs` is the
// platform. That split is what makes the rules testable - `rustc --test src/cursor_model.rs` runs the table
// test at the bottom without a window, a GPU or a WebView (`cargo test --lib` cannot start in this project:
// the tauri/WebView2 dependency chain makes the test binary fail with STATUS_ENTRYPOINT_NOT_FOUND).
//
// It replaces three scattered mechanisms that used to disagree with each other (a desired-cursor static, an
// 8ms "sentinel" that forced it, and a re-clip on geometry) - the five statics they kept
// (`DESIRED_CURSOR`, `CURSOR_HWND`, `CURSOR_ENFORCED`, `CAPTURE_HWND`, `FG_MISMATCH_TICKS`) are FIELDS of
// one table now, so "what we want", "what we did" and "what we saw" cannot drift apart.
//
// Modelled on SDL3 (zlib): `WIN_UpdateClipCursor` (SDL_windowswindow.c), `SDL_RedrawCursor` (SDL_mouse.c)
// and `SDL_HINT_MOUSE_RELATIVE_MODE_CENTER`. Three rules matter:
//   1. **NO FOCUS => THE CLIP IS NOT OURS.** Release the clip (only one WE set), and put the ARROW back -
//      we are the reason the cursor was hidden, and Windows only re-decides a shape when the pointer MOVES
//      into a window. That is the "press Win and the cursor is gone until I jiggle the mouse" report.
//   2. **CLIP != WARP.** While capturing, the cursor is confined to the CLIENT AREA (P1.62c) - not to a
//      centre pixel: the clip must never MOVE the pointer, and `ClipCursor` clamps the pointer into whatever
//      rectangle it is given, so a target derived from the client centre towed the cursor along every time
//      the window was dragged or resized. Confining it to the client is enough (raw deltas keep arriving and
//      the pointer cannot wander off to another application), and while capturing the pointer is HIDDEN, so
//      where exactly it sits does not matter. The CROSSHAIR is a SHOW-time thing: the `warp` plan of the
//      hidden -> visible transition moves it there while it is still hidden. (SDL_windowsevents.c:608 lists
//      why warping is unreliable: coalesced and cached, ignored outside the focus window, and a no-op while
//      the cursor shape is NULL.)
//   3. **A TICK THAT CHANGES NOTHING MAKES NO CALL.** `shape`/`clipped` record what was last applied, so the
//      caller can reconcile as often as it likes. That - and not deleting it - is what stopped the old
//      sentinel from fighting the system in the background (RAWMON `cursorFix` ticked 1-6 times a second).

/// A rectangle in SCREEN coordinates. Deliberately its own type: the platform layer converts to/from the
/// Win32 `RECT` at the boundary, so this file stays free of `windows`/`winapi` types.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct ClipRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl ClipRect {
    pub const ZERO: ClipRect = ClipRect { left: 0, top: 0, right: 0, bottom: 0 };
}

/// A point in SCREEN coordinates (the cursor position). Its own type for the same reason as `ClipRect`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct ClipPos {
    pub x: i32,
    pub y: i32,
}

/// The shape we want on screen. `Unknown` = we have pushed nothing yet (so nothing is compared against it).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum CursorShape {
    #[default]
    Unknown,
    Arrow,
    Hidden,
}

/// **THE NATIVE WINDOW HANDLE, AS AN OPAQUE TYPE (P1.82).** Every platform has one - an `HWND` on
/// Windows, an `NSWindow*` on macOS, an XID or a `GtkWindow*` on Linux - and the model has to remember
/// WHICH window it manages. The field is PRIVATE on purpose: the shared layers may pass this value
/// around and ask whether it exists, but they cannot see or invent the integer inside it, so "a
/// handle is a number" stays inside the backend that has to convert it.
///
/// It is an `isize` underneath because that is what every target we build for fits a pointer into
/// (and what a `static AtomicIsize` can hold). Only `platform/<os>/` calls `from_raw`/`raw`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct NativeWindow(isize);

impl NativeWindow {
    /// No window (yet) - what the old `hwnd == 0` tests meant, with a name.
    pub const NONE: NativeWindow = NativeWindow(0);

    /// Wrap a raw platform handle. **Backends only.**
    pub const fn from_raw(raw: isize) -> NativeWindow {
        NativeWindow(raw)
    }

    /// The raw value, for the platform call that needs one. **Backends only.**
    pub const fn raw(&self) -> isize {
        self.0
    }

    /// Do we have a window at all?
    pub const fn is_none(&self) -> bool {
        self.0 == 0
    }

    /// The inverse, for the places that read better that way.
    pub const fn is_some(&self) -> bool {
        self.0 != 0
    }
}

impl Default for NativeWindow {
    fn default() -> Self {
        NativeWindow::NONE
    }
}

/// The MODEL: one table. Every field is either an intent, a record of what we did, or a diagnostic.
#[derive(Clone, Copy, Default)]
pub struct CursorModel {
    /// the window we manage (`NativeWindow::NONE` until the front end hands one over)
    pub window: NativeWindow,
    /// the front end's INTENT: 0 unknown / 1 visible / 2 hidden
    pub want: u8,
    /// the game wants the mouse for look control (capture / relative mode)
    pub relative: bool,
    // (`centre_lock` used to live here: the clip was confined to one pixel at the client centre. It is gone
    // in P1.62c - see rule 2 in the header. The crosshair is now only the WARP target.)
    /// the rect WE clipped to; `ZERO` = we hold no clip (nobody else's clip is ever touched)
    pub clipped: ClipRect,
    /// the shape we last pushed - rule 3
    pub shape: CursorShape,
    /// diagnostics: how many plans were really applied (RAWMON `cursorFix`)
    pub enforced: u32,
    /// debounce for "capture asked for while backgrounded": act after two ticks in a row
    pub fg_mismatch_ticks: u8,
    /// P1.55: the product wants the cursor on the crosshair when a menu opens (the original feel). It is the
    /// WARP PLAN that implements it - and only on a hidden -> visible transition, applied while still
    /// hidden, and skipped entirely when the cursor is already there (the centre lock usually means it is).
    pub centre_on_show: bool,
    /// **THE ARROW GUARD (P1.60)**: ticks left of "we have just GIVEN THE MOUSE BACK, so we owe the player an
    /// arrow - and if the system reports none, it is ours to undo". Armed by `arm_arrow_guard` on every
    /// release and on every foreground loss, decremented once per reconciler tick.
    ///
    /// Why it exists (boot.log, P1.60): after a release the model handed the arrow back EXACTLY ONCE
    /// (`m.shape == Hidden` -> force), the system answered `showing=true` - and ~0.2 s later it was hidden
    /// again (`showing=false hCursor=0`) with `enforced` unchanged, i.e. nobody pushed it. From then on the
    /// model did NOTHING for four seconds (`RAWMON … cursorFix=0 desired=1 showing=0`) because rule 1 only
    /// compared the plan with OUR OWN RECORD, and our record already said Arrow. A real mouse move was the
    /// only thing that brought it back. The guard makes "we owe an arrow" a BOUNDED state instead: while it
    /// runs, a system that reports no cursor gets the arrow pushed again. Bounded, so a foreground
    /// application that legitimately hides the cursor is not fought forever - which is the reason rule 1
    /// compares against our own record in the first place.
    pub arrow_guard: u8,
    /// **THE LOST FIGHT (P1.69)**: ticks in a row where we want the cursor HIDDEN, we are focused, and the
    /// system keeps SHOWING it. That combination means somebody else is displaying a cursor - a system overlay
    /// that never takes the foreground (the emoji/IME panel, the touch keyboard, the volume OSD...), because
    /// Chromium pushes NULL while the CSS says `none`. Pushing `SetCursor(0)` does NOT win: the boot.log had
    /// `enforced` climbing 1145 -> 1671 (a push every 8 ms) with the cursor visible the whole time.
    ///
    /// **P1.75: reaching this counter no longer hands the mouse back.** It used to (P1.69: release + tell the
    /// front end, which pauses - "what the player expects once the system has taken the screen"), but the
    /// report's verdict was the opposite: pressing Win+; must not pause the game. What it does now is STOP
    /// PUSHING - the capture stays, the view keeps turning (raw deltas do not care about the cursor), and the
    /// cursor on screen stays the overlay's until the overlay closes.
    pub lost_fight_ticks: u8,
    /// **Is the user holding the window right now?** (`win::clip_is_postponed`, mirrored here so the pure
    /// rule can consult it) - P1.70. The crosshair move of the hidden -> visible transition must never happen
    /// while a hand is on the frame: that is the ONE case where moving the pointer drags a window with it.
    pub user_holding: bool,
}

/// ~250 ms at the sentinel's 8 ms tick: "we have been trying to hide a cursor somebody else keeps showing".
pub const LOST_FIGHT_TICKS: u8 = 32;

/// How long the ARROW GUARD stays armed, in reconciler ticks (the sentinel ticks every 8 ms, so ~1 s).
pub const ARROW_GUARD_TICKS: u8 = 125;

/// Arm the guard: we have just given the mouse back (see the field for why that needs a bounded state).
pub fn arm_arrow_guard(m: &mut CursorModel) {
    m.arrow_guard = ARROW_GUARD_TICKS;
}

/// One reconciler tick of the guard. `decide` is pure and never does this itself.
pub fn tick_arrow_guard(m: &mut CursorModel) {
    m.arrow_guard = m.arrow_guard.saturating_sub(1);
}

/// What we OBSERVED - the model's INPUT. Every field is gathered by the platform layer.
#[derive(Clone, Copy, Default)]
pub struct CursorProbe {
    /// is our window the foreground one?
    pub focused: bool,
    /// does the system report a non-NULL, showing cursor?
    pub showing: bool,
    /// the client area in screen coordinates (the centre lock is derived from it)
    pub client: ClipRect,
    // (`window` used to live here: the whole-window rect, the fallback clip target while the pointer sat on the
    // frame (P1.62d). The centre lock replaced that target in P1.76 and nothing reads the frame rect any more,
    // so the field - and the `GetWindowRect` on every probe - is gone.)
    // (`remote_session` used to live here: a remote-desktop session needed a larger 1px centre lock. With the
    // client-area clip (P1.62c) the coarse absolute positions an RDP client reports no longer matter, so the
    // field - and the `SM_REMOTESESSION` read on every probe - is gone.)
    /// where the cursor is right now (screen coordinates)
    pub pos: ClipPos,
    /// the VIRTUAL SCREEN bounds: `ClipCursor` refuses a rectangle that is not on the screen, so every clip
    /// target is intersected with this (a window half off the screen is the normal way to hit it).
    pub screen: ClipRect,
    /// **Is this a REMOTE DESKTOP session?** (`GetSystemMetrics(SM_REMOTESESSION)`, read once and cached by
    /// `win::remote_session`.) It widens the centre lock from 1 px to 5 px, exactly as SDL does
    /// (`remote_desktop_adjustment`, `SDL_windowswindow.c:397`): a remote pointer is positioned coarsely and
    /// would fight a single-pixel box, while locally a single pixel is what makes the pointer immovable.
    pub remote: bool,
}

/// The DECISION - data again. `clip: None` = leave the clip alone; `Some(ZERO)` = release it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CursorPlan {
    pub clip: Option<ClipRect>,
    pub shape: CursorShape,
    /// Can the mouse really be HELD? `false` = the clip cannot apply (the window is off the screen), so the
    /// caller must not believe it is capturing - that belief is what let the cursor walk out of a half
    /// off-screen window while the game still processed clicks.
    pub confined: bool,
    /// P1.55: the applier must WARP to here **while the cursor is hidden**, then show it. `Some` only on a
    /// hidden -> visible transition that wants the crosshair and is not already there.
    pub warp: Option<ClipPos>,
    /// P1.55: push the shape even though our RECORD already matches, because the SYSTEM disagrees with it
    /// (a dropped `SetCursor`, or Chromium answering `WM_SETCURSOR` from a stale cache). Both directions.
    pub force_shape: bool,
    /// **P1.62: END THE CAPTURE** - the caller must clear the capture request (`relative`), because the
    /// pointer is not inside this window any more. A capture whose window no longer contains the pointer is
    /// broken, and re-clipping would CLAMP the pointer into the new client rectangle: that is what towed the
    /// cursor along with a window being dragged or resized (the boot.log: `relative=true` for four seconds
    /// while the clip walked 963 -> 639 -> 480, with the pointer dragged along at every step).
    ///
    /// **Only that one path sets it (P1.75)**: an overlay that keeps showing a cursor used to end the capture
    /// here too (P1.69, "hand the mouse back" -> the front end pauses), and the report's verdict was that the
    /// pause is worse than the fight - pressing Win+; must not pause the game.
    pub drop_capture: bool,
}

pub fn rect_is_zero(r: ClipRect) -> bool {
    r.left == 0 && r.top == 0 && r.right == 0 && r.bottom == 0
}

pub fn rect_is_empty(r: ClipRect) -> bool {
    r.right <= r.left || r.bottom <= r.top
}

/// The overlap of two rectangles (`rect_is_empty` reports the "they do not touch" case).
pub fn intersect(a: ClipRect, b: ClipRect) -> ClipRect {
    ClipRect {
        left: a.left.max(b.left),
        top: a.top.max(b.top),
        right: a.right.min(b.right),
        bottom: a.bottom.min(b.bottom),
    }
}

/// How far the cursor is kept away from a MONITOR EDGE. Windows reveals an auto-hidden taskbar (and can
/// trigger edge app-switching) when the pointer reaches the outermost rows of a monitor - and a clip that is
/// allowed to touch the screen edge parks the cursor exactly there: reported as "with the window more than
/// half below the screen, the cursor wakes the hidden taskbar". 2px is the margin SDL uses for the same
/// class of problem (its remote-desktop centre lock).
const SCREEN_EDGE_MARGIN: i32 = 2;

/// Pull `visible` away from the sides where it actually COINCIDES with the screen boundary. A window that
/// does not touch an edge is returned unchanged, so this costs nothing in the ordinary case.
pub fn away_from_screen_edges(visible: ClipRect, screen: ClipRect, margin: i32) -> ClipRect {
    let mut r = visible;
    if r.left <= screen.left {
        r.left += margin;
    }
    if r.top <= screen.top {
        r.top += margin;
    }
    if r.right >= screen.right {
        r.right -= margin;
    }
    if r.bottom >= screen.bottom {
        r.bottom -= margin;
    }
    r
}

/// Put `r` inside `bounds`: a rect that FITS slides (keeping its size), one that is too big is SHRUNK to the
/// bounds - sliding cannot help there, and ClipCursor needs a rectangle that is really on the screen.
/// `bounds` must be non-empty.
pub fn fit_into(r: ClipRect, bounds: ClipRect) -> ClipRect {
    let w = (r.right - r.left).min(bounds.right - bounds.left).max(1);
    let h = (r.bottom - r.top).min(bounds.bottom - bounds.top).max(1);
    let left = r.left.clamp(bounds.left, (bounds.right - w).max(bounds.left));
    let top = r.top.clamp(bounds.top, (bounds.bottom - h).max(bounds.top));
    ClipRect { left, top, right: left + w, bottom: top + h }
}

/// The 1px rect at the CLIENT CENTRE - "the crosshair". Only the WARP uses it (P1.62c): the clip is the
/// whole client area now, so this is the target of a move the player never sees, not a confinement.
fn crosshair_rect(p: &CursorProbe) -> ClipRect {
    let cx = (p.client.left + p.client.right) / 2;
    let cy = (p.client.top + p.client.bottom) / 2;
    ClipRect { left: cx, top: cy, right: cx + 1, bottom: cy + 1 }
}

/// The region a clip target may live in: the VISIBLE part of the client, kept a couple of pixels away from
/// the monitor edges (see SCREEN_EDGE_MARGIN). `ZERO` when nothing is visible.
fn clip_region(p: &CursorProbe) -> ClipRect {
    // **Only the VISIBLE part of the client area can be clipped to**: `ClipCursor` refuses a rectangle that
    // is not on the screen (SDL says so in its own comment: "ClipCursor may fail if rect beyond screen").
    let visible = intersect(p.client, p.screen);
    if rect_is_empty(visible) {
        return ClipRect::ZERO;
    }
    // The cursor may only live a couple of pixels inside a monitor edge. A visible sliver thinner than the
    // margin keeps its own (tiny) area: refusing to capture would be worse.
    let safe = away_from_screen_edges(visible, p.screen, SCREEN_EDGE_MARGIN);
    if rect_is_empty(safe) {
        visible
    } else {
        safe
    }
}

/// **THE CENTRE LOCK (P1.76) - the clip while we hold the mouse: a box AT THE CROSSHAIR, one pixel wide.**
///
/// This is SDL's `relative_mode_center`, which is ON by default (`SDL_HINT_MOUSE_RELATIVE_MODE_CENTER`,
/// `include/SDL3/SDL_hints.h:3032-3051`) and is the whole reason Minecraft's pointer never moves: with
/// `lock_to_ctr` the clip becomes `data->cursor_ctrlock_rect` - **1x1 px locally, 5x1 over a remote desktop**
/// (`src/video/windows/SDL_windowswindow.c:397-403`, used at `:1598-1632`) - offset to the client centre, so
/// Windows itself refuses to move the pointer out of that box. Nothing has to warp, and the shell's overlay
/// cursor (which is the SYSTEM cursor, drawn wherever the pointer is) is pinned there too - which is why in MC
/// the cursor that Win+; reveals sits still, exactly on the crosshair.
///
/// **The width matters, and P1.76 got it wrong first (P1.77).** It used a 3x1 box "as a compromise", which left
/// the pointer three valid columns: Windows clamps it to the NEAREST column, so it parked 1px off the crosshair
/// and could be nudged between cx-1, cx and cx+1 - reported, correctly, as "the cursor still moves slightly".
/// SDL's local box is a single pixel, and `remote_desktop_adjustment = GetSystemMetrics(SM_REMOTESESSION) ? 2 : 0`
/// is the only reason it is ever wider (a coarse remote pointer would fight a 1px box). So: `p.remote` decides,
/// and locally the pointer has exactly ONE position.
///
/// **This INVERTS the invariant this file was built on.** P1.63's rule was "the rect handed to `ClipCursor`
/// always CONTAINS the pointer, so the clip can never move it" - that is what made dragging/resizing stop
/// towing the pointer. With a centre lock the box deliberately does NOT contain the pointer (unless it is dead
/// centre) and moving it IS the mechanism. The old concerns are covered elsewhere now:
///   * the drag/resize tow: the whole window session releases the clip anyway (`CLIP_POSTPONED` +
///     `win-session` -> the front end pauses), which is exactly how SDL handles it (`postpone_clipcursor`
///     while `in_title_click`, `SDL_windowswindow.c:1543`);
///   * a capture request that arrives while the pointer is on the title bar: it is REFUSED while the user holds
///     the frame (`winWindowMoving`), so the clamp can never drag a window that is being moved.
pub fn centre_lock(p: &CursorProbe) -> ClipRect {
    let region = clip_region(p);
    if rect_is_zero(region) {
        return ClipRect::ZERO; // nothing visible to lock to: the caller releases instead (a minimised window)
    }
    let target = fit_into(crosshair_rect(p), region);
    // SDL's own adjustment: 0 locally (ONE pixel), 2 on a remote desktop (5x1). See the note above.
    let pad = if p.remote { 2 } else { 0 };
    ClipRect {
        left: target.left - pad,
        top: target.top,
        right: target.right + pad,
        bottom: target.bottom,
    }
}

/// **Where "opening a menu" wants the pointer: the crosshair** (the client centre), fitted into what can be
/// clipped to. Deliberately its own function (P1.62): the CLIP target now follows the pointer while it is
/// inside the window, so deriving the crosshair from it would answer "the cursor is already at the crosshair"
/// for every position - and the warp would never fire. (The `becoming_visible_elsewhere_plans_a_warp` table
/// test caught exactly that.)
pub fn crosshair_of(p: &CursorProbe) -> ClipPos {
    let region = clip_region(p);
    if rect_is_zero(region) {
        return centre_of(p.client);
    }
    centre_of(fit_into(crosshair_rect(p), region))
}

/// The centre of a rect - where "opening a menu" wants the cursor (the crosshair).
pub fn centre_of(r: ClipRect) -> ClipPos {
    ClipPos { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
}

/// **Where to move the pointer when we HAND THE ARROW BACK** (P1.62g): the crosshair, or `None` for "leave it
/// where it is". Pure, so the rule is table-testable while the platform half (`win::restore_arrow`) stays
/// thin - and the applier can safely do it because the pointer IS hidden at that moment.
///
/// Why this is not `decide`'s `warp`: that plan is gated on the hidden -> visible TRANSITION
/// (`m.shape == Hidden`), and handing the arrow back sets that record to Arrow - so a later reconcile sees
/// "no transition" and never warps. The 911-line boot.log was explicit about it: 16 focus losses while
/// capturing (Win / Alt+Tab) produced not ONE warp, while every explicit release (ESC, Resume, the backpack -
/// which stay Hidden until the reconciler plans the Arrow) did warp. Handing the arrow back and centring are
/// ONE action, so they happen together.
///
/// Two guards, both deliberate: a pointer OUTSIDE our window is never moved (P1.62d - the user may be holding
/// a window by its title bar), and `centre_on_show` can switch the whole thing off.
pub fn hand_back_warp(m: &CursorModel, p: &CursorProbe) -> Option<ClipPos> {
    if !m.centre_on_show || m.user_holding {
        // Switched off, or the user has a HAND ON THE FRAME: moving the pointer then drags the window with it
        // (that is the whole reason this rule has an exception at all).
        return None;
    }
    // **…AND IT NO LONGER CARES WHERE THE POINTER IS (P1.70).** It used to refuse a pointer outside our
    // window, which made "the cursor comes back" centre the cursor on SOME paths and not on others: the
    // Win+; / IME overlay leaves the pointer over ITS window, so the pause menu appeared with the cursor
    // wherever it had been. Where the pointer sits on the way IN is not a statement about what the player
    // wants - "the mouse is mine again" is, and that is the transition this rule describes.
    let target = crosshair_of(p);
    if p.pos == target {
        None
    } else {
        Some(target)
    }
}

/// The whole rule set. PURE: no Win32, no globals - this is what the table test drives.
pub fn decide(m: &CursorModel, p: &CursorProbe) -> CursorPlan {
    if m.window.is_none() {
        return plan(None, CursorShape::Unknown, false, None, false);
    }
    // ===== THE PROJECTION (P1.63) =====
    //
    // ONE policy input from the front end (`want`: "the mouse is mine", i.e. in a world with no modal UI) -
    // ANDed with the one OS fact we must never fight (`focused`). Everything else is MEASURED here, every
    // tick. There is no event left that could be late, missed, or applied out of order, because nothing is
    // event-driven any more; and there is no per-transition compensation because there are no transitions to
    // miss. Every one of P1.58…P1.62g was a patch on ONE such transition.
    //
    // The shape makes three invariants structural (each was a bug a per-transition patch could not kill):
    //   1. **The rect handed to `ClipCursor` is the CENTRE LOCK** (P1.76, SDL's `relative_mode_center`): a 3x1
    //      px box at the crosshair, which is what pins the pointer there and makes it immovable - rather than
    //      P1.63's "a rect that contains the pointer, so the clip can never move it". See `centre_lock`.
    //   2. **The only MOVE in the whole system is the crosshair warp of the hidden -> visible transition**
    //      (`hand_back_warp`), done while the pointer is still hidden - and with the centre lock it normally
    //      has nothing to do, because the pointer is already on the crosshair.
    //   3. **The shape is compared with the SYSTEM** (`GetCursorInfo`) whenever we are focused, so a dropped
    //      `SetCursor` or Chromium answering from a stale NULL cache is corrected on the next tick.
    let hidden = m.want == 2 && p.focused;
    if hidden {
        // **THE CENTRE LOCK (P1.76).** One target, no "where is the pointer" question at all: `ClipCursor` is
        // given the 3x1 box at the crosshair, so Windows itself keeps the pointer inside it (that IS the
        // mechanism - see `centre_lock`). This replaces both P1.62's "drop the capture when the pointer leaves
        // the window" and P1.64's one-time "entry move": with a centre lock the pointer cannot leave, and a
        // pointer that starts outside is simply pulled in by the clamp, exactly as MC does it.
        let target = centre_lock(p);
        if rect_is_zero(target) {
            // Nothing visible to lock to (minimised, or the window is off the screen): do NOT pretend to hold
            // the mouse - release, hand the arrow back and tell the caller. This is now the ONLY `drop_capture`
            // (P1.62's pointer-left-the-window case cannot happen any more; the drag/resize case is handled by
            // the window session, which releases the clip before the pointer can be towed).
            let force = m.shape == CursorShape::Hidden || (m.arrow_guard > 0 && !p.showing);
            let release = plan(
                if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) },
                CursorShape::Arrow,
                false,
                None,
                force,
            );
            return CursorPlan { drop_capture: true, ..release };
        }
        // **SOMEBODY ELSE IS DRAWING THE CURSOR: STOP PUSHING, BUT KEEP THE MOUSE (P1.75, by request).**
        // P1.69 gave up here - release the clip, `drop_capture` -> the front end's "hand the mouse back and
        // pause" policy - because `SetCursor(0)` cannot win against a shell overlay and the pushes climbed
        // to 125/s without winning. The report's verdict is that the PAUSE is worse than the fight: pressing
        // Win+; must not pause the game.
        //
        // So the capture stays (the view keeps turning - the deltas are WM_INPUT and do not care where the
        // cursor is, and the overlay does not take the foreground) and we simply stop pushing the shape:
        // `force_shape = false` means `apply_shape` makes no call at all (our record already says Hidden),
        // so the storm is over; the moment the overlay is gone `p.showing` goes false and the normal branch
        // below resumes with no special case. Nothing is moved and nothing is owed - the cursor is the
        // overlay's until it closes, and with the centre lock it is pinned on the crosshair while it is up.
        if p.showing && m.lost_fight_ticks >= LOST_FIGHT_TICKS {
            return plan(Some(target), CursorShape::Hidden, true, None, false);
        }
        // …otherwise the disagreement is ours to correct: push the hidden shape (that is how a dropped
        // `SetCursor` or a stale Chromium cache gets fixed).
        return plan(Some(target), CursorShape::Hidden, true, None, p.showing);
    }
    // Not hidden: no world, a modal UI, or another application in front. Release what we hold, show the
    // arrow, and - if the pointer was hidden until this tick - CENTRE IT, in the same plan (the applier hides
    // first, so the move is never seen). A background window never compares with the system (rule 1 of the
    // old model, now just the `p.focused` term in `force`), so it cannot fight the foreground application.
    let was_hidden = m.shape == CursorShape::Hidden;
    // **THE HAND-BACK CENTRES ONLY WHILE WE ARE IN FRONT (P1.75, by request).** `p.focused` is back as the gate
    // on the move itself, and there is no debt behind it any more: a hand-back that happens while another window
    // (or the secure desktop of a session lock, after Win+L) is in front moves NOTHING and owes nothing, so the
    // cursor simply stays where it was until the player moves it. What keeps centring is the deliberate release
    // - ESC, Resume, the backpack, the world leaving - which always happens while we are in front, and whose
    // move really is invisible (the applier hides the cursor first: `apply_cursor(false)` -> warp -> show).
    //
    // The history that got here, so it is not re-litigated: P1.70 warped on every hand-back (the Win+L move was
    // issued against the locked desktop, landed nowhere, and consumed the transition); P1.71 turned that into a
    // debt paid at an "invisible moment" (foreground AND no cursor displayed - a state the pause menu never is
    // in, so it was paid by a later accident: "the cursor is not centred and clicking puts it back"); P1.73 paid
    // it on the hand-back itself and settled it by measurement. Each of those was a real fix for a real log;
    // the report's decision is simply that this path should do nothing at all.
    let warp = if was_hidden && p.focused { hand_back_warp(m, p) } else { None };
    let force = was_hidden
        || (p.focused && disagrees(p, CursorShape::Arrow))
        || (m.arrow_guard > 0 && !p.showing);
    plan(
        if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) },
        CursorShape::Arrow,
        false,
        warp,
        force,
    )
}

/// **Rule 4 (P1.58): a HIDDEN intent does not outlive the FOREGROUND SESSION.**
///
/// `want` is a statement about a PLAYING session ("the mouse belongs to the game"), and a playing session
/// does not continue while another application is in the foreground. Forgetting it here is HALF of the root
/// cure for the Windows focus FLAP (press Win: `focus LOST` -> `focus GAIN` several times in a row). With the
/// intent still standing, the sentinel applied `Hidden` again on every "focus gained" - the no-capture branch
/// of `decide` hides for `want == 2` - so the arrow blinked in and out for as long as the system kept
/// flip-flopping, whether or not the front end asked for anything. The other half is in the front end: it no
/// longer RE-REQUESTS capture on a focus event either (main.ts::onWinFocus), and the pause menu the blur
/// raises is what keeps the game paused until the player resumes.
///
/// Clearing it is safe because the front end speaks again on the way back: `reassertCursor()` (the focus
/// handler, the menu/Apps key guard) sends the intent unconditionally, and `applyCursor()` sends it whenever
/// the CSS value changes. So a window that has just regained focus does NOTHING to the cursor until the front
/// end says what it wants - which is exactly the right state for that gap.
pub fn forget_intent(m: &mut CursorModel) {
    m.want = 0;
}

/// Does the SYSTEM disagree with the shape we want? (`showing` is `GetCursorInfo` - reality - not our record,
/// which is the whole point: a `SetCursor` push can be dropped and Chromium can answer from a stale cache.)
fn disagrees(p: &CursorProbe, shape: CursorShape) -> bool {
    shape != CursorShape::Unknown && p.showing != (shape == CursorShape::Arrow)
}

fn plan(
    clip: Option<ClipRect>,
    shape: CursorShape,
    confined: bool,
    warp: Option<ClipPos>,
    force_shape: bool,
) -> CursorPlan {
    CursorPlan {
        clip,
        shape,
        confined,
        warp,
        force_shape,
        drop_capture: false,
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> ClipRect {
        ClipRect { left: 100, top: 100, right: 900, bottom: 700 }
    }

    fn model(relative: bool, clipped: ClipRect) -> CursorModel {
        CursorModel {
            window: NativeWindow::from_raw(42),
            // (P1.63) The front end's boolean: `relative` in this helper means "the game wants the mouse",
            // which is `want == 2` now - the model no longer has a separate capture request.
            want: if relative { 2 } else { 1 },
            relative,
            clipped,
            shape: CursorShape::Unknown,
            enforced: 0,
            fg_mismatch_ticks: 0,
            centre_on_show: true,
            arrow_guard: 0,
            lost_fight_ticks: 0,
            user_holding: false,
        }
    }

    fn screen() -> ClipRect {
        ClipRect { left: 0, top: 0, right: 1920, bottom: 1080 }
    }

    /// A probe with the cursor at the client centre (where the crosshair warp puts it).
    fn probe(focused: bool) -> CursorProbe {
        CursorProbe {
            focused,
            showing: true,
            client: client(),
            screen: screen(),
            pos: ClipPos { x: 500, y: 400 },
            remote: false,
        }
    }

    #[test]
    fn becoming_visible_at_the_centre_does_not_move_anything() {
        // Opening a menu is the moment the crosshair matters, and this is the one case where it needs no move
        // at all - which is the only way a move can never be seen (P1.55).
        let mut m = model(false, ClipRect::ZERO);
        m.shape = CursorShape::Hidden;
        assert_eq!(decide(&m, &probe(true)).warp, None);
    }

    #[test]
    fn becoming_visible_elsewhere_plans_a_warp() {
        let mut m = model(false, ClipRect::ZERO);
        m.shape = CursorShape::Hidden;
        let mut p = probe(true);
        p.pos = ClipPos { x: 120, y: 120 };
        assert_eq!(decide(&m, &p).warp, Some(ClipPos { x: 500, y: 400 }));
    }

    #[test]
    fn an_already_visible_cursor_is_never_warped() {
        let mut m = model(false, ClipRect::ZERO);
        m.shape = CursorShape::Arrow;
        let mut p = probe(true);
        p.pos = ClipPos { x: 120, y: 120 };
        assert_eq!(decide(&m, &p).warp, None, "only hidden -> visible moves the cursor");
    }

    #[test]
    fn centring_can_be_switched_off() {
        let mut m = model(false, ClipRect::ZERO);
        m.shape = CursorShape::Hidden;
        m.centre_on_show = false;
        let mut p = probe(true);
        p.pos = ClipPos { x: 120, y: 120 };
        assert_eq!(decide(&m, &p).warp, None);
    }

    #[test]
    fn the_shape_is_re_pushed_when_the_system_disagrees() {
        let mut p = probe(true);
        p.showing = false; // we want the arrow, the system shows nothing
        assert!(decide(&model(false, ClipRect::ZERO), &p).force_shape);
        let mut m = model(false, ClipRect::ZERO);
        m.want = 2; // we want it hidden, the system shows the arrow
        assert!(decide(&m, &probe(true)).force_shape);
        assert!(
            !decide(&model(false, ClipRect::ZERO), &probe(true)).force_shape,
            "agreement is not a disagreement"
        );
        // A background window never fights for the shape (rule 1), not even when the system disagrees.
        let mut bg = probe(false);
        bg.showing = false;
        assert!(!decide(&model(false, ClipRect::ZERO), &bg).force_shape);
    }

    #[test]
    fn unfocused_releases_only_a_clip_we_hold() {
        assert_eq!(decide(&model(true, client()), &probe(false)).clip, Some(ClipRect::ZERO));
        assert_eq!(decide(&model(true, ClipRect::ZERO), &probe(false)).clip, None);
    }

    #[test]
    fn unfocused_restores_the_arrow() {
        // The Win-key report: WE hid the cursor, focus went away, and Windows only re-decides a shape when
        // the pointer moves - so the model has to ask for the arrow itself.
        assert_eq!(decide(&model(true, client()), &probe(false)).shape, CursorShape::Arrow);
    }

    #[test]
    fn a_capture_centres_with_the_centre_lock_and_hides() {
        // **THE CLIP IS A 3x1 BOX AT THE CROSSHAIR (P1.76)** - SDL's `relative_mode_center`, which is what pins
        // the pointer in Minecraft (see `centre_lock`). The old "the whole client area, so the clip can never
        // move the pointer" (P1.62c) is deliberately gone: a moving pointer is exactly what the report wanted
        // removed, and the box cannot tow a window because the drag/resize session releases the clip first.
        let plan = decide(&model(true, ClipRect::ZERO), &probe(true));
        assert_eq!(plan.shape, CursorShape::Hidden);
        let clip = plan.clip.expect("a clip");
        assert_eq!(clip, ClipRect { left: 500, top: 400, right: 501, bottom: 401 }, "ONE pixel, on the desktop");
        assert!(!rect_is_empty(clip));
        // …and a REMOTE desktop gets SDL's wider box: a coarse remote pointer would fight a single pixel.
        let mut far = probe(true);
        far.remote = true;
        assert_eq!(
            decide(&model(true, ClipRect::ZERO), &far).clip,
            Some(ClipRect { left: 498, top: 400, right: 503, bottom: 401 }),
            "5x1 over RDP (SDL's remote_desktop_adjustment)"
        );
    }

    #[test]
    fn the_centre_lock_does_not_depend_on_where_the_pointer_is() {
        // The pointer's position is not an input to the clip any more: wherever it is, the box is the same one,
        // and `ClipCursor` pulls it in. (That is the one intentional "the clip may move the pointer" in the
        // file - see `centre_lock`.)
        let m = model(true, ClipRect::ZERO);
        let mut p = probe(true);
        p.pos = ClipPos { x: 120, y: 640 }; // a corner of the client
        assert_eq!(decide(&m, &p).clip, decide(&model(true, ClipRect::ZERO), &probe(true)).clip);
        p.pos = ClipPos { x: 880, y: 120 }; // the opposite corner
        assert_eq!(decide(&m, &p).clip, decide(&model(true, ClipRect::ZERO), &probe(true)).clip);
        // …even for a pointer that is INSIDE the box: same target, no special case.
        p.pos = ClipPos { x: 500, y: 400 };
        assert_eq!(decide(&m, &p).clip, decide(&model(true, ClipRect::ZERO), &probe(true)).clip);
    }

    #[test]
    fn no_capture_releases_and_shows() {
        let plan = decide(&model(false, client()), &probe(true));
        assert_eq!(plan.clip, Some(ClipRect::ZERO));
        assert_eq!(plan.shape, CursorShape::Arrow);
    }

    #[test]
    fn a_hidden_intent_also_confines() {
        // (P1.63) There is no "hidden but uncaptured" state any more: asking for the cursor to be hidden IS
        // asking for it to be locked to the crosshair while the window is foreground. That is what removes the
        // whole class of "the intent outlived the capture" bugs.
        let mut m = model(false, ClipRect::ZERO);
        m.want = 2;
        let plan = decide(&m, &probe(true));
        assert_eq!(plan.shape, CursorShape::Hidden);
        assert_eq!(plan.clip, decide(&model(true, ClipRect::ZERO), &probe(true)).clip);
        // …and in the background the same intent confines nothing (the projection's `focused` term).
        assert_eq!(decide(&m, &probe(false)).clip, None);
    }

    #[test]
    fn an_unmanaged_window_plans_nothing() {
        let mut m = model(false, client());
        m.window = NativeWindow::NONE;
        let plan = decide(&m, &probe(true));
        assert_eq!(plan.clip, None);
        assert_eq!(plan.shape, CursorShape::Unknown);
    }

    #[test]
    fn a_half_offscreen_window_is_still_confined() {
        // The reported bug: a target that lands off the screen is REFUSED by `ClipCursor`, and a client that
        // believes it holds a clip then lets the cursor walk out. With the centre lock the box is fitted into
        // the VISIBLE part of the client first, so a half-off-screen window still gets a lock that is on screen.
        let mut p = probe(true);
        p.client = ClipRect { left: 600, top: 100, right: 1400, bottom: 700 }; // centre x = 1000 = the edge
        p.screen = ClipRect { left: 0, top: 0, right: 1000, bottom: 1080 };
        p.pos = ClipPos { x: 800, y: 400 };
        let plan = decide(&model(true, ClipRect::ZERO), &p);
        assert!(plan.confined, "the visible half can still be locked to");
        let clip = plan.clip.expect("a clip");
        assert!(!rect_is_empty(clip));
        assert!(clip.right <= 1000 && clip.bottom <= 1080, "inside the screen: {clip:?}");
    }

    #[test]
    fn handing_the_arrow_back_lands_on_the_crosshair_while_hidden() {
        // The reported "pressing Win does not centre the cursor" (P1.62g): the hand-back happens in ONE call
        // (release + arrow), so the crosshair move has to be part of it - `decide`'s warp could not see the
        // transition any more.
        let m = model(false, ClipRect::ZERO);
        let mut p = probe(true);
        p.pos = ClipPos { x: 120, y: 120 }; // inside the window, away from the crosshair
        assert_eq!(hand_back_warp(&m, &p), Some(ClipPos { x: 500, y: 400 }));
        p.pos = ClipPos { x: 500, y: 400 }; // already there: nothing to do
        assert_eq!(hand_back_warp(&m, &p), None);
        // **A POINTER OUTSIDE OUR WINDOW STILL CENTRES (P1.70)**: the Win+; / IME overlay leaves it over ITS
        // window, and the reported bug was that the pause menu then appeared with the cursor wherever it was.
        p.pos = ClipPos { x: 500, y: 20 };
        assert_eq!(hand_back_warp(&m, &p), Some(ClipPos { x: 500, y: 400 }));
        // …UNLESS the user is HOLDING the window: that is the one case where the move would drag it.
        let mut held = model(false, ClipRect::ZERO);
        held.user_holding = true;
        assert_eq!(hand_back_warp(&held, &p), None, "a hand on the frame is never fought");
        let mut off = model(false, ClipRect::ZERO);
        off.centre_on_show = false;
        p.pos = ClipPos { x: 120, y: 120 };
        assert_eq!(hand_back_warp(&off, &p), None, "`centre_on_show` switches it off");
    }

    #[test]
    fn the_screen_edge_margin_is_kept() {
        // The second report: a clip allowed to reach the last row of the monitor parks the (invisible) cursor
        // there and wakes the auto-hidden taskbar - so the lock is pulled 2px away from that edge.
        let mut p = probe(true);
        p.client = ClipRect { left: 100, top: 500, right: 900, bottom: 1400 };
        p.pos = ClipPos { x: 500, y: 600 };
        let clip = decide(&model(true, ClipRect::ZERO), &p).clip.expect("a clip");
        assert!(clip.bottom <= 1080 - SCREEN_EDGE_MARGIN, "away from the taskbar edge: {clip:?}");
        assert!(clip.top >= 500, "and still inside the window: {clip:?}");
        // The pointer no longer gets a vote: the box is the box (P1.76). (Its old "the pointer wins" rule was
        // there because a clip that excluded the pointer moved it - which is now the mechanism, not a bug.)
        let base = decide(&model(true, ClipRect::ZERO), &p).clip.expect("a clip");
        p.pos = ClipPos { x: 500, y: 1079 };
        assert_eq!(decide(&model(true, ClipRect::ZERO), &p).clip, Some(base));
    }

    #[test]
    fn a_pointer_on_the_title_bar_is_pulled_to_the_crosshair() {
        // P1.62d made the clip the whole WINDOW rect here so that a capture request arriving on the title bar
        // (the user is dragging) moved nothing. With the centre lock the box deliberately pulls the pointer to
        // the crosshair - which is safe because a capture request while the user HOLDS the frame is refused
        // before it gets here (`winWindowMoving` + `CLIP_POSTPONED`), and SDL does exactly the same thing.
        let m = model(true, ClipRect::ZERO);
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 80 }; // on the title bar: above the client (100..)
        let plan = decide(&m, &p);
        assert!(!plan.drop_capture, "the request survives: there is something to lock to");
        assert_eq!(plan.clip, decide(&m, &probe(true)).clip, "the same centre lock as anywhere else");
        assert_eq!(plan.warp, None, "and the LOCK does the moving: no warp is planned");
        // A pointer inside the client is not a special case either.
        p.pos = ClipPos { x: 500, y: 400 };
        assert_eq!(decide(&m, &p).clip, decide(&m, &probe(true)).clip);
    }

    #[test]
    fn a_window_that_touches_no_edge_is_left_alone() {
        let p = probe(true); // client (100,100,900,700) inside screen (0,0,1920,1080)
        assert_eq!(away_from_screen_edges(p.client, p.screen, SCREEN_EDGE_MARGIN), p.client);
    }

    #[test]
    fn a_window_entirely_off_the_screen_cannot_be_confined() {
        let mut p = probe(true);
        p.client = ClipRect { left: 2400, top: 0, right: 3400, bottom: 600 };
        let plan = decide(&model(true, ClipRect::ZERO), &p);
        assert!(!plan.confined, "nothing can be held");
        assert_eq!(plan.clip, None, "we hold nothing, so there is nothing to release");
        assert!(plan.drop_capture, "and the request itself is dropped (the front end's pause policy)");
        assert_eq!(plan.shape, CursorShape::Arrow, "the arrow comes back with it");
    }

    #[test]
    fn the_visible_part_wins() {
        // The lock is fitted into the VISIBLE part of the client (the screen-edge margin included), so a window
        // that hangs off the monitor still gets a box that is really on the screen.
        let m = model(true, ClipRect::ZERO);
        let mut p = probe(true);
        p.client = ClipRect { left: 800, top: 100, right: 1800, bottom: 700 };
        p.screen = ClipRect { left: 0, top: 0, right: 1000, bottom: 1080 };
        p.pos = ClipPos { x: 900, y: 400 };
        let clip = decide(&m, &p).clip.expect("a clip");
        assert!(clip.left <= 1000 - SCREEN_EDGE_MARGIN && clip.right <= 1000, "on the screen: {clip:?}");
        assert!(!rect_is_empty(clip), "and never collapsed");
    }

    #[test]
    fn a_visible_window_always_has_a_non_empty_centre_lock() {
        // An EMPTY rect is rejected by Windows, so the lock must never collapse for a window that is at least
        // partly on the screen.
        let t = centre_lock(&probe(true));
        assert!(!rect_is_empty(t), "1x1 px at the crosshair: {t:?}");
        assert_eq!(t, ClipRect { left: 500, top: 400, right: 501, bottom: 401 });
        // …and a window with nothing visible gives ZERO, which is the caller's cue to release instead.
        let mut p = probe(true);
        p.client = ClipRect { left: 2400, top: 0, right: 3400, bottom: 600 };
        assert!(rect_is_zero(centre_lock(&p)));
    }

    #[test]
    fn a_background_window_hands_the_arrow_back_exactly_once() {
        // "Press Win / Alt+Tab and the cursor stays gone until I jiggle the mouse": WE hid it, so the model
        // has to hand the arrow back itself (Windows only re-decides a shape when the pointer moves). Once
        // pushed, the record says Arrow and a background window stops fighting the foreground app for it.
        let mut m = model(true, client());
        m.shape = CursorShape::Hidden;
        assert!(decide(&m, &probe(false)).force_shape, "we are the reason it was hidden");
        m.shape = CursorShape::Arrow; // what apply_shape recorded
        assert!(
            !decide(&m, &probe(false)).force_shape,
            "…and never again while we are in the background"
        );
    }

    #[test]
    fn a_foreground_loss_releases_the_clip_and_hands_the_arrow_back() {
        // (P1.63) The projection makes the old rule 4 structural instead of something to remember: a background
        // window is never hidden (`hidden = want == 2 && p.focused`), so no intent can "outlive" the session.
        let mut m = model(true, client());
        m.shape = CursorShape::Hidden;
        let mut lost = probe(false); // the cursor is somewhere else while the game holds it
        lost.pos = ClipPos { x: 700, y: 600 };
        let away = decide(&m, &lost);
        assert_eq!(away.clip, Some(ClipRect::ZERO), "the clip we hold is released");
        assert_eq!(away.shape, CursorShape::Arrow, "and the arrow comes back");
        assert_eq!(
            away.warp, None,
            "and the pointer is NOT moved either (P1.75): a hand-back from the background does nothing at all"
        );
        m.clipped = ClipRect::ZERO; // what apply_clip(ZERO) records
        m.shape = CursorShape::Arrow;
        // Focus returns and the front end still wants the mouse (it is the pause menu that would flip that):
        // the projection takes it back - hide and LOCK again, no event involved.
        let back = decide(&m, &probe(true));
        assert_eq!(back.shape, CursorShape::Hidden);
        assert_eq!(back.clip, decide(&model(true, ClipRect::ZERO), &probe(true)).clip, "the centre lock is back");
    }

    #[test]
    fn the_arrow_guard_corrects_a_null_that_came_back_after_our_single_push() {
        // The P1.60 report, exactly as boot.log showed it: we released, the arrow was pushed, and then the
        // system reported NO cursor again while our own record still said Arrow. "Compare with our own
        // record" is what left the cursor invisible for four seconds; the guard is the bounded fix.
        let mut m = model(false, ClipRect::ZERO);
        m.want = 1;
        m.shape = CursorShape::Arrow; // what apply_shape recorded when we handed it back
        let mut p = probe(false);
        p.showing = false; // …and the system says nothing is on screen
        assert!(
            !decide(&m, &p).force_shape,
            "without the guard this is a no-op - the bug"
        );
        arm_arrow_guard(&mut m);
        assert!(decide(&m, &p).force_shape, "the guard pushes the arrow again");
    }

    #[test]
    fn the_arrow_guard_expires_and_never_fights_a_shown_cursor() {
        let mut m = model(false, ClipRect::ZERO);
        m.arrow_guard = ARROW_GUARD_TICKS;
        // A system that already shows the cursor is never pushed at (the guard is about a MISSING arrow).
        assert!(!decide(&m, &probe(false)).force_shape);
        // …and it runs out: after ~1 s we are back to the old, bounded behaviour (a foreground application
        // that hides the cursor for its own reasons must not be fought forever).
        let mut p = probe(false);
        p.showing = false;
        assert!(decide(&m, &p).force_shape);
        for _ in 0..ARROW_GUARD_TICKS {
            tick_arrow_guard(&mut m);
        }
        assert_eq!(m.arrow_guard, 0);
        assert!(!decide(&m, &p).force_shape, "the guard is over");
    }

    #[test]
    fn arming_the_guard_is_idempotent_and_counts_down_to_zero() {
        let mut m = model(false, ClipRect::ZERO);
        arm_arrow_guard(&mut m);
        arm_arrow_guard(&mut m);
        assert_eq!(m.arrow_guard, ARROW_GUARD_TICKS);
        let mut ticks = 0;
        while m.arrow_guard > 0 && ticks < 1000 {
            tick_arrow_guard(&mut m);
            ticks += 1;
        }
        assert_eq!(ticks, ARROW_GUARD_TICKS as i32);
        tick_arrow_guard(&mut m); // saturating: never wraps around into "armed again"
        assert_eq!(m.arrow_guard, 0);
    }

    #[test]
    fn a_cursor_a_system_overlay_keeps_showing_ends_the_fight() {
        // P1.69: the emoji/IME overlay never takes the foreground, so the projection keeps wanting hidden while
        // the system keeps showing a cursor (the log had `enforced` climb 1145 -> 1671 without winning).
        // **P1.75: reaching that point no longer hands the mouse back** - the report's verdict was that the pause
        // is worse than the fight ("Win+; must not pause the game"), so the capture is KEPT and the pushes stop.
        let mut m = model(true, ClipRect::ZERO);
        let mut p = probe(true); // showing = true: somebody else is drawing a cursor
        p.pos = ClipPos { x: 120, y: 120 }; // …and the pointer is away from the crosshair
        assert!(!decide(&m, &p).drop_capture, "the first ticks keep trying (and pushing)");
        assert!(decide(&m, &p).force_shape, "…which is the disagreement loop");
        m.lost_fight_ticks = LOST_FIGHT_TICKS;
        let plan = decide(&m, &p);
        assert!(
            !plan.drop_capture,
            "the capture is KEPT (P1.75, by request): pressing Win+; must not pause the game"
        );
        assert_eq!(plan.shape, CursorShape::Hidden, "we still want it hidden");
        assert!(
            !plan.force_shape,
            "…and we stop pushing the shape while somebody else draws the cursor (that storm is what the give-up \
             was for, and it is not coming back)"
        );
        assert_eq!(plan.warp, None, "nothing is moved either: the cursor on screen is the overlay's");
        // A cursor the system already hides is never a lost fight: that is the normal capturing state, and it
        // keeps correcting the shape.
        let mut shown = probe(true);
        shown.showing = false;
        let plan = decide(&m, &shown);
        assert!(!plan.drop_capture, "the ordinary capturing state is not affected");
        assert!(
            !plan.force_shape,
            "…and with the system agreeing (nothing displayed) there is nothing to push at all"
        );
    }

    #[test]
    fn a_hand_back_only_centres_while_we_are_in_front() {
        // P1.75, by request: the Win+L / Alt+Tab centring is gone. A hand-back that happens while another window
        // (or the secure desktop of a session lock) is in front moves NOTHING and owes nothing - the cursor
        // stays where it was until the player moves it, instead of being carried back to the crosshair by a
        // retry that fires later (the report: "the cursor is not centred, and clicking puts it back").
        let mut m = model(true, client());
        m.shape = CursorShape::Hidden;
        let mut away = probe(false); // a lost foreground: Win+L / Alt+Tab / the Win key
        away.pos = ClipPos { x: 700, y: 600 };
        let plan = decide(&m, &away);
        assert_eq!(plan.shape, CursorShape::Arrow, "the arrow still comes back");
        assert_eq!(plan.warp, None, "but the pointer is NOT moved from the background");
        // The unlock: the front end has handed the mouse back and we are in front again - and NOTHING happens,
        // because nothing was ever owed.
        m.shape = CursorShape::Arrow;
        m.clipped = ClipRect::ZERO;
        m.want = 1;
        m.relative = false;
        let mut back = probe(true);
        back.pos = ClipPos { x: 320, y: 195 };
        assert_eq!(decide(&m, &back).warp, None, "no debt, no retry, no move after the unlock");
        assert_eq!(decide(&m, &back).drop_capture, false, "and certainly no capture to drop");
        // …while the deliberate release - always in front - still centres, which is the behaviour that must not
        // be lost with it. (The front end's `want=1` is what makes it a release: with `want=2` we are still
        // capturing, and that is the hidden branch.)
        let mut releasing = model(true, client());
        releasing.shape = CursorShape::Hidden;
        releasing.want = 1;
        releasing.relative = false;
        let mut front = probe(true);
        front.pos = ClipPos { x: 320, y: 195 };
        assert_eq!(
            decide(&releasing, &front).warp,
            Some(ClipPos { x: 500, y: 400 }),
            "ESC / Resume / the backpack still land on the crosshair"
        );
    }

    #[test]
    fn taking_the_mouse_locks_the_pointer_and_never_drops_it_for_a_pointer_outside() {
        // The minimise/maximise report (P1.64) and the P1.62 drop rule both disappear into the centre lock: a
        // pointer that arrives outside the window is simply pulled into the box (no "entry move" warp, no
        // request refused), and an ONGOING capture with a pointer outside is not a broken capture any more -
        // the pointer cannot leave, so "the pointer is outside" is not a state we can be in.
        let mut m = model(true, ClipRect::ZERO); // want = 2
        m.shape = CursorShape::Arrow; // we were not capturing a tick ago
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 20 }; // on the title bar
        let plan = decide(&m, &p);
        assert!(!plan.drop_capture, "the request is NOT dropped: there is a box to lock to");
        assert_eq!(plan.shape, CursorShape::Hidden);
        assert_eq!(plan.clip, decide(&m, &probe(true)).clip, "the same centre lock");
        assert_eq!(plan.warp, None, "the LOCK does the moving (a warp would be a second mechanism)");
        // An ONGOING capture, same pointer: identical plan - nothing to drop, nothing to move.
        m.shape = CursorShape::Hidden;
        let ongoing = decide(&m, &p);
        assert!(!ongoing.drop_capture, "an ongoing capture is not dropped for that either");
        assert_eq!(ongoing.clip, plan.clip);
        // …and only a window with NOTHING visible drops the capture (a minimised window).
        let mut tiny = probe(true);
        tiny.pos = ClipPos { x: 500, y: 20 };
        tiny.client = ClipRect { left: 2400, top: 0, right: 3400, bottom: 600 };
        assert!(decide(&m, &tiny).drop_capture);
    }

    #[test]
    fn a_pointer_outside_the_window_still_centres_unless_the_user_holds_it() {
        // P1.62 used to refuse this move for a pointer outside our window, and that is what made "the cursor
        // comes back" centre on some paths and not others (the Win+; / IME overlay leaves the pointer over ITS
        // window, so the pause menu appeared with the cursor wherever it had been - P1.70).
        let mut m = model(false, ClipRect::ZERO);
        m.shape = CursorShape::Hidden;
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 20 }; // over somebody else's window
        assert_eq!(decide(&m, &p).warp, Some(ClipPos { x: 500, y: 400 }));
        // …unless the user has a hand on the frame: moving it then drags the window with it.
        let mut held = model(false, ClipRect::ZERO);
        held.shape = CursorShape::Hidden;
        held.user_holding = true;
        assert_eq!(decide(&held, &p).warp, None);
    }

}
