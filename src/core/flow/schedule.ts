// ===== Schedule: named systems, three stages, declared order AND declared access =====
// Three lanes. The first two mirror the game's two clocks; the third exists because the UI does NOT
// stop when they do:
//   fixed  — MC-style fixed tps, driven by the accumulator (input consumption, physics)
//   render — once per rendered frame (view interpolation, meshing, drawing, diagnostics)
//   ui     — the DOM-reconciling lane. Runs at the end of every frame, AND on its own clock while
//            the game loop is stopped (the main menu) via world.renderUi().
//
// WHY THE THIRD LANE IS NOT JUST "the last part of render". MENU mode halts the simulation and
// the draw, which is what keeps the last frame on screen and the CPU idle — and the main menu is the
// one state in which the user still interacts with the UI while that is true. With the widget layer
// in the render lane, a toast raised from the main menu wrote component data that nothing ever
// reconciled into the DOM. The UI is a view of component data, so it has to be driven by its own pump
// (world.renderUi()) rather than by whichever lane happens to be running. Stage order also gives the
// ui lane a STRONGER guarantee than the per-pair edge it replaced: it always runs after the render
// lane, so everything `diagnostics` wrote this frame is already in place.
//
// AN OPEN MODAL DOES NOT MEAN A STOPPED LOOP. The backpack releases the mouse and drops the LOCAL
// player's INPUT (canControl() false: controller/interaction skip it, movement ignores its keys but
// keeps integrating gravity and its velocity — a body without intent, not a body without physics)
// while the world keeps running. Its commands ride the ordinary frame, and only the main menu needs
// the pump.
//
// This file is the SCHEDULING half of parallelism. The EXECUTION half (more than one core) is not
// here, and cannot be: see the note at the bottom of this header.
//
// WHAT A SYSTEM DECLARES
//   after / before           ORDER. "player.movement must run after player.controller."
//   reads / writes           ACCESS to components. A component in `writes` is also implicitly read.
//   readsExternal /          ACCESS to state the ECS does not model: the DOM, the GPU, a three.js
//   writesExternal           object, the block world. Free-form target names, so a new target needs
//                            no type; reuse an existing name if you mean the same thing.
//
// WHAT THE SCHEDULE COMPUTES FROM THAT
//   A BATCH is a set of systems with no conflicting access and no ordering edge between them.
//   Members of one batch may run in ANY order — that is what makes them parallelisable; the batches
//   themselves run in order. `world.batchesOf(stage)` returns the computed grouping and
//   `world.scheduleReport()` prints it.
//
//   run() executes batch by batch and, WITHIN a batch, in resolved (registration) order — because
//   determinism is worth more than a fake thread. Swapping the order inside a batch is exactly what
//   an executor would be allowed to do, and the Node assertion suite checks it cannot change the
//   outcome.
//
// TWO THINGS THIS ENFORCES AT BOOT (both used to be conventions)
//   1. A DEPENDENCY MUST BE DECLARED. If two systems in a stage touch the same component or the
//      same external target and no after/before path orders them, resolve() throws. Relying on
//      registration order for a dependency is the "load-bearing order that only exists as a
//      comment" problem, and it is now impossible. This is how the fake edges below were found:
//      `player.movement` needs BOTH `motion.snapshot` (so PREV_POSITION still holds the
//      pre-movement position) and `player.controller` (whose ORIENTATION it reads), and the only
//      edge that said so ordered the snapshot against the camera instead.
//   2. A TYPO'D LABEL, A CYCLE, OR A CONSTRAINT THE SORT FAILED TO HONOUR throws — as before.
//
// run() additionally enforces the barrier invariant: a system that changes component structure while
// it runs (spawn/despawn/insert/remove instead of world.commands) throws immediately.
//
// WHY THERE IS NO MULTI-CORE EXECUTOR HERE
//   Components come in two kinds, and neither can cross a thread boundary today:
//     - RECORD components (MOTION/CONTROL/INVENTORY) are JS objects. A Worker gets a structured
//       CLONE, which would break the identity guarantee systems rely on (iron rule 2).
//     - SOA components are typed arrays and could move, but the systems heavy enough to be worth
//       offloading also read the voxel Map (collision, interaction) or write the DOM (ui.inventory,
//       diagnostics), and neither is shareable.
//   On top of that, only 2 of the 5 fixed systems are pure numeric kernels (snapshot, controller)
//   and they are a handful of float operations over ONE entity: the message round-trip would cost
//   more than the work. `report()` states what is actually parallel per stage instead of leaving it
//   to prose — today: the fixed stage is a genuine dependency chain, and the render stage has 6
//   parallel pairs.

import type { AnyComponent } from "../data/component";
import type { World } from "../world";

