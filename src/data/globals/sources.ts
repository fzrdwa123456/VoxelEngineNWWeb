// ===== UI bindings: the SOURCE TABLE, as data =====
// A widget may declare a SOURCE (UI_BIND) instead of owning a number. This table maps a source id to a
// getter; `logic/ui/bindings.ts` resolves every bound widget once per frame in the `ui` lane — the same
// shape as the action table (data/globals/actions.ts: ids in, behaviour supplied by whoever owns the
// state).
//
// WHY THIS EXISTS. A slider that copies its value into itself drifts: the main menu and the pause menu
// each build their own settings panel, so each held its OWN copy of the frame cap, and the two could
// disagree with each other and with the value actually in force (they did). Declaring "my value comes
// from `fpsCap`" makes the shared state the only owner and the widget a projection of it, which is the
// same rule the rest of the UI follows: a surface writes data, the reconciler draws.
//
// WHAT A BINDING IS NOT: it does not format. A widget whose TEXT is composed ("60 FPS" vs the word for
// "unlimited") is surface logic and stays a pushed label — the resolver never writes the DOM, the
// reconciler does, and a missing source is a LOUD no-op (logged once), not a crash.
import { defineResource, type Resource } from "../../core/world";

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

// ===== The source IDS =====

/** The frame cap's source. Both settings panels' sliders BIND to this instead of holding their own copy,
 *  which is what stopped them from drifting away from the value in force. */
export const SOURCE_FPS_CAP = "fpsCap";
