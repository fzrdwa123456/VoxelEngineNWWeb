// ===== Query: cached sparse-set intersection =====
// A query is created once per component set (the store caches it) and RE-USED every step, so the
// per-step cost is "is the store's structural version still the one I built for?" instead of a set
// intersection. `refresh()` is that check plus a rebuild when it fails.
//
// The rebuild walks the RAREST component's dense list and filters by the others, so query cost
// scales with the smallest candidate list rather than with the entity count (EnTT's rule).
//
// LIFETIME CONTRACT: the result is valid until the next STRUCTURAL change (spawn/despawn/insert/
// remove). Structural changes are applied only at a barrier — never inside a system — so calling
// refresh() once at the top of a system's step makes `rows`/`handles` stable for that whole step.

import type { Entity } from "./entity";
import type { AnyComponent } from "./component";
import type { Store } from "./store";

export class Query {
  /** Entity INDICES carrying every component in `components`, in dense-list order. */
  private readonly rows: number[] = [];
  private handles: Entity[] = [];
  private handlesBuiltFor = -1;
  /** Store structural version the cached rows were built for (-1 = never) */
  private builtFor = -1;

  constructor(
    private readonly store: Store,
    /** Every component an entity must carry to match. At least one is required. */
    readonly components: readonly AnyComponent[],
  ) {}

  /** Rebuild the match set if the store changed structurally; a cheap no-op otherwise. */
  refresh(): void {
    if (this.builtFor === this.store.structuralVersion) return;
    this.builtFor = this.store.structuralVersion;
    this.handlesBuiltFor = -1;

    const rows = this.rows;
    rows.length = 0;
    const all = this.components;
    let rarest = all[0];
    for (const component of all) {
      if (component.dense.length < rarest.dense.length) rarest = component;
    }

    outer: for (const index of rarest.dense) {
      for (const component of all) {
        if (component === rarest) continue;
        // `!(x >= 0)` rather than `x < 0`: a row past the end of `sparse` reads back `undefined`,
        // and `undefined < 0` is false — which would silently treat it as attached.
        if (!(component.sparse[index] >= 0)) continue outer;
      }
      // A dense entry always belongs to a live entity (despawn detaches from every component);
      // the check is a cheap guard against a stale row surviving a recycled slot.
      if (this.store.entities.isAliveIndex(index)) rows.push(index);
    }
  }

  /** Matching entity indices. Valid until the next structural change. */
  get indices(): readonly number[] {
    this.refresh();
    return this.rows;
  }

  get length(): number {
    this.refresh();
    return this.rows.length;
  }

  /** Entity index at position `i` */
  index(i: number): number {
    this.refresh();
    return this.rows[i];
  }

  /** Entity HANDLE at position `i` */
  entity(i: number): Entity {
    this.refresh();
    this.buildHandles();
    return this.handles[i];
  }

  /** Every matching entity HANDLE. Valid until the next structural change. */
  entities(): readonly Entity[] {
    this.refresh();
    this.buildHandles();
    return this.handles;
  }

  private buildHandles(): void {
    if (this.handlesBuiltFor === this.builtFor) return;
    this.handlesBuiltFor = this.builtFor;
    const handles = this.handles;
    handles.length = 0;
    for (const index of this.rows) handles.push(this.store.entities.handle(index));
  }
}
