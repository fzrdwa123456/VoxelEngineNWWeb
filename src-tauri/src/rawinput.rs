// Raw mouse input — the NAPI version in the original rawinput/src/lib.rs ported to Tauri.
//
// The original shape: JS calls pollDelta() every frame to actively **pull** (a synchronous NAPI
// call that reads and writes in-process atomics).
// Tauri has no synchronous IPC, so the direction is inverted: the Rust side **pushes** —
// the collector thread still accumulates into the atomics, and a separate throttling thread takes
// the accumulated value and zeroes it every BATCH_MS, sending it to the frontend through the Tauri
// event "raw-input"; the frontend accumulates in the event callback, and poll() still takes it
// synchronously.
//
// The semantics are unchanged: both consume relative deltas in per-frame batches — only the
// transport changed from pull to push.
// Throttling is necessary: WM_INPUT can arrive hundreds of times a second, and one IPC event per
// message would drown the webview.
//
// dwFlags does not set RIDEV_NOLEGACY: legacy messages are not swallowed, so Chromium's pointer
// lock is unaffected and the two paths run in parallel.
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const WM_CLOSE: u32 = 0x0010;
const WM_DESTROY: u32 = 0x0002;
const WM_INPUT: u32 = 0x00FF;
const RID_INPUT: u32 = 0x10000003;
const RIM_TYPEMOUSE: u32 = 0;
const MOUSE_MOVE_ABSOLUTE: u16 = 0x0001;
const RIDEV_INPUTSINK: u32 = 0x00000100;
const THREAD_PRIORITY_TIME_CRITICAL: i32 = 15;

/// Push throttle: at most one event per 4 ms (≈250/s) — denser than one frame, which is enough
/// and does not flood IPC
const BATCH_MS: u64 = 4;

// ===== A low-level keyboard hook, solely to swallow the CONTEXT-MENU gestures =====
// The menu/Apps key and Shift+F10 make Windows enter menu state and switch the cursor to an arrow; the
// DOM's `contextmenu` preventDefault cannot stop that step (it happens before the page is consulted), and
// our 8 ms cursor sentinel then forces the cursor back to hidden — what the player sees is a cursor FLASH,
// and the window menu may pop up as well. So the key is swallowed before Windows/Chromium ever sees it.
//
// **The ESC half is GONE (P1.72).** It existed for one reason only: with the browser's Pointer Lock API,
// ESC is the "default unlock gesture" and is handled by the browser process before the page sees it
// (ForwardKeyboardEvent -> PreHandleKeyboardEvent; at the Chrome layer
// `chrome/browser/ui/exclusive_access/exclusive_access_manager.cc:196` looks only at the keycode and never
// asks the page whether it called preventDefault), so the page had to be handed a synthesised event. The
// engine no longer uses pointer lock at all (see src/host/browser/mousecapture.ts), so ESC reaches the page
// normally and swallowing it would only risk eating a key the menus need.
const WH_KEYBOARD_LL: i32 = 13;
/// The menu key (Apps): one of the keyboard's "context menu" gestures
const VK_APPS: u32 = 0x5D;
/// F10 combined with Shift = a gesture equivalent to the menu key (a bare F10 is left alone: it
/// may be one of the player's bound keys)
const VK_F10: u32 = 0x79;
const VK_SHIFT: u32 = 0x10;

type WndProc = unsafe extern "system" fn(isize, u32, usize, isize) -> isize;

