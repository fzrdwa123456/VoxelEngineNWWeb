// 窗口操作 —— 对应原 NW.js 版 platform/shell.ts 里 nw.Window.get() 那一半。
//
// 逐条对照（NW.js -> Tauri v2）：
//   win.show() / win.focus()          -> window.show() / window.set_focus()
//   win.close()                       -> app.exit(0)
//   win.on("focus"/"blur")            -> WindowEvent::Focused -> emit("win-focus"/"win-blur")
//   win.enterKioskMode()/leave        -> window.set_fullscreen(bool)
//   win.setAlwaysOnTop(false)         -> 不需要：NW.js 的 kiosk 会偷偷置顶才要撤，Tauri 不会
//   cursor.exe / setCursorPos(x, y)   -> 这里自己算窗口中心 + SetCursorPos
use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicU8, Ordering};

use tauri::WebviewWindow;

/// 把系统光标放到窗口正中心（菜单/背包打开时让光标回到准星位置）。
/// 原版是"JS 算坐标 -> 交给 cursor.exe / NAPI 插件"，这里一步到位：窗口几何直接从 Tauri 拿。
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

/// 窗口模式切换（对应原版的 kiosk 全屏开关，运行时不重启）
pub fn set_fullscreen(window: &WebviewWindow, fullscreen: bool) -> bool {
    window.set_fullscreen(fullscreen).is_ok()
}

/// 当前是否全屏（原版读 win.isFullscreen）
pub fn is_fullscreen(window: &WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

// ===== 原生鼠标捕获（不走 Pointer Lock API）=====
//
// 为什么不走浏览器的指针锁定：ESC 解锁是**浏览器的安全策略**，由浏览器进程在页面之前处理
// （`render_widget_host_impl.cc` 的 ForwardKeyboardEvent -> PreHandleKeyboardEvent；
//  Chrome 层 `exclusive_access_manager.cc:196` 只看 keycode），而且解锁之后有一段时间
// **拒绝重新锁定**（Blink 里那条 `kUserEscapeCooldown`：「Pointer lock cannot be acquired
// immediately after the user has exited the lock.」）。页面无权关闭，Tauri/WebView2 也没暴露开关。
// NW.js 当年能解决是因为它自带一份打过补丁的 Chromium。
//
// 所以这里用 Win32 那一套自己捕获鼠标：
//   ClipCursor(客户区)  —— 把系统光标**物理限制**在窗口里（出不去 = 不会点到别的窗口、不会丢焦点）
//   SetCursorPos(中心)  —— 配合它用（Windows 会把光标挪进矩形）
// 光标隐藏仍然交给 CSS（`pointerlock.applyCursor()` 的 `cursor: none`）：光标被夹在客户区内，
// 一定落在 webview 上，所以 CSS 足够 —— 不需要去 hook WM_SETCURSOR。
//
// **失焦必须释放**（见 lib.rs 的 Focused(false) 分支），否则 Alt-Tab 之后用户的光标被关在窗口里。
/// 客户区矩形（屏幕坐标）。失败返回 None。
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

/// 打开/关闭原生鼠标捕获。返回是否成功（失败时前端会退回浏览器的 requestPointerLock）。
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
        // **故意不动光标位置**。捕获是"转隐藏"的一步，按规则**隐藏路径不居中、不挪光标** ——
        // 之前这里有一句 SetCursorPos(窗口中心)，结果进世界 / 点「回到游戏」时玩家会看见
        // 光标先往窗口中间跳一下再消失（就是"隐藏却居中了"那个毛病）。
        // 而且它完全没有必要：raw input 的相对增量与光标位置无关，ClipCursor 自己会把光标夹进矩形。
        ok
    }
}

