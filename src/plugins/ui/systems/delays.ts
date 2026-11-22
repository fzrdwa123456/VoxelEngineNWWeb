// ===== The delayed intents, applied on the tick =====
// `setTimeout` was the only way four places could say "in a moment", and each one owned a timer the
// schedule could not see:
//
//   1. closing the BACKPACK relocked the mouse on the next event-loop turn (ui.navigation's `relockSoon`)
//   2. the lock manager retried a REJECTED lock after 1300 ms (platform/pointerlock.ts)
//   3. `reapplyCursor()` re-asserted the cursor at 0 and 120 ms after the window regained focus
//   4. the menu/Apps key (and Shift+F10) re-asserted it at the next frame plus 0/32/80 ms
//      (platform/window-guards.ts) — the layer that wins the "the system reveals the cursor, we hide it
//      again" race, and therefore the one place a missed deadline is VISIBLE to the player
//
// The DEADLINE is a resource now (ecs/resources.ts::DELAYED_INTENTS) and this system applies whatever is
// due, once per frame. Two consequences, both deliberate:
//
//   * a delay survives a paused game — it is a wall-clock comparison, not a frame counter, exactly like
//     the toast (the ui lane runs with dt = 0 while the menu pumps it, so a counter would never expire);
//   * "when does this happen" is DATA: one debug line per applied intent instead of a timer nobody can
//     enumerate, and the gate can drive the clock instead of sleeping through it.
//
// The EFFECTS stay injected (the composition root's — the same shape ui.navigation uses for its
// pointer-lock effects), so this module imports no platform code and touches no DOM of its own: it decides
// WHEN, the deps know HOW.
import type { DelayedIntents } from "../../../data/globals/resources";
import { DELAYED_INTENTS } from "../../../data/globals/resources";
import type { SystemAccess, World } from "../../../core/world";

export interface DelaySystemDeps {
  /** Capture the mouse again (platform/pointerlock.ts::relock). The reason string is the requester's. */
  readonly relock: (reason: string) => void;
  /** Retry a lock the platform REJECTED (pointerlock.ts::retry) — armed by the lock manager itself. */
  readonly lockRetry: (reason: string) => void;
  /** Write the cursor state again (pointerlock.ts::applyCursor). */
  readonly cursor: () => void;
  readonly log?: (line: string) => void;
}

/** It produces NO component data, so its declaration is only about the external targets it writes — and
 *  those are `ui.navigation`'s two (`pointerLock`, `cursor`), which is what FORCES the order between them:
 *  the schedule refuses two systems in a stage that write the same target with no declared edge. */
export const DELAYS_ACCESS: SystemAccess = {
  writesExternal: ["pointerLock", "cursor"],
};

export class DelaySystem {
  private readonly queue: DelayedIntents;

  constructor(
    world: World,
    private readonly deps: DelaySystemDeps,
  ) {
    this.queue = world.resource(DELAYED_INTENTS);
  }

  /** How many intents this system has applied (diagnostics / the Node gate). It is a field of the QUEUE
   *  resource (DELAYED_INTENTS.applied) — the counter belongs with the deadlines it counts. */
  get appliedCount(): number {
    return this.queue.applied;
  }

  get pendingCount(): number {
    return this.queue.pending;
  }

  step(): void {
    for (const intent of this.queue.takeDue()) {
      this.queue.applied++;
      switch (intent.kind) {
        case "relock":
          this.deps.relock(intent.arg);
          break;
        case "lockRetry":
          // The one that gets a line: it means the platform refused a lock, which is the interesting case.
          this.deps.log?.(`DELAY lockRetry [${intent.arg}]`);
          this.deps.lockRetry(intent.arg);
          break;
        case "cursor":
          this.deps.cursor();
          break;
      }
    }
  }
}