#[repr(C)]
struct WndClassW {
    style: u32,
    lpfn_wnd_proc: Option<WndProc>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: isize,
    h_icon: isize,
    h_cursor: isize,
    h_br_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

#[repr(C)]
struct RawInputDevice {
    us_usage_page: u16,
    us_usage: u16,
    dw_flags: u32,
    hwnd_target: isize,
}

#[repr(C)]
struct RawInputHeader {
    dw_type: u32,
    dw_size: u32,
    h_device: isize,
    w_param: usize,
}

const RAWINPUT_HEADER_SIZE: usize = std::mem::size_of::<RawInputHeader>();

// MSDN tagRAWMOUSE x64 layout: usFlags(2)+pad(2)+usButtonFlags(2)+usButtonData(2)
//   + ulRawButtons(4) + lLastX(4) + lLastY(4) + ulExtraInformation(4) = 24
const RAWMOUSE_SIZE: usize = 24;
const OFF_L_LAST_X: usize = RAWINPUT_HEADER_SIZE + 12;
/// `usButtonFlags` — the half of the packet this file used to skip (see BUTTONS below).
const OFF_US_BUTTON_FLAGS: usize = RAWINPUT_HEADER_SIZE + 4;

// ===== BUTTONS, from the raw packet instead of from window messages (P1.76) =====
//
// Why: with a shell overlay on top of the game (Win+;, the IME candidate window), the click is dispatched to
// THAT window, so our webview's `mousedown`/`mouseup` never fire and break/place stop working while the panel
// is up. Minecraft does not have that problem because SDL reads the button edges out of the very same RAWMOUSE
// packet the motion deltas come from (`rawmouse->usButtonFlags` -> `SDL_SendMouseButton(..., SDL_GetKeyboardFocus(),
// ...)`, src/video/windows/SDL_windowsevents.c:556-732) - raw input is DEVICE level, so which window the click
// was dispatched to does not matter at all.
//
// We already receive those packets (`RIDEV_INPUTSINK`) and already parse past this field; this is the half that
// used to be thrown away. The edges are accumulated as two bitmasks and pushed with the deltas, so the ordering
// inside one 4 ms batch is "all downs, then all ups" (a down+up of the same button inside 4 ms collapses, which
// no human can do). The wheel lives in the same union (`RI_MOUSE_WHEEL` + `usButtonData`) and is deliberately
// NOT read yet: nothing in the front end consumes a wheel event.
const RI_MOUSE_LEFT_BUTTON_DOWN: u16 = 0x0001;
const RI_MOUSE_LEFT_BUTTON_UP: u16 = 0x0002;
const RI_MOUSE_RIGHT_BUTTON_DOWN: u16 = 0x0004;
const RI_MOUSE_RIGHT_BUTTON_UP: u16 = 0x0008;
const RI_MOUSE_MIDDLE_BUTTON_DOWN: u16 = 0x0010;
const RI_MOUSE_MIDDLE_BUTTON_UP: u16 = 0x0020;
const RI_MOUSE_BUTTON_4_DOWN: u16 = 0x0040;
const RI_MOUSE_BUTTON_4_UP: u16 = 0x0080;
const RI_MOUSE_BUTTON_5_DOWN: u16 = 0x0100;
const RI_MOUSE_BUTTON_5_UP: u16 = 0x0200;

/// One bit per button, in the order the front end's `MouseEvent.button` uses (0 left, 1 middle, 2 right,
/// 3 = X1, 4 = X2), so the raw path can reuse `buttonToCode`/`buttonToAction` unchanged.
const BTN_LEFT: u32 = 1 << 0;
const BTN_MIDDLE: u32 = 1 << 1;
const BTN_RIGHT: u32 = 1 << 2;
const BTN_X1: u32 = 1 << 3;
const BTN_X2: u32 = 1 << 4;

/// `(usButtonFlags bit, our button bit, is_down)` — one table, walked in `wnd_proc`.
const BUTTON_FLAGS: [(u16, u32, bool); 10] = [
    (RI_MOUSE_LEFT_BUTTON_DOWN, BTN_LEFT, true),
    (RI_MOUSE_LEFT_BUTTON_UP, BTN_LEFT, false),
    (RI_MOUSE_RIGHT_BUTTON_DOWN, BTN_RIGHT, true),
    (RI_MOUSE_RIGHT_BUTTON_UP, BTN_RIGHT, false),
    (RI_MOUSE_MIDDLE_BUTTON_DOWN, BTN_MIDDLE, true),
    (RI_MOUSE_MIDDLE_BUTTON_UP, BTN_MIDDLE, false),
    (RI_MOUSE_BUTTON_4_DOWN, BTN_X1, true),
    (RI_MOUSE_BUTTON_4_UP, BTN_X1, false),
    (RI_MOUSE_BUTTON_5_DOWN, BTN_X2, true),
    (RI_MOUSE_BUTTON_5_UP, BTN_X2, false),
];

#[repr(C)]
struct Msg {
    hwnd: isize,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
    _l_private: u32,
}

/// The key information a WH_KEYBOARD_LL callback receives (only vkCode is used; the rest is laid
/// out per the ABI)
#[repr(C)]
struct KbDllHookStruct {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    dw_extra_info: usize,
}

extern "system" {
    fn GetAsyncKeyState(v_key: i32) -> i16;
    fn RegisterRawInputDevices(devices: *const RawInputDevice, count: u32, cb_size: u32) -> i32;
    fn GetRawInputData(
        h_raw_input: isize,
        ui_command: u32,
        p_data: *mut u8,
        pcb_size: *mut u32,
        cb_size_header: u32,
    ) -> u32;
    fn GetModuleHandleW(lp_module_name: *const u16) -> isize;
    fn RegisterClassW(lp_wc: *const WndClassW) -> u16;
    fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: isize,
        menu: isize,
        instance: isize,
        param: *mut core::ffi::c_void,
    ) -> isize;
    fn DefWindowProcW(hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
    fn GetMessageW(msg: *mut Msg, hwnd: isize, min_filter: u32, max_filter: u32) -> i32;
    fn TranslateMessage(msg: *const Msg) -> i32;
    fn DispatchMessageW(msg: *const Msg) -> isize;
    fn PostQuitMessage(code: i32);
    fn PostMessageW(hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> i32;
    fn GetCurrentThread() -> isize;
    fn SetThreadPriority(thread: isize, priority: i32) -> i32;
    pub fn SetCursorPos(x: i32, y: i32) -> i32;
    // ===== Used by the low-level context-menu hook =====
    fn SetWindowsHookExW(
        id_hook: i32,
        lpfn: Option<unsafe extern "system" fn(i32, usize, isize) -> isize>,
        h_mod: isize,
        thread_id: u32,
    ) -> isize;
    fn UnhookWindowsHookEx(hook: isize) -> i32;
    fn CallNextHookEx(hook: isize, code: i32, w_param: usize, l_param: isize) -> isize;
    fn GetForegroundWindow() -> isize;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    /// Walks up to the top level (GA_ROOT=2) / the owner root (GA_ROOTOWNER=3) — used to answer
    /// "is the foreground window one of ours"
    fn GetAncestor(hwnd: isize, flags: u32) -> isize;
    fn GetCurrentProcessId() -> u32;
}

// ===== Global accumulators (single instance; multiple instances merge counts, harmless in a game) =====
static ACC_DX: AtomicI32 = AtomicI32::new(0);
static ACC_DY: AtomicI32 = AtomicI32::new(0);
static ACC_ABS_DROPPED: AtomicI32 = AtomicI32::new(0);
/// Diagnostics: total WM_INPUT messages received (including the filtered absolute-coordinate events)
static ACC_WM_INPUT_TOTAL: AtomicI32 = AtomicI32::new(0);
/// Diagnostics: number of GetRawInputData failures
static ACC_RID_FAIL: AtomicI32 = AtomicI32::new(0);
/// **Raw button edges** (P1.76): bitmasks, OR-ed in by the collector and cleared by the push thread. See the
/// BUTTONS note above for why these come from the device and not from `mousedown`.
static ACC_BTN_DOWN: AtomicU32 = AtomicU32::new(0);
static ACC_BTN_UP: AtomicU32 = AtomicU32::new(0);
/// Diagnostics: how many packets carried a button edge (shown on the RAWMON line as `btn=`)
static ACC_BTN_TOTAL: AtomicI32 = AtomicI32::new(0);

static RUNNING: AtomicBool = AtomicBool::new(false);
static REGISTERED: AtomicBool = AtomicBool::new(false);

/// Hook handle (0 = not installed -> **fail open**: the gesture is not swallowed and Windows may reveal
/// the cursor for a moment)
static MENU_HOOK: AtomicIsize = AtomicIsize::new(0);
/// How many times the hook **has been called** (+1 per key event). Probe use: if it stays 0 the
/// hook is not being called at all
/// (installed but ineffective vs never installed are two entirely different faults, and this one
/// number separates them).
static HOOK_SEEN: AtomicI32 = AtomicI32::new(0);

/// Does the foreground window belong to this process? If not, **nothing is swallowed** — otherwise
/// the user pressing the menu key in another program would be eaten by us too.
///
/// **The test walks the HWND / ancestor chain, not "the process id of the foreground window".**
/// It used to compare `GetWindowThreadProcessId(GetForegroundWindow()) == our pid`, but under
/// Tauri/WebView2 the foreground HWND can be **a child window of WebView2 itself** (owned by
/// `msedgewebview2.exe`), so that test was always false — the consequence being a hook that was
/// "installed but swallowed not a single key": the menu key / Shift+F10 leaked into the page (the
/// `code=ContextMenu` line in the log is the evidence).
/// Three cases are accepted now: the foreground window is ours, the foreground's **root window**
/// is ours, or the foreground's **owner root window** is ours.
/// Visible to the rest of the crate since P1.50: `win.rs` asks the same question before it touches the
/// cursor or centres it - one predicate, one answer (it already encodes the root/owner-root cases).
pub(crate) unsafe fn foreground_is_ours() -> bool {
    let fg = GetForegroundWindow();
    if fg == 0 {
        return false;
    }
    if window_is_ours(fg) {
        return true;
    }
    // GA_ROOT = 2: walk a child window all the way up to the top level (WebView2's child window
    // lands here)
    let root = GetAncestor(fg, 2);
    if root != 0 && root != fg && window_is_ours(root) {
        return true;
    }
    // GA_ROOTOWNER = 3: one more fallback up the owner chain (the host of a popup window)
    let owner = GetAncestor(fg, 3);
    owner != 0 && owner != fg && owner != root && window_is_ours(owner)
}

/// Is this window's thread/process ours
unsafe fn window_is_ours(hwnd: isize) -> bool {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    pid != 0 && pid == GetCurrentProcessId()
}

/// One probe line (the push thread emits it once as an event, the frontend writes it to debug.log):
/// `seen` = how many times the hook was called (0 = the hook is not called); then the HWND/PID of
/// the foreground window, its root window and its owner root window, plus our PID — this one line
/// shows why the "is the foreground ours" test comes out false.
fn hook_probe_line() -> String {
    unsafe {
        let pid_of = |h: isize| -> u32 {
            let mut p: u32 = 0;
            if h != 0 {
                GetWindowThreadProcessId(h, &mut p);
            }
            p
        };
        let fg = GetForegroundWindow();
        let root = if fg != 0 { GetAncestor(fg, 2) } else { 0 };
        let owner = if fg != 0 { GetAncestor(fg, 3) } else { 0 };
        format!(
            "HOOKPROBE seen={} hook={:#x} fg={:#x}/pid={} root={:#x}/pid={} owner={:#x}/pid={} ours={}",
            HOOK_SEEN.load(Ordering::Relaxed),
            MENU_HOOK.load(Ordering::Relaxed) as usize,
            fg as usize,
            pid_of(fg),
            root as usize,
            pid_of(root),
            owner as usize,
            pid_of(owner),
            GetCurrentProcessId()
        )
    }
}

/// The WH_KEYBOARD_LL callback. **Must be extremely fast**: a few comparisons + atomic increments,
/// then `return 1` to swallow.
unsafe extern "system" fn menu_hook(code: i32, w_param: usize, l_param: isize) -> isize {
    if code >= 0 && l_param != 0 {
        let kb = &*(l_param as *const KbDllHookStruct);
        HOOK_SEEN.fetch_add(1, Ordering::Relaxed); // probe: the hook really was called (atomic, safe)
        // **The menu key / Shift+F10 must be swallowed.** They are the "context menu" keyboard
        // gestures: on receiving one, Windows enters menu state and switches the cursor to an arrow
        // (the `contextmenu` preventDefault at the DOM layer cannot stop that step), and our 8 ms
        // cursor sentinel immediately forces it back to hidden — what the player sees is **a cursor
        // flash**; it may also pop up the window menu. Swallow it before Windows/Chromium ever sees it,
        // and there is neither a flash nor a menu.
        // It is swallowed only when "the foreground is this window", and only Shift+F10 is swallowed
        // (a bare F10 is not — it may be one of the player's bound keys).
        let shift_f10 = kb.vk_code == VK_F10 && (GetAsyncKeyState(VK_SHIFT as i32) as u16 & 0x8000) != 0;
        if (kb.vk_code == VK_APPS || shift_f10) && foreground_is_ours() {
            return 1;
        }
        let _ = w_param;
    }
    CallNextHookEx(0, code, w_param, l_param)
}

struct Listener {
    running: std::sync::Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
    hwnd: AtomicIsize,
}

fn state() -> &'static Mutex<Option<Listener>> {
    static S: OnceLock<Mutex<Option<Listener>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn wnd_proc(hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize {
    if msg == WM_INPUT && l_param != 0 {
        ACC_WM_INPUT_TOTAL.fetch_add(1, Ordering::Relaxed);
        let mut size: u32 = 0;
        // the first call retrieves the required buffer size
        if GetRawInputData(
            l_param,
            RID_INPUT,
            std::ptr::null_mut(),
            &mut size,
            RAWINPUT_HEADER_SIZE as u32,
        ) == u32::MAX
        {
            ACC_RID_FAIL.fetch_add(1, Ordering::Relaxed);
            return DefWindowProcW(hwnd, msg, w_param, l_param);
        }
        let mut buf = vec![0u8; size as usize];
        let written = GetRawInputData(
            l_param,
            RID_INPUT,
            buf.as_mut_ptr(),
            &mut size,
            RAWINPUT_HEADER_SIZE as u32,
        );
        if written == u32::MAX || (written as usize) < RAWINPUT_HEADER_SIZE + RAWMOUSE_SIZE {
            ACC_RID_FAIL.fetch_add(1, Ordering::Relaxed);
            return DefWindowProcW(hwnd, msg, w_param, l_param);
        }
        let dev_type = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
        if dev_type == RIM_TYPEMOUSE {
            // **BUTTONS FIRST, and INDEPENDENT of the motion flags** (P1.76): a packet can carry a button edge
            // with no motion at all, and an ABSOLUTE-coordinate packet can carry one too (SDL does the same:
            // `haveButton` is checked outside its `isAbsolute` branch).
            let btn = u16::from_ne_bytes([buf[OFF_US_BUTTON_FLAGS], buf[OFF_US_BUTTON_FLAGS + 1]]);
            if btn != 0 {
                let mut down: u32 = 0;
                let mut up: u32 = 0;
                for (flag, bit, is_down) in BUTTON_FLAGS {
                    if btn & flag == 0 {
                        continue;
                    }
                    if is_down {
                        down |= bit;
                    } else {
                        up |= bit;
                    }
                }
                if down != 0 {
                    ACC_BTN_DOWN.fetch_or(down, Ordering::Relaxed);
                }
                if up != 0 {
                    ACC_BTN_UP.fetch_or(up, Ordering::Relaxed);
                }
                ACC_BTN_TOTAL.fetch_add(1, Ordering::Relaxed);
            }
            let us_flags = u16::from_ne_bytes([buf[RAWINPUT_HEADER_SIZE], buf[RAWINPUT_HEADER_SIZE + 1]]);
            if us_flags & MOUSE_MOVE_ABSOLUTE == 0 {
                // relative mode: lLastX/Y are the deltas (standard and gaming mice both take this path)
                let dx = i32::from_ne_bytes([
                    buf[OFF_L_LAST_X],
                    buf[OFF_L_LAST_X + 1],
                    buf[OFF_L_LAST_X + 2],
                    buf[OFF_L_LAST_X + 3],
                ]);
                let dy = i32::from_ne_bytes([
                    buf[OFF_L_LAST_X + 4],
                    buf[OFF_L_LAST_X + 5],
                    buf[OFF_L_LAST_X + 6],
                    buf[OFF_L_LAST_X + 7],
                ]);
                if dx != 0 || dy != 0 {
                    ACC_DX.fetch_add(dx, Ordering::Relaxed);
                    ACC_DY.fetch_add(dy, Ordering::Relaxed);
                }
            } else {
                // absolute coordinates (tablet / remote desktop): dropped
                ACC_ABS_DROPPED.fetch_add(1, Ordering::Relaxed);
            }
        }
        return 0;
    }
    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return 0;
    }
    DefWindowProcW(hwnd, msg, w_param, l_param)
}

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

/// Starts the listener: the collector thread + the push thread. On failure it returns the reason
/// and the game runs as usual (merely without raw input as a fallback).
pub fn start(app: AppHandle) -> Result<(), String> {
    {
        let guard = state().lock().unwrap();
        if guard.is_some() {
            return Ok(()); // already started
        }
    }

    let running = std::sync::Arc::new(AtomicBool::new(true));
    let registered = std::sync::Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Result<isize, String>>();
    let running_clone = running.clone();
    let registered_clone = registered.clone();

    let handle = std::thread::spawn(move || unsafe {
        let class_name = wide("VoxelRawMouseListener");
        let h_instance = GetModuleHandleW(std::ptr::null());
        if h_instance == 0 {
            let _ = tx.send(Err("GetModuleHandleW failed".into()));
            return;
        }

        // RegisterClassW failing when the class already exists is normal (a repeated start); ignore it
        let wc = WndClassW {
            style: 0,
            lpfn_wnd_proc: Some(wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance,
            h_icon: 0,
            h_cursor: 0,
            h_br_background: 0,
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class_name.as_ptr(),
        };
        let _atom = RegisterClassW(&wc);

        // HWND_MESSAGE as the parent = a message-only window: invisible and not in the taskbar
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            -3, // HWND_MESSAGE
            0,
            h_instance,
            std::ptr::null_mut(),
        );
        if hwnd == 0 {
            let _ = tx.send(Err("CreateWindowExW failed".into()));
            return;
        }

        // ===== Install the context-menu hook first (it does **not depend** on raw input
        // registering successfully) =====
        // A low-level hook is called back on whichever thread installed it — so the GetMessageW
        // loop below also pumps messages for the hook, which is a hard requirement of
        // WH_KEYBOARD_LL (not optional).
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(menu_hook), 0, 0);
        MENU_HOOK.store(hook, Ordering::SeqCst);

        // Register raw mouse input: INPUTSINK lets the hidden window receive global input even
        // while it is not in the foreground.
        // **A failure no longer aborts the thread** — the hook must keep working; the two paths
        // are independent.
        let device = RawInputDevice {
            us_usage_page: 0x01, // Generic Desktop
            us_usage: 0x02,      // Mouse
            dw_flags: RIDEV_INPUTSINK,
            hwnd_target: hwnd,
        };
        let ok = RegisterRawInputDevices(&device, 1, std::mem::size_of::<RawInputDevice>() as u32);
        registered_clone.store(ok != 0, Ordering::SeqCst);
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        let _ = tx.send(Ok(hwnd));

        // Message loop: blocks waiting for WM_INPUT / WM_CLOSE; when running=false, stop() sends
        // WM_CLOSE to wake it and exit
        let mut msg = Msg {
            hwnd: 0,
            message: 0,
            w_param: 0,
            l_param: 0,
            time: 0,
            pt_x: 0,
            pt_y: 0,
            _l_private: 0,
        };
        while running_clone.load(Ordering::SeqCst) && GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        // Note: UnregisterClassW is deliberately not called — leaking one class name per process is
        // harmless and avoids multiple instances treading on each other
    });

    let hwnd = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "rawinput thread init timeout".to_string())?
        .map_err(|e| e)?;

