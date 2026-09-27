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
}

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
    if !m.centre_on_show {
        return None;
    }
    if !contains(intersect(p.client, p.screen), p.pos) {
        return None;
    }
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

/// The whole rule set. PURE: no Win32, no globals - this is what the table test drives.
pub fn decide(m: &CursorModel, p: &CursorProbe) -> CursorPlan {
    if m.hwnd == 0 {
        return plan(None, CursorShape::Unknown, false, None, false);
    }
    if !p.focused {
        // Rule 1.
        // Not our foreground: no shape of ours belongs on the screen (rule 1) - EXCEPT that we are the one
        // that hid it, so the arrow is handed back EXACTLY ONCE (`m.shape == Hidden`): that is the
        // "press Win / Alt+Tab and the cursor stays gone until I jiggle the mouse" report. Once pushed, the
        // record says Arrow, so a background window never keeps fighting the foreground app for the cursor.
        //
        // **…AND THEN THE ARROW GUARD (P1.60): "exactly once" is not enough.** A NULL cursor comes back
        // after that single push (Chromium answers `WM_SETCURSOR` from the cache it filled while we were
        // capturing), and because the plan is compared with OUR OWN RECORD - which now says Arrow - the model
        // then sat still while the system reported `showing=false`: a real boot.log had four consecutive
        // `RAWMON … cursorFix=0 desired=1 showing=0` windows, and only a mouse move restored it. While the
        // guard runs we keep pushing; after ~1 s we are back to comparing with our own record, so a
        // foreground application that hides the cursor for its own reasons is not fought forever.
        let force = m.shape == CursorShape::Hidden || (m.arrow_guard > 0 && !p.showing);
        return plan(
            if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) },
            CursorShape::Arrow,
            false,
            None,
            force,
        );
    }
    if m.relative {
        // Rule 2. `confined` is false when the window has no visible area left: the caller then DROPS
        // capture instead of pretending to hold the mouse.
        // **A CAPTURE WHOSE WINDOW NO LONGER CONTAINS THE POINTER IS OVER (P1.62).**
        //
        // The clip keeps the pointer inside OUR WINDOW (client or frame - see `clip_target`), so finding it
        // OUTSIDE the window means the window moved out from under it: the user dragged or resized it and the
        // pointer was left behind. Re-clipping would CLAMP the pointer back in, which is what towed it (the
        // boot.log: `relative=true` for four seconds while the clip walked 963 -> 639 -> 480, dragging the
        // pointer at every step - a late `LOCK request [world entered]` had re-taken the capture after the
        // geometry release).
        //
        // Dropping the capture instead is the platform half of the policy the front end already applies to
        // a geometry change ("hand the mouse back + pause"), and it cannot tow anything. **It applies to an
        // ONGOING capture only** - a capture REQUEST (`set_mouse_capture`) must not be refused for this, or
        // the front end falls back to the browser's pointer lock, which is worse in every way: ESC unlocks
        // it, it has a re-lock cooldown, and Chromium's own client-area clip tows the pointer just as happily.
        let held_area = if rect_is_empty(p.window) { intersect(p.client, p.screen) } else { intersect(p.window, p.screen) };
        if !contains(held_area, p.pos) {
            return drop_capture_plan();
        }
        let target = clip_target(p);
        // We want it HIDDEN, so a system that still shows it is the disagreement to correct.
        return plan(Some(target), CursorShape::Hidden, !rect_is_zero(target), None, p.showing);
    }
    // No capture: nothing is confined, and the arrow is right - unless the front end asked for hidden
    // (a loading screen draws its own progress and wants no pointer on top of it).
    let shape = if m.want == 2 { CursorShape::Hidden } else { CursorShape::Arrow };
    let clip = if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) };
    // **THE CROSSHAIR WARP (P1.55)**: only on hidden -> visible, only when the product wants it, and only
    // when the cursor is not already at the centre. The applier hides first, so the move is never visible.
    let warp = if shape == CursorShape::Arrow
        && m.shape == CursorShape::Hidden
        && m.centre_on_show
        && !is_at_centre(p)
        // **…and never for a pointer that is OUTSIDE the window (P1.62)**: that is a pointer the user is
        // holding on a title bar or a sizing border, and moving it would yank the window being dragged.
        && contains(intersect(p.client, p.screen), p.pos)
    {
        Some(crosshair_of(p))
    } else {
        None
    };
    plan(clip, shape, false, warp, disagrees(p, shape))
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
    CursorPlan { clip, shape, confined, warp, force_shape, drop_capture: false }
}

