// ===== Position snapshot system: freeze last tick's settled position =====
// Fixed lane, registered FIRST — before anything moves.
//
// PREV_POSITION has two consumers, and BOTH are wrong if it goes stale:
//   - the render interpolation lerps PREV_POSITION -> POSITION across exactly one physics tick;
//   - collision uses it as the SWEEP ORIGIN, replaying this tick's displacement in sub-steps.
//
// It used to be written by the CAMERA system, for the local player's row only. That made the
// collision sweep silently wrong for any other entity: the origin stayed at the spawn point, so
// every tick re-resolved the whole spawn->current line — O(distance) sub-steps per tick, colliding
// with blocks the entity had already passed, and quadratic total work. The fix is the query below:
// this is data that belongs to EVERY entity with a previous position, not to whoever owns a camera.
//
// The matching half of the fix is in collision.ts: PREV_POSITION is part of its query, so an entity
// that lacks one is not swept at all (it falls through the world — loud and obvious) instead of
// being swept from a bogus origin (it jitters and lags — quiet and baffling).
import { POSITION, PREV_POSITION } from "../components/Player";
import type { SystemAccess, World } from "../World";

/** Declared access: the schedule uses it to order and batch. Independent of `player.controller`
 *  (different components), which is what puts the two in one batch. */
export const SNAPSHOT_ACCESS: SystemAccess = {
  reads: [POSITION],
  writes: [PREV_POSITION],
};

export class PositionSnapshotSystem {
  constructor(private readonly world: World) {}

  step(): void {
    const rows = this.world.query(POSITION, PREV_POSITION).indices;
    for (let row = 0; row < rows.length; row++) {
      const index = rows[row];
      PREV_POSITION.x[index] = POSITION.x[index];
      PREV_POSITION.y[index] = POSITION.y[index];
      PREV_POSITION.z[index] = POSITION.z[index];
    }
  }
}
