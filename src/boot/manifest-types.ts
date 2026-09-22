// ===== The manifest's shape =====
// Cut out of `manifest.ts` for the same reason `core/services/settings-diff.ts` was cut out of the shell:
// `manifest.ts` itself is import-safe, but the SHAPE has to be importable by the Node gate (and by a
// future editor UI) without dragging anything else in.
export interface PluginManifestEntry {
  readonly id: string;
  readonly enabled: boolean;
}

export interface PluginManifest {
  readonly plugins: readonly PluginManifestEntry[];
}
