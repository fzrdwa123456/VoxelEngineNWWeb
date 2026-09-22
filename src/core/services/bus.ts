// ===== The configuration CHANGE BUS =====
// A configuration value (language, font, UI scale, key binds) lives in its resource under `data/`, and the
// modules that own those values are data-only: they write the value and nothing else. What is left is the
// NOTIFICATION half — "who has to be told that it changed" — and that is behaviour: it holds callbacks and
// invokes them. It lives here, in the host, next to its two subscribers, not inside the data modules:
//
//   * persistence — the composition root saves settings.json when any of them changes
//   * legacy label refreshes — the settings panel re-pushes the few labels composed from a VALUE
//     ("60 FPS", "1.25x") that cannot be an i18n key re-derived by the reconciler every frame
//
// Why it is not a system: the notification has to leave the module that changed the value IMMEDIATELY (a
// language switch must repaint before the next frame, and a save must not wait for a lane), and a system
// cannot be paged from outside the loop. The bus is the smallest thing that keeps the data modules free
// of behaviour while the subscribers stay exactly where the effects belong.

/** The configuration values that can raise a change notification. */
export type ConfigKind = "lang" | "font" | "uiScale" | "binds";

const listeners: Record<ConfigKind, Set<() => void>> = {
  lang: new Set(),
  font: new Set(),
  uiScale: new Set(),
  binds: new Set(),
};

/** Subscribe to one configuration value's changes (the composition root saves; the settings panel
 *  refreshes its value-composed labels). */
export function onConfigChange(kind: ConfigKind, cb: () => void): void {
  listeners[kind].add(cb);
}

/** Tell the subscribers a configuration value just changed. Called by the module that OWNS the value,
 *  right after it wrote the resource — never by a reader. */
export function notifyConfigChange(kind: ConfigKind): void {
  listeners[kind].forEach((cb) => cb());
}