export type Stage = "fixed" | "render" | "ui";

export interface SystemContext {
  readonly world: World;
  /** fixed stage: the fixed timestep, always 1/120. render stage: the frame delta in seconds. */
  readonly dt: number;
  /** render stage: how far into the pending physics tick this frame is (render interpolation) */
  readonly alpha: number;
  /** completed fixed steps so far (1 on the first step) */
  readonly tick: number;
}

/** What a system is allowed to touch. Declared so the schedule can order and batch it. */
export interface SystemAccess {
  /** Components this system READS without writing */
  readonly reads?: readonly AnyComponent[];
  /** Components this system WRITES (and therefore also reads) */
  readonly writes?: readonly AnyComponent[];
  /** Non-component targets this system READS (e.g. "camera3d", "chunkMeshes") */
  readonly readsExternal?: readonly string[];
  /** Non-component targets this system WRITES (e.g. "dom.hotbar", "gpuChunkMeshes") */
  readonly writesExternal?: readonly string[];
}

export interface SystemDef extends SystemAccess {
  /** Unique label. Ordering constraints reference it and errors name it. */
  readonly name: string;
  readonly stage: Stage;
  /** Labels that must run EARLIER in the same stage */
  readonly after?: readonly string[];
  /** Labels that must run LATER in the same stage */
  readonly before?: readonly string[];
  run(ctx: SystemContext): void;
}

/** The resolved plan for one stage */
export interface StageSchedule {
  readonly stage: Stage;
  /** Execution order, flattened across batches */
  readonly systems: readonly SystemDef[];
  /** Systems grouped so that no two members conflict and no edge orders them. Members of one batch
   *  may run in ANY order; batches run in order. */
  readonly batches: readonly (readonly SystemDef[])[];
  /** Pairs of systems that share a batch — the parallelism this stage actually offers */
  readonly parallelPairs: number;
}

/** Per-system access as id/target sets, so the conflict test is a set intersection */
interface AccessSets {
  readonly reads: ReadonlySet<number>;
  readonly writes: ReadonlySet<number>;
  readonly readsExternal: ReadonlySet<string>;
  readonly writesExternal: ReadonlySet<string>;
}

export class Schedule {
  private readonly defs: SystemDef[] = [];
  private readonly byName = new Map<string, SystemDef>();
  private plan: StageSchedule[] = [];

  /** Register a system. Registration order is the execution order unless after/before says otherwise. */
  add(def: SystemDef): void {
    if (this.byName.has(def.name)) {
      throw new Error(`Schedule.add: duplicate system name "${def.name}"`);
    }
    this.byName.set(def.name, def);
    this.defs.push(def);
  }

  /** Every registered system, in registration order (used for diagnostics) */
  get systems(): readonly SystemDef[] {
    return this.defs;
  }

  /** Is a system with this name registered? (The hot-plug path asks before it removes one.) */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Remove one system by name and return it (null when there was none). The caller re-resolves: the
   *  returned def is only out of the LANES once `resolve()` has run again. Used by the hot-plug path. */
  remove(name: string): SystemDef | null {
    const def = this.byName.get(name);
    if (!def) return null;
    this.byName.delete(name);
    const at = this.defs.indexOf(def);
    if (at >= 0) this.defs.splice(at, 1);
    return def;
  }

  /** Resolved execution order of one stage (empty until resolve()) */
  orderOf(stage: Stage): readonly SystemDef[] {
    return this.planOf(stage)?.systems ?? [];
  }

  /** Computed batches of one stage (empty until resolve()) */
  batchesOf(stage: Stage): readonly (readonly SystemDef[])[] {
    return this.planOf(stage)?.batches ?? [];
  }

  /** Resolve + verify every stage: order, access conflicts and batching. Call once, before the loops. */
  resolve(): void {
    this.plan = [this.build("fixed"), this.build("render"), this.build("ui")];
  }

  /** One line per stage: how many systems, batches and parallel pairs, plus the grouping.
   *  Cheap to log at boot, and the reason this file needs no prose about what is parallel. */
  report(): string[] {
    return this.plan.map((entry) => {
      const groups = entry.batches
        .map((batch) =>
          batch.length > 1 ? `(${batch.map((def) => def.name).join(" ~ ")})` : batch[0].name,
        )
        .join(" | ");
      return (
        `SCHEDULE ${entry.stage}: ${entry.systems.length} systems, ${entry.batches.length} batches, ` +
        `${entry.parallelPairs} parallel pair(s) [${groups}]`
      );
    });
  }

