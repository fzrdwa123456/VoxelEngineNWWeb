// ===== What the PLAYER plugin PUBLISHES to the composition root (P1.18b) =====
// The same reverse direction as `render-handles.ts` (P1.45), for the same reason: `PluginHost.instances` goes
// ONE WAY (root -> plugin), while the composition root DRIVES the player's input system by hand — the raw-input
// device thread feeds it (`rawDelta`/`rawButtons`), the mouse-capture manager holds it (`lock`), the frame loop
// drains its look meter (`takeLookFrameMeter`/`frameLook`), `ui.navigation` calls `prepareUnlock` /
// `releaseCapture`, and the win-focus handlers read `locked` and set `rawInputActive`.
//
// The plugin constructs that ONE instance; this resource is how the root reaches it. A second instance would
// drive nothing (no listener would be attached to it), which is exactly the bug this shape prevents.
//
// Typed STRUCTURALLY, like every resource in `data/globals` (a data module may not import a plugin type) and
// deliberately narrow: only the members the root and the mouse-capture manager actually touch.
import { defineResource, type Resource } from "../../core/world";

/** The player input system, as its outside callers see it. */
export interface PlayerInputHandles {
  /** Is the native capture open? (log lines and the frame probe read it) */
  readonly locked: boolean;
  /** Set once the raw-input device reports whether it came up (see the note in `boot/main.ts`). */
  rawInputActive: boolean;
  /** Give the mouse back to the OS and stop feeding view deltas. */
  prepareUnlock(): void;
  /** Drop the capture with no side effects (the modal-UI path). */
  releaseCapture(): void;
  /** The native mutex the mouse-capture manager takes. */
  lock(): Promise<void> | undefined;
  /** Raw deltas, straight from the device thread's packets. */
  rawDelta(dx: number, dy: number): void;
  /** The button edges of the same packets (P1.76). */
  rawButtons(down: number, up: number): void;
  /** Queue the accumulated raw look as ONE intent — called once per frame by the loop. */
  frameLook(): void;
  /** The per-frame look meter the PHYS/FRAME log line prints. */
  takeLookFrameMeter(): { samples: number; px: number };
}

export interface PlayerHandles {
  readonly input: PlayerInputHandles;
}

export const PLAYER_HANDLES: Resource<PlayerHandles> = defineResource<PlayerHandles>("playerHandles");
