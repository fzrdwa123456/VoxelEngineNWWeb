// ===== THE RAW-INPUT SESSION: the cross-platform half (P1.80) =====
//
// What used to be `rawinput.rs` minus the collection. It owns the ACCUMULATORS the platform pushes
// into, the push thread that drains them into Tauri events at a fixed cadence, the statistics and the
// start/stop bookkeeping - and it names no platform: `crate::platform` starts the collector and
// answers the two probes.
//
// The direction of the data is worth stating once, because it is the whole design:
//
//     platform collector thread   --push-->   ACC_DX/ACC_DY/ACC_BTN_DOWN/ACC_BTN_UP   --drain-->   push thread   --emit-->   the page
//
// The collector never emits and the push thread never touches the device. That split is what keeps
// the event rate bounded (the collector can see hundreds of packets a second), and it is why the
// front end can treat both the deltas and the button edges as per-frame batches.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::platform;

/// Push throttle: at most one event per 4 ms (≈250/s) — denser than one frame, which is enough
/// and does not flood IPC
const BATCH_MS: u64 = 4;

#[derive(Clone, Serialize)]
pub struct MouseDelta {
    pub dx: i32,
    pub dy: i32,
    /// Emission time (milliseconds since the push thread started). The frontend uses it to estimate
    /// "how long this event sat in the queue" — see the RAWLAG line.
    pub t: u64,
}

/// **Raw button edges** (P1.76): two bitmasks, one bit per button (0 left, 1 middle, 2 right, 3 = X1, 4 = X2),
/// so a 4 ms batch can carry "left down + right up" without any ordering information being needed.
#[derive(Clone, Serialize)]
pub struct RawButtons {
    pub down: u32,
    pub up: u32,
}

/// The payload name of every event pushed to the frontend
const EVENT: &str = "raw-input";
/// …and the payload name for the button edges (P1.76)
const BUTTON_EVENT: &str = "raw-buttons";

// ===== Global accumulators (single instance; multiple instances merge counts, harmless in a game) =====
pub(crate) static ACC_DX: AtomicI32 = AtomicI32::new(0);
pub(crate) static ACC_DY: AtomicI32 = AtomicI32::new(0);
pub(crate) static ACC_ABS_DROPPED: AtomicI32 = AtomicI32::new(0);
/// Diagnostics: total WM_INPUT messages received (including the filtered absolute-coordinate events)
pub(crate) static ACC_WM_INPUT_TOTAL: AtomicI32 = AtomicI32::new(0);
/// Diagnostics: number of GetRawInputData failures
pub(crate) static ACC_RID_FAIL: AtomicI32 = AtomicI32::new(0);
/// **Raw button edges** (P1.76): bitmasks, OR-ed in by the collector and cleared by the push thread. See the
/// BUTTONS note above for why these come from the device and not from `mousedown`.
pub(crate) static ACC_BTN_DOWN: AtomicU32 = AtomicU32::new(0);
pub(crate) static ACC_BTN_UP: AtomicU32 = AtomicU32::new(0);
/// Diagnostics: how many packets carried a button edge (shown on the RAWMON line as `btn=`)
pub(crate) static ACC_BTN_TOTAL: AtomicI32 = AtomicI32::new(0);

pub(crate) static RUNNING: AtomicBool = AtomicBool::new(false);
pub(crate) static REGISTERED: AtomicBool = AtomicBool::new(false);

/// Set once `start` has finished - the same "already running" gate the listener registry used to
/// be. Cleared by `stop`, so a stop/start pair is legal.
pub(crate) static STARTED: AtomicBool = AtomicBool::new(false);

