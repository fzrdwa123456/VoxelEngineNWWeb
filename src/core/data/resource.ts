// ===== Resources: world-scoped singletons, typed by a handle =====
// Anything there is exactly ONE of and that is not per-entity data: the time step, the input
// device state, the voxel world, the local player's entity handle. Resources are how a system
// gets at shared state WITHOUT importing another system — which is the whole point, since systems
// must not import each other.
//
// The handle is a typed token, so `world.resource(TIME)` is checked at compile time, and the
// value is resolved at `world.start()` time rather than at module load.

export interface Resource<T> {
  readonly name: string;
  /** phantom type carrier (never read at runtime) */
  readonly _type?: T;
}

export function defineResource<T>(name: string): Resource<T> {
  return { name };
}
