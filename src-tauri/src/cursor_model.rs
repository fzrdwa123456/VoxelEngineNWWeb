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
//   2. **CLIP != WARP.** Relative mode confines the cursor to a ONE-PIXEL rect at the client centre (SDL's
//      `cursor_ctrlock_rect` is exactly that, +2px for remote sessions) instead of warping it there: the
//      cursor cannot wander, raw deltas keep arriving, and "opening a menu lands on the crosshair" follows
//      from the clip instead of from a `SetCursorPos` call. (SDL_windowsevents.c:608 lists why warping is
//      unreliable: coalesced and cached, ignored outside the focus window, and a no-op while the cursor
//      shape is NULL.)
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
    /// confine to one pixel at the client centre instead of the whole client area
    pub centre_lock: bool,
    /// the rect WE clipped to; `ZERO` = we hold no clip (nobody else's clip is ever touched)
    pub clipped: ClipRect,
    /// the shape we last pushed - rule 3
    pub shape: CursorShape,
    /// diagnostics: how many plans were really applied (RAWMON `cursorFix`)
    pub enforced: u32,
    /// debounce for "capture asked for while backgrounded": act after two ticks in a row
    pub fg_mismatch_ticks: u8,
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
    /// a remote-desktop session needs a slightly larger centre lock (SDL does the same)
    pub remote_session: bool,
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

/// The rect to confine the cursor to. PURE (the remote-session flag and the screen bounds arrive in the
/// probe). Returns `ZERO` when NOTHING can be confined (the window is off the screen).
pub fn clip_target(m: &CursorModel, p: &CursorProbe) -> ClipRect {
    // **Only the VISIBLE part of the client area can be clipped to**: `ClipCursor` refuses a rectangle that
    // is not on the screen (SDL says so in its own comment: "ClipCursor may fail if rect beyond screen").
    let visible = intersect(p.client, p.screen);
    if rect_is_empty(visible) {
        return ClipRect::ZERO;
    }
    let target = if m.centre_lock {
        let adjust = if p.remote_session { 2 } else { 0 };
        let cx = (p.client.left + p.client.right) / 2;
        let cy = (p.client.top + p.client.bottom) / 2;
        ClipRect { left: cx - adjust, top: cy, right: cx + 1 + adjust, bottom: cy + 1 }
    } else {
        p.client
    };
    // A 1px rect whose centre is off the screen cannot be clipped to, and for relative mode it does not
    // matter WHERE inside the window the cursor sits - so the target slides into the visible part.
    fit_into(target, visible)
}

/// The whole rule set. PURE: no Win32, no globals - this is what the table test drives.
pub fn decide(m: &CursorModel, p: &CursorProbe) -> CursorPlan {
    if m.hwnd == 0 {
        return CursorPlan { clip: None, shape: CursorShape::Unknown, confined: false };
    }
    if !p.focused {
        // Rule 1.
        return CursorPlan {
            clip: if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) },
            shape: CursorShape::Arrow,
            confined: false,
        };
    }
    if m.relative {
        // Rule 2. `confined` is false when the window has no visible area left: the caller then DROPS
        // capture instead of pretending to hold the mouse.
        let target = clip_target(m, p);
        return CursorPlan {
            clip: Some(target),
            shape: CursorShape::Hidden,
            confined: !rect_is_zero(target),
        };
    }
    // No capture: nothing is confined, and the arrow is right - unless the front end asked for hidden
    // (a loading screen draws its own progress and wants no pointer on top of it).
    CursorPlan {
        clip: if rect_is_zero(m.clipped) { None } else { Some(ClipRect::ZERO) },
        shape: if m.want == 2 { CursorShape::Hidden } else { CursorShape::Arrow },
        confined: false,
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
            centre_lock: true,
            clipped,
            shape: CursorShape::Unknown,
            enforced: 0,
            fg_mismatch_ticks: 0,
        }
    }

    fn screen() -> ClipRect {
        ClipRect { left: 0, top: 0, right: 1920, bottom: 1080 }
    }

    fn probe(focused: bool) -> CursorProbe {
        CursorProbe { focused, showing: true, client: client(), remote_session: false, screen: screen() }
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
    fn capture_confines_to_the_centre_pixel_and_hides() {
        let plan = decide(&model(true, ClipRect::ZERO), &probe(true));
        assert_eq!(plan.shape, CursorShape::Hidden);
        assert_eq!(plan.clip, Some(ClipRect { left: 500, top: 400, right: 501, bottom: 401 }));
    }

    #[test]
    fn a_remote_session_gets_the_larger_centre_lock() {
        let mut p = probe(true);
        p.remote_session = true;
        assert_eq!(
            decide(&model(true, ClipRect::ZERO), &p).clip,
            Some(ClipRect { left: 498, top: 400, right: 503, bottom: 401 })
        );
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
        let plan = decide(&model(true, ClipRect::ZERO), &p);
        assert!(plan.confined, "the visible half can still be clipped to");
        let clip = plan.clip.expect("a clip");
        assert!(!rect_is_empty(clip));
        assert!(clip.right <= 1000 && clip.bottom <= 1080, "inside the screen: {clip:?}");
    }

    #[test]
    fn a_window_entirely_off_the_screen_cannot_be_confined() {
        let mut p = probe(true);
        p.client = ClipRect { left: 2400, top: 0, right: 3400, bottom: 600 };
        let plan = decide(&model(true, ClipRect::ZERO), &p);
        assert!(!plan.confined, "nothing can be held");
        assert_eq!(plan.clip, Some(ClipRect::ZERO), "and whatever we held is released");
        assert_eq!(plan.shape, CursorShape::Hidden, "the intent is still capture");
    }

    #[test]
    fn the_visible_part_wins_over_the_whole_client() {
        let mut m = model(true, ClipRect::ZERO);
        m.centre_lock = false;
        let mut p = probe(true);
        p.client = ClipRect { left: 800, top: 100, right: 1800, bottom: 700 };
        p.screen = ClipRect { left: 0, top: 0, right: 1000, bottom: 1080 };
        assert_eq!(
            decide(&m, &p).clip,
            Some(ClipRect { left: 800, top: 100, right: 1000, bottom: 700 }),
            "the client is intersected with the screen"
        );
    }

    #[test]
    fn a_centre_lock_of_zero_still_yields_a_non_empty_clip() {
        // A 1x1 rect is legal for ClipCursor; an EMPTY one would be rejected by Windows, so the target must
        // never collapse (the tests above pin the exact 1px rect).
        let t = clip_target(&model(false, ClipRect::ZERO), &probe(true));
        assert!(!rect_is_empty(t));
    }
}
