// ===== The plugin manifest: which plugins this install runs =====
// The manifest is DATA, and it is the one piece of the plugin system a player can edit. It is read from
// the PACK CHAIN like every other content file (a resource pack or a mod may ship `plugins.json`; the
// highest-priority layer wins), and it is never allowed to break the boot:
//
//   * no file            → the built-in default list below
//   * unparsable / wrong shape → logged and IGNORED, the default list is used
//   * an id the engine does not have → logged as unknown, the rest still applies
//   * a plugin the manifest does not mention → enabled iff it is in the default list
//
// Turning a plugin off means its systems are never registered (the composition root asks
// `installOutcome.has(id)` before contributing them), which is the cheapest honest form of "pluggable":
// a subsystem that is not wanted costs nothing and cannot break the boot.
import type { PluginManifest } from "./manifest-types";
export type { PluginManifest, PluginManifestEntry } from "./manifest-types";

/** The file the pack chain is searched for (a mod or a resource pack may ship one). */
export const MANIFEST_FILE = "plugins.json";

/** The plugins this engine installs when nothing says otherwise. */
export const DEFAULT_PLUGINS: readonly string[] = ["world", "player", "render", "diagnostics", "ui", "input"];

export function defaultManifest(): PluginManifest {
  return { plugins: DEFAULT_PLUGINS.map((id) => ({ id, enabled: true })) };
}

/** Parse a manifest. Returns null when the value cannot be used at all (the caller keeps the default). */
export function parseManifest(raw: unknown): PluginManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const list = (raw as { plugins?: unknown }).plugins;
  if (!Array.isArray(list)) return null;
  const plugins: { id: string; enabled: boolean }[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      plugins.push({ id: entry, enabled: true });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    const enabled = (entry as { enabled?: unknown }).enabled;
    plugins.push({ id, enabled: enabled !== false });
  }
  return plugins.length > 0 ? { plugins } : null;
}

/** Read the manifest out of the pack chain's layers (the LAST layer that parses wins). */
export function readManifest(
  layers: readonly Uint8Array[],
  log: (line: string) => void,
): { readonly manifest: PluginManifest; readonly source: string } {
  for (let i = layers.length - 1; i >= 0; i--) {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(layers[i]));
    } catch {
      log(`${MANIFEST_FILE}: layer ${i + 1} is not valid JSON — ignoring it`);
      continue;
    }
    const manifest = parseManifest(raw);
    if (!manifest) {
      log(`${MANIFEST_FILE}: layer ${i + 1} has no usable "plugins" array — ignoring it`);
      continue;
    }
    return { manifest, source: `pack layer ${i + 1}/${layers.length}` };
  }
  return { manifest: defaultManifest(), source: layers.length > 0 ? "built-in (pack copy unusable)" : "built-in" };
}

/** Is this plugin wanted? An unmentioned plugin follows the built-in default list. */
export function isEnabled(manifest: PluginManifest, id: string): boolean {
  const entry = manifest.plugins.find((p) => p.id === id);
  if (entry) return entry.enabled;
  return DEFAULT_PLUGINS.includes(id);
}

/** The ids a manifest mentions that this engine does not know (logged at boot; a newer file is fine). */
export function unknownPlugins(manifest: PluginManifest, known: readonly string[]): readonly string[] {
  return manifest.plugins.map((p) => p.id).filter((id) => !known.includes(id));
}
