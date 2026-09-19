// ===== UI bindings: where a widget's VALUE comes from =====
// A widget may declare a SOURCE (UI_BIND) instead of owning a number. The table below maps a source id
// to a getter, and UiBindingSystem resolves every bound widget once per frame in the `ui` lane — the
// same shape as the action table in actions.ts (ids in, behaviour supplied by whoever owns the state).
//
// WHY THIS EXISTS. A slider that copies its value into itself drifts: the main menu and the pause menu
// each build their own settings panel, so each held its OWN copy of the frame cap, and the two could
// disagree with each other and with the value actually in force (they did — see ROADMAP). Declaring
// "my value comes from `fpsCap`" makes the shared state the only owner and the widget a projection of
// it, which is the same rule the rest of the UI follows: a surface writes data, the reconciler draws.
//
// WHAT A BINDING IS NOT: it does not format. A widget whose TEXT is composed ("60 FPS" vs the word for
// "unlimited") is a push, because formatting is surface logic; only the VALUE is derived. And a binding
// never writes the DOM — the reconciler does that, from the component.
import { defineResource, type Resource, type SystemAccess, type World } from "../World";
import { snapToRange, UI_BIND, UI_INPUT } from "./widgets";

/** A source returns the value in the WIDGET's own domain (the range the surface gave the slider), not
 *  in whatever units the shared state uses — the surface that owns both decides the mapping. */
export type UiSource = () => number;

export const UI_SOURCES: Resource<Map<string, UiSource>> = defineResource<Map<string, UiSource>>(
  "uiSources",
);

export function createUiSources(): Map<string, UiSource> {
  return new Map<string, UiSource>();
}

/** Register a source once per process. A duplicate id THROWS: two surfaces claiming one source is a
 *  wiring bug, and it is how "the other panel's slider never moves" would start. */
export function onUiSource(sources: Map<string, UiSource>, id: string, get: UiSource): void {
  if (sources.has(id)) throw new Error(`onUiSource: "${id}" is already registered`);
  sources.set(id, get);
}

/** Declared access: it reads what every widget declares and writes the resolved VALUE. */
export const UI_BINDING_ACCESS: SystemAccess = {
  reads: [UI_BIND, UI_INPUT],
  writes: [UI_INPUT],
};

/** Resolves bound widgets, once per frame, in the ui lane and BEFORE the reconciler. */
export class UiBindingSystem {
  private readonly sources: ReadonlyMap<string, UiSource>;
  /** Sources that were asked for and not found — logged once each, not every frame. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly world: World,
    private readonly log?: (line: string) => void,
  ) {
    this.sources = world.resource(UI_SOURCES);
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