    RUNNING.store(true, Ordering::SeqCst);
    // Whether raw input actually registered is taken from what the thread reported (the context-menu
    // hook works even when it fails)
    REGISTERED.store(registered.load(Ordering::SeqCst), Ordering::SeqCst);

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
        let mut last_seen = HOOK_SEEN.load(Ordering::Relaxed);
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
                    let _ = app.emit("hook-probe", hook_probe_line());
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
                let seen = HOOK_SEEN.load(Ordering::Relaxed);
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
                    if unsafe { foreground_is_ours() } { 1 } else { 0 },
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

    *state().lock().unwrap() = Some(Listener {
        running,
        handle: Mutex::new(Some(handle)),
        hwnd: AtomicIsize::new(hwnd),
    });
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
        menuHook: MENU_HOOK.load(Ordering::SeqCst) != 0,
    }
}

pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
    // Remove the hook (an unremoved low-level hook keeps being called until the process exits)
    let hook = MENU_HOOK.swap(0, Ordering::SeqCst);
    if hook != 0 {
        unsafe { UnhookWindowsHookEx(hook) };
    }
    let mut guard = state().lock().unwrap();
    if let Some(l) = guard.take() {
        l.running.store(false, Ordering::SeqCst);
        let hwnd = l.hwnd.swap(0, Ordering::SeqCst);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
        }
        if let Some(h) = l.handle.lock().unwrap().take() {
            let _ = h.join();
        }
    }
}
