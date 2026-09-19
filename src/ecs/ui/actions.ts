// ===== The UI action table =====
// A clickable widget carries an ACTION: an id plus a value (see widgets.ts UI_ACTION). The id is looked
// up HERE — in a resource, not in the reconciler — so the reconciler stays generic: it knows how to
// deliver a click, not what a "settings panel" is. A surface registers its handlers during wiring and
// never has to import the system that renders it.
//
// WHY A TABLE INSTEAD OF A CALLBACK PER BUTTON: one handler serves a whole group
// (`lang` with value "zh"/"en"/"ja", `key` with the key code), which is what keeps a 104-key visual
// keyboard from needing 104 closures. It also gives the Node gate something to assert.
import { defineResource, type Resource } from "../World";

export type UiActionHandler = (value: string) => void;

export const UI_ACTIONS: Resource<Map<string, UiActionHandler>> = defineResource<Map<string, UiActionHandler>>(
  "uiActions",
);

export function createUiActions(): Map<string, UiActionHandler> {
  return new Map<string, UiActionHandler>();
}

/** Register an action handler. Wiring-time only, and a duplicate id THROWS: two surfaces claiming the
 *  same action is a wiring bug that would otherwise show up as "the other menu's button does nothing". */
export function onUiAction(
  actions: Map<string, UiActionHandler>,
  id: string,
  handler: UiActionHandler,
): void {
  if (actions.has(id)) throw new Error(`onUiAction: "${id}" is already registered`);
  actions.set(id, handler);
}

/** Deliver a click/input to its handler. An UNKNOWN id is a loud no-op rather than a throw: it means a
 *  widget declares an action nobody registered, and killing the click handler chain over it would break
 *  the whole UI. The log line names the action, which is what makes the wiring bug findable. */
export function dispatchUiAction(
  actions: ReadonlyMap<string, UiActionHandler>,
  id: string,
  value: string,
  log?: (line: string) => void,
): void {
  const handler = actions.get(id);
  if (!handler) {
    log?.(`UI action "${id}" has no handler (value="${value}")`);
    return;
  }
  handler(value);
}
