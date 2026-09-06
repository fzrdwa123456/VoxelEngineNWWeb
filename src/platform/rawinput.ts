// ===== Raw mouse input (wrapper over the Rust native plugin) =====
// Loads game\core\rawinput.node (source in rawinput/, cargo build --release artifact):
// a background-thread HWND_MESSAGE window + RegisterRawInputDevices(INPUTSINK) collects WM_INPUT,
// atomically accumulates relative deltas; JS polls pollDelta() to take and reset them.
// Gating for view rotation lives inside PlayerInputSystem.applyRawInput:
// applied only when pointer lock was cancelled by Chromium and the window is partially offscreen (free-mouse mode),
// discarded when locked/in menus, avoiding double counting with movementX or rotating the view behind menus.
import { sendLog } from "./shell";

interface RawMouseNative {
  pollDelta(): { dx: number; dy: number };
    /** Set the system cursor's screen position (in-process direct call, replaces the old cursor.exe subprocess) */
  setCursorPos?(x: number, y: number): boolean;
}

const req = eval("require") as (id: string) => any;
const nodePath = req("node:path");

export interface RawInputHandle {
    /** Whether the plugin loaded (false = game runs normally, no raw-input fallback) */
  available: boolean;
    /** Take the accumulated delta and reset it */
  poll(): { dx: number; dy: number };
}

let nativeListener: RawMouseNative | null = null;
// Module note: set_cursor_pos is a module-level export (alongside the RawMouseListener class), not on the instance
let nativeModule: { setCursorPos?(x: number, y: number): boolean } | null = null;

export function startRawInput(): RawInputHandle {
  try {
        // process.execPath = game\core\core.exe -> rawinput.node in the same directory
    const coreDir = nodePath.dirname(process.execPath);
    const mod = req(nodePath.join(coreDir, "rawinput.node"));
    nativeListener = new mod.RawMouseListener();
    nativeModule = mod;
        sendLog("RAWINPUT plugin loaded, raw input listener started");
    return {
      available: true,
      poll: () => nativeListener!.pollDelta(),
    };
  } catch (e) {
        sendLog(`RAWINPUT load failed (no raw-input fallback, game unaffected): ${String(e)}`);
    return { available: false, poll: () => ({ dx: 0, dy: 0 }) };
  }
}

// Center the cursor on the window center (screen coords): the cursor lands on the crosshair when menus/inventory open.
// Prefers the plugin's in-process direct call (~microseconds); the old cursor.exe subprocess is retired, source kept in launcher/cursor.c
// (re-enabling requires restoring npm run build:cursor and uncommenting below)
export function centerCursor(): void {
  try {
    const win = (globalThis as any).nw.Window.get();
    const cx = Math.round(win.x + win.width / 2);
    const cy = Math.round(win.y + win.height / 2);
    if (nativeModule?.setCursorPos?.(cx, cy)) return;
    // const { execFile } = req("node:child_process");
    // execFile(nodePath.join(coreDir, "cursor.exe"), [String(cx), String(cy)], () => {});
  } catch {}
}
