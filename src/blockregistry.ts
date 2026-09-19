// ===== Block registry: data-driven (data\blocks.json inside packs, merged across packs) =====
// "The engine itself is a mod": built-in blocks and user content are on equal footing.
// A mod (game\mods\<name>\) or resource pack carrying data\blocks.json adds blocks (distinct ids unioned)
// or overrides existing ones (same id: higher-priority pack wins). Priority (low->high): mods < user resourcepacks
// (MC semantics: resource packs are the final authority; mods provide the content baseline; players reskin mod blocks via packs).
// In-pack path (MC taxonomy): assets\<ns>\data\blocks.json (data goes in data\, sibling of textures\/lang\);
// normalized to the global path data/blocks.json.
// Entry fields: label (display name, defaults to id) / color (solid material, CSS color) / top/side/bottom (texture paths,
// pack-root relative) / all (shorthand for all three faces); a referenced texture that no pack in the chain provides sets hasMissingTexture (neighbour faces are then not culled and alphaTest drops the fragments).
import { packsInstalled, resolveAllBytes, textureMissing } from "./rendering/textures";
import { logDebug } from "./platform/shell";

export interface BlockDef {
  id: string;
  label: string;  // Display name (inventory tooltip)
  color?: string;  // Solid material (when no texture)
  top?: string;  // Texture path; top/bottom default to side
  side?: string;
  bottom?: string;
  /** Some referenced face texture is missing from the pack chain (the neighbour faces are then not
   *  culled and alphaTest drops the fragments). Named for its CAUSE: it says nothing about whether
   *  the block is see-through. */
  hasMissingTexture: boolean;
}

type RawDef = { label?: unknown; color?: unknown; top?: unknown; side?: unknown; bottom?: unknown; all?: unknown };

const registry = new Map<string, BlockDef>();
let loaded = false;

// Fallback: when no pack in the chain has blocks.json (built-in mod deleted), register only the missing block
// so the inventory/world set always has something usable (the built-in trio moved to mods\defaultmod.zip; the engine no longer bundles it)
const FALLBACK_DEFS: Record<string, RawDef> = {
    missing: { label: "Missing Block", side: "block/nonexistent.png" },
};

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function defFrom(id: string, raw: RawDef): BlockDef {
  const side = asStr(raw.side) ?? asStr(raw.all);
  const def: BlockDef = {
    id,
    label: asStr(raw.label) ?? id,
    color: asStr(raw.color),
    side,
    top: asStr(raw.top) ?? asStr(raw.all) ?? side,
    bottom: asStr(raw.bottom) ?? asStr(raw.all) ?? side,
    hasMissingTexture: false,
  };
  def.hasMissingTexture = [def.top, def.side, def.bottom].some((p) => p !== undefined && textureMissing(p));
  return def;
}

/** Loaded once at startup: merge every pack's blocks.json (low->high priority, later merges win on same id) */
export function loadBlockRegistry(): void {
  if (loaded) return;
  // 包还没装好之前**不建、也不置 loaded** —— 否则会把"只剩 FALLBACK_DEFS"的结果永久缓存住。
  // 原版不需要这个判断（fs 同步，模块求值时包就在）；Tauri 的包是 await preloadPacks() 才到的。
  if (!packsInstalled()) return;
  loaded = true;
  const layers = resolveAllBytes("data/blocks.json");
  let merged: Record<string, RawDef> = {};
  for (const bytes of layers) {
    try {
      const p = JSON.parse(new TextDecoder().decode(bytes));
      if (p && typeof p === "object") merged = { ...merged, ...p };
    } catch {
            /* Bad json: ignore this layer, other layers unaffected */
    }
  }
  if (!Object.keys(merged).length) merged = FALLBACK_DEFS;  // Empty-chain fallback
  for (const [id, raw] of Object.entries(merged)) {
    if (!raw || typeof raw !== "object") continue;
    registry.set(id, defFrom(id, raw as RawDef));
  }
    logDebug(`BLOCKREG registry loaded: ${registry.size} blocks (${layers.length} layers of blocks.json) -> [${[...registry.keys()].join(", ")}]`);
}

export function getBlockDef(id: string): BlockDef | undefined {
  loadBlockRegistry();
  return registry.get(id);
}

/** All registered block ids (fills the inventory) */
export function allBlockIds(): string[] {
  loadBlockRegistry();
  return [...registry.keys()];
}