/// **窗口几何变了：把裁剪矩形重新算一遍。**
///
/// 为什么必须有：`ClipCursor` 的矩形是「开始捕获那一刻」算的，窗口一缩放/移动它就**过时**了 ——
/// 光标于是能跑到边框/标题栏（**非客户区**，Chromium 的 `cursor:none` 管不到），玩家就能一边拖窗口
/// 一边转视角，松手后光标还在窗口里到处滑。
///
/// 前端现在对「捕获期间的几何变化」是**直接放捕获 +（世界里且无 UI 时）弹暂停菜单**（main.ts 的
/// `onWinGeometry`），所以多数情况下这里无事可做；但**程序自己改窗口模式**（全屏 / 窗口化）时前端会
/// 抑制那次暂停 —— 那时捕获还开着，矩形必须跟上。它顺带覆盖 DPI 变化、窗口吸附、被别的程序挪动等
/// 其它几何变化。返回是否真的重夹了（诊断用）。
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

/// 无条件释放捕获（失焦 / 退出时的安全网；重复调用无害）
pub fn release_mouse_capture() {
    CAPTURE_HWND.store(0, Ordering::Relaxed);
    unsafe {
        ClipCursor(std::ptr::null());
    }
}

/// **捕获只允许在前台开着 —— 这条是系统级兜底。**
///
/// 为什么必须有：`ClipCursor` **不看**窗口是不是前台，而原始输入用的是 `RIDEV_INPUTSINK`（**后台也收**）。
/// 于是"在后台把捕获打开"的后果是三重同时发生的 —— 全都实测过：
///   * 系统光标被夹在我们窗口的矩形里，而那块屏幕区域上现在是**别的应用** —— 光标出不去；
///   * 视角照样跟着转（后台的原始输入照收）；
///   * 光标被全局隐藏（CSS/意图都是 hidden，8ms 哨兵还每 16ms 强制维持）。
///
/// 前端已经加了焦点门禁（`PointerLock` 的 `focused`）挡住正常路径（进世界时的自动 relock 是最容易踩的
/// 一处），这一条是**兜底**：任何让捕获在非前台打开或继续存在的路径（UAC 抢焦点、系统级切换、前端漏掉的
/// 事件）都会在约 32ms 内被拆掉。
///
/// 返回 `true` 表示**刚刚释放**：调用方负责 emit `capture-lost` 让前端做"放鼠标 +（世界里且无 UI 时）
/// 暂停"那一套 —— 只在 Rust 侧释放是不够的，前端那边的 `INPUT_STATE.locked` 还是 true（视角照转、光标
/// 照隐藏），等于没救。释放与恢复光标都 marshal 到主线程（`SetCursor`/`ShowCursor`/`ClipCursor` 那套的
/// 规矩；这个函数本身跑在原始输入的推送线程上）。
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
        return false; // 前台切换的瞬间本来就会短暂不一致：连续两次（≈32ms）才动手
    }
    FG_MISMATCH_TICKS.store(0, Ordering::Relaxed);
    let h = app.clone();
    let _ = h.run_on_main_thread(move || {
        release_mouse_capture();
        apply_cursor(true); // 光标跟着放出来，别把它留在隐藏状态
    });
    true
}

