// ===== World: the ECS façade =====
// One object to construct, one import path to remember. It composes the pieces in ecs/core/ and is
// the ONLY thing the rest of the engine needs to know about:
//
//   entities + components   world.spawn() / despawn() / insert() / remove() / has() / get() / query()
//   shared singletons       world.insertResource(R, value) / world.resource(R)
//   behaviour               world.addSystem({ name, stage, after, before, run })
//   deferred writes         world.commands.send(Cmd, payload)
//   driving the loops       world.start() once, then world.stepFixed(dt) / world.render(alpha, delta)
//                           and world.renderUi() while the game loop is stopped (see below)
//
// HOW A FRAME RUNS (every entry point flushes the command queue FIRST, which is the barrier):
//   stepFixed(dt)   barrier -> fixed stage  (camera snapshot, controller, movement, collision, ...)
//   render(a, d)    barrier -> render stage (view interpolation, chunk meshing, diagnostics, draw)
//                          -> ui stage     (the DOM reconcilers, always last)
//   renderUi()      barrier -> ui stage     (stopped-loop pump: the main menu)
// A structural change is only ever applied at a barrier, so component columns and query results
// never move underneath a running system. The scheduler throws if a system breaks that.

import { Commands, type CommandType } from "./effect/command-queue";
import type { AnyComponent, RecordComponent, Schema, SoAComponent } from "./data/component";
import { describeEntity, type Entity } from "./data/entity";
import type { Query } from "./data/query";
import type { Resource } from "./data/resource";
import { Schedule, type Stage, type StageSchedule, type SystemContext, type SystemDef } from "./flow/schedule";
import { Store } from "./data/store";

export type { CommandType } from "./effect/command-queue";
export { defineCommand } from "./effect/command-queue";
export type { AnyComponent, RecordComponent, Schema, SoAComponent } from "./data/component";
export { defineComponent, defineRecord } from "./data/component";
export { describeEntity, entityGeneration, entityIndex, NULL_ENTITY } from "./data/entity";
export type { Entity } from "./data/entity";
export type { Query } from "./data/query";
export { defineResource } from "./data/resource";
export type { Resource } from "./data/resource";
export type { Stage, StageSchedule, SystemAccess, SystemContext, SystemDef } from "./flow/schedule";

/** The context object is reused across steps; systems must read its fields, never keep it. */
interface MutableContext {
  world: World;
  dt: number;
  alpha: number;
  tick: number;
}

export class World {
  /** Entities, component columns and cached queries. Behaviour-free. */
  readonly store = new Store();
  /** Deferred writes from anything that is not a system (UI, DOM handlers, the composition root). */
  readonly commands = new Commands(this);

  private readonly schedule = new Schedule();
  private readonly resources = new Map<Resource<unknown>, unknown>();
  private readonly ctx: MutableContext = { world: this, dt: 0, alpha: 0, tick: 0 };
  private completedSteps = 0;
  private started = false;

  /** Bumped by every structural change. The scheduler uses it to catch systems that mutate
   *  structure, and queries use it to know when their cached result went stale. */
  get structuralVersion(): number {
    return this.store.structuralVersion;
  }

  /** Completed fixed steps (1 during the first step, 0 before the loop starts) */
  get tick(): number {
    return this.completedSteps;
  }

  // ===== entities & components =====

  /** Create a live entity with no components. Attach data with insert(). */
  spawn(): Entity {
    return this.store.spawn();
  }

  /** Destroy an entity and detach all of its components. False when it was already dead. */
  despawn(entity: Entity): boolean {
    return this.store.despawn(entity);
  }

  /** Attach a struct-of-arrays component. `values` overwrite the zero-initialized row. */
  insert<S extends Schema>(
    entity: Entity,
    component: SoAComponent<S>,
    values?: Partial<Record<keyof S & string, number>>,
  ): void;
  /** Attach a record component. Without `value` the component's own factory makes a fresh record. */
  insert<T>(entity: Entity, component: RecordComponent<T>, value?: T): void;
  insert(entity: Entity, component: AnyComponent, values?: unknown): void {
    this.store.insert(entity, component as never, values as never);
  }

  /** Detach one component; the entity stays alive. */
  remove(entity: Entity, component: AnyComponent): boolean {
    return this.store.remove(entity, component);
  }

  has(entity: Entity, component: AnyComponent): boolean {
    return this.store.has(entity, component);
  }

  /** Read a RECORD component. Struct-of-arrays components have no single value: check has() and
   *  read the column (`POSITION.x[index]`) — that is deliberate, so no copied record can go stale. */
  get<T>(entity: Entity, component: RecordComponent<T>): T | undefined {
    return this.store.get(entity, component);
  }

  /** Cached query over every entity carrying ALL of the given components. Call `.refresh()` once
   *  per step before iterating; the result is then stable for that step. */
  query(...components: AnyComponent[]): Query {
    return this.store.query(...components);
  }

  // ===== resources =====

  /** Register a world-scoped singleton. Call before start(); resources are stable objects, so
   *  "updating" one means mutating the value it holds. */
  insertResource<T>(resource: Resource<T>, value: T): void {
    if (this.resources.has(resource as Resource<unknown>)) {
      throw new Error(`World.insertResource: resource "${resource.name}" is already registered`);
    }
    this.resources.set(resource as Resource<unknown>, value);
  }

