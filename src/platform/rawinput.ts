// ===== Raw mouse input（原 NW.js 版是 rawinput.node 这个 NAPI 插件）=====
//
// 现在采集在 Rust 里（src-tauri/src/rawinput.rs，就是原 rawinput/src/lib.rs 那套
// HWND_MESSAGE 隐藏窗口 + RegisterRawInputDevices 的直译），搬运方向从"JS 每帧拉"变成
// "Rust 每 4ms 推一条 raw-input 事件"：
//
//   Rust 采集线程 -> AtomicI32 累加 -> 节流线程每 4ms swap+emit
//                                            ↓  Tauri 事件
//   这里的监听器：记诊断 + 把增量交给 `onDelta`  <- 前端
//                                            ↓
//   PlayerInputSystem.rawDelta()：接管/宽限/尖峰判定（事件期，rule 3），通过的部分累加
//                                            ↓
//   frame() 每帧一次 input.frameLook()：整帧位移变成**一个** look 意图
//
// **注意最后两步**：判定在事件期、应用在帧边界。中间**没有定时器**了 —— 原来那个 8ms
// `setInterval(…, 8)` 会被 Chromium 的输入任务优先级挤成 9~12ms 一档（按住键时尤其明显），
// 于是"每帧分到几份视角增量"在 0/1/2/3 之间乱跳，就是"按住键转视角不顺滑"的来源。
// 节流（4ms 合批）还是要的：WM_INPUT 一秒几百条，一条一个 IPC 事件会把 webview 淹掉。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { logDebug } from "./shell";

export interface RawInputHandle {
  /** Whether the plugin loaded (false = game runs normally, no raw-input fallback) */
  readonly available: boolean;
  /** 原始输入**到底**可用没有。
   *
   *  **必须 await 它再决定要不要走依赖原始输入的那条路**：`available` 要等
   *  `invoke("rawinput_start")` 落地才会变真，在那之前一直是 false。
   *  原版这里是同步 NAPI（`require("rawinput.node")`），`available` 当场就是真值，
   *  所以调用点可以直接读 —— Tauri 版有这个时间差，同步读会**永久**拿到 false。
   *  踩过的后果：`input.rawInputActive` 一直是 false，于是原生鼠标捕获永远不启用
   *  （退回 `requestPointerLock()`，又撞上 ESC 解锁 + 冷却），raw-input 视角接管也一起失效。
   *  resolve 的值就是可用性。 */
  readonly ready: Promise<boolean>;
}

/** Rust `rawinput_stats` 的形状 */
interface RawStats {
  available: boolean;
  wmInputTotal: number;
  ridFail: number;
  absoluteDropped: number;
  /** 方案 B 的 ESC 钩子装上没有 */
  escHook: boolean;
}

let available = false;

/** ===== 诊断（RAWLAG 行，每秒一行）：原始增量事件的**到达节奏**与**队列积压** =====
 *
 *  「按住键转视角不顺滑」要么是事件被丢/被量化，要么是事件在队列里压住了。这一行把两件事都量出来：
 *   * `gapMax`  —— 相邻两条事件的最大到达间隔。稳态应该是 ~4ms（Rust 每 4ms 推一次）；
 *                  如果按键期间它跳到几十毫秒、然后又连着来一串，那就是"堵塞 + 一次性冲出"。
 *   * `backlog` —— 事件在队列里压了多久。Rust 和 JS 的时钟原点不同，所以用**最小偏移做基线**：
 *                  offset = performance.now() - payload.t，全程最小值≈纯传输延迟；当前 offset 减掉它
 *                  就是"比最顺的时候多压了多久"。这就是积压毫秒数的直接测量。 */
let evCount = 0;
let gapMax = 0;
let lastArrive = 0;
let minOffset = Number.POSITIVE_INFINITY;
let backlogSum = 0;
let backlogMax = 0;
let lagAt = 0;

/** ===== 方案 B：被 Rust 钩子吞掉的 ESC =====
 *
 *  为什么 ESC 要从这里来而不是 DOM：ESC 是浏览器的"默认解锁手势"，由浏览器进程在把按键
 *  交给页面**之前**就处理掉了（`preventDefault()` 拦不住 —— 见 main.ts:725 那条注释引的 #7907，
 *  那个模型只在 NW.js 里成立）。所以 Rust 侧装了个 WH_KEYBOARD_LL 钩子把它**吞掉**，
 *  再从这儿推过来，我们**合成一个真的 KeyboardEvent** 派发到 document。
 *
 *  这样 input.ts 里发布 key edge 的监听器、main.ts 里 preventDefault 的监听器全都不用改，
 *  走的还是原来那条 KEY_EVENTS -> ui.navigation 的路。
 *  （游戏里所有 keydown/keyup 监听器都挂在 document 上，而且没有一处检查 isTrusted，
 *    所以合成事件能被正常接收。） */
