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

/// The MODEL: one table. Every field is either an intent, a record of what we did, or a diagnostic.
#[derive(Clone, Copy, Default)]
pub struct CursorModel {
    /// the window we manage (0 = none yet)
    pub hwnd: isize,
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
    /// `enforced` climbing 1145 -> 1671 (a push every 8 ms) with the cursor visible the whole time. After
    /// `LOST_FIGHT_TICKS` of it the projection gives up and hands the mouse back, i.e. the front end pauses -
    /// which is what the player expects once the system has taken the screen.
    pub lost_fight_ticks: u8,
    /// **Is the user holding the window right now?** (`win::clip_is_postponed`, mirrored here so the pure
    /// rule can consult it) - P1.70. The crosshair move of the hidden -> visible transition must never happen
    /// while a hand is on the frame: that is the ONE case where moving the pointer drags a window with it.
    pub user_holding: bool,
    /// **THE CENTRE DEBT**: a hand-back happened that did not leave the pointer on the crosshair, so the
    /// centring is owed until it is MEASURED there (`is_at_centre`).
    ///
    /// Why a debt at all, and why it is no longer gated (P1.73):
    ///   * the Win+L hand-back plans its move on the loss tick, while the secure desktop has the input - the
    ///     `SetCursorPos` is issued against a desktop the user is not looking at and lands nowhere, and the
    ///     transition it consumed is the only chance that rule gets. A retry has to outlive the tick.
    ///   * P1.71 armed it correctly but PAID it only at a moment it called "invisible" (foreground AND no
    ///     cursor displayed). The boot.log showed why that never happens: the pause menu displays an arrow of
    ///     our own, and Alt+Tab / the Win key / Win+L leave the window in the background - so the debt waited
    ///     and was settled by a later accident (the foreground coming back, or a flicker of Chromium's stale
    ///     cursor cache). The report was "the cursor is visible but not on the crosshair, and clicking puts it
    ///     back on the crosshair".
    /// Now the payment needs only "the front end is no longer asking for hidden" (`want != 2`, so a capture is
    /// never disturbed - a move then would reach the input pipeline as a synthetic delta), and the bookkeeping
    /// is the measurement itself. It is dropped the moment the player takes the mouse again
    /// (`win::set_mouse_capture`), so it can never fire into a running session; no timer, because a lock can
    /// last minutes.
    pub centre_debt: bool,
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
    /// the client area in screen coordinates (the clip target comes from it)
    pub client: ClipRect,
    /// **The WHOLE window rect in screen coordinates** (client + frame: title bar and sizing borders). It is
    /// the fallback clip target while the pointer is on the frame (P1.62d): clamping the pointer into the
    /// CLIENT then moved the window, because Windows' move/size loop follows the pointer - and a capture
    /// request can arrive exactly while the user is dragging the window. A rect that already CONTAINS the
    /// pointer is one `ClipCursor` will not move it into. `ZERO` when it could not be read (then the client is
    /// used, as before).
    pub window: ClipRect,
    // (`remote_session` used to live here: a remote-desktop session needed a larger 1px centre lock. With the
    // client-area clip (P1.62c) the coarse absolute positions an RDP client reports no longer matter, so the
    // field - and the `SM_REMOTESESSION` read on every probe - is gone.)
    /// where the cursor is right now (screen coordinates)
    pub pos: ClipPos,
    /// the VIRTUAL SCREEN bounds: `ClipCursor` refuses a rectangle that is not on the screen, so every clip
    /// target is intersected with this (a window half off the screen is the normal way to hit it).
    pub screen: ClipRect,
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
    pub drop_capture: bool,
    /// **P1.73: we handed the mouse back and did NOT leave the pointer on the crosshair** - the caller
    /// records the debt (`CursorModel::centre_debt`), which is retried until the pointer is MEASURED there.
    pub arm_centre_debt: bool,
    /// **P1.73**: the pointer is now measured AT the crosshair, so the debt is settled. Measured, not "we
    /// issued a move": a move that lands nowhere (the secure desktop of a session lock) must stay owed.
    pub settle_centre_debt: bool,
}

pub fn rect_is_zero(r: ClipRect) -> bool {
    r.left == 0 && r.top == 0 && r.right == 0 && r.bottom == 0
}

pub fn rect_is_empty(r: ClipRect) -> bool {
    r.right <= r.left || r.bottom <= r.top
}

