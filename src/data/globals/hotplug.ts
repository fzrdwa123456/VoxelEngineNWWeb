// ===== The hot-plug SURFACES: which plugin a key toggles, and what to call it (P1.24) =====
// DATA, not wiring. The mechanism (`core/plugin/hotplug.ts`) knows how to install and uninstall a plugin;
// the CATALOGUE of plugins that may be plugged in belongs to the build; this table is the user-facing part
// of it — the key that toggles a surface and the name a toast shows. Keeping it here is what lets
// `ui.navigation` (a system in the ui lane) offer the key without knowing which plugins exist, and lets the
// command in `core/effect/commands.ts` name the outcome without importing a plugin.
//
// Adding a surface later means ONE line here plus one entry in the root's catalogue — which is the shape the
// next optional ui surfaces (`ui-keybind`, the toast, the backpack) are going to use.
export interface HotPlugSurface {
  /** The plugin id, exactly as `plugins.json` and `registry`/`installPlugins` spell it. */
  readonly id: string;
  /** The `KeyboardEvent.code` that toggles it. F-keys are safe: the bind table does not use them (F3/F4
   *  belong to the debug surface's own chord, and F1/F2/F5..F12 are free). */
  readonly key: string;
  /** What a toast and the log call it (developer-facing, so it stays the plugin id). */
  readonly label: string;
}

export const HOT_PLUG_SURFACES: readonly HotPlugSurface[] = [
  { id: "ui-crosshair", key: "F5", label: "ui-crosshair (the aiming reticle)" },
  { id: "ui-debug", key: "F8", label: "ui-debug (F3/F4 debug surface)" },
  { id: "ui-toast", key: "F10", label: "ui-toast (HUD message)" },
  { id: "ui-inventory", key: "F11", label: "ui-inventory (inventory + hotbar)" },
  { id: "ui-keybind", key: "F9", label: "ui-keybind (key bind page)" },
];

/** The surface a key code toggles, if any. The ui lane asks this per key EDGE. */
export function hotPlugSurfaceForKey(code: string): HotPlugSurface | undefined {
  return HOT_PLUG_SURFACES.find((surface) => surface.key === code);
}

/** A surface's label by plugin id — empty string for an id this table does not know. */
export function hotPlugLabel(id: string): string {
  return HOT_PLUG_SURFACES.find((surface) => surface.id === id)?.label ?? id;
}
