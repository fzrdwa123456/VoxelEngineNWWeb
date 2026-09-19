// ===== Raw mouse input（原 NW.js 版是 rawinput.node 这个 NAPI 插件）=====
//
// 现在采集在 Rust 里（src-tauri/src/rawinput.rs，就是原 rawinput/src/lib.rs 那套
// HWND_MESSAGE 隐藏窗口 + RegisterRawInputDevices 的直译），搬运方向从"JS 每帧拉"变成
// "Rust 每 4ms 推一条 raw-input 事件"：
//
//   Rust 采集线程 -> AtomicI32 累加 -> 节流线程每 4ms swap+emit
//                                            ↓  Tauri 事件
//   这里的监听器累加进本地 accDx/accDy  <- 前端
//                                            ↓
//   poll() 同步取走并清零（调用点一行没改）
//
// 语义没变：都是"按帧批量消费相对增量"。节流是必要的，WM_INPUT 一秒上百条，
// 一条一个 IPC 事件会把 webview 淹掉。
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
  /** Take the accumulated delta and reset it */
  poll(): { dx: number; dy: number };
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

let accDx = 0;
let accDy = 0;
let available = false;

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

export function startRawInput(): RawInputHandle {
  // 先挂监听器再启动采集：反过来的话最前面几毫秒的增量会丢
  void listen<{ dx: number; dy: number }>("raw-input", (event) => {
    accDx += event.payload.dx;
    accDy += event.payload.dy;
  });
  installEscBridge();

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
    poll: () => {
      const out = { dx: accDx, dy: accDy };
      accDx = 0;
      accDy = 0;
      return out;
    },
  };
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