function installEscBridge(): void {
  void listen<{ down: boolean; repeat: boolean }>("esc", (event) => {
    const { down, repeat } = event.payload;
    document.dispatchEvent(
      new KeyboardEvent(down ? "keydown" : "keyup", {
        code: "Escape",
        key: "Escape",
        repeat,
        bubbles: true,
      }),
    );
  });
}

/** 启动原始输入监听。`onDelta` 在**每一条**事件到达时被调用（Rust 每 4ms 推一块），
 *  由调用方（`PlayerInputSystem.rawDelta`）逐个做接管/宽限/尖峰判定并累加到本帧 ——
 *  视角的**应用**因此每帧恰好一次（见 `input.ts::frameLook`）。
 *
 *  **这里不再是"累积到自己人手里、等 8ms 定时器来 poll"**：那个定时器是"按住键转视角不顺滑"的
 *  元凶 —— Chromium 把按键这种输入任务排在定时器任务之前，按住键（自动重复 ~30 次/秒）会把
 *  8ms 的采样挤成 9~12ms 一档，每帧分到的份数在 0/1/2/3 之间乱跳（探针 `pf` 实测）。 */
export function startRawInput(onDelta: (dx: number, dy: number) => void): RawInputHandle {
  // 先挂监听器再启动采集：反过来的话最前面几毫秒的增量会丢
  void listen<{ dx: number; dy: number; t?: number }>("raw-input", (event) => {
    const now = performance.now();
    const { dx, dy } = event.payload;
    evCount++;
    if (lastArrive > 0) {
      const gap = now - lastArrive;
      if (gap > gapMax) gapMax = gap;
    }
    lastArrive = now;
    const t = event.payload.t;
    if (typeof t === "number") {
      const offset = now - t;
      if (offset < minOffset) minOffset = offset;
      const backlog = offset - minOffset;
      backlogSum += backlog;
      if (backlog > backlogMax) backlogMax = backlog;
    }
    onDelta(dx, dy);
  });
  installEscBridge();
  // 一次性探针（Rust 推送线程发的）：钩子到底有没有被调用（seen=0 就是没有），以及前台窗口是谁 ——
  // Rust 侧拿不到日志根目录（AppState.root 是私有的），所以走事件由这里写进 debug.log。
  void listen<string>("hook-probe", (event) => logDebug(String(event.payload)));
  // RAWMON：Rust 每秒报一次"这一秒谁在动"（emits / wmIn / cursorFix / hookSeen / 光标与捕获状态）
  void listen<string>("raw-mon", (event) => logDebug(String(event.payload)));

  const ready = invoke<RawStats>("rawinput_start")
    .then((stats) => {
      available = stats.available;
      if (stats.available) {
        logDebug("RAWINPUT listener started (Rust thread + raw-input events)");
      } else {
        logDebug("RAWINPUT unavailable (no raw-input fallback, game unaffected)");
      }
      logDebug(
        stats.escHook
          ? "ESC HOOK installed (原生吞掉 ESC -> 合成键盘事件；浏览器不会再解指针锁定)"
          : "ESC HOOK NOT installed (失败即放行：ESC 退回浏览器行为——第一次解锁，第二次才到页面)",
      );
      return stats.available;
    })
    .catch((e) => {
      // 加载失败不影响游戏：鼠标走普通的 mousemove 那条路
      logDebug(`RAWINPUT start failed (no raw-input fallback, game unaffected): ${String(e)}`);
      return false;
    });

  return {
    get available() {
      return available;
    },
    ready,
  };
}

/** 每秒一行 RAWLAG 的诊断文本（调用方 = 帧探针，负责写进 debug.log）；不足一秒返回 null。
 *  原来这一行是在 8ms 的 poll() 里打的，而那个定时器已经删掉了（见 startRawInput 的说明）。 */
export function rawLagLine(): string | null {
  const now = performance.now();
  if (lagAt === 0) {
    lagAt = now;
    return null;
  }
  if (now - lagAt < 1000) return null;
  const line =
    `RAWLAG ev=${evCount}/s gapMax=${gapMax.toFixed(1)}ms ` +
    `backlogAvg=${(evCount > 0 ? backlogSum / evCount : 0).toFixed(2)}ms backlogMax=${backlogMax.toFixed(1)}ms`;
  lagAt = now;
  evCount = 0;
  gapMax = 0;
  backlogSum = 0;
  backlogMax = 0;
  return line;
}

/** 诊断：WM_INPUT 收到了多少条、丢了多少绝对坐标事件（F3 面板上能看出原始输入到底有没有在跑） */
export function rawInputStats(): Promise<RawStats> {
  return invoke<RawStats>("rawinput_stats");
}

/** Center the cursor on the window center（原版走插件的 in-process SetCursorPos）。
 *  这里 Rust 直接从 Tauri 拿窗口几何再 SetCursorPos，坐标根本不用绕到 JS 来。 */
export function centerCursor(): void {
  void invoke("center_cursor").catch(() => {});
}