/// **The plan that ENDS the capture** (P1.62): release the clip, hand the arrow back and tell the caller to
/// clear the capture request. No warp - the pointer is outside the window, so moving it would yank whatever
/// the user is dragging.
fn drop_capture_plan() -> CursorPlan {
    CursorPlan {
        clip: Some(ClipRect::ZERO),
        shape: CursorShape::Arrow,
        confined: false,
        warp: None,
        force_shape: true,
        drop_capture: true,
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
            want: 1,
            relative,
            clipped,
            shape: CursorShape::Unknown,
            enforced: 0,
            fg_mismatch_ticks: 0,
            centre_on_show: true,
            arrow_guard: 0,
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
    fn a_hidden_intent_stays_hidden_without_capture() {
        let mut m = model(false, ClipRect::ZERO);
        m.want = 2;
        let plan = decide(&m, &probe(true));
        assert_eq!(plan.shape, CursorShape::Hidden);
        assert_eq!(plan.clip, None, "nothing is confined outside capture");
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
        p.pos = ClipPos { x: 500, y: 20 }; // on the title bar: NEVER yank a pointer we do not own the window of
        assert_eq!(hand_back_warp(&m, &p), None);
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
        let m = model(true, ClipRect::ZERO);
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 80 }; // inside the window (60..710), above the client (100..)
        let plan = decide(&m, &p);
        assert!(!plan.drop_capture, "the capture survives: the pointer is still inside our window");
        assert_eq!(plan.clip, Some(window()), "the clip is the window rect");
        assert!(contains(plan.clip.expect("a clip"), p.pos), "and it contains the pointer");
        // Back inside the client, the clip tightens to the client area again (the sentinel's next tick).
        p.pos = ClipPos { x: 500, y: 400 };
        assert_eq!(decide(&m, &p).clip, Some(client()));
        // …and when the window rect could NOT be read, the client is all we can trust: a pointer outside it
        // is then treated as outside (the capture ends) rather than clipped to a frame we do not know.
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
        assert_eq!(plan.clip, Some(ClipRect::ZERO), "and whatever we held is released");
        assert!(plan.drop_capture, "and the capture itself is given up (P1.62)");
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
    fn a_stale_hidden_intent_is_what_used_to_re_hide_the_cursor_on_focus_gain() {
        // The flap in ONE line, pinned so it cannot come back: an intent that survived the foreground loss
        // hides the cursor again the moment the window is foreground again - with no capture behind it.
        let mut m = model(false, ClipRect::ZERO);
        m.want = 2;
        m.shape = CursorShape::Hidden;
        assert_eq!(decide(&m, &probe(true)).shape, CursorShape::Hidden);
        assert_eq!(decide(&m, &probe(true)).clip, None, "and with no capture behind it");
    }

    #[test]
    fn a_foreground_loss_forgets_the_hidden_intent() {
        // Rule 4. win.rs::on_foreground_lost() is the platform half (drop the capture request + release
        // the clip we hold); the intent is what this pins.
        let mut m = model(true, client());
        m.want = 2;
        m.shape = CursorShape::Hidden;
        m.relative = false; // release_mouse_capture()
        forget_intent(&mut m);
        // The clip itself is released by the platform half (`apply_clip(ZERO)`, which records ZERO): while
        // that is still recorded, the plan releases it and shows the arrow - and NOTHING is confined.
        let releasing = decide(&m, &probe(true));
        assert_eq!(releasing.clip, Some(ClipRect::ZERO));
        assert_eq!(releasing.shape, CursorShape::Arrow);
        m.clipped = ClipRect::ZERO; // what apply_clip(ZERO) records
        // Coming back must now touch the cursor not at all: no clip (nothing is confined without a capture
        // request) and no hidden shape. That is the Win-key flap, cured.
        let back = decide(&m, &probe(true));
        assert_eq!(back.shape, CursorShape::Arrow);
        assert_eq!(back.clip, None);
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
    fn a_capture_ends_when_the_pointer_leaves_the_window() {
        // The P1.62 report, second half. A capture that is still held while the user drags the window by its
        // TITLE BAR (or a sizing border) has a pointer in the NON-CLIENT area: "keep the lock where the
        // pointer is" cannot apply, and clamping it into the moving client centre is what towed it. So the
        // capture is DROPPED instead - release the clip, hand the arrow back, and tell the caller.
        let m = model(true, ClipRect::ZERO);
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 20 }; // above client (100,100)-(900,700): the title bar
        let plan = decide(&m, &p);
        assert!(plan.drop_capture, "the capture is over");
        assert_eq!(plan.clip, Some(ClipRect::ZERO), "and the clip we hold is released");
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
    fn a_pointer_outside_the_window_is_never_warped() {
        // The other half of the same report: the hidden -> visible warp ("opening a menu lands on the
        // crosshair") must not fire for a pointer that is out on a title bar - moving it would drag the
        // window the user is holding.
        let mut m = model(false, ClipRect::ZERO);
        m.shape = CursorShape::Hidden;
        let mut p = probe(true);
        p.pos = ClipPos { x: 500, y: 20 }; // the title bar
        assert_eq!(decide(&m, &p).warp, None);
        p.pos = ClipPos { x: 120, y: 120 }; // inside the window, but away from the crosshair
        assert_eq!(decide(&m, &p).warp, Some(ClipPos { x: 500, y: 400 }));
    }

}
