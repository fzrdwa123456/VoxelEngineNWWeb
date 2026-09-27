// ===== Native mouse capture (**not through the Pointer Lock API**) =====
//
// Why not the browser's pointer lock: the ESC unlock is a **browser security policy**, handled by the
// browser process **before** the key is handed to the page (ForwardKeyboardEvent ->
// PreHandleKeyboardEvent in `content/browser/renderer_host/render_widget_host_impl.cc`; at the Chrome
// layer `chrome/browser/ui/exclusive_access/exclusive_access_manager.cc:196` looks only at the keycode
// and never checks whether the page called preventDefault). And after unlocking it **refuses to re-lock**
// for a while — the `kUserEscapeCooldown` in Blink (`pointer_lock_controller.cc:273-277`):
//   "Pointer lock cannot be acquired immediately after the user has exited the lock."
// The W3C spec makes both of those requirements rather than implementation details ("a default unlock
// gesture must always be available… the ESC key is recommended"; a re-lock after an escape needs fresh
// user activation), it exits the lock on its own whenever the window loses focus, and on exit it puts the
// cursor back **where it was when the lock was entered** — so the "the menu's cursor lands on the
// crosshair" behaviour this engine wants cannot be built on it at all.
//
// So this goes through Win32 instead (the Rust side's `win.rs::set_mouse_capture`):
//   ClipCursor(client area) + SetCursor(NULL)
// Hiding the cursor is still CSS's job (`pointerlock.applyCursor()`'s `cursor: none`) — the cursor is
// clamped inside the client area and therefore necessarily lands on the webview, so CSS suffices and
// there is no need to hook WM_SETCURSOR.
//
// The view rotation comes from raw input (`RIDEV_INPUTSINK`, so the pointer's position — clamped or not —
// never matters). This is Minecraft's mechanism, ported: SDL's `SDL_SetWindowRelativeMouseMode` is
// literally `WIN_SetRawMouseEnabled` on Windows, and MC never touches the OS cursor while it holds the
// mouse.
//
// **There is NO fallback to `requestPointerLock` (P1.72).** A failure is reported as a failure: the mouse
// stays free and the reason is logged. Silently switching mechanism would put the engine back on the
// browser's policy (ESC unlock + cooldown + focus-loss unlock) without anyone asking for it — and without
// raw input a capture would hide and clip the cursor for a view that cannot turn.
import { invoke } from "@tauri-apps/api/core";

import { logDebug } from "../desktop/shell";

/** Turn native capture on. Resolves on success, **rejects** when the platform refused it (the caller
 *  reports that; the mouse simply stays free). */
export function captureMouse(_dom: HTMLElement): Promise<void> {
  return invoke<boolean>("mouse_capture", { on: true }).then((ok) => {
    if (!ok) {
      logDebug("MOUSE CAPTURE native refused (no pointer-lock fallback by design, P1.72)");
      throw new Error("native mouse capture refused");
    }
  });
}

/** Release: turn the native capture off. Idempotent — the Rust side treats a release it does not hold as
 *  a no-op. */
export function releaseMouse(): void {
  void invoke<boolean>("mouse_capture", { on: false }).catch(() => {});
}