/// 切回焦点之后"踢"一下光标，让它**重新画到屏幕上**。
///
/// 两个失败模式都要覆盖（boot.log 的探针把两个都抓到了，它们是不同的病）：
///
/// **(a) Chromium 缓存的光标还是 NULL** —— 它只会照着缓存回答我们的 `WM_SETCURSOR`：
///     `focus GAIN before=showing=false hCursor=0` → `after` 还是 0。
///     这条 Rust 侧治不了，必须让**前端把 CSS 真的改一次**（见 pointerlock.ts::reapplyCursor）。
///
/// **(b) 系统状态已经对了，但屏幕上的光标没重画**：
///     `focus GAIN before=showing=true hCursor=65539`，系统说"箭头、可见"，可就是看不见，
///     动一下鼠标才出现 —— 光标叠加层需要一次位置或可见性变化才会重绘。
///     这条由这里治：挪 1px（**故意不挪回来** —— 挪回去等于没动，上一版就是这么白干的）
///     + toggle 一次 `ShowCursor`。1px 的偏移在下一次真实鼠标移动时就归位了。
pub fn kick_cursor_repaint() {
    unsafe {
        let mut p = Point { x: 0, y: 0 };
        if GetCursorPos(&mut p) != 0 {
            // 挪 1px **再挪回来** —— 位置净变化为 0。
            // 原来只挪过去不挪回来，代价是**每次窗口获得焦点都永久右移 1px 并累积**：
            //   focus GAIN before=pos=(1292,647) / after=pos=(1293,647)
            // 反复 Alt-Tab、点回窗口就会慢慢飘。这里保留"位置确实变过一次"这个效果
            // （当初用来强制系统重绘光标叠加层的手段），但把它对称化，玩家看不到、也不会累积。
            let _ = crate::rawinput::SetCursorPos(p.x + 1, p.y);
            let _ = crate::rawinput::SetCursorPos(p.x, p.y);
        }
        // 再 toggle 一次可见性：显示↔隐藏本身也会强制重绘，两种手段叠加最稳。
        // 引用计数净变化为 0，不影响别的东西。
        ShowCursor(0);
        ShowCursor(1);
    }
}

// ===== 光标归我们自己管（哨兵）=====
//
// 为什么不依赖 Chromium：CSS 的 `cursor` 只是**意图**，真正决定屏幕上看不看得见的是
// `SetCursor` 的推送，而它的时机完全不可靠 —— 探针在 boot.log 里抓到两种失败：
//   * 失焦那一刻 CSS 从 none 变 default，推送被系统丢掉，切回来还是隐藏（且 Chromium 的缓存
//     仍是 NULL，问它 `WM_SETCURSOR` 它答的也是 NULL）；
//   * 释放捕获（`ClipCursor(NULL)`）**根本不碰光标形状**，于是暂停界面开着、系统里却还是隐藏。
// 另外 Windows 一按 Alt 就进菜单模式、把箭头光标设上去 —— 捕获期间这会让玩家突然看见光标。
//
// 所以：前端只告诉我们**期望**（可见/隐藏），Rust 每 8ms 校对一次，不符就直接纠正。
// 这只在"可见性"层面纠正（`hCursor == 0` 才算隐藏），**不会覆盖 Chromium 的指针形状** ——
// 鼠标停在按钮上时那个手型光标是非 NULL 的，哨兵看到"可见"就什么都不做。
static DESIRED_CURSOR: AtomicU8 = AtomicU8::new(0); // 0=未知 1=可见 2=隐藏
static CURSOR_HWND: AtomicIsize = AtomicIsize::new(0);
static CURSOR_ENFORCED: AtomicU32 = AtomicU32::new(0); // 纠正次数（诊断）
/// 当前**开着**捕获的那个窗口（0 = 没捕获）。`set_mouse_capture` 记下、`release_mouse_capture` 清掉，
/// 于是「窗口几何变了要不要重夹一下」有一个便宜的答案（见 `reclip_mouse_capture`）。
static CAPTURE_HWND: AtomicIsize = AtomicIsize::new(0);
/// 连续几次 tick 发现"捕获开着但窗口不是前台"（去抖：前台切换的瞬间本来就会短暂不一致）
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

/// 系统层面光标到底可不可见：`hCursor == 0`（NULL 形状）就是不可见。
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

/// 直接按期望值设一次光标
fn apply_cursor(visible: bool) {
    unsafe {
        if visible {
            SetCursor(LoadCursorW(0, IDC_ARROW));
        } else {
            SetCursor(0); // NULL 形状 = 看不见
        }
        CURSOR_ENFORCED.fetch_add(1, Ordering::Relaxed);
    }
}

