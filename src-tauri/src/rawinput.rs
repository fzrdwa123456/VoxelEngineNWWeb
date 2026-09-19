// 原始鼠标输入 —— 原 rawinput/src/lib.rs 的 NAPI 版本换成 Tauri 版本。
//
// 原来的形状：JS 每帧调 pollDelta() 主动**拉**（NAPI 同步调用，读写进程内原子量）。
// Tauri 里没有同步 IPC，所以方向反过来：Rust 侧**推** ——
// 采集线程照旧往原子量里累加，另一个节流线程每 BATCH_MS 把累加值取走、清零，
// 通过 Tauri 事件 "raw-input" 发给前端；前端在事件回调里累加，poll() 依然是同步取走。
//
// 语义没变：都是"按帧批量消费相对增量"，只是搬运方式从拉变推。
// 节流是必要的：WM_INPUT 一秒钟可能上百条，一条一个 IPC 事件会把 webview 淹掉。
//
// dwFlags 不加 RIDEV_NOLEGACY：不吞 legacy 消息，Chromium 的 pointer lock 不受影响，两条路并行。
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

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

/// 推送节流：最多 4ms 一个事件（≈250/s），比一帧还密，够用且不淹 IPC
const BATCH_MS: u64 = 4;

// ===== 方案 B：低级键盘钩子，只为了吞掉 ESC =====
// 为什么需要它：ESC 是浏览器的"默认解锁手势"，由**浏览器进程在把按键交给页面之前**
// 就处理掉了（content/browser/renderer_host/render_widget_host_impl.cc 的
// ForwardKeyboardEvent -> PreHandleKeyboardEvent；Chrome 层见
// chrome/browser/ui/exclusive_access/exclusive_access_manager.cc:196 HandleUserKeyEvent，
// 它只看 keycode，从不查页面有没有 preventDefault）。所以页面里的 preventDefault()
// （main.ts:725，注释还引着 #7907）在原生 Chromium/WebView2 上**拦不住**它：
//   第 1 次 ESC -> 浏览器解指针锁定（光标出来，页面根本收不到这次 keydown）
//   第 2 次 ESC -> 已经没有锁定可解，事件才落到页面 -> 暂停界面
// 办法就是让浏览器**永远看不到 ESC**：钩子吞掉，再从这儿推给前端合成一个真的 KeyboardEvent。
const WH_KEYBOARD_LL: i32 = 13;
const VK_ESCAPE: u32 = 0x1B;
const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_SYSKEYUP: u32 = 0x0105;

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

// MSDN tagRAWMOUSE x64 布局: usFlags(2)+pad(2)+usButtonFlags(2)+usButtonData(2)
//   + ulRawButtons(4) + lLastX(4) + lLastY(4) + ulExtraInformation(4) = 24
const RAWMOUSE_SIZE: usize = 24;
const OFF_L_LAST_X: usize = RAWINPUT_HEADER_SIZE + 12;

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

/// WH_KEYBOARD_LL 回调收到的按键信息（只用 vkCode，其余按 ABI 排布）
#[repr(C)]
struct KbDllHookStruct {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    dw_extra_info: usize,
}

extern "system" {
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
    // ===== ESC 钩子用到的（方案 B）=====
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
    fn GetCurrentProcessId() -> u32;
}

// ===== 全局累加器 (单实例使用; 多实例会合并计数, 游戏场景无影响) =====
static ACC_DX: AtomicI32 = AtomicI32::new(0);
static ACC_DY: AtomicI32 = AtomicI32::new(0);
static ACC_ABS_DROPPED: AtomicI32 = AtomicI32::new(0);
/// 诊断: 收到的 WM_INPUT 总数 (含被过滤的绝对坐标事件)
static ACC_WM_INPUT_TOTAL: AtomicI32 = AtomicI32::new(0);
/// 诊断: GetRawInputData 失败次数
static ACC_RID_FAIL: AtomicI32 = AtomicI32::new(0);

