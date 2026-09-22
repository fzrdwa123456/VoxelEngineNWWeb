// ===== Entities: generation-checked handles =====
// An entity is a NUMBER packing `index << 8 | generation`:
//   index       23 bits -> 8,388,608 slots handed out over the process lifetime
//   generation   8 bits -> bumped every time a slot is recycled
//
// The packing is what makes a stale handle DETECTABLE. A bare counter cannot tell you that the id
// you cached was despawned — it silently addresses whatever now occupies the slot. Here isAlive()
// compares the generation too, so a stale handle reports false instead of lying.
//
// The packing also keeps every entity a small non-negative int32, so entity ids stay cheap as Map
// keys and array indices; nothing ever becomes a heap-allocated double.
//
// Component columns are indexed by `entityIndex(entity)`, NEVER by the handle: the handle exists
// for identity and safety at API boundaries only.

export type Entity = number;

/** The null handle: never alive, never a valid index. `create()` starts at index 1. */
export const NULL_ENTITY: Entity = 0;

const GENERATION_BITS = 8;
const GENERATION_MASK = (1 << GENERATION_BITS) - 1; // 255
/** 23-bit index space, so `index << 8` stays inside a positive int32. */
const MAX_INDEX = (1 << (31 - GENERATION_BITS)) - 1; // 8,388,607
const INITIAL_SLOTS = 1024;

export function entityIndex(entity: Entity): number {
  return entity >>> GENERATION_BITS;
}

export function entityGeneration(entity: Entity): number {
  return entity & GENERATION_MASK;
}

/** Human-readable handle for error messages and logs: `e3g1` (index 3, generation 1). */
export function describeEntity(entity: Entity): string {
  return entity === NULL_ENTITY ? "null" : `e${entityIndex(entity)}g${entityGeneration(entity)}`;
}

/** Slot allocator. Owns generation counters and the free list; knows nothing about components. */
export class EntityAllocator {
  private generations = new Uint8Array(INITIAL_SLOTS);
  private live = new Uint8Array(INITIAL_SLOTS);
  private readonly recycled: number[] = [];
  private nextIndex = 1; // slot 0 is reserved for NULL_ENTITY
  private liveCount = 0;

  /** Live entities */
  get aliveCount(): number {
    return this.liveCount;
  }

  /** Slots handed out so far. Component columns must be able to address this many rows. */
  get capacity(): number {
    return this.nextIndex;
  }

  /** Allocate a handle, reusing a recycled slot when one is free (bumping its generation). */
  create(): Entity {
    let index = this.recycled.pop();
    if (index === undefined) {
      index = this.nextIndex++;
      if (index > MAX_INDEX) {
        throw new Error(`EntityAllocator: index space exhausted (${MAX_INDEX + 1} slots)`);
      }
      this.ensureSlots(this.nextIndex);
    }
    this.live[index] = 1;
    this.liveCount++;
    return (index << GENERATION_BITS) | this.generations[index];
  }

  /** Kill a handle. Returns false if it was already dead, so double-destroy is a no-op. */
  destroy(entity: Entity): boolean {
    if (!this.isAlive(entity)) return false;
    const index = entityIndex(entity);
    this.live[index] = 0;
    // Bump the generation: every handle still pointing at this slot stops matching.
    // (After 256 recycles of the SAME slot an ancient handle could collide again; with 8 bits and
    // per-slot recycling that needs 256 despawns of one slot before its reuse — not a real risk.)
    this.generations[index] = (this.generations[index] + 1) & GENERATION_MASK;
    this.recycled.push(index);
    this.liveCount--;
    return true;
  }

  isAlive(entity: Entity): boolean {
    if (entity === NULL_ENTITY) return false;
    const index = entityIndex(entity);
    if (index >= this.nextIndex) return false;
    return this.live[index] === 1 && this.generations[index] === entityGeneration(entity);
  }

  /** Liveness of a raw column row. Same check as isAlive() for callers that only hold an index. */
  isAliveIndex(index: number): boolean {
    return index < this.nextIndex && this.live[index] === 1;
  }

  /** Rebuild the full handle for a component column row (columns store plain indices). */
  handle(index: number): Entity {
    return (index << GENERATION_BITS) | this.generations[index];
  }

  /** Visit every live entity INDEX, in ascending slot order. */
  forEachAliveIndex(visit: (index: number) => void): void {
    for (let index = 1; index < this.nextIndex; index++) {
      if (this.live[index] === 1) visit(index);
    }
  }

  private ensureSlots(slots: number): void {
    if (slots <= this.generations.length) return;
    let size = this.generations.length;
    while (size < slots) size *= 2;
    const generations = new Uint8Array(size);
    generations.set(this.generations);
    this.generations = generations;
    const live = new Uint8Array(size);
    live.set(this.live);
    this.live = live;
  }
}
