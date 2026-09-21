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
import { defineResource, type Resource } from "./ecs/World";

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

/** The registry as DATA: the merged block table and whether it has been built. It used to be a
 *  module-level `const registry` + `let loaded`. The object exists at import time (the packs are loaded
 *  before the World is built) and the composition root INSERTS it as BLOCK_REGISTRY, so the table has a
 *  name and an owner and a system (or a test) can read it instead of calling into this module. */
export interface BlockRegistryState {
  readonly byId: Map<string, BlockDef>;
  loaded: boolean;
}

export const BLOCK_REGISTRY: Resource<BlockRegistryState> =
  defineResource<BlockRegistryState>("blockRegistry");

const state: BlockRegistryState = { byId: new Map(), loaded: false };

/** The one instance, for the composition root to insert (and for this module's own readers). */
export function blockRegistryState(): BlockRegistryState {
  return state;
}

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
  if (state.loaded) return;
  // Do NOT build and do NOT set `loaded` before the packs are installed — that would cache a registry
  // holding nothing but FALLBACK_DEFS forever. The original needed no such test (fs is synchronous, the
  // packs are there when the module is evaluated); a Tauri pack arrives only through `await preloadPacks()`.
  if (!packsInstalled()) return;
  state.loaded = true;
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
    state.byId.set(id, defFrom(id, raw as RawDef));
  }
    logDebug(`BLOCKREG registry loaded: ${state.byId.size} blocks (${layers.length} layers of blocks.json) -> [${[...state.byId.keys()].join(", ")}]`);
}

export function getBlockDef(id: string): BlockDef | undefined {
  loadBlockRegistry();
  return state.byId.get(id);
}

/** All registered block ids (fills the inventory) */
export function allBlockIds(): string[] {
  loadBlockRegistry();
  return [...state.byId.keys()];
}
