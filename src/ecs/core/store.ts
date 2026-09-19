// ===== Store: entities + component columns + cached queries =====
// The data half of the ECS. It owns the entity allocator, the per-component columns, and one
// cached Query per requested component set. It has NO behaviour: every rule about what runs when
// lives in the scheduler, every rule about what a system may touch lives in the components.
//
// STRUCTURAL CHANGES ARE THE THING TO GET RIGHT. spawn/despawn/insert/remove mutate the dense
// lists that queries iterate, so doing any of them while a system is running would corrupt that
// system's iteration. The store therefore counts them (`structuralVersion`) and the scheduler
// refuses to let a system change that counter — all structural work goes through `world.commands`
// and is applied at a barrier. Because of that, columns and query results never move underneath a
// running system, which is exactly what lets systems cache typed arrays within one step.

import { describeEntity, EntityAllocator, entityIndex, type Entity } from "./entity";
import { claimComponent, type AnyComponent, type RecordComponent, type Schema, type SoAComponent } from "./component";
import { Query } from "./query";

export class Store {
  /** Entity handles, generations and recycling */
  readonly entities = new EntityAllocator();

  /** Bumped by every structural change. Query results are valid for one version. */
  structuralVersion = 0;

  /** Registered components, indexed by component id (sparse: ids are process-global) */
  private readonly components: AnyComponent[] = [];
  private readonly queries = new Map<string, Query>();

  // ===== entities =====

  /** Create a live entity with no components. Attach data with insert(). */
  spawn(): Entity {
    const entity = this.entities.create();
    // New slot -> every column must be able to address it
    this.growColumns(this.entities.capacity);
    this.structuralVersion++;
    return entity;
  }

  /** Destroy an entity and detach all of its components. False when it was already dead. */
  despawn(entity: Entity): boolean {
    if (!this.entities.destroy(entity)) return false;
    const index = entityIndex(entity);
    for (const component of this.components) {
      if (component !== undefined) detach(component, index);
    }
    this.structuralVersion++;
    return true;
  }

  // ===== components =====

  /** Attach a struct-of-arrays component. `values` overwrite the zero-initialized row. */
  insert<S extends Schema>(
    entity: Entity,
    component: SoAComponent<S>,
    values?: Partial<Record<keyof S & string, number>>,
  ): void;
  /** Attach a record component. Without `value` the component's own factory makes a fresh record. */
  insert<T>(entity: Entity, component: RecordComponent<T>, value?: T): void;
  insert(entity: Entity, component: AnyComponent, values?: unknown): void {
    this.bind(component);
    if (!this.entities.isAlive(entity)) {
      throw new Error(
        `Store.insert: entity ${describeEntity(entity)} is not alive (component "${component.name}") — spawn it first`,
      );
    }
    const index = entityIndex(entity);
    if (component.sparse[index] >= 0) {
      throw new Error(
        `Store.insert: entity ${describeEntity(entity)} already carries "${component.name}" — ` +
          `mutate the existing data in place instead of replacing it`,
      );
    }
    this.growColumns(this.entities.capacity);

    if (component.kind === "soa") {
      const soa = component as SoAComponent<Schema>;
      // Zero the row: a recycled index must never inherit the previous occupant's values.
      for (const field of soa.fieldNames) {
        (soa[field] as unknown as number[])[index] = 0;
      }
      if (values !== undefined) {
        for (const [field, value] of Object.entries(values as Record<string, number>)) {
          const column = (soa as unknown as Record<string, number[] | undefined>)[field];
          if (column === undefined) {
            throw new Error(`Store.insert: "${component.name}" has no field "${field}"`);
          }
          column[index] = value;
        }
      }
    } else {
      (component as RecordComponent<unknown>).data[index] =
        values ?? (component as RecordComponent<unknown>).make();
    }

    attach(component, index);
    this.structuralVersion++;
  }

  /** Detach one component; the entity stays alive. False when it was not attached. */
  remove(entity: Entity, component: AnyComponent): boolean {
    this.bind(component);
    if (!this.entities.isAlive(entity)) return false;
    if (!detach(component, entityIndex(entity))) return false;
    this.structuralVersion++;
    return true;
  }

  has(entity: Entity, component: AnyComponent): boolean {
    this.bind(component);
    return this.entities.isAlive(entity) && component.sparse[entityIndex(entity)] >= 0;
  }

  /** Read a RECORD component. Struct-of-arrays components have no single value: read `POSITION.x[i]`
   *  after checking has() — that is deliberate, so nothing can hand out a stale copied record. */
  get<T>(entity: Entity, component: RecordComponent<T>): T | undefined {
    if (!this.entities.isAlive(entity)) return undefined;
    const index = entityIndex(entity);
    // Attachment, not just liveness: a recycled slot must never expose the previous occupant's
    // record (detach clears it as well — belt and braces, because this is a silent-corruption class).
    return component.sparse[index] >= 0 ? component.data[index] : undefined;
  }

  // ===== queries =====

  /** Cached query over every entity carrying ALL of the given components. */
  query(...components: AnyComponent[]): Query {
    if (components.length === 0) {
      throw new Error("Store.query: at least one component is required");
    }
    let key = "";
    for (const component of components) {
      this.bind(component);
      key += `${component.id},`;
    }
    let query = this.queries.get(key);
    if (query === undefined) {
      query = new Query(this, components);
      this.queries.set(key, query);
    }
    return query;
  }

  // ===== internals =====

  /** Register a component definition with this store and size its columns. Idempotent.
   *  Throws if the definition's storage is already owned by a DIFFERENT store — see
   *  claimComponent() for why one process supports one World. */
  private bind(component: AnyComponent): void {
    if (this.components[component.id] === component) return;
    claimComponent(component, this);
    if (this.components[component.id] !== undefined) {
      throw new Error(
        `Store.bind: two different definitions share component id ${component.id} ` +
          `("${this.components[component.id]!.name}" and "${component.name}")`,
      );
    }
    this.components[component.id] = component;
    component.grow(this.entities.capacity);
  }

  private growColumns(capacity: number): void {
    for (const component of this.components) {
      if (component !== undefined) component.grow(capacity);
    }
  }
}

/** Append to the dense list and record the slot in the sparse map. */
function attach(component: AnyComponent, index: number): void {
  component.sparse[index] = component.dense.length;
  component.dense.push(index);
}

/** Swap-remove from the dense list: O(1), but it moves the last entry into the freed slot.
 *  Also drops any record, so a recycled entity slot can never expose the previous occupant's data. */
function detach(component: AnyComponent, index: number): boolean {
  const slot = component.sparse[index];
  if (slot === undefined || slot < 0) return false;
  const last = component.dense.pop()!;
  if (last !== index) {
    component.dense[slot] = last;
    component.sparse[last] = slot;
  }
  component.sparse[index] = -1;
  if (component.kind === "record") {
    (component as RecordComponent<unknown>).data[index] = undefined;
  }
  return true;
}
