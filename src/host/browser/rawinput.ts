// ===== Raw mouse input (the NW.js version used the rawinput.node NAPI plugin) =====
//
// Collection now happens in Rust (src-tauri/src/rawinput.rs, a direct translation of the original
// rawinput/src/lib.rs — that HWND_MESSAGE hidden window + RegisterRawInputDevices), and the direction of
// travel changed from "JS pulls every frame" to "Rust pushes one raw-input event every 4ms":
//
//   Rust collector thread -> AtomicI32 accumulate -> throttle thread swap+emits every 4ms
//                                            ↓  Tauri event
//   the listener here: record diagnostics + hand the delta to `onDelta`  <- front end
//                                            ↓
//   PlayerInputSystem.rawDelta(): takeover/grace/spike decision (event time, rule 3); the rest accumulates
//                                            ↓
//   frame() calls input.frameLook() once per frame: the frame's displacement becomes **one** look intent
//
// **Note the last two steps**: the decision happens at event time, the application at a frame boundary.
// There is **no timer** in between any more — the old 8ms `setInterval(…, 8)` was squeezed by Chromium's
// input-task priority into 9~12ms buckets (most obvious while a key is held), so "how many view deltas
// this frame gets" jumped between 0/1/2/3, which is exactly where "the view is not smooth while a key is
// held" came from. Throttling (4ms batching) is still needed: WM_INPUT is several hundred a second and
// one IPC event each would drown the webview.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { RawTransportCounters } from "../../data/globals/resources";
import { logDebug } from "../desktop/shell";

export interface RawInputHandle {
  /** Whether the plugin loaded (false = game runs normally, no raw-input fallback) */
  readonly available: boolean;
  /** Whether raw input is **actually** available.
   *
   *  **You MUST await it before deciding whether to take the path that depends on raw input**:
   *  `available` only turns true once `invoke("rawinput_start")` has landed, and is false until then.
   *  The original was synchronous NAPI here (`require("rawinput.node")`), so `available` was the real
   *  value on the spot and a call site could read it directly — the Tauri version has that time gap, and
   *  reading it synchronously gets false **permanently**. The consequence that was hit:
   *  `input.rawInputActive` stayed false, so native mouse capture was never enabled (falling back to
   *  `requestPointerLock()`, which runs into the ESC unlock + cooldown again), and the raw-input view
   *  takeover failed along with it. The resolved value IS the availability. */
  readonly ready: Promise<boolean>;
}

/** The shape of Rust's `rawinput_stats` */
interface RawStats {
  available: boolean;
  wmInputTotal: number;
  ridFail: number;
  absoluteDropped: number;
  /** Whether plan B's ESC hook is installed */
  escHook: boolean;
}

let available = false;

/** ===== Diagnostics (the RAWLAG line, one per second): the raw delta events' **arrival rhythm** and
 *  their **queue backlog** =====
 *
 *  "the view is not smooth while a key is held" is either events being dropped/quantised, or events
 *  being stuck in a queue. This line measures both:
 *   * `gapMax`  — the largest arrival gap between two adjacent events. At steady state it should be
 *                 ~4ms (Rust pushes once every 4ms); if it jumps to tens of milliseconds while a key is
 *                 held and is then followed by a burst of events, that is "a jam + one big flush".
 *   * `backlog` — how long an event sat in the queue. Rust and JS have different clock origins, so the
 *                 **minimum offset is the baseline**: offset = performance.now() - payload.t, whose
 *                 running minimum ≈ the pure transport delay; the current offset minus that is "how much
 *                 longer it was held than in the smoothest case". That is a direct measurement of the
 *                 backlog in milliseconds.
 *
 *  THE COUNTERS ARE A RESOURCE now (`InputDiagnostics.raw`, ecs/resources.ts): the object is handed to
 *  `startRawInput` by the composition root, and the input system formats the line once a second — so this
 *  module keeps no state of its own and no longer writes to the log. */