  /** Run a stage: batch by batch, and within a batch in resolved order. */
  run(stage: Stage, ctx: SystemContext): void {
    for (const batch of this.batchesOf(stage)) {
      for (const def of batch) {
        const before = ctx.world.structuralVersion;
        try {
          def.run(ctx);
        } catch (err) {
          throw new Error(`system "${def.name}" (${stage}) failed: ${message(err)}`, { cause: err });
        }
        if (ctx.world.structuralVersion !== before) {
          throw new Error(
            `system "${def.name}" changed component structure while running — spawn/despawn/insert/` +
              `remove must go through world.commands, which is applied at a barrier`,
          );
        }
      }
    }
  }

  private planOf(stage: Stage): StageSchedule | undefined {
    return this.plan.find((entry) => entry.stage === stage);
  }

  private build(stage: Stage): StageSchedule {
    const systems = this.defs.filter((def) => def.stage === stage);
    const position = new Map<string, number>();
    systems.forEach((def, i) => position.set(def.name, i));

    const edges: number[][] = systems.map(() => []);
    const indegree = new Array<number>(systems.length).fill(0);
    const require = (name: string, owner: string, kind: string): number => {
      const found = position.get(name);
      if (found === undefined) {
        throw new Error(
          `Schedule.resolve: system "${owner}" declares ${kind} "${name}", ` +
            `which is not a "${stage}"-stage system`,
        );
      }
      return found;
    };
    const edge = (from: number, to: number): void => {
      edges[from].push(to);
      indegree[to]++;
    };

    systems.forEach((def, i) => {
      for (const name of def.after ?? []) edge(require(name, def.name, "after"), i);
      for (const name of def.before ?? []) edge(i, require(name, def.name, "before"));
    });

    // Kahn's algorithm, always taking the LOWEST original index among the ready nodes, so
    // unconstrained systems keep their registration order instead of being reordered arbitrarily.
    const ordered: SystemDef[] = [];
    const emitted = new Array<boolean>(systems.length).fill(false);
    for (let n = 0; n < systems.length; n++) {
      let pick = -1;
      for (let i = 0; i < systems.length; i++) {
        if (!emitted[i] && indegree[i] === 0) {
          pick = i;
          break;
        }
      }
      if (pick < 0) {
        const stuck = systems.filter((_, i) => !emitted[i]).map((def) => def.name);
        throw new Error(
          `Schedule.resolve: circular ordering constraint in the "${stage}" stage among ` +
            `${stuck.join(", ")}`,
        );
      }
      emitted[pick] = true;
      ordered.push(systems[pick]);
      for (const to of edges[pick]) indegree[to]--;
    }

    // Verify the emitted order against the declared constraints. Redundant with the sort, and that
    // is the point: the load-bearing order is now checked, not merely documented.
    const rank = new Map<string, number>();
    ordered.forEach((def, i) => rank.set(def.name, i));
    for (const def of ordered) {
      const at = rank.get(def.name)!;
      for (const name of def.after ?? []) {
        if (rank.get(name)! >= at) {
          throw new Error(`Schedule.resolve: "${def.name}" must run after "${name}" but is ordered before it`);
        }
      }
      for (const name of def.before ?? []) {
        if (rank.get(name)! <= at) {
          throw new Error(`Schedule.resolve: "${def.name}" must run before "${name}" but is ordered after it`);
        }
      }
    }

    // The adjacency above is indexed by REGISTRATION position, and everything below (the conflict
    // verification and the batcher) indexes systems by their RESOLVED position. Remap it ONCE here, so
    // both halves see the same graph the sort used. Using one space with the other's indices is what
    // made a declared edge fail whenever the sort MOVED one of its two systems — which happens exactly
    // when the declaration is registered before the system it points at, the one case the old code
    // could only handle by asking people to register things in the right order (ROADMAP §3.9 had it as
    // a GAP; the batcher is correct now, and `check:ecs` pins both registration orders).
    const resolvedAt = new Array<number>(systems.length);
    ordered.forEach((def, at) => {
      resolvedAt[position.get(def.name)!] = at;
    });
    const resolvedEdges: number[][] = ordered.map(() => []);
    edges.forEach((targets, from) => {
      for (const to of targets) resolvedEdges[resolvedAt[from]].push(resolvedAt[to]);
    });

    const names = componentNames(ordered);
    this.verifyDeclaredDependencies(stage, ordered, resolvedEdges, names);

    const batches = this.batch(stage, ordered, resolvedEdges, names);
    const parallelPairs = batches.reduce((sum, group) => sum + (group.length * (group.length - 1)) / 2, 0);
    return { stage, systems: ordered, batches, parallelPairs };
  }