// ===== 禁用"单按 Alt 打开系统菜单" =====
//
// 为什么要禁：每个带标题栏的窗口都自带系统菜单，Windows 的规则是**单按 Alt（松开时）激活它**。
// 菜单一激活就会连锁三件事（日志实证：`KBCAP keydown code=AltLeft` 之后 109ms 就 `WINFOCUS blur`）：
//   1. 菜单相当于模态弹窗 → 宿主窗口收到 `WM_ACTIVATE(WA_INACTIVE)` → Tauri 报成 `Focused(false)`
//      → 游戏的 onWinBlur **按设计自动暂停 + 释放鼠标捕获** → canControl=false → 视角动不了；
//   2. 菜单模式跑一个**嵌套模态消息循环**，卡住主线程 —— Tauri 的事件投递（`app.emit` 的
//      raw-input）和 `run_on_main_thread`（光标哨兵的纠正）全部积压 → 视角彻底不动、光标不刷新；
//   3. 单击鼠标才会取消菜单模式 → 主线程恢复、积压事件一次性冲出 → 于是"点一下才正常"。
//
// 修法就是**在窗口过程里吞掉 SC_KEYMENU**（"用户按 Alt 请求打开菜单"那条系统命令），
// 不调 DefWindowProc，菜单模式根本不会启动 —— 上面三条自然都不发生。
//
// **不影响 Alt+Tab**：Alt+Tab 是系统级热键，不走 WM_SYSCOMMAND。
// （对比：用低级键盘钩子吞掉 Alt 会把 Alt+Tab 一起废掉，所以不采用。）
const WM_SYSCOMMAND: u32 = 0x0112;
const SC_KEYMENU: usize = 0xF100;
/// 键盘的"上下文菜单"手势（菜单键 / Shift+F10）在系统层也会以 WM_CONTEXTMENU 送到窗口：默认处理会
/// "准备弹出菜单"，而弹出前 Windows 会把光标显示出来 —— 我们那个 8ms 光标哨兵随即又按回隐藏，玩家看到的
/// 就是"鼠标闪一下"。和 Alt 的 SC_KEYMENU 同一招：在窗口过程里吞掉，不调 DefWindowProc。
/// （页面里的 contextmenu preventDefault 拦不住这一步，WebView2 自带菜单也已经关了 —— 都不是它。）
const WM_CONTEXTMENU: u32 = 0x007B;
/// SC_MOUSEMENU：请求打开窗口菜单的另一种形式（和 SC_KEYMENU 同一族）
const SC_MOUSEMENU: usize = 0xF090;
const GWLP_WNDPROC: i32 = -4;
const WM_NCDESTROY: u32 = 0x0082;

/// 子类化之前的窗口过程，除上面那几条菜单消息外全部转发给它（也就是 tao 自己的那份）
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
        // 吞掉：不调 DefWindowProc，菜单模式/上下文菜单都不会启动（也就不会把光标亮出来）
        return 0;
    }
    let old = OLD_WNDPROC.load(Ordering::SeqCst);
    if msg == WM_NCDESTROY && old != 0 {
        // 还原（进程退出时其实无所谓，但这是规矩）
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, old);
    }
    if old != 0 {
        return CallWindowProcW(old, hwnd, msg, w_param, l_param);
    }
    0
}

/// 给顶层窗口装上"菜单抑制器"。返回是否成功。
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

/// 把光标放回窗口客户区中心（原来"开菜单/背包时光标落在准星位置"的行为）
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