/// Starts the listener: the platform's collector + our push thread. On failure it returns the
/// reason and the game runs as usual (merely without raw input as a fallback).
pub fn start(app: AppHandle) -> Result<(), String> {
    if STARTED.load(Ordering::SeqCst) {
        return Ok(()); // already started
    }

    // The collector reports (native handle, did raw input really register) - or why it could not.
    let (_window, registered) = platform::rawinput_start_collector()?;

    RUNNING.store(true, Ordering::SeqCst);
    REGISTERED.store(registered, Ordering::SeqCst);

    // Push thread: at a fixed rate it takes and zeroes the accumulated values and emits events
    // (the frontend's synchronous poll() reads its own accumulator)
    std::thread::spawn(move || {
        let mut tick: u32 = 0;
        let t0 = Instant::now();
        // ===== RAWMON diagnostics (one line per second) =====
        // Purpose: turn "holding a key + turning the view is not smooth" from guesswork into
        // numbers. This line reports **how many times each of four possible paths moved during this
        // second**: emits=IPC events we pushed to the frontend (capped at 250/s); wmIn=raw mouse
        // packets delivered by the system; btn=packets that carried a button edge (P1.76: if this stays 0 while
        // you click, the buttons are not reaching us at all); cursorFix=how many times the cursor sentinel
        // **actually corrected** the state (the `CURSOR_ENFORCED` delta — always climbing = a tug of war with
        // the system); hookSeen=how many times the low-level keyboard hook was called (always 0 =
        // the hook never reaches the input path). The rest are the state at that moment.
        let mut emits: u32 = 0;
        let mut last_wm = ACC_WM_INPUT_TOTAL.load(Ordering::Relaxed);
        let mut last_btn = ACC_BTN_TOTAL.load(Ordering::Relaxed);
        let mut last_fix = crate::cursor_session::cursor_enforced_count() as i32;
        let mut last_seen = platform::rawinput_hook_seen();
        let mut last_mon = Instant::now();
        while RUNNING.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(BATCH_MS));
            tick = tick.wrapping_add(1);
            // Cursor sentinel: reconcile visibility every second tick (≈8 ms), forcing the expected
            // value back onto a state that Windows menu mode / Chromium's push timing has scrambled.
            // In steady state GetCursorInfo agrees and nothing extra happens.
            // Cursor sentinel: reconcile visibility **every tick (≈4 ms)** (it used to be every
            // second tick) — the "menu key flashes the cursor" is exactly the interval between "the
            // system lights the cursor up -> the sentinel forces it back"; halving the period halves
            // that interval (the frontend also rewrites the hidden state on the key edge itself, so
            // both sides fight over that same frame).
            crate::cursor_session::cursor_sentinel(&app);
            if tick % 2 == 0 {
                // Capture must stay on only while in the foreground: when it is not, tear it down
                // and tell the frontend (which "releases the mouse + pauses if it should").
                // Releasing on the Rust side alone is not enough — the frontend's
                // INPUT_STATE.locked is still true, so the view keeps turning and the cursor stays
                // hidden.
                if crate::cursor_session::capture_foreground_check(&app) {
                    let _ = app.emit("capture-lost", ());
                }
                // Probe: emitted once each at 4s / 8s / 12s (the old "once 1.5 seconds after
                // startup" fired before any key was pressed, which answered nothing). If seen does
                // not climb while keys are pressed, the hook truly is never called; hook=0x0 means
                // the install never succeeded.
                if tick == 1000 || tick == 2000 || tick == 3000 {
                    let _ = app.emit("hook-probe", platform::rawinput_hook_probe_line());
                }
            }
            let dx = ACC_DX.swap(0, Ordering::Relaxed);
            let dy = ACC_DY.swap(0, Ordering::Relaxed);
            if dx != 0 || dy != 0 {
                emits += 1;
                let _ = app.emit(EVENT, MouseDelta { dx, dy, t: t0.elapsed().as_millis() as u64 });
            }
            // **…and the button edges of the same batch (P1.76)**, on their own channel so a button edge with
            // no motion still arrives (a click that does not move the mouse is the common case).
            let down = ACC_BTN_DOWN.swap(0, Ordering::Relaxed);
            let up = ACC_BTN_UP.swap(0, Ordering::Relaxed);
            if down != 0 || up != 0 {
                emits += 1;
                let _ = app.emit(BUTTON_EVENT, RawButtons { down, up });
            }

            // RAWMON: one line per second (emitted as an event, the frontend writes it to
            // debug.log along the same route as HOOKPROBE)
            let now = Instant::now();
            if now.duration_since(last_mon).as_millis() >= 1000 {
                let wm = ACC_WM_INPUT_TOTAL.load(Ordering::Relaxed);
                let fix = crate::cursor_session::cursor_enforced_count() as i32;
                let seen = platform::rawinput_hook_seen();
                let (desired, showing) = crate::cursor_session::cursor_state();
                let line = format!(
                    "RAWMON emits={} wmIn={} btn={} cursorFix={} hookSeen={} ridFail={} desired={} showing={} capture={} fgOurs={}",
                    emits,
                    wm - last_wm,
                    ACC_BTN_TOTAL.load(Ordering::Relaxed) - last_btn,
                    fix - last_fix,
                    seen - last_seen,
                    ACC_RID_FAIL.load(Ordering::Relaxed),
                    desired,
                    if showing { 1 } else { 0 },
                    if crate::cursor_session::capture_active() { 1 } else { 0 },
                    if platform::foreground_is_ours() { 1 } else { 0 },
                );
                let _ = app.emit("raw-mon", line);
                emits = 0;
                last_wm = wm;
                last_btn = ACC_BTN_TOTAL.load(Ordering::Relaxed);
                last_fix = fix;
                last_seen = seen;
                last_mon = now;
            }
        }
    });

    STARTED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Diagnostics data. The field names are deliberately camelCase — serde then serialises straight
/// into the shape of the frontend's RawStats interface.
#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct RawStats {
    pub available: bool,
    pub wmInputTotal: i32,
    pub ridFail: i32,
    pub absoluteDropped: i32,
    /// Whether the low-level context-menu hook is installed (false = fail open: the menu key /
    /// Shift+F10 reach Windows and may flash the cursor for a frame)
    pub menuHook: bool,
}

pub fn stats() -> RawStats {
    RawStats {
        available: RUNNING.load(Ordering::SeqCst) && REGISTERED.load(Ordering::SeqCst),
        wmInputTotal: ACC_WM_INPUT_TOTAL.load(Ordering::Relaxed),
        ridFail: ACC_RID_FAIL.load(Ordering::Relaxed),
        absoluteDropped: ACC_ABS_DROPPED.load(Ordering::Relaxed),
        menuHook: platform::menu_hook_installed(),
    }
}

pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
    platform::rawinput_stop_collector();
    STARTED.store(false, Ordering::SeqCst);
}