/** ===== Plan B: the ESC that Rust's hook swallows =====
 *
 *  Why ESC has to come from here rather than the DOM: ESC is the browser's "default unlock gesture",
 *  handled by the browser process **before** the key is handed to the page (`preventDefault()` cannot
 *  stop it — see #7907, cited by the comment at main.ts:725; that model only holds in NW.js). So the
 *  Rust side installs a WH_KEYBOARD_LL hook that **swallows** it and pushes it over from here, and we
 *  **synthesise a real KeyboardEvent** and dispatch it on document.
 *
 *  That way neither the listener in input.ts that publishes the key edge nor the preventDefault listener
 *  in main.ts changes, and the route is still the original one: KEY_EVENTS -> ui.navigation.
 *  (Every keydown/keyup listener in the game hangs off document and not one of them checks isTrusted, so
 *    a synthetic event is accepted normally.) */
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

/** Start the raw-input listener. `onDelta` is called on **every** event that arrives (Rust pushes one
 *  block every 4ms), and the caller (`PlayerInputSystem.rawDelta`) does the takeover/grace/spike decision
 *  on each one and accumulates into this frame — so the view is **applied** exactly once per frame (see
 *  `input.ts::frameLook`).
 *
 *  **This is no longer "accumulate into our own hands and wait for an 8ms timer to poll"**: that timer
 *  was the culprit behind "the view is not smooth while a key is held" — Chromium schedules key input
 *  tasks ahead of timer tasks, so holding a key (auto-repeat ~30/s) squeezed the 8ms sampling into
 *  9~12ms buckets and the sample count per frame jumped between 0/1/2/3 (measured with the `pf` probe).
 *
 *  `raw` is the `InputDiagnostics.raw` counter object (a RESOURCE): this listener is its only writer and
 *  the input system prints it once a second, so the counters have an owner and this module keeps none. */
export function startRawInput(
  onDelta: (dx: number, dy: number) => void,
  raw: RawTransportCounters,
): RawInputHandle {
  // Install the listener before starting collection: the other order loses the first few milliseconds of
  // deltas
  void listen<{ dx: number; dy: number; t?: number }>("raw-input", (event) => {
    const now = performance.now();
    const { dx, dy } = event.payload;
    raw.evCount++;
    if (raw.lastArrive > 0) {
      const gap = now - raw.lastArrive;
      if (gap > raw.gapMax) raw.gapMax = gap;
    }
    raw.lastArrive = now;
    const t = event.payload.t;
    if (typeof t === "number") {
      const offset = now - t;
      if (offset < raw.minOffset) raw.minOffset = offset;
      const backlog = offset - raw.minOffset;
      raw.backlogSum += backlog;
      if (backlog > raw.backlogMax) raw.backlogMax = backlog;
    }
    onDelta(dx, dy);
  });
  installEscBridge();
  // A one-off probe (sent by Rust's push thread): whether the hook is ever called at all (seen=0 means
  // no), and who the foreground window is — the Rust side cannot reach the log root (AppState.root is
  // private), so it comes as an event and is written into debug.log here.
  void listen<string>("hook-probe", (event) => logDebug(String(event.payload)));
  // RAWMON: Rust reports once a second "who moved during this second" (emits / wmIn / cursorFix /
  // hookSeen / cursor and capture state)
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
          ? "ESC HOOK installed (ESC is swallowed natively -> a synthetic key event; the browser can no longer release pointer lock)"
          : "ESC HOOK NOT installed (fail open: ESC falls back to the browser behaviour - the first press unlocks, only the second reaches the page)",
      );
      return stats.available;
    })
    .catch((e) => {
      // A load failure does not affect the game: the mouse takes the ordinary mousemove path
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

/** Diagnostics: how many WM_INPUT events arrived and how many absolute-coordinate events were dropped
 *  (the F3 panel shows whether raw input is really running) */
export function rawInputStats(): Promise<RawStats> {
  return invoke<RawStats>("rawinput_stats");
}

/** Center the cursor on the window center (the original went through the plugin's in-process
 *  SetCursorPos). Here Rust takes the window geometry straight from Tauri and then calls SetCursorPos,
 *  so the coordinates never have to make a detour into JS. */
export function centerCursor(): void {
  void invoke("center_cursor").catch(() => {});
}