/// 前端在**期望值变化**时调（`pointerlock.applyCursor()` 里）：记下期望 + 立刻纠正一次；
/// 切到"可见"时顺手把光标放回窗口中心（这就是"不居中"那条）。
///
/// **`SetCursor` 必须跑在窗口所属线程（主线程）上**，而 Tauri 的命令默认在线程池里执行 ——
/// 所以这里用 `run_on_main_thread` marshal 回去。
pub fn set_cursor_intent(app: &tauri::AppHandle, hwnd: isize, visible: bool) {
    let prev = DESIRED_CURSOR.swap(if visible { 1 } else { 2 }, Ordering::Relaxed);
    CURSOR_HWND.store(hwnd, Ordering::Relaxed);
    // **只在"隐藏 -> 可见"这一次转变里居中** —— 也就是"从捕获态退出来、菜单打开"的那一刻，
    // 和原来"开菜单/背包时光标落在准星位置"的手感一致。
    //
    // **不能每次变可见都居中**：启动时 boot() 末尾那次 applyCursor()（主菜单刚显示）也会走到这里，
    // 而那时 prev == 0（还没有过任何意图）—— 结果就是双击 exe 的瞬间鼠标被拽到屏幕中间。
    // prev == 2 才表示"上一次是隐藏"，也就是真的从游戏里退出来了。
    let was_hidden = prev == 2;
    let _ = app.run_on_main_thread(move || {
        apply_cursor(visible);
        if visible && was_hidden && hwnd != 0 {
            unsafe { center_on(hwnd) };
        }
    });
}

/// 哨兵：期望和实际不符就纠正。由 rawinput 的 4ms 线程每两次 tick 调一次（≈8ms）。
///
/// 它负责三件事：
///   * 捕获期间 Windows 被 Alt 弄进菜单模式、把箭头设上去 → **立刻按回 NULL**（"把 alt 呼出鼠标禁掉"）；
///   * 暂停/菜单期间光标卡在隐藏 → 立刻设成箭头；
///   * 任何别的时序漏掉的时刻。
///
/// 轮询 `GetCursorInfo` 是线程无关的，随便哪个线程都行；**只有真的不符时**才 marshal 回主线程，
/// 所以稳态下没有任何额外开销。
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

/// 诊断（RAWMON 行）：期望的光标状态（0 未知 / 1 可见 / 2 隐藏）与系统此刻**是否真的显示**光标。
/// 两个数放一起看就能判断"哨兵是不是在跟系统拉锯"：`desired=2 showing=1` 反复出现 = 系统一直把光标
/// 显示回来、哨兵一直按回去 —— 每次都要 marshal 到主线程，而主线程正是跑渲染的那条。
pub fn cursor_state() -> (u8, bool) {
    (DESIRED_CURSOR.load(Ordering::Relaxed), cursor_visible_now())
}

/// 诊断（RAWMON 行）：现在有没有开着鼠标捕获（ClipCursor）
pub fn capture_active() -> bool {
    CAPTURE_HWND.load(Ordering::Relaxed) != 0
}

/// 让 WebView2 **重新决定一次光标形状** —— 发一条 `WM_SETCURSOR` 给光标下的那个窗口。
///
/// 这就是 Windows 在处理**真实鼠标输入之前**做的事，所以 Chromium 会走完全相同的路径
/// （读当前 CSS → `SetCursor`），而且这次调用发生在**窗口已经重新聚焦之后**，不会被系统丢掉。
///
/// 为什么不能用 `SetCursorPos` 挪 1px（第一版就是这么写的，没用）：
/// MSDN 对 `WM_SETCURSOR` 的原文是 *"Sent to a window if **the mouse** causes the cursor to
/// move within a window"* —— 程序调 `SetCursorPos` 不算"鼠标"，Windows 会发 `WM_MOUSEMOVE`
/// 但**不会**因此重走"决定光标形状"这条路径。
///
/// 具体要修的 bug（有日志证据）：不按 ESC、直接用 Alt-Tab / Win 键触发暂停时，失焦这件事
/// **本身**才让暂停菜单出现，于是 CSS 在**同一瞬间**从 `none` 变成 `default` —— 那一刻窗口正在
/// 失去焦点，Chromium 推下去的光标被系统丢掉，切回来就是失焦前那个隐藏光标，要动一下鼠标
/// （或按 Alt 进菜单模式，那也会强制重设光标）才恢复。先按 ESC 的情况没事，因为那一次 CSS
/// 变化发生在窗口仍聚焦时，立刻就生效了。
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
        // 只对我们自己的窗口做 —— 光标当时在别的程序上就没有什么可刷新的
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(under, &mut pid);
        if pid == 0 || pid != GetCurrentProcessId() {
            return;
        }
        // lParam = MAKELPARAM(HTCLIENT, WM_MOUSEMOVE)：和真实鼠标移动时一模一样的载荷
        let lparam = ((WM_MOUSEMOVE as isize) << 16) | (HTCLIENT as isize);
        SendMessageW(under, WM_SETCURSOR, under as usize, lparam);
    }
}

