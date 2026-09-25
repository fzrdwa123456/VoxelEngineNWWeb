// ===== Block registry: the engine-side table, ASSEMBLED from what the install DECLARED (P1.37) =====
// "The engine itself is a mod": built-in blocks and user content are on equal footing. The blocks come from
// `assets/<ns>/data/blocks.json` inside the packs (normalized to `data/blocks.json`), merged low->high
// priority — mods provide the content baseline, user resource packs reskin or override them (same id: the
// higher-priority pack wins), which is MC's semantics.
//
// WHAT CHANGED (P1.37) AND WHY IT MATTERS: this module used to read the pack chain ITSELF, in `loadBlockRegistry()`,
// at config time — i.e. "which blocks does this install have" was answered by a data module before the plugins
// were even installed, so content was not something a plugin could declare (the ROADMAP's P1.20 blocker). The
// TABLE is now assembled from the ENTRIES the content plugin contributed into `SLOT_BLOCKS` (which it
// discovered from the chain — see `data/assets/blocks.ts`), after the install. Same data, one owner, and the
// engine's content is a plugin's statement like the language set.
//
// Entry fields (as a pack writes them): label (display name, defaults to id) / color (solid material, CSS
// color) / top/side/bottom (texture paths, pack-root relative) / all (shorthand for all three faces); a
// referenced texture that no pack in the chain provides sets hasMissingTexture (neighbour faces are then not
// culled and alphaTest drops the fragments).
import { textureMissing } from "./textures";
import { FALLBACK_BLOCK_ENTRIES, type BlockEntry } from "./blocks";
import { defineResource, type Resource } from "../../core/world";

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

/** The registry as DATA: the assembled block table and whether it has been built. The object exists at
 *  import time and the composition root INSERTS it as BLOCK_REGISTRY, so the table has a name and an owner
 *  and a system (or a test) can read it instead of calling into this module. */
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

function defFrom(entry: BlockEntry): BlockDef {
  const side = entry.side ?? entry.all;
  const def: BlockDef = {
    id: entry.id,
    label: entry.label ?? entry.id,
    color: entry.color,
    side,
    top: entry.top ?? entry.all ?? side,
    bottom: entry.bottom ?? entry.all ?? side,
    hasMissingTexture: false,
  };
  def.hasMissingTexture = [def.top, def.side, def.bottom].some((p) => p !== undefined && textureMissing(p));
  return def;
}

/** ASSEMBLE the table from the DECLARED entries (the content plugin's `SLOT_BLOCKS`) and return the line
 *  describing it. THE FIRST CALL WINS: the table is built once, from what the install declared, and a later
 *  caller (a test, a second driver) reads the same table instead of rebuilding it.
 *
 *  An EMPTY declaration is not an error: it registers the discovery's fallback entry set (`missing`), the
 *  same rule the module always had for "the chain has no blocks.json" — extended to cover "no content plugin
 *  declared any block", so the inventory and the world still have something usable. */
export function buildBlockRegistry(entries: readonly BlockEntry[]): string {
  if (!state.loaded) {
    state.loaded = true;
    const list = entries.length > 0 ? entries : FALLBACK_BLOCK_ENTRIES;
    for (const entry of list) state.byId.set(entry.id, defFrom(entry));
  }
  return `BLOCKREG registry loaded: ${state.byId.size} blocks -> [${[...state.byId.keys()].join(", ")}]`;
}

/** One block's definition, or undefined when the install has no such block (every caller treats that as
 *  "unknown block": the inventory shows the checker, the icon baker uses its fallback). */
export function getBlockDef(id: string): BlockDef | undefined {
  return state.byId.get(id);
}

/** All registered block ids, in declaration order (what the inventory and the starting items are filled
 *  from). Empty until `buildBlockRegistry` has run — the build is the install's job, not a reader's. */
export function allBlockIds(): string[] {
  return [...state.byId.keys()];
}
