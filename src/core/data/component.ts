// ===== Components: the two storage kinds =====
// A component is a DEFINITION (id, name, storage shape) shared by the whole process. The DATA
// lives in columns on that definition, indexed by entity index. There are exactly two kinds, and
// picking between them is the only storage decision in the engine:
//
//   SOA    defineComponent("position", { x: "f32", y: "f32", z: "f32" })
//          One typed array PER FIELD, indexed by entity index -> `POSITION.x[index]`.
//          Use for numbers that systems read and write as math. No per-entity object at all.
//
//   RECORD defineRecord("control", () => ({ keys: new Set(), mode: "walk", flying: false }))
//          One plain object per entity -> `CONTROL.data[index]`. Use for object-valued state and
//          for flags whose boolean semantics matter. The record identity is stable for the whole
//          time the component is attached, so a system MAY cache `CONTROL.data[index]` (iron
//          rule 1). The `data` ARRAY identity is stable too: plain arrays grow in place.
//
// Both kinds carry the same sparse-set membership bookkeeping:
//   dense   entity INDICES carrying the component. ORDER IS NOT STABLE — removal swap-fills.
//   sparse  entity index -> slot in `dense`, or -1 when absent. A plain number[] on purpose: it
//           grows in place, so `sparse` never has to be re-allocated (a typed array would).
//
// IRON RULE (the one that keeps SOA honest): the typed arrays ARE re-allocated when the entity
// count outgrows them, so never cache `POSITION.x` across a structural change. Structural changes
// only ever happen at a barrier, never inside a system (see core/schedule.ts), so a reference read
// inside a system's step stays valid for that whole step.

export type FieldKind = "f32" | "i32" | "u8";
export type FieldArray<K extends FieldKind> = K extends "f32"
  ? Float32Array
  : K extends "i32"
    ? Int32Array
    : Uint8Array;
export type Schema = Readonly<Record<string, FieldKind>>;
export type FieldArrays<S extends Schema> = { -readonly [K in keyof S]: FieldArray<S[K]> };

/** Rows a column starts with. Growth doubles from here, so the first few hundred spawns are free. */
const INITIAL_ROWS = 1024;

/** Bookkeeping every component carries, whatever its storage kind. */
export interface ComponentBase {
  readonly id: number;
  /** Stable name; used in error messages and as the query cache key */
  readonly name: string;
  /** Entity INDICES carrying this component (dense). Order is not stable. */
  readonly dense: number[];
  /** entity index -> slot in `dense`, or -1. Plain array: grows in place, never re-allocated. */
  readonly sparse: number[];
  /** Rows of addressable storage (>= the store's entity capacity) */
  rows: number;
  /** Grow the columns so they can address `rows` entity slots. Called by the store only. */
  grow(rows: number): void;
}

export type SoAComponent<S extends Schema> = FieldArrays<S> &
  ComponentBase & {
    readonly kind: "soa";
    readonly schema: S;
    readonly fieldNames: ReadonlyArray<keyof S & string>;
  };

export type RecordComponent<T> = ComponentBase & {
  readonly kind: "record";
  /** Factory for a fresh default record; the store calls it on insert with no explicit value */
  readonly make: () => T;
  /** One record per entity index, `undefined` where the component is absent. Stable identity. */
  readonly data: Array<T | undefined>;
};

/** Anything usable as an insert/query target. Deliberately minimal so both kinds satisfy it. */
export type AnyComponent = ComponentBase & { readonly kind: "soa" | "record" };

function createFieldArray(kind: FieldKind, rows: number): FieldArray<FieldKind> {
  if (kind === "f32") return new Float32Array(rows);
  if (kind === "i32") return new Int32Array(rows);
  return new Uint8Array(rows);
}

/** `sparse` must have no holes, so it is filled with -1 as it grows. */
function growSparse(component: AnyComponent, rows: number): void {
  for (let i = component.sparse.length; i < rows; i++) component.sparse.push(-1);
}

function growSoA(component: SoAComponent<Schema>, rows: number): void {
  if (rows <= component.rows) return;
  let size = Math.max(component.rows, INITIAL_ROWS);
  while (size < rows) size *= 2;
  for (const field of component.fieldNames) {
    const next = createFieldArray(component.schema[field], size);
    next.set(component[field] as unknown as ArrayLike<number>);
    (component as unknown as Record<string, unknown>)[field] = next;
  }
  component.rows = size;
  growSparse(component, size);
}

function growRecord<T>(component: RecordComponent<T>, rows: number): void {
  if (rows <= component.rows) return;
  let size = Math.max(component.rows, INITIAL_ROWS);
  while (size < rows) size *= 2;
  component.data.length = size; // plain array: grows in place, identity preserved
  component.rows = size;
  growSparse(component, size);
}

/** Next component id. Ids are process-global and start at 1 (0 is reserved as "no component"). */
let nextComponentId = 1;

/** Which store owns each definition's columns. The DATA lives on the process-global definition
 *  (that is what makes `POSITION.x[row]` readable from any module), so two stores sharing one
 *  definition would silently see each other's rows — a fresh World would find entities "already
 *  carrying" components it never attached. One process, one World: this turns that silent
 *  corruption into a startup error. Tests that need isolation must define their own components, or
 *  reuse a single World (which also exercises the multi-entity paths). */
const owners = new WeakMap<AnyComponent, object>();

export function claimComponent(component: AnyComponent, owner: object): void {
  const existing = owners.get(component);
  if (existing === undefined) {
    owners.set(component, owner);
    return;
  }
  if (existing !== owner) {
    throw new Error(
      `component "${component.name}" is already bound to another World — component storage lives on ` +
        `the definition, so one process supports one World (see ROADMAP.md §3.9)`,
    );
  }
}

/** Define a struct-of-arrays component: numeric fields in typed arrays indexed by entity index. */
export function defineComponent<S extends Schema>(name: string, schema: S): SoAComponent<S> {
  const fieldNames = Object.keys(schema) as Array<keyof S & string>;
  const component = {
    kind: "soa" as const,
    id: nextComponentId++,
    name,
    schema,
    fieldNames,
    rows: 0,
    dense: [] as number[],
    sparse: [] as number[],
    grow(rows: number): void {
      growSoA(component as unknown as SoAComponent<Schema>, rows);
    },
  } as unknown as SoAComponent<S>;
  for (const field of fieldNames) {
    (component as unknown as Record<string, unknown>)[field] = createFieldArray(schema[field], 0);
  }
  return component;
}

/** Define an opaque component: one plain data record per entity, identity stable while attached. */
export function defineRecord<T>(name: string, make: () => T): RecordComponent<T> {
  const component = {
    kind: "record" as const,
    id: nextComponentId++,
    name,
    make,
    data: [] as Array<T | undefined>,
    rows: 0,
    dense: [] as number[],
    sparse: [] as number[],
    grow(rows: number): void {
      growRecord(component, rows);
    },
  } as RecordComponent<T>;
  return component;
}