/// 诊断用：直接量"光标现在到底是显示还是隐藏"。
///
/// `GetCursorInfo` 的 `CURSOR_SHOWING` 标志是**系统层面**的事实 —— 不是 CSS、不是我们的推测。
/// 用它就能判定"Alt-Tab 回来光标不见了"到底是：
///   * CSS 已经说 default，但系统那边还是 hidden（= 形状没重刷，我的 nudge 机制错了），或者
///   * 系统那边本来就是 showing，那问题在别处。
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

/// `WM_SETCURSOR` 的载荷常量（见 refresh_cursor）
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
    // 这两个在 rawinput.rs 里也声明了（那边不是 pub，所以这里再声明一份；
    // 不同模块各自声明同一个 Win32 符号是合法的，链接到同一个导入）
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn GetCurrentProcessId() -> u32;
    fn ShowCursor(show: i32) -> i32;
    fn SetCursor(cursor: isize) -> isize;
    fn LoadCursorW(hinst: isize, name: *const u16) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    fn CallWindowProcW(prev: isize, hwnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
}

/// ===== 方案 A：关掉 WebView2 的**浏览器加速键** =====
///
/// WebView2 默认 `AreBrowserAcceleratorKeysEnabled = true`，于是这些键会被浏览器抢走：
///   F3 -> 弹出"查找"（本项目里 F3 是调试面板 / F3+F4 游戏模式选择器的热键！）
///   Ctrl+F -> 查找栏、F5 -> 刷新、F12 -> DevTools、Ctrl+P -> 打印 ...
///
/// Tauri 2.11 **没有**暴露这个开关（`tauri-2.11.5/src` 里只有菜单的 accelerator，
/// 没有 `accelerator_keys`）。wry 有（`with_browser_accelerator_keys`，落到
/// `SetAreBrowserAcceleratorKeysEnabled(false)`），所以这里走 Tauri 官方的
/// `with_webview` 拿到 `ICoreWebView2Controller`，自己设一次。
///
/// 代价（知情同意）：**Ctrl+C / Ctrl+V / Ctrl+A 这类也一起关掉**。游戏里不需要它们。
/// 结果写进 logs\boot.log，方便确认到底设上没设上。
pub fn disable_browser_accelerator_keys(window: &WebviewWindow, log_root: std::path::PathBuf) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    // 闭包要 'static，所以 root 得 move 进去；外面这个 Err 分支还要用，先留一份。
    let root_for_outer_log = log_root.clone();
    match window.with_webview(move |webview| {
        // SAFETY: with_webview 保证这个回调跑在 webview 存活的时刻、且在正确的线程上。
        // Windows 上 `PlatformWebview::controller()` **直接返回** ICoreWebView2Controller
        // （不是裸指针 —— 那是 macOS 分支的签名）。
        let result = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings3| settings3.SetAreBrowserAcceleratorKeysEnabled(false))
                // **WebView2 自己的上下文菜单也要关**。它由**宿主**弹出（不是页面弹的），所以页面里
                // `contextmenu` 的 preventDefault 挡不住它；而它在菜单键 / Shift+F10 / 右键时会弹一个
                // 弹窗 —— Windows 会给弹窗一个**可见光标**，我们的 8ms 光标哨兵随即又把它按回隐藏，玩家
                // 看到的就是"鼠标闪一下"。游戏里右键是"放方块"，本来就不需要任何上下文菜单。
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
