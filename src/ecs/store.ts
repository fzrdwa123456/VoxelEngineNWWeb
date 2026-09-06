// ===== Entity store: bare-id entities, lifecycle, typed component storage, queries =====
// The pure-ECS half of the ecs/ layer: entities are bare numeric ids (never classes),
// components are plain data records stored per component key, systems find their subjects
// through queries. The hand-rolled Player (components/Player.ts) deliberately stays outside —
// it is the one special entity with class semantics; this store is for the many
// (NPCs, projectiles, pickups, ...). Owned by the World as `world.entities`.
//
// Typical use inside a system:
//   const VELOCITY = componentKey<{ vx: number; vy: number }>("velocity");
//   const id = world.entities.spawn();
//   world.entities.add(id, VELOCITY, { vx: 1, vy: 0 });
//   for (const id of world.entities.query(VELOCITY)) { ... world.entities.get(id, VELOCITY) ... }

export type EntityId = number;

/** Typed component key: `componentKey<T>("name")` — the phantom type makes add/get/query type-safe
 *  while the store itself stays a plain string-keyed map (zero per-component class machinery). */
export interface ComponentKey<T> {
  readonly id: string;
  /** phantom type carrier (never read at runtime) */
  readonly _type?: T;
}

export function componentKey<T>(id: string): ComponentKey<T> {
  return { id };
}

export class EntityStore {
  private nextId: EntityId = 1;
  private readonly alive = new Set<EntityId>();
  /** component key id -> (entity id -> data) */
  private readonly stores = new Map<string, Map<EntityId, unknown>>();

  /** Create a live entity: a bare id. Attach data with add() — an entity with no components is valid. */
  spawn(): EntityId {
    const id = this.nextId++;
    this.alive.add(id);
    return id;
  }

  /** Destroy an entity and drop all of its components.
   *  Immediate (queries return snapshot arrays, so despawning mid-iteration is safe). */
  despawn(id: EntityId): void {
    this.alive.delete(id);
    for (const m of this.stores.values()) m.delete(id);
  }

  isAlive(id: EntityId): boolean {
    return this.alive.has(id);
  }

  /** Number of live entities */
  get aliveCount(): number {
    return this.alive.size;
  }

  /** Attach a component record on an entity.
   *  Throws on a dead id (adding to a despawned entity would leak orphaned data) and on a
   *  duplicate (the entity already owns this component type). The duplicate guard enforces
   *  the engine-wide invariant: records are created once at spawn and mutated IN PLACE —
   *  systems cache the references, so replacing a record would silently desync every reader. */
  add<T>(id: EntityId, key: ComponentKey<T>, data: T): void {
    if (!this.alive.has(id)) {
      throw new Error(`EntityStore.add on dead entity ${id} (component "${key.id}") — spawn it first`);
    }
    let m = this.stores.get(key.id);
    if (!m) {
      m = new Map();
      this.stores.set(key.id, m);
    }
    if (m.has(id)) {
      throw new Error(
        `EntityStore.add duplicate component "${key.id}" on entity ${id} — mutate the existing record in place instead of replacing it`,
      );
    }
    m.set(id, data);
  }

  /** Read an entity's component record (undefined when absent) */
  get<T>(id: EntityId, key: ComponentKey<T>): T | undefined {
    return this.stores.get(key.id)?.get(id) as T | undefined;
  }

  /** Detach one component (returns whether it was present); the entity stays alive */
  remove(id: EntityId, key: ComponentKey<unknown>): boolean {
    const m = this.stores.get(key.id);
    if (!m) return false;
    const had = m.delete(id);
    if (m.size === 0) this.stores.delete(key.id);
    return had;
  }

  has(id: EntityId, key: ComponentKey<unknown>): boolean {
    return this.stores.get(key.id)?.has(id) ?? false;
  }

  /** All live entities owning ALL of the given component keys.
   *  Returns a snapshot array (safe to despawn/add while iterating).
   *  Iterate the smallest candidate store first — query cost scales with the rarest component. */
  query(...keys: ReadonlyArray<ComponentKey<unknown>>): EntityId[] {
    if (keys.length === 0) return [...this.alive];
    const maps: Array<Map<EntityId, unknown>> = [];
    for (const k of keys) {
      const m = this.stores.get(k.id);
      if (!m || m.size === 0) return []; // some component exists nowhere -> no match
      maps.push(m);
    }
    maps.sort((a, b) => a.size - b.size);
    const [smallest, ...rest] = maps;
    const out: EntityId[] = [];
    for (const id of smallest.keys()) {
      if (!this.alive.has(id)) continue;
      let ok = true;
      for (const m of rest) {
        if (!m.has(id)) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(id);
    }
    return out;
  }

  /** All live entities, no component filter */
  all(): EntityId[] {
    return [...this.alive];
  }
}