static RUNNING: AtomicBool = AtomicBool::new(false);
static REGISTERED: AtomicBool = AtomicBool::new(false);

/// ESC 钩子句柄（0 = 没装上 -> **失败即放行**：不吞 ESC，游戏退回"按两次"的旧行为）
static ESC_HOOK: AtomicIsize = AtomicIsize::new(0);
/// 待推送的 ESC 边沿。钩子回调里**只**动这些原子量 ——
/// 低级钩子有 `LowLevelHooksTimeout`（默认 1 秒），在回调里发 IPC 慢了会被 Windows 静默摘钩子。
static ESC_DOWNS: AtomicI32 = AtomicI32::new(0);
static ESC_REPEATS: AtomicI32 = AtomicI32::new(0);
static ESC_UPS: AtomicI32 = AtomicI32::new(0);
/// 按下状态（用来区分"首次按下"和"长按重复"）
static ESC_IS_DOWN: AtomicBool = AtomicBool::new(false);

/// 前台窗口属于本进程吗？不是就**不吞** —— 否则用户在别的程序里按 ESC 也会被我们吃掉。
unsafe fn foreground_is_ours() -> bool {
    let hwnd = GetForegroundWindow();
    if hwnd == 0 {
        return false;
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    pid != 0 && pid == GetCurrentProcessId()
}

/// WH_KEYBOARD_LL 回调。**必须极快**：几次比较 + 原子自增，然后 `return 1` 吞掉。
unsafe extern "system" fn esc_hook(code: i32, w_param: usize, l_param: isize) -> isize {
    if code >= 0 && l_param != 0 {
        let kb = &*(l_param as *const KbDllHookStruct);
        if kb.vk_code == VK_ESCAPE && foreground_is_ours() {
            match w_param as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => {
                    if ESC_IS_DOWN.swap(true, Ordering::Relaxed) {
                        ESC_REPEATS.fetch_add(1, Ordering::Relaxed);
                    } else {
                        ESC_DOWNS.fetch_add(1, Ordering::Relaxed);
                    }
                }
                WM_KEYUP | WM_SYSKEYUP => {
                    ESC_IS_DOWN.store(false, Ordering::Relaxed);
                    ESC_UPS.fetch_add(1, Ordering::Relaxed);
                }
                _ => {}
            }
            return 1; // 吞掉：浏览器永远看不到这次 ESC，也就不会解指针锁定
        }
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
        // 第一次调用拿需要的缓冲区大小
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
            let us_flags = u16::from_ne_bytes([buf[RAWINPUT_HEADER_SIZE], buf[RAWINPUT_HEADER_SIZE + 1]]);
            if us_flags & MOUSE_MOVE_ABSOLUTE == 0 {
                // 相对模式: lLastX/Y 就是增量 (标准鼠标/游戏鼠标都走这)
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
                // 绝对坐标 (平板/远程桌面): 丢弃
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
}

/// 被钩子吞掉的 ESC，推给前端去合成一个真的 KeyboardEvent（见 src/platform/rawinput.ts）
#[derive(Clone, Serialize)]
pub struct EscEvent {
    pub down: bool,
    pub repeat: bool,
}

/// 每条推给前端的事件载荷
const EVENT: &str = "raw-input";
/// ESC 边沿的载荷名（方案 B）
const ESC_EVENT: &str = "esc";

/// 启动监听：采集线程 + 推送线程。失败时返回原因，游戏照常跑（没有原始输入兜底而已）。
pub fn start(app: AppHandle) -> Result<(), String> {
    {
        let guard = state().lock().unwrap();
        if guard.is_some() {
            return Ok(()); // 已经起过了
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

        // 类已存在时 RegisterClassW 失败是正常的 (重复 start), 忽略
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

        // HWND_MESSAGE 父窗口 = message-only 窗口, 不可见不进任务栏
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

        // ===== 方案 B：先装 ESC 钩子（它**不依赖**原始输入注册成功）=====
        // 低级钩子装在哪个线程，回调就在哪个线程被调用 —— 所以下面那个 GetMessageW 循环
        // 同时也在给钩子泵消息，这是 WH_KEYBOARD_LL 的硬要求（不是可选的）。
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(esc_hook), 0, 0);
        ESC_HOOK.store(hook, Ordering::SeqCst);

        // 注册原始鼠标输入: INPUTSINK 让隐藏窗口在非前台也能收到全局输入。
        // **失败不再中止线程** —— ESC 钩子要照样工作，两条路互相独立。
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

        // 消息循环: 阻塞等 WM_INPUT / WM_CLOSE, running=false 时由 stop 发 WM_CLOSE 唤醒退出
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
        // 注: 故意不 UnregisterClassW, 进程级泄漏一个类名无害且避免多实例互踩
    });

    let hwnd = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "rawinput thread init timeout".to_string())?
        .map_err(|e| e)?;

    RUNNING.store(true, Ordering::SeqCst);
    // 原始输入到底注册上没有，以线程报上来的为准（ESC 钩子即使它失败也照样工作）
    REGISTERED.store(registered.load(Ordering::SeqCst), Ordering::SeqCst);

    // 推送线程：定速把累加值取走清零并发事件（前端同步 poll() 拿的是自己那份累加器）
    std::thread::spawn(move || {
        let mut tick: u32 = 0;
        while RUNNING.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(BATCH_MS));
            tick = tick.wrapping_add(1);
            // 光标哨兵：每两次 tick（≈8ms）校对一次可见性，把被 Windows 菜单模式 / Chromium
            // 推送时机弄乱的状态按回期望值。稳态下 GetCursorInfo 一致，不做任何额外动作。
            if tick % 2 == 0 {
                crate::win::cursor_sentinel(&app);
            }
            let dx = ACC_DX.swap(0, Ordering::Relaxed);
            let dy = ACC_DY.swap(0, Ordering::Relaxed);
            if dx != 0 || dy != 0 {
                let _ = app.emit(EVENT, MouseDelta { dx, dy });
            }
            // 被钩子吞掉的 ESC 边沿：同样按批推，顺序 down -> repeat -> up
            // （人不可能 4ms 内按两次，所以这个顺序实际上不会乱）
            for _ in 0..ESC_DOWNS.swap(0, Ordering::Relaxed) {
                let _ = app.emit(ESC_EVENT, EscEvent { down: true, repeat: false });
            }
            for _ in 0..ESC_REPEATS.swap(0, Ordering::Relaxed) {
                let _ = app.emit(ESC_EVENT, EscEvent { down: true, repeat: true });
            }
            for _ in 0..ESC_UPS.swap(0, Ordering::Relaxed) {
                let _ = app.emit(ESC_EVENT, EscEvent { down: false, repeat: false });
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

/// 诊断数据。字段名故意用 camelCase —— serde 直接序列化成前端那个 RawStats 接口的形状。
#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct RawStats {
    pub available: bool,
    pub wmInputTotal: i32,
    pub ridFail: i32,
    pub absoluteDropped: i32,
    /// 方案 B 的 ESC 钩子装上没有（false = 失败即放行，游戏退回"按两次 ESC"）
    pub escHook: bool,
}

pub fn stats() -> RawStats {
    RawStats {
        available: RUNNING.load(Ordering::SeqCst) && REGISTERED.load(Ordering::SeqCst),
        wmInputTotal: ACC_WM_INPUT_TOTAL.load(Ordering::Relaxed),
        ridFail: ACC_RID_FAIL.load(Ordering::Relaxed),
        absoluteDropped: ACC_ABS_DROPPED.load(Ordering::Relaxed),
        escHook: ESC_HOOK.load(Ordering::SeqCst) != 0,
    }
}

pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
    // 摘掉 ESC 钩子（低级钩子不摘的话，进程退出前它会一直被调用）
    let hook = ESC_HOOK.swap(0, Ordering::SeqCst);
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
