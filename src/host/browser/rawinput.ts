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
  /** Whether the low-level context-menu hook is installed */
  menuHook: boolean;
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
 *  the input system prints it once a second, so the counters have an owner and this module keeps none.
 *
 *  **`onButtons` is the second channel of the same packets (P1.76)**: the raw mouse stream carries the button
 *  edges as well (`usButtonFlags`), and they arrive even when the click was DISPATCHED to another window (a
 *  shell overlay on top, e.g. Win+;), which is the one thing the DOM's `mousedown` cannot do. The two bitmasks
 *  are decoded by `input.ts::rawButtons`, which is also where the DOM path is switched off so a click can
 *  never be counted twice. */
export function startRawInput(
  onDelta: (dx: number, dy: number) => void,
  onButtons: (down: number, up: number) => void,
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
  // **Raw BUTTON edges (P1.76)**: same packets, second channel. They are pushed on their own event so a click
  // that does not move the mouse still arrives, and they are device-level — the click may have been
  // dispatched to a shell overlay and we still see it (see the header note).
  void listen<{ down: number; up: number }>("raw-buttons", (event) => {
    onButtons(event.payload.down, event.payload.up);
  });
  // A one-off probe (sent by Rust's push thread): whether the low-level context-menu hook is ever called
  // (seen=0 means no), and who the foreground window is — the Rust side cannot reach the log root
  // (AppState.root is private), so it comes as an event and is written into debug.log here.
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
        // **This is now a hard requirement for playing, not a degradation (P1.72).** The view comes from
        // WM_INPUT; without it a capture would hide and clip the cursor for a view that cannot turn, so
        // `input.lock()` refuses to capture at all. There is deliberately no pointer-lock fallback.
        logDebug("RAWINPUT unavailable -> the mouse CANNOT be captured (no pointer-lock fallback, P1.72)");
      }
      logDebug(
        stats.menuHook
          ? "MENU HOOK installed (the menu key / Shift+F10 are swallowed natively, so Windows never flashes the cursor)"
          : "MENU HOOK NOT installed (fail open: the menu key may reveal the cursor for a frame)",
      );
      return stats.available;
    })
    .catch((e) => {
      // A load failure does not affect the menus; it does mean the mouse cannot be captured.
      logDebug(`RAWINPUT start failed (the mouse cannot be captured): ${String(e)}`);
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

