// ===== Native mouse capture (**not through the Pointer Lock API**) =====
//
// Why not the browser's pointer lock: the ESC unlock is a **browser security policy**, handled by the
// browser process **before** the key is handed to the page (ForwardKeyboardEvent ->
// PreHandleKeyboardEvent in `content/browser/renderer_host/render_widget_host_impl.cc`; at the Chrome
// layer `chrome/browser/ui/exclusive_access/exclusive_access_manager.cc:196` looks only at the keycode
// and never checks whether the page called preventDefault). And after unlocking it **refuses to re-lock**
// for a while — the `kUserEscapeCooldown` in Blink (`pointer_lock_controller.cc:273-277`):
//   "Pointer lock cannot be acquired immediately after the user has exited the lock."
// The page has no say in it, and Tauri/WebView2 exposes no switch either. NW.js could solve it back then
// because it shipped its own patched Chromium.
//
// So this goes through Win32 instead (the Rust side's `win.rs::set_mouse_capture`):
//   ClipCursor(client area) + SetCursorPos(center)
// Hiding the cursor is still CSS's job (`pointerlock.applyCursor()`'s `cursor: none`) — the cursor is
// clamped inside the client area and therefore necessarily lands on the webview, so CSS suffices and
// there is no need to hook WM_SETCURSOR.
//
// The view rotation comes from raw input (while captured, `movementX` goes to zero once the cursor
// reaches an edge, see the note in input.ts).
//
// **Failure means fall back**: when the native command fails (or returns false) it falls back to
// `requestPointerLock()`, because returning to the browser's old behaviour is preferable to leaving the
// mouse completely out of control.
import { invoke } from "@tauri-apps/api/core";

import { logDebug } from "./shell";

/** Turn native capture on. Resolves on success; on failure it **falls back** to the browser's
 *  requestPointerLock. */
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

/** Release: turn the native capture off and, as a backstop, drop the browser's lock too (both paths are
 *  idempotent) */
export function releaseMouse(): void {
  void invoke<boolean>("mouse_capture", { on: false }).catch(() => {});
  if (typeof document !== "undefined" && document.pointerLockElement) {
    document.exitPointerLock();
  }
}