/// Is `p` inside `r`? Half-open on the right/bottom edges, matching the 1px rects `ClipCursor` is given.
/// Used by the centre lock to decide whether a re-clip would have to MOVE the pointer (P1.62).
pub fn contains(r: ClipRect, p: ClipPos) -> bool {
    !rect_is_empty(r) && p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom
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

/// The rect to confine the cursor to. PURE (the remote-session flag and the screen bounds arrive in the
/// probe). Returns `ZERO` when NOTHING can be confined (the window is off the screen).
pub fn clip_target(p: &CursorProbe) -> ClipRect {
    let client_visible = intersect(p.client, p.screen);
    // **THE CLIP IS A RECTANGLE THAT CONTAINS THE POINTER (P1.62c/P1.62d).**
    //
    // `ClipCursor` CLAMPS the pointer into the rectangle it is given, so the ONE invariant that matters is:
    // **the target always contains the pointer.** Everything else follows from it.
    //   * a target derived from the client CENTRE towed the pointer along with the window (the original report:
    //     the clip walked 963 -> 639 -> 480 with `relative=true`, dragging the pointer at every step);
    //   * a 1px lock AT the pointer fixed that inside the client, but a capture request that arrives while the
    //     user is DRAGGING the window finds the pointer on the title bar - outside the client - and clamping it
    //     back in moved the WINDOW by the same amount (Windows' move loop follows the pointer); that was the
    //     last reported "it still moves a little", 6px in the boot.log (`pos=(1166,192)` -> `(1166,198)`).
    // So: inside the client the clip IS the client; on the frame it is the whole WINDOW rect, which already
    // contains the pointer; `fit_into` then clips either to the visible part of the screen.
    let target = if contains(client_visible, p.pos) || rect_is_empty(p.window) {
        p.client
    } else {
        p.window
    };
    let visible = intersect(target, p.screen);
    if rect_is_empty(visible) {
        return ClipRect::ZERO;
    }
    // The screen-edge margin (it keeps an invisible cursor off the taskbar's auto-hide band) is preferred, but
    // it must never EXCLUDE the pointer: containing the pointer wins, because a clip that excludes it is a clip
    // that moves it.
    let safe = away_from_screen_edges(visible, p.screen, SCREEN_EDGE_MARGIN);
    let region = if rect_is_empty(safe) || !contains(safe, p.pos) { visible } else { safe };
    fit_into(target, region)
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

/// Is the cursor already at the CROSSHAIR (where opening a menu wants it)? If it is, no warp is planned -
/// a move the player cannot see is still a move the compositor can show between messages.
///
/// It asks `crosshair_of`, NOT `centre_of(clip_target(...))` (P1.62): the clip is the whole client area now,
/// so its centre is the client centre for EVERY pointer position and the old question would always answer
/// "yes, already there" - the warp would never fire. (Two table tests pin the two shapes of that mistake.)
pub fn is_at_centre(p: &CursorProbe) -> bool {
    p.pos == crosshair_of(p)
}

/// **Do we OWE the player a centring?** (P1.73) A hand-back must leave the pointer ON the crosshair, so a
/// hand-back that happens anywhere else owes one. Three terms: the pointer is not already there, centring is
/// not switched off, and the user has no hand on the frame (moving it then drags the window).
///
/// **It no longer asks whether a move was POSSIBLE (P1.71 did, and that was the bug the boot.log showed).**
/// The old version only armed the debt when this tick's move had been refused, and only paid it at a moment
/// that was "the foreground AND no cursor displayed" - a condition the real world almost never satisfies
/// right after a hand-back (the pause menu displays an arrow of our own, and Alt+Tab/Win+L leave the window
/// in the background), so the debt sat unpaid and was settled by a LATER accident (the foreground coming
/// back, or a flicker of Chromium's stale cursor cache) - the report was "the cursor is not centred, and
/// clicking puts it back on the crosshair". Now the debt is armed by the hand-back itself and paid on
/// measurement (see `decide`).
pub fn owes_centre(m: &CursorModel, p: &CursorProbe) -> bool {
    m.centre_on_show && !m.user_holding && !is_at_centre(p)
}

/// The whole rule set. PURE: no Win32, no globals - this is what the table test drives.
pub fn decide(m: &CursorModel, p: &CursorProbe) -> CursorPlan {
    if m.hwnd == 0 {
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
    //   1. **The rect handed to `ClipCursor` always CONTAINS the pointer** (or the clip is released), so
    //      `ClipCursor` can never move it. A window drag, a resize, a title-bar press or a stale request
    //      therefore cannot tow the cursor: the projection releases and re-clips a tick later.
    //   2. **The only MOVE in the whole system is the crosshair warp of the hidden -> visible transition**
    //      (`hand_back_warp`), done while the pointer is still hidden and never on a pointer outside our
    //      window. It is derived from the PREVIOUS tick's applied shape, so no event has to arm it.
    //   3. **The shape is compared with the SYSTEM** (`GetCursorInfo`) whenever we are focused, so a dropped
    //      `SetCursor` or Chromium answering from a stale NULL cache is corrected on the next tick.
    let hidden = m.want == 2 && p.focused;
    if hidden {
        let target = clip_target(p);
        // The pointer is outside our window (the user is dragging it, or the window has moved away from it).
        if rect_is_zero(target) || !contains(target, p.pos) {
            // **THE ONE ENTRY MOVE (P1.64).** TAKING the mouse may move the pointer into our window ONCE,
            // while it is hidden - the projection's version of SDL's "entering relative mode recentres". It
            // is needed because the pointer and the window get out of step: after a minimise, a maximise or a
            // restore it usually sits outside the window (the taskbar, the desktop, another screen position).
            // Refusing to clip there dropped the request, the front end read that as "the window was lost"
            // and paused again - so Resume LOOPED: a visible cursor, a view that cannot turn, ESC the only key
            // that does anything.
            //
            // Allowed ONLY on the entry (`m.shape != Hidden`: we were not capturing a tick ago) and only when
            // the client has a visible part to move into. An ONGOING capture whose pointer leaves the window
            // is the drag/resize case, and that still RELEASES instead of towing (invariant 1).
            if m.shape != CursorShape::Hidden && !rect_is_zero(clip_region(p)) {
                return plan(Some(target), CursorShape::Hidden, true, Some(crosshair_of(p)), true);
            }
            let force = m.shape == CursorShape::Hidden || (m.arrow_guard > 0 && !p.showing);
            let release = plan(
                if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) },
                CursorShape::Arrow,
                false,
                None,
                force,
            );
            // **…AND THIS PATH NEVER OWES A CENTRING (P1.71).** The pointer is outside our window because the
            // user put it there (a drag, a resize, a window that moved away) or because there is nothing
            // visible to clip to. A debt would later PULL it back in, which is the class of move P1.62…P1.62d
            // spent four rounds removing.
            return CursorPlan { drop_capture: true, ..release };
        }
        // **WE CANNOT WIN: STOP FIGHTING (P1.69).** We want it hidden, we are focused, and the system has been
        // SHOWING a cursor for ~250 ms: an overlay owns the screen (see `lost_fight_ticks`). Hand the mouse
        // back instead - the front end pauses, the cursor is legitimately visible again, and the 125 pushes a
        // second stop.
        if p.showing && m.lost_fight_ticks >= LOST_FIGHT_TICKS {
            // **AND THIS PATH DOES NOT CENTRE AT ALL (P1.74, by request).** It used to owe a centring and pay it
            // one tick later, when the front end's "hand the mouse back" arrived. That move is a move the player
            // WATCHES - the whole reason we gave up is that a cursor is on screen and we cannot hide it (P1.70's
            // boot.log: "the cursor appears and THEN jumps to the middle") - and the alternative the report
            // chose is no centring at all: the cursor stays exactly where the overlay left it until the player
            // moves it themselves. Nothing is owed here, so the retry in the not-hidden branch below has nothing
            // to pay, and the next tick (shape is Arrow now) cannot plan a `was_hidden` warp either.
            //
            // The OTHER hand-backs keep centring: ESC / Resume / the backpack release the mouse while we are in
            // front (that move is invisible - the applier hides the cursor first), and a lost foreground is
            // covered by the debt because its loss-tick move may land nowhere (Win+L).
            let release = plan(
                if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) },
                CursorShape::Arrow,
                false,
                None,
                m.shape == CursorShape::Hidden,
            );
            return CursorPlan { drop_capture: true, ..release };
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
    // **ONE CENTRING RULE, MC-STYLE (P1.73).** The hand-back moves the pointer to the crosshair ONCE, right
    // here, with no "are we the foreground" gate: a plain `SetCursorPos` from a background window lands
    // normally (only the secure desktop of a session lock swallows it - that is exactly what the retry below
    // is for), and requiring focus was what pushed Alt+Tab / the Win key / Win+L right through to the moment
    // the player clicked back into the window ("the cursor is not centred, and clicking puts it back").
    let mut warp = if was_hidden { hand_back_warp(m, p) } else { None };
    // **…AND THE RESULT IS MEASURED, NOT ASSUMED.** An unpaid centring is retried on every later tick where
    // the front end is no longer asking for hidden, until the pointer really IS on the crosshair: the loss-tick
    // move of a Win+L is issued against a desktop that does not exist yet, and the debt is what carries the
    // intent across the lock. No timer, no expiry, nothing to remember about whether a call was made.
    //
    // The retry keeps the `p.focused` term (only the retry - the hand-back above does not): a move that cannot
    // land must not be fired every 4 ms for the whole length of a session lock. It is not what used to defer
    // the Alt+Tab / Win-key cases either - those are centred by the hand-back itself, on the loss tick.
    if warp.is_none() && m.centre_debt && m.want != 2 && p.focused {
        warp = hand_back_warp(m, p);
    }
    // SETTLE: the two ways a centring can be considered done - the pointer is MEASURED on the crosshair, or we
    // just issued the move while we are in front. The unfocused case is deliberately NOT settled by issuing:
    // that is the one the Win+L log showed landing nowhere, and it is what the retry exists for.
    let settle_centre_debt = (m.centre_debt && is_at_centre(p)) || (warp.is_some() && p.focused);
    // ARM: this hand-back did not leave the pointer on the crosshair, so we owe a centring - unless the move
    // we just issued (while in front, so it really lands) has already settled it.
    let arm_centre_debt = was_hidden && !settle_centre_debt && owes_centre(m, p);
    let force = was_hidden
        || (p.focused && disagrees(p, CursorShape::Arrow))
        || (m.arrow_guard > 0 && !p.showing);
    CursorPlan {
        arm_centre_debt,
        settle_centre_debt,
        ..plan(
            if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) },
            CursorShape::Arrow,
            false,
            warp,
            force,
        )
    }
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
        // The CENTRE-DEBT flags are P1.73's and are set by the two branches that hand the mouse back; every
        // other plan leaves them alone.
        arm_centre_debt: false,
        settle_centre_debt: false,
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
            hwnd: 42,
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
            centre_debt: false,
        }
    }

    fn screen() -> ClipRect {
        ClipRect { left: 0, top: 0, right: 1920, bottom: 1080 }
    }

    /// The whole window: a title bar above the client and borders around it (what `GetWindowRect` returns).
    fn window() -> ClipRect {
        ClipRect { left: 90, top: 60, right: 910, bottom: 710 }
    }

    /// A probe with the cursor at the client centre (where the crosshair warp puts it).
    fn probe(focused: bool) -> CursorProbe {
        CursorProbe {
            focused,
            showing: true,
            client: client(),
            window: window(),
            screen: screen(),
            pos: ClipPos { x: 500, y: 400 },
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
    fn a_capture_confines_to_the_client_area_and_hides() {
        // **THE CLIP IS THE CLIENT AREA, NOT A CENTRE LOCK (P1.62c).** Confining it to a pixel at the client
        // centre meant every window move re-clipped to the NEW centre and `ClipCursor` clamped the pointer
        // there - the "dragging or resizing the window tows the cursor" report. The pointer is hidden while
        // capturing and the view comes from raw deltas, so its POSITION does not matter; "it cannot leave the
        // window" does.
        let plan = decide(&model(true, ClipRect::ZERO), &probe(true));
        assert_eq!(plan.shape, CursorShape::Hidden);
        assert_eq!(plan.clip, Some(client()), "the whole client area, minus the screen edges");
    }

    #[test]
    fn the_clip_covers_the_client_area_wherever_the_pointer_is_inside_it() {
        // …and it does not depend on WHERE the pointer sits either (the P1.62 rule that kept a 1px lock at the
        // pointer is gone with it): a re-clip cannot drag the pointer, because the target is the window itself.
        let m = model(true, ClipRect::ZERO);
        let mut p = probe(true);
        p.pos = ClipPos { x: 120, y: 640 }; // a corner of the client
        assert_eq!(decide(&m, &p).clip, Some(client()));
        p.pos = ClipPos { x: 880, y: 120 }; // the opposite corner
        assert_eq!(decide(&m, &p).clip, Some(client()));
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
        // asking for it to be confined to our window while the window is foreground. That is what removes the
        // whole class of "the intent outlived the capture" bugs.
        let mut m = model(false, ClipRect::ZERO);
        m.want = 2;
        let plan = decide(&m, &probe(true));
        assert_eq!(plan.shape, CursorShape::Hidden);
        assert_eq!(plan.clip, Some(client()));
        // …and in the background the same intent confines nothing (the projection's `focused` term).
        assert_eq!(decide(&m, &probe(false)).clip, None);
    }

    #[test]
    fn an_unmanaged_window_plans_nothing() {
        let mut m = model(false, client());
        m.hwnd = 0;
        let plan = decide(&m, &probe(true));
        assert_eq!(plan.clip, None);
        assert_eq!(plan.shape, CursorShape::Unknown);
    }

    #[test]
    fn a_half_offscreen_window_is_still_confined() {
        // The reported bug: the centre (and the 1px target) lands off the screen, ClipCursor refuses the
        // rectangle, and a client that believed it held a clip let the cursor walk out of the window.
        let mut p = probe(true);
        p.client = ClipRect { left: 600, top: 100, right: 1400, bottom: 700 }; // centre x = 1000 = the edge
        p.screen = ClipRect { left: 0, top: 0, right: 1000, bottom: 1080 };
        p.pos = ClipPos { x: 800, y: 400 }; // INSIDE the window (a pointer outside ends the capture now)
        let plan = decide(&model(true, ClipRect::ZERO), &p);
        assert!(plan.confined, "the visible half can still be clipped to");
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
    fn the_screen_edge_margin_is_kept_but_never_at_the_pointers_expense() {
        // The second report: the clip was allowed to reach the last row of the monitor, and a clipped cursor
        // parked there wakes the auto-hidden taskbar - so the visible part is pulled 2px away from that edge.
        let mut p = probe(true);
        p.client = ClipRect { left: 100, top: 500, right: 900, bottom: 1400 };
        p.window = ClipRect { left: 90, top: 400, right: 910, bottom: 1500 }; // the frame around that client
        p.pos = ClipPos { x: 500, y: 600 };
        let clip = decide(&model(true, ClipRect::ZERO), &p).clip.expect("a clip");
        assert!(clip.bottom <= 1080 - SCREEN_EDGE_MARGIN, "away from the taskbar edge: {clip:?}");
        assert!(clip.top >= 500, "and still inside the window: {clip:?}");
        // …but when the pointer itself is inside that band, CONTAINING IT wins: a clip that excludes the
        // pointer is a clip that moves it, and moving it is what towed the window (P1.62d).
        p.pos = ClipPos { x: 500, y: 1079 };
        let clip = decide(&model(true, ClipRect::ZERO), &p).clip.expect("a clip");
        assert!(contains(clip, p.pos), "the clip never excludes the pointer: {clip:?}");
    }

    #[test]
    fn a_pointer_on_the_title_bar_gets_the_window_clip_and_is_not_moved() {
        // The last reported residue (P1.62d): a capture request that arrives while the user is DRAGGING the
        // window finds the pointer on the title bar. Clamping it into the client moved the window by the same
        // amount (6px in the boot.log) - so the clip becomes the whole WINDOW, which already contains the
        // pointer and therefore moves nothing.
        let mut m = model(true, ClipRect::ZERO);
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 80 }; // inside the window (60..710), above the client (100..)
        let plan = decide(&m, &p);
        assert!(!plan.drop_capture, "the request survives: the pointer is still inside our window");
        assert_eq!(plan.clip, Some(window()), "the clip is the window rect");
        assert!(contains(plan.clip.expect("a clip"), p.pos), "and it contains the pointer");
        // Back inside the client, the clip tightens to the client area again (the sentinel's next tick).
        p.pos = ClipPos { x: 500, y: 400 };
        assert_eq!(decide(&m, &p).clip, Some(client()));
        // …and when the window rect could NOT be read, the client is all we can trust: a pointer outside it
        // is treated as outside (the request is dropped) rather than clipped to a frame we do not know.
        m.shape = CursorShape::Hidden; // an ongoing capture, not the entry
        let mut blind = probe(true);
        blind.window = ClipRect::ZERO;
        blind.pos = ClipPos { x: 500, y: 80 };
        assert!(decide(&m, &blind).drop_capture);
        // …while a pointer INSIDE the client is unaffected by the missing frame rect.
        blind.pos = ClipPos { x: 500, y: 400 };
        assert_eq!(decide(&m, &blind).clip, Some(client()));
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
        p.window = ClipRect { left: 2390, top: -40, right: 3410, bottom: 610 }; // the frame goes with it
        let plan = decide(&model(true, ClipRect::ZERO), &p);
        assert!(!plan.confined, "nothing can be held");
        assert_eq!(plan.clip, None, "we hold nothing, so there is nothing to release");
        assert!(plan.drop_capture, "and the request itself is dropped (the front end's pause policy)");
        assert_eq!(plan.shape, CursorShape::Arrow, "the arrow comes back with it");
    }

    #[test]
    fn the_visible_part_wins_over_the_whole_client() {
        let m = model(true, ClipRect::ZERO);
        let mut p = probe(true);
        p.client = ClipRect { left: 800, top: 100, right: 1800, bottom: 700 };
        p.screen = ClipRect { left: 0, top: 0, right: 1000, bottom: 1080 };
        p.pos = ClipPos { x: 900, y: 400 }; // inside the window
        assert_eq!(
            decide(&m, &p).clip,
            Some(ClipRect { left: 800, top: 100, right: 1000 - SCREEN_EDGE_MARGIN, bottom: 700 }),
            "the client is intersected with the screen, and pulled off its right edge"
        );
    }

    #[test]
    fn a_visible_window_always_has_a_non_empty_clip_target() {
        // An EMPTY rect is rejected by Windows, so the target must never collapse for a window that is at
        // least partly on the screen (the tests above pin the exact rectangle).
        let t = clip_target(&probe(true));
        assert!(!rect_is_empty(t));
        assert_eq!(t, client());
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
            away.warp,
            Some(ClipPos { x: 500, y: 400 }),
            "the hand-back centres even from the background (P1.73): only the secure desktop swallows the move"
        );
        assert!(away.arm_centre_debt, "…and it OWES the centring until the pointer is measured there");
        m.clipped = ClipRect::ZERO; // what apply_clip(ZERO) records
        m.shape = CursorShape::Arrow;
        // Focus returns and the front end still wants the mouse (it is the pause menu that would flip that):
        // the projection takes it back - hide and confine again, no event involved.
        let back = decide(&m, &probe(true));
        assert_eq!(back.shape, CursorShape::Hidden);
        assert_eq!(back.clip, Some(client()));
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
        // the system keeps showing a cursor (the log had `enforced` climb 1145 -> 1671 without winning). After
        // ~250 ms it gives up and hands the mouse back, which makes the front end pause.
        // **P1.74: this path neither moves the pointer NOR owes a centring for later** - the cursor stays where
        // the overlay left it (the move would be watched either way; see the branch's own note).
        let mut m = model(true, ClipRect::ZERO);
        let mut p = probe(true); // showing = true: somebody else is drawing a cursor
        p.pos = ClipPos { x: 120, y: 120 }; // …and the pointer is away from the crosshair
        assert!(!decide(&m, &p).drop_capture, "the first ticks keep trying");
        m.lost_fight_ticks = LOST_FIGHT_TICKS;
        let plan = decide(&m, &p);
        assert!(plan.drop_capture, "…and then it gives up");
        assert_eq!(plan.shape, CursorShape::Arrow);
        assert_eq!(
            plan.warp, None,
            "it does NOT move the pointer: the cursor is visible, so the move would be watched (P1.71)"
        );
        assert!(
            !plan.arm_centre_debt,
            "…and this path owes NO centring either (P1.74, by request): the cursor stays where the overlay \
             left it, instead of jumping to the crosshair a tick later"
        );
        // …and that is a decision about THIS path only: the same hand-back through the front end's release does
        // centre (see `the_centre_debt_is_paid_on_the_first_moment_no_cursor_is_displayed`).
        // A cursor the system already hides is never a lost fight: that is the normal capturing state.
        let mut shown = probe(true);
        shown.showing = false;
        assert!(!decide(&m, &shown).drop_capture);
    }

    #[test]
    fn the_centre_debt_is_paid_on_the_first_moment_no_cursor_is_displayed() {
        // The Win+L report (P1.71), as one sequence: the hand-back happens while the secure desktop owns the
        // input, so the move is not attempted; and the tick where the foreground comes back with the system
        // reporting NO cursor on screen is where the debt is paid - invisibly.
        let mut m = model(true, client());
        m.shape = CursorShape::Hidden;
        let mut locked = probe(false);
        locked.pos = ClipPos { x: 0, y: 0 }; // what `GetCursorPos` answers while locked
        assert!(decide(&m, &locked).arm_centre_debt, "the loss owes a centring");
        m.centre_debt = true;
        m.shape = CursorShape::Arrow; // …which is what the hand-back applied
        m.clipped = ClipRect::ZERO;
        // …and the front end answers the announced loss by handing the mouse back (the pause menu):
        m.want = 1;
        m.relative = false;
        // Back in front, and the cursor is up again: **the debt is paid anyway (P1.73)**. P1.71 refused to
        // move here ("a cursor is displayed"), which is exactly the state the pause menu is in - so the debt
        // waited for a later accident, and the report was "the cursor is not centred, and clicking puts it on
        // the crosshair". The applier hides the cursor before it moves, so a displayed cursor is no obstacle.
        let mut visible = probe(true);
        visible.pos = ClipPos { x: 320, y: 195 };
        let plan = decide(&m, &visible);
        assert_eq!(plan.warp, Some(ClipPos { x: 500, y: 400 }), "the debt is paid while the menu shows a cursor");
        assert!(
            plan.settle_centre_debt,
            "…and a move issued while IN FRONT settles it (that one really lands); the unfocused call is the one \
             that does not, and it keeps the debt (see the Win+L test)"
        );
        // …and the settled state is also reached by measurement, which is what ends a background centring.
        let mut centred = visible;
        centred.pos = ClipPos { x: 500, y: 400 };
        let plan = decide(&m, &centred);
        assert_eq!(plan.warp, None, "nothing to do once it is there");
        assert!(plan.settle_centre_debt, "the debt is settled by the measurement too");
        // A pointer that is already on the crosshair owes nothing, and an unarmed model never moves.
        m.centre_debt = false;
        let mut corner = probe(true);
        corner.pos = ClipPos { x: 320, y: 195 };
        assert_eq!(decide(&m, &corner).warp, None, "no debt, no move");
        assert_eq!(decide(&m, &corner).arm_centre_debt, false, "…and a running menu arms nothing");
    }

    #[test]
    fn the_centre_debt_survives_a_move_that_lands_nowhere_and_is_paid_after_the_lock() {
        // Win+L, end to end (P1.73). The loss tick plans the move and it LANDS NOWHERE (the secure desktop owns
        // the input), so the debt has to outlive the tick; the retry then happens as soon as the front end has
        // handed the mouse back, and it is the MEASUREMENT that ends it.
        let mut m = model(true, client());
        m.shape = CursorShape::Hidden;
        let mut locked = probe(false);
        locked.pos = ClipPos { x: 0, y: 0 }; // what `GetCursorPos` answers while locked
        let plan = decide(&m, &locked);
        assert_eq!(plan.warp, Some(ClipPos { x: 500, y: 400 }), "the hand-back plans the move (MC-style: once)");
        assert!(plan.arm_centre_debt, "…and owes the centring, because the pointer is not there");
        // The platform applied it - and the pointer never moved (the move landed on the wrong desktop).
        m.centre_debt = true;
        m.shape = CursorShape::Arrow;
        m.clipped = ClipRect::ZERO;
        m.want = 1; // the front end answers the announced loss: the pause menu is up
        m.relative = false;
        let mut still_locked = probe(false);
        still_locked.pos = ClipPos { x: 0, y: 0 };
        assert_eq!(decide(&m, &still_locked).warp, None, "nothing to do while we are not in front");
        let mut corner = probe(true);
        corner.pos = ClipPos { x: 320, y: 195 };
        assert_eq!(
            decide(&m, &corner).warp,
            Some(ClipPos { x: 500, y: 400 }),
            "the retry fires on the first tick with no capture wanted - the unlock"
        );
    }

    #[test]
    fn the_centre_debt_is_never_paid_into_a_running_capture() {
        // The move would be invisible, but it would reach the input pipeline as a synthetic mouse movement -
        // the "teleport-sized jump" of P1.62d. A player who takes the mouse back drops the debt entirely
        // (`win::set_mouse_capture`), so this is the pure half of that rule.
        let mut m = model(true, ClipRect::ZERO); // want = 2: the game holds the mouse
        m.centre_debt = true;
        let mut p = probe(true);
        p.showing = false; // the cursor is hidden, as it is while capturing
        p.pos = ClipPos { x: 120, y: 120 };
        let plan = decide(&m, &p);
        assert_eq!(plan.warp, None, "a capture is never moved by the debt");
        assert!(!plan.settle_centre_debt, "and the debt is left for later");
        // The same facts with the front end no longer asking for hidden: the debt IS paid (that is the only
        // gate left - no focus, no "is a cursor displayed").
        let plan = decide(&model(false, ClipRect::ZERO), &p);
        assert_eq!(plan.warp, None, "…but a model with NO debt never moves");
        let mut owing = m;
        owing.want = 1;
        assert_eq!(decide(&owing, &p).warp, Some(ClipPos { x: 500, y: 400 }), "the hand-back pays it");
    }

    #[test]
    fn taking_the_mouse_moves_the_pointer_into_the_window_once() {
        // The minimise/maximise report (P1.64): the pointer is outside the restored window when the request
        // comes in. Dropping the request there paused the game again and Resume looped - so the ENTRY is
        // allowed to move the pointer in, while it is hidden. An ONGOING capture must not (that is the drag
        // case), which is the second half of this test.
        let mut m = model(true, ClipRect::ZERO); // want = 2
        m.shape = CursorShape::Arrow; // we were not capturing a tick ago
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 20 }; // outside the window rect (60..710)
        let plan = decide(&m, &p);
        assert!(!plan.drop_capture, "the request is NOT dropped: we are taking the mouse");
        assert_eq!(plan.shape, CursorShape::Hidden);
        assert_eq!(plan.warp, Some(ClipPos { x: 500, y: 400 }), "and the pointer comes to the crosshair");
        assert!(!rect_is_zero(plan.clip.expect("a clip")), "with something to clip to");
        // Already capturing, and the pointer leaves the window (the user is dragging it): release, never tow.
        m.shape = CursorShape::Hidden;
        let plan = decide(&m, &p);
        assert!(plan.drop_capture, "an ONGOING capture releases instead of towing");
        assert_eq!(plan.warp, None, "and it never moves the pointer");
        // …and with nothing visible to move into, even the entry releases (a minimised window).
        m.shape = CursorShape::Arrow;
        let mut tiny = probe(true);
        tiny.pos = ClipPos { x: 500, y: 20 };
        tiny.client = ClipRect { left: 2400, top: 0, right: 3400, bottom: 600 };
        tiny.window = ClipRect { left: 2390, top: -40, right: 3410, bottom: 610 };
        assert!(decide(&m, &tiny).drop_capture);
    }

    #[test]
    fn a_capture_ends_when_the_pointer_leaves_the_window() {
        // The P1.62 report, second half. A capture that is still held while the user drags the window by its
        // TITLE BAR (or a sizing border) has a pointer in the NON-CLIENT area: "keep the lock where the
        // pointer is" cannot apply, and clamping it into the moving client centre is what towed it. So the
        // capture is DROPPED instead - release the clip, hand the arrow back, and tell the caller.
        let mut m = model(true, ClipRect::ZERO);
        m.shape = CursorShape::Hidden; // an ONGOING capture (not the entry)
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 20 }; // above client (100,100)-(900,700): the title bar
        let plan = decide(&m, &p);
        assert!(plan.drop_capture, "the request is dropped (the front end's pause policy)");
        assert_eq!(plan.clip, None, "we hold nothing to release");
        // (the pointer is ABOVE the window rect as well - the window is 60..710 - which is what makes it a
        // drop rather than a window clip)
        assert_eq!(plan.shape, CursorShape::Arrow, "with the arrow back");
        assert_eq!(plan.warp, None, "and NOTHING is moved: the user is holding the window");
        // Inside the window the capture continues, confined to the client area.
        p.pos = ClipPos { x: 500, y: 400 };
        let plan = decide(&m, &p);
        assert!(!plan.drop_capture);
        assert_eq!(plan.clip, Some(client()));
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
