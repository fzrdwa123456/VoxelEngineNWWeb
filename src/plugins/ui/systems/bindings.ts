// ===== ui.bindings: resolve every BOUND widget's value from its source, once per frame =====
// The DATA (the source table) is `data/globals/sources.ts`; this is the behaviour that reads it. The
// resolver never writes the DOM — the reconciler does — and it snaps the source's value onto the
// widget's own range (the range is presentation, the number is shared state).
import type { SystemAccess, World } from "../../../core/world";
import { UI_PAINT, type UiBindingsPaint } from "../../../data/globals/paint";
import { UI_SOURCES, type UiSource } from "../../../data/globals/sources";
import { snapToRange, UI_BIND, UI_INPUT } from "../components";

/** Declared access: it reads what every widget declares and writes the resolved VALUE. */
export const UI_BINDING_ACCESS: SystemAccess = {
  reads: [UI_BIND, UI_INPUT],
  writes: [UI_INPUT],
};

/** Resolves bound widgets, once per frame, in the ui lane and BEFORE the reconciler. */
export class UiBindingSystem {
  private readonly sources: ReadonlyMap<string, UiSource>;
  /** Sources that were asked for and not found — logged once each, not every frame. The set lives in
   *  UI_PAINT.bindings (data/globals/paint.ts): a "what did I already say" cache is world data too. */
  private readonly paint: UiBindingsPaint;
  private get reported(): Set<string> {
    return this.paint.reported;
  }

  constructor(
    private readonly world: World,
    private readonly log?: (line: string) => void,
  ) {
    this.sources = world.resource(UI_SOURCES);
    this.paint = world.resource(UI_PAINT).bindings;
  }

  /** How many widgets are bound (diagnostics / the Node gate) */
  get boundCount(): number {
    return this.world.query(UI_BIND, UI_INPUT).entities().length;
  }

  step(): void {
    for (const entity of this.world.query(UI_BIND, UI_INPUT).entities()) {
      const bind = this.world.get(entity, UI_BIND);
      const input = this.world.get(entity, UI_INPUT);
      if (!bind || !input) continue;
      const get = this.sources.get(bind.source);
      if (!get) {
        // A loud no-op, once per source: an unregistered source leaves the widget where it is instead
        // of crashing the lane, but it must not be silent — this is a wiring bug.
        if (!this.reported.has(bind.source)) {
          this.reported.add(bind.source);
          this.log?.(`UI source "${bind.source}" has no provider (widget ${entity})`);
        }
        continue;
      }
      const value = snapToRange(get(), input);
      // Write only on change: the reconciler diffs against the last value it wrote, so an unchanged
      // value costs nothing and a value the user is dragging is not fought.
      if (input.value !== value) input.value = value;
    }
  }
}