  /** Every access conflict between two systems must be ordered by a declared after/before path.
   *  Without this, a dependency would silently be resolved by registration order. */
  private verifyDeclaredDependencies(
    stage: Stage,
    ordered: readonly SystemDef[],
    edges: readonly number[][],
    names: ReadonlyMap<number, string>,
  ): void {
    const access = ordered.map(accessSets);
    const reaches = (from: number, to: number): boolean => {
      const seen = new Set<number>([from]);
      const stack = [from];
      while (stack.length > 0) {
        const at = stack.pop()!;
        for (const next of edges[at]) {
          if (next === to) return true;
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      return false;
    };

    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const shared = conflict(access[i], access[j], names);
        if (shared === null) continue;
        // The declared graph may order either way; it only has to order them.
        if (reaches(i, j) || reaches(j, i)) continue;
        throw new Error(
          `Schedule.resolve("${stage}"): "${ordered[i].name}" and "${ordered[j].name}" both touch ` +
            `${shared} but neither is declared after the other — add an after/before constraint ` +
            `(registration order is not a dependency)`,
        );
      }
    }
  }

  /** Earliest-fit batching: a system joins the first batch that neither orders it against an
   *  unplaced predecessor nor conflicts with a member. */
  private batch(
    stage: Stage,
    ordered: readonly SystemDef[],
    edges: readonly number[][],
    names: ReadonlyMap<number, string>,
  ): SystemDef[][] {
    const access = ordered.map(accessSets);
    const indexOf = new Map<SystemDef, number>();
    ordered.forEach((def, i) => indexOf.set(def, i));
    const batchOf = new Array<number>(ordered.length).fill(-1);
    const batches: SystemDef[][] = [];

    for (let i = 0; i < ordered.length; i++) {
      const def = ordered[i];
      // Every DIRECT predecessor must be in a strictly earlier batch; transitivity follows.
      let target = 0;
      for (let p = 0; p < ordered.length; p++) {
        if (edges[p].includes(i)) target = Math.max(target, batchOf[p] + 1);
      }
      for (;;) {
        const group = batches[target];
        if (group === undefined) {
          batches[target] = [def];
          break;
        }
        const blocked = group.some(
          (member) => conflict(access[i], access[indexOf.get(member)!], names) !== null,
        );
        if (!blocked) {
          group.push(def);
          break;
        }
        target++;
      }
      batchOf[i] = target;
    }

    // Verify what we just built, so a bug in the batcher cannot silently produce a wrong plan.
    for (const group of batches) {
      for (let a = 0; a < group.length; a++) {
        for (let b = a + 1; b < group.length; b++) {
          const shared = conflict(
            access[indexOf.get(group[a])!],
            access[indexOf.get(group[b])!],
            names,
          );
          if (shared !== null) {
            throw new Error(
              `Schedule.batch("${stage}"): "${group[a].name}" and "${group[b].name}" were batched ` +
                `together but both touch ${shared}`,
            );
          }
        }
      }
    }
    for (let i = 0; i < ordered.length; i++) {
      for (const next of edges[i]) {
        if (batchOf[i] >= batchOf[next]) {
          throw new Error(
            `Schedule.batch("${stage}"): "${ordered[i].name}" must run before "${ordered[next].name}" ` +
              `but was batched no earlier`,
          );
        }
      }
    }

    return batches;
  }
}

/** A system's touched components/targets. `writes` implies read access, so a read/write pair
 *  conflicts once. */
function accessSets(def: SystemDef): AccessSets {
  const writes = new Set<number>((def.writes ?? []).map((component) => component.id));
  const reads = new Set<number>((def.reads ?? []).map((component) => component.id));
  for (const id of writes) reads.add(id);
  return {
    reads,
    writes,
    readsExternal: new Set(def.readsExternal ?? []),
    writesExternal: new Set(def.writesExternal ?? []),
  };
}

/** What the two systems share, described for an error message, or null when they are independent */
function conflict(a: AccessSets, b: AccessSets, names: ReadonlyMap<number, string>): string | null {
  for (const id of a.writes) {
    if (b.reads.has(id)) return `component "${names.get(id) ?? `#${id}`}"`;
  }
  for (const id of b.writes) {
    if (a.reads.has(id)) return `component "${names.get(id) ?? `#${id}`}"`;
  }
  for (const target of a.writesExternal) {
    if (b.readsExternal.has(target)) return `target "${target}"`;
  }
  for (const target of b.writesExternal) {
    if (a.readsExternal.has(target)) return `target "${target}"`;
  }
  for (const target of a.writesExternal) {
    if (b.writesExternal.has(target)) return `target "${target}"`;
  }
  return null;
}

function componentNames(systems: readonly SystemDef[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const def of systems) {
    for (const component of [...(def.reads ?? []), ...(def.writes ?? [])]) {
      names.set(component.id, component.name);
    }
  }
  return names;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
