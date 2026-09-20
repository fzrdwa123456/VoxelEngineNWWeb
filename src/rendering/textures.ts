// ===== MC-style resource pack textures: built-in default.zip + user resource packs (folder or zip) override =====
// Priority (MC semantics): user packs in reverse directory-name order (later loaded wins) > built-in default.zip > built-in fallback
//
// **The only Tauri-side change is where the packs COME FROM**:
//   the original listed resourcepacks/ and mods/, read files and unzipped archives itself through node:fs;
//   here a single `await preloadPacks()` at startup fetches everything from Rust (src-tauri/src/packs.rs),
//   and `resolveTexture()`/`resolveBytes()` stay **synchronous** afterwards, so no call site (blockregistry,
//   i18n, blockicons, inventory...) changed a line.
//
// The split is deliberate: Rust only lists directories and reads bytes (what Node's fs did), while the MC
// namespace normalization / priority / layering all stay below — that is pure logic, and `check:ecs` covers
// it. The zip is still unpacked by fflate on the front end (Rust does not unzip, saving a dependency).
import { unzipSync } from "fflate";
import { invoke } from "@tauri-apps/api/core";

import { logDebug } from "../platform/shell";

type Bytes = Uint8Array;

/** The shape Rust's `preload_packs` returns (serde's camelCase) */
interface PackEntryPayload {
  name: string;
  builtin: boolean;
  /** Folder pack: relative path -> base64 */
  files: Record<string, string>;
  /** Zip pack: base64 of the whole archive (unpacked by fflate on the front end) */
  zipB64?: string;
}

interface PackSnapshotPayload {
  builtin: PackEntryPayload | null;
  mods: PackEntryPayload[];
  resourcepacks: PackEntryPayload[];
}

const overrides = new Map<string, Bytes>();
let builtin: Map<string, Bytes> | null = null;
let scanned = false;
/** Whether `preloadPacks()` has finished. Until it has, every resolution takes the engine fallback and
 *  **writes no cache** — otherwise the "missing texture" answered the first time is cached forever and
 *  can never change once the packs are installed. */
let installed = false;
// Pack layering (low priority first: builtin earliest, user packs in scan order): for registry-style JSON merged across packs
// (when several packs each carry blocks.json, single-value overrides keep only one — layering preserves every copy for priority merging)
const packLayers: Map<string, Bytes>[] = [];
/** Pack info for the resourcepacks directory only (no mods — the original `listPacks()` listed that one
 *  directory too) */
const resourcepackInfos: PackInfo[] = [];
let builtinInfo: PackInfo | null = null;
let warnedNotInstalled = false;

function bytesToB64(bytes: Bytes): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Bytes {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ===== MC-style namespace normalization =====
// In-pack path convention: assets/<namespace>/<path> (e.g. assets/minecraft/textures/block/dirt.png).
// On load, strip assets/ and the namespace layer (plus the optional textures/ category layer, MC convention), normalizing to a global path:
//   assets/voxel/textures/block/dirt.png  ->  block/dirt.png   (full MC structure)
//   assets/voxel/block/dirt.png           ->  block/dirt.png   (textures layer omitted)
//   block/dirt.png                        ->  block/dirt.png   (flat structure)
// All three structures are equivalent; non-texture classes like lang/sounds have no textures layer, stripped the same way without harm.
// Consumers (resolveTexture/resolveBytes) always use normalized paths, unaware of namespaces and the textures layer
function normalizeKey(name: string): string | null {
  const rel = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) return null;
  const parts = rel.split("/");
  if (parts[0] === "assets" && parts.length >= 3) {
    const rest = parts.slice(2);  // Strip assets/ and the namespace layer
        // Strip the optional textures/ category layer (MC: assets/<ns>/textures/... is the standard home for image assets)
    if (rest[0] === "textures" && rest.length >= 2) return rest.slice(1).join("/");
    return rest.join("/");
  }
  return rel;  // Flat structure kept as-is (incl. unconventional layouts like files directly under assets/)
}

/** One pack -> a normalized path:bytes table (the original's `readZip()`/`walkDir()` merged into one,
 *  except the bytes come from Rust rather than fs) */
function decodePack(entry: PackEntryPayload): Map<string, Bytes> {
  const map = new Map<string, Bytes>();
  if (entry.zipB64) {
    try {
      const out = unzipSync(b64ToBytes(entry.zipB64));
      for (const [name, data] of Object.entries(out)) {
        if (!data) continue;
        const rel = normalizeKey(name);
        if (rel) map.set(rel, data);
      }
    } catch {
        // Bad packs ignored; other packs unaffected
    }
    return map;
  }
  for (const [name, b64] of Object.entries(entry.files)) {
    const rel = normalizeKey(name);  // Folder packs support the same assets/<ns>/ three-layer structure
    if (rel) map.set(rel, b64ToBytes(b64));
  }
  return map;
}

/** Install one pack into the override chain (the three lines of the original `scanPackDir` loop body) */
function installEntry(entry: PackEntryPayload, listInfos: boolean): void {
  const layer = decodePack(entry);
  for (const [rel, bytes] of layer) overrides.set(rel, bytes);
  packLayers.push(layer);
  if (listInfos) resourcepackInfos.push({ name: entry.name, builtin: false, fileCount: layer.size });
}

/** Install one directory's entries. Rust hands them over in **ascending name order** and this walks them
 *  backwards (later loaded = higher priority) — the original `scanPackDir` loop. */
function installDir(entries: PackEntryPayload[]): void {
  for (let i = entries.length - 1; i >= 0; i--) installEntry(entries[i], false);
}