  resource<T>(resource: Resource<T>): T {
    const value = this.resources.get(resource as Resource<unknown>);
    if (value === undefined) {
      throw new Error(
        `World.resource: "${resource.name}" was never registered — insert it before start()`,
      );
    }
    return value as T;
  }

  // ===== systems =====

  /** Register a system. Registration order is the default execution order; `after`/`before` state
   *  the constraints that are actually load-bearing. */
  addSystem(def: SystemDef): void {
    this.schedule.add(def);
  }

  /** Resolve and verify the execution order. Call ONCE, after registering every system and before
   *  the loops start: it is what turns the load-bearing order into a startup error instead of a
   *  comment nobody re-reads. */
  start(): void {
    if (this.started) throw new Error("World.start: already started");
    this.schedule.resolve();
    this.started = true;
  }

  /** Register or REMOVE a system at RUNTIME and re-resolve the schedule — the hot-plug path (P1.24).
   *
   *  Legal only at a BARRIER, and the command queue is the door that guarantees it: `HotPlugPlugin` is
   *  flushed at the top of every entry point, before any lane runs, so no system ever sees the schedule
   *  change underneath it. `resolve()` re-runs the whole verification (unknown name, cycle, unsatisfiable
   *  edge, undeclared dependency) and THROWS in the schedule's own words — the caller undoes the
   *  contributions it just filed, so a plugin that cannot be added leaves no trace.
   *
   *  `start()` deliberately is not re-run: the schedule is the thing being re-resolved, and re-running the
   *  boot would re-run every plugin's `start`. */
  hotAddSystem(def: SystemDef): void {
    this.schedule.add(def);
    this.schedule.resolve();
  }

  /** Take one system out at a barrier and re-resolve. Returns the def, or null when the name was never
   *  there — a plugin that declared no system is not an error. */
  hotRemoveSystem(name: string): SystemDef | null {
    const removed = this.schedule.remove(name);
    if (removed) this.schedule.resolve();
    return removed;
  }

  /** Drop a resource. NOT used by the hot-plug uninstall path any more (P1.28): a resource the root's table
   *  inserted is read by CORE commands too (`ShowToast` -> TOAST), so dropping it on uninstall broke the
   *  engine rather than the surface — see the note at the loop in `core/plugin/hotplug.ts`. This stays for a
   *  plugin that genuinely created an object at runtime and owns its lifetime. */
  removeResource<T>(resource: Resource<T>): boolean {
    return this.resources.delete(resource as Resource<unknown>);
  }

  /** Is this resource registered? Asked by a plugin that has to insert its own when it is installed at
   *  runtime (the boot table already inserted it in the ordinary case). */
  hasResource<T>(resource: Resource<T>): boolean {
    return this.resources.has(resource as Resource<unknown>);
  }

  /** Registered systems of one stage, in resolved execution order */
  systemOrder(stage: Stage): readonly SystemDef[] {
    return this.schedule.orderOf(stage);
  }

  /** Computed batches of one stage: systems grouped so that no two members conflict. Members of a
   *  batch may run in ANY order; the batches themselves run in order. Empty until start(). */
  batchesOf(stage: Stage): readonly (readonly SystemDef[])[] {
    return this.schedule.batchesOf(stage);
  }

  /** One line per stage describing systems, batches and parallel pairs — the computed answer to
   *  "what could run at the same time", instead of a claim in a comment. Log it at boot. */
  scheduleReport(): string[] {
    return this.schedule.report();
  }

  /** Advance every fixed-stage system by exactly dt. The command barrier runs first. */
  stepFixed(dt: number): void {
    this.assertStarted("stepFixed");
    this.commands.flush();
    this.completedSteps++;
    this.ctx.dt = dt;
    this.ctx.alpha = 0;
    this.ctx.tick = this.completedSteps;
    this.schedule.run("fixed", this.ctx);
  }

  /** Run every render-stage system, then the ui lane. The command barrier runs first, so a command
   *  sent from the UI or the main menu is applied before this frame is drawn. */
  render(alpha: number, delta: number): void {
    this.assertStarted("render");
    this.commands.flush();
    this.ctx.dt = delta;
    this.ctx.alpha = alpha;
    this.ctx.tick = this.completedSteps;
    this.schedule.run("render", this.ctx);
    this.schedule.run("ui", this.ctx);
  }

  /** Run the command barrier and the ui lane ONLY — no simulation, no drawing.
   *
   *  The composition root calls this from a second pump while the game loop is stopped (the main
   *  menu), which is exactly when the user is interacting with the UI. Without it, a widget
   *  write or a UI command made in that state sat in component data until the game resumed: see the
   *  three-lane note at the top of core/schedule.ts. dt/alpha are 0 here because no tick is being
   *  advanced — the ui lane reconciles current state, it does not integrate anything. */
  renderUi(): void {
    this.assertStarted("renderUi");
    this.commands.flush();
    this.ctx.dt = 0;
    this.ctx.alpha = 0;
    this.ctx.tick = this.completedSteps;
    this.schedule.run("ui", this.ctx);
  }

  private assertStarted(entry: string): void {
    if (!this.started) {
      throw new Error(`World.${entry}: call world.start() after registering systems and resources`);
    }
  }
}

/** Render a handle for an error message. Re-exported here so callers need one import path. */
export const entityName = describeEntity;
