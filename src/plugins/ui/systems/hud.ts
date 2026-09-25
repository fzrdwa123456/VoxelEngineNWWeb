// ===== ui.hud: the HUD HOST — which gameplay widgets EXIST, and whether they are visible =====
// The crosshair and the hotbar were spawned VISIBLE during wiring and no system ever wrote their
// visibility, so they were up in EVERY mode — the main menu, the pause menu (where the hotbar even
// draws ABOVE that menu's root: z-index 31 against 30) and behind the loading screen. The hotbar's
// slots were clickable there too, i.e. a menu click could change the selected slot. The old code had no
// notion of "these belong to a world": the only gate in the engine was `canControl()`, and that says
// what the MOUSE does, not which UI is on screen.
//
// TWO JOBS, and both are the host's (P1.34):
//   1. LIFETIME — an element is MOUNTED when the table lists it and TAKEN DOWN (disposed + despawned,
//      whole subtree) when it is gone. Both are STRUCTURAL changes, so both travel through the ui lane's
//      one deferral, `UiLayoutOp`, and happen at a barrier: a system may not spawn or despawn (iron
//      rule 1). A plugin installed at runtime therefore gets its HUD element within a frame, and
//      uninstalling it leaves nothing behind — the residue trap the rubber band and the toast taught us,
//      solved once for every element.
//   2. VISIBILITY — `gate`, each element's own predicate. The host asks the LIVE element (the table is
//      rebuilt every frame), so a gate that closes on its own — "the inventory layer is not installed" —
//      needs no rebuild and no re-install.
//
// WHY A SEPARATE SYSTEM: the visibility answer is one predicate per element applied to its widgets, and
// it belongs next to the widgets it gates rather than inside the inventory view (which is about the
// bag's CONTENT) or inside ui.picker (which owns the F3 panel and the mode chord). It lives in the ui
// lane because it writes widget data, and it is the FIRST system of that lane: it is a gate on what the
// rest of the lane may show.
//
// It does NOT own the F3 panel or the picker panel: those are a game SESSION's UI (F3 was pressed in a
// world), and `ui.picker` hides them itself when it sees that no world is running. And it deliberately
// does not touch the toast: a main-menu message is a documented case (the multiplayer placeholder is
// drawn by the menu frame), so "gameplay UI" here means the HUD that mirrors a running world.
import type { Entity, SystemAccess, World } from "../../../core/world";
import { UI_HUD_PAINTED, type HudPainted, type UiHudElement } from "../../../data/globals/ui-hud";
import { UiLayoutOp } from "../../../data/globals/ui-pages";
import { setUiVisible, subtreeOf, UI_STATE } from "../components";

/** It writes the HUD roots' visibility and nothing else (the mounts are commands, not component writes). */
export const UI_HUD_ACCESS: SystemAccess = {
  writes: [UI_STATE],
};

export interface HudDeps {
  /** Every HUD element in force right now: the ones plugins contributed (`SLOT_UI_HUD`) plus the core's own,
   *  late-bound through the root's registry getter. Each carries ITS OWN gate — that is the whole point. */
  readonly elements: () => readonly UiHudElement[];
  /** Where a failed `build` is reported (the root's debug log). */
  readonly log: (line: string) => void;
}

export class UiHudSystem {
  /** What this host mounted last frame, by element id (world data — see UI_HUD_PAINTED). */
  private readonly painted: Map<string, HudPainted>;
  /** Elements whose mount command is queued but not applied yet. Without this, the frames between the send
   *  and the barrier would each send ANOTHER mount and build the widgets twice. */
  private readonly mounting = new Set<string>();
  /** Elements whose `build` THREW. They are not retried: a build that failed once fails on every frame, and
   *  in the page host that exact shape turned one bad line into a flood of `frame error`s. A re-install
   *  clears the record (the element is gone from the table, so `retire()` forgets it). */
  private readonly broken = new Set<string>();

  constructor(
    private readonly world: World,
    private readonly deps: HudDeps,
  ) {
    this.painted = world.resource(UI_HUD_PAINTED);
  }

  /** ui lane, once per frame: take down what went away, mount what is new, then paint every element from
   *  its own gate. The mounts and the despawns are DEFERRED — that is the whole mechanism. */
  step(): void {
    const live = [...this.deps.elements()].sort((a, b) => a.order - b.order);
    const ids = new Set(live.map((el) => el.id));
    this.retire(ids);
    // A failed build is not retried while its element stays in the table; when the element DISAPPEARS
    // (uninstalled) the record is dropped, so installing it again gets a clean attempt.
    for (const id of [...this.broken]) if (!ids.has(id)) this.broken.delete(id);
    this.mount(live);
    for (const el of live) {
      const mounted = this.painted.get(el.id);
      if (!mounted) continue; // queued, or its build failed: there is nothing to write yet
      const visible = el.gate();
      for (const root of mounted.roots) setUiVisible(this.world, root, visible);
    }
  }

  /** WHAT WENT AWAY: forget it here (so it is not painted again and the remount is possible) and let the
   *  BARRIER dispose of it and despawn its widgets. A top-level element is not enough: the whole SUBTREE
   *  goes, because a despawn does not cascade. */
  private retire(present: ReadonlySet<string>): void {
    for (const [id, mounted] of [...this.painted]) {
      if (present.has(id)) continue;
      this.painted.delete(id);
      this.broken.delete(id);
      this.world.commands.send(UiLayoutOp, {
        apply: (world) => {
          mounted.element.dispose?.();
          for (const root of mounted.roots) {
            for (const e of subtreeOf(world, root)) world.despawn(e);
          }
          this.deps.log(`HUD element unmounted ${id}`);
        },
      });
    }
  }

  /** WHAT IS MISSING: an element the host has never mounted is built at the NEXT barrier. An element that
   *  brings its own pre-spawned `roots` is adopted right here — no structure changes, so no deferral. */
  private mount(live: readonly UiHudElement[]): void {
    for (const el of live) {
      if (this.painted.has(el.id) || this.mounting.has(el.id) || this.broken.has(el.id)) continue;
      if (el.roots) {
        this.painted.set(el.id, { element: el, roots: el.roots });
        continue;
      }
      const build = el.build;
      if (!build) continue; // neither form: not mountable (see the element table's contract)
      this.mounting.add(el.id);
      this.world.commands.send(UiLayoutOp, {
        apply: (world) => {
          this.mounting.delete(el.id);
          let roots: readonly Entity[];
          try {
            roots = build({ world, log: this.deps.log });
          } catch (error) {
            // FAILURE ISOLATION: logged once, never retried, and it must not kill the lane that paints every
            // other surface (or boot).
            this.broken.add(el.id);
            this.deps.log(`HUD element FAILED ${el.id}: ${String((error as Error)?.message ?? error)}`);
            return;
          }
          // Recorded only now, i.e. only for a build that SUCCEEDED: an unrecorded mount is what gets retried.
          this.painted.set(el.id, { element: el, roots });
          this.deps.log(`HUD element mounted ${el.id}`);
        },
      });
    }
  }
}