/** Called once at startup: install every pack Rust scanned, into memory */
export function installPacks(snap: PackSnapshotPayload): void {
  for (const layer of packLayers) layer.clear();
  packLayers.length = 0;
  overrides.clear();
  resourcepackInfos.length = 0;
  resourcepackInfos.length = 0;
  resourcepackInfos.length = 0;
  scanCache.clear();
  builtin = null;
  builtinInfo = null;

    // The builtin layer enters first (lowest priority, overridden when user packs/mods merge)
  if (snap.builtin) {
    builtin = decodePack(snap.builtin);
    packLayers.push(builtin);
    builtinInfo = { name: snap.builtin.name, builtin: true, fileCount: builtin.size };
  }
  installDir(snap.mods);  // mods directory (middle priority: content baseline, provides blocks.json/own textures)
  for (let i = snap.resourcepacks.length - 1; i >= 0; i--) installEntry(snap.resourcepacks[i], false);
  // Entry info for resourcepacks (used by listPacks): ascending name order in, so walk it backwards
  for (let i = snap.resourcepacks.length - 1; i >= 0; i--) {
    const e = snap.resourcepacks[i];
    const layer = packLayers[packLayers.length - (snap.resourcepacks.length - i)];
    if (layer) resourcepackInfos.push({ name: e.name, builtin: false, fileCount: layer.size });
  }
  installed = true;
  scanned = true;
}

/** Whether `preloadPacks()` has finished.
 *
 *  **Every place that reads the packs at module scope or on first call and caches the result must ask
 *  this first**: i18n's three dictionaries, blockregistry's registry, background's menu-background
 *  answer. The original needed no such test — `fs.readFileSync` is synchronous, so the packs are on
 *  disk when the module is evaluated; a Tauri pack arrives only through `await preloadPacks()`, and an
 *  ESM import is evaluated before the module body, so copying the original caches an EMPTY result
 *  forever (that was the first release's bug: dictionaries at zh=0 en=0 ja=0, and the UI showed raw
 *  keys such as `menu.paused`). */
export function packsInstalled(): boolean {
  return installed;
}

/** Startup preload: awaited once at the top of main.ts. A failure is not fatal — every resolution then
 *  takes the engine fallback (the magenta/black checkerboard) */
export async function preloadPacks(): Promise<void> {
  try {
    const snap = await invoke<PackSnapshotPayload>("preload_packs");
    installPacks(snap);
    logDebug(
      `PACKS installed: builtin=${snap.builtin ? 1 : 0} mods=${snap.mods.length} ` +
        `resourcepacks=${snap.resourcepacks.length} files=${overrides.size}`,
    );
  } catch (e) {
    logDebug(`PACKS preload failed (engine fallbacks only): ${String(e)}`);
  }
}

function scanPacks(): void {
  if (scanned) return;
  scanned = true;
  if (!installed && !warnedNotInstalled) {
    warnedNotInstalled = true;
    logDebug("PACKS not installed yet (preloadPacks() has not finished) — falling back to the engine's built-ins for this resolution, not caching it");
  }
}

/** Return the bytes of every pack containing the file, low->high priority (for merging registry files like blocks.json across packs); empty array = no pack has it */
export function resolveAllBytes(rel: string): Bytes[] {
  scanPacks();
  if (!installed) return [];
  const out: Bytes[] = [];
  for (const layer of packLayers) {
    const b = layer.get(rel);
    if (b) out.push(b);
  }
  return out;
}

// Missing-texture fallback: a procedural 2x2 magenta/black checkerboard PNG (magenta FF00FF and black diagonals), hardcoded data URL.
// Engine-bundled fallback; deleting resource packs never loses it; cannot be overridden — missing resource = always shows this checkerboard
export const CHECKER_TEXTURE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z/CfAQKALAAb8gP9tnmFggAAAABJRU5ErkJggg==";

const cache = new Map<string, string>();
const scanCache = new Map<string, string>();

/** Resolve raw bytes with resource-pack semantics (user packs > built-in default.zip, whole-file override); shared by non-texture resources like language files */
export function resolveBytes(rel: string): Bytes | null {
  scanPacks();
  if (!installed) return null;
  return overrides.get(rel) ?? builtin?.get(rel) ?? null;
}

/** Resolve a texture with resource-pack semantics: resource pack/mod same-name file > procedural checkerboard; returns a data URL */
export function resolveTexture(rel: string): string {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  scanPacks();
  if (!installed) return CHECKER_TEXTURE_URL;  // No cache write: the key must be able to change after install
  const bytes = overrides.get(rel) ?? builtin?.get(rel);
  const url = bytes ? `data:image/png;base64,${bytesToB64(bytes)}` : CHECKER_TEXTURE_URL;
  cache.set(rel, url);
  return url;
}

/** Whether the target texture is missing (no user pack/built-in pack has it) — used for transparency decisions */
export function textureMissing(rel: string): boolean {
  scanPacks();
  if (!installed) return true;
  return !(overrides.get(rel) ?? builtin?.get(rel));
}

export interface PackInfo {
  name: string;
  builtin: boolean;
  fileCount: number;
}

/** List packs in the resource pack directory (built-in default.zip fixed last, user packs reverse-name order = priority high to low) */
export function listPacks(): PackInfo[] {
  scanPacks();
  const out = [...resourcepackInfos];
  if (builtinInfo) out.push(builtinInfo);
  return out.sort((a, b) => (a.builtin ? 1 : b.builtin ? -1 : b.name.localeCompare(a.name)));
}
