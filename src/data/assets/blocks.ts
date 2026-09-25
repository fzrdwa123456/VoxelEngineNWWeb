// ===== THE BLOCK TABLE, as DATA the PACK CHAIN delivers (P1.37) =====
// Same shape as `languages.ts`, for the same reason: "which blocks does this install have" is CONTENT, and it
// used to be answered by `blockregistry.ts` itself, at CONFIG time, before the plugins install — so the
// content plugin had nothing to say about the engine's content and the table was built behind everyone's
// back. This module is the DISCOVERY half: it merges every `data/blocks.json` layer of the chain into plain
// entries. The content plugin contributes them (`SLOT_BLOCKS`) at INSTALL time, and `blockregistry.ts`
// assembles the engine-side definitions from what was DECLARED — the pack chain is still the source, the
// plugin is the statement, and the loader is their consumer (the shape P1.20 asked for).
//
// In-pack path (MC taxonomy): assets/<ns>/data/blocks.json  ->  normalized to `data/blocks.json`.
// Priority (low->high): mods < user resourcepacks (same id: the higher-priority layer wins).
import { packsInstalled, resolveAllBytes } from "./textures";

/** One block as a pack writes it: the id plus the raw fields. Fields a pack omits stay undefined, and the
 *  registry decides what that means (label falls back to the id, top/bottom to side). */
export interface BlockEntry {
  readonly id: string;
  readonly label?: string;
  /** Solid material (a CSS colour), used when no texture is set. */
  readonly color?: string;
  readonly top?: string;
  readonly side?: string;
  readonly bottom?: string;
  /** Shorthand for all three faces. */
  readonly all?: string;
}

/** Registered when the chain delivers NO block at all (the built-in mod was deleted): one `missing` block,
 *  so the inventory and the world always have something usable. It is a property of the DISCOVERY — "the
 *  pack chain is empty" — which is why it lives here rather than in the registry's assembly step. */
export const FALLBACK_BLOCK_ENTRIES: readonly BlockEntry[] = [
  { id: "missing", label: "Missing Block", side: "block/nonexistent.png" },
];

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** How many `data/blocks.json` layers the chain has (the boot line reports it: "0 layers" and "empty file"
 *  look identical in a block count, and they are different problems). */
export function discoveredBlockLayers(): number {
  return packsInstalled() ? resolveAllBytes("data/blocks.json").length : 0;
}

/** Every block the pack chain delivers, merged low->high priority (later layers win on the same id) in
 *  declaration order, or the FALLBACK set when the chain has no `data/blocks.json` at all.
 *
 *  Empty before the packs are installed — callers must not cache that answer (the registry does not: it is
 *  built once, from the DECLARATIONS, after the install). */
export function discoverBlockEntries(): BlockEntry[] {
  if (!packsInstalled()) return [];
  let merged: Record<string, Record<string, unknown>> = {};
  for (const bytes of resolveAllBytes("data/blocks.json")) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && typeof parsed === "object") {
        merged = { ...merged, ...(parsed as Record<string, Record<string, unknown>>) };
      }
    } catch {
            /* Bad json: ignore this layer, other layers unaffected */
    }
  }
  const entries: BlockEntry[] = [];
  for (const [id, raw] of Object.entries(merged)) {
    if (!raw || typeof raw !== "object") continue;
    entries.push({
      id,
      label: asStr(raw.label),
      color: asStr(raw.color),
      top: asStr(raw.top),
      side: asStr(raw.side),
      bottom: asStr(raw.bottom),
      all: asStr(raw.all),
    });
  }
  return entries.length > 0 ? entries : [...FALLBACK_BLOCK_ENTRIES];
}

/** The ids only — what the STARTING INVENTORY is seeded from.
 *
 *  The player entity is spawned BEFORE the plugins install, so it cannot ask the REGISTRY (which is built
 *  from the declarations): it asks the same discovery the content plugin declares FROM, which is why the two
 *  cannot disagree about what a starting inventory may contain. */
export function discoveredBlockIds(): string[] {
  return discoverBlockEntries().map((entry) => entry.id);
}
