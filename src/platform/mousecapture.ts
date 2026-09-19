// ===== 原生鼠标捕获（**不走 Pointer Lock API**）=====
//
// 为什么不用浏览器的指针锁定：ESC 解锁是**浏览器的安全策略**，由浏览器进程在把按键交给页面
// **之前**处理（`content/browser/renderer_host/render_widget_host_impl.cc` 的
// ForwardKeyboardEvent -> PreHandleKeyboardEvent；Chrome 层
// `chrome/browser/ui/exclusive_access/exclusive_access_manager.cc:196` 只看 keycode，
// 从不查页面有没有 preventDefault）。而且解锁之后有一段时间**拒绝重新锁定** ——
// Blink 里那条 `kUserEscapeCooldown`（`pointer_lock_controller.cc:273-277`）：
//   "Pointer lock cannot be acquired immediately after the user has exited the lock."
// 页面无权关闭，Tauri/WebView2 也没暴露开关。NW.js 当年能解决是因为它自带一份打过补丁的 Chromium。
//
// 所以改走 Win32（Rust 侧 `win.rs::set_mouse_capture`）：
//   ClipCursor(客户区) + SetCursorPos(中心)
// 光标隐藏仍然由 CSS 负责（`pointerlock.applyCursor()` 的 `cursor: none`）——
// 光标被夹在客户区内，必然落在 webview 上，CSS 就够，不用去 hook WM_SETCURSOR。
//
// 视角旋转由 raw input 提供（捕获期间 `movementX` 会在光标贴边时归零，见 input.ts 的说明）。
//
// **失败即退回**：原生命令失败（或返回 false）时回退到 `requestPointerLock()`，
// 宁可回到浏览器的老行为，也不能让鼠标完全失控。
import { invoke } from "@tauri-apps/api/core";

import { logDebug } from "./shell";

/** 打开原生捕获。成功 resolve；失败时**回退**到浏览器的 requestPointerLock。 */
export function captureMouse(dom: HTMLElement): Promise<void> {
  return invoke<boolean>("mouse_capture", { on: true })
    .then((ok) => {
      if (ok) return;
      logDebug("MOUSE CAPTURE native refused, falling back to requestPointerLock");
      return dom.requestPointerLock() as unknown as Promise<void>;
    })
    .catch((err) => {
      logDebug(`MOUSE CAPTURE native failed (${String(err)}), falling back to requestPointerLock`);
      return dom.requestPointerLock() as unknown as Promise<void>;
    });
}

/** 释放：原生关掉，同时兜底把浏览器的锁也放掉（两条路都幂等） */
export function releaseMouse(): void {
  void invoke<boolean>("mouse_capture", { on: false }).catch(() => {});
  if (typeof document !== "undefined" && document.pointerLockElement) {
    document.exitPointerLock();
  }
}
