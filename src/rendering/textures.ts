// ===== MC-style resource pack textures: built-in default.zip + user resource packs (folder or zip) override =====
// Priority (MC semantics): user packs in reverse directory-name order (later loaded wins) > built-in default.zip > built-in fallback
import { unzipSync } from "fflate";

const req = eval("require") as (id: string) => any;
const path = req("node:path");
const fs = req("node:fs");

// game\ root: process.execPath = game\core\core.exe -> parent is game\
const gameRoot = path.join(path.dirname(process.execPath), "..");
const packsDir = path.join(gameRoot, "resourcepacks");
const modsDir = path.join(gameRoot, "mods");  // Separate mods directory (higher priority than user resourcepacks)
const BUILTIN_NAME = "default.zip";

type Bytes = Uint8Array;

const overrides = new Map<string, Bytes>();
let builtin: Map<string, Bytes> | null = null;
let scanned = false;
// Pack layering (low priority first: builtin earliest, user packs in scan order): for registry-style JSON merged across packs
// (when several packs each carry blocks.json, single-value overrides keep only one — layering preserves every copy for priority merging)
const packLayers: Map<string, Bytes>[] = [];

function bytesToB64(bytes: Bytes): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
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

function readZip(file: string): Map<string, Bytes> {
  const map = new Map<string, Bytes>();
  try {
    const out = unzipSync(fs.readFileSync(file));
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

function walkDir(dir: string, base: string, cb: (rel: string, bytes: Bytes) => void): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
        // rel must be hand-joined with forward slashes, and base empty means no leading slash: path.join's Windows backslashes + empty-string concat "/blocks.json"
        // both mismatch the zip's path keys (forward-slash paths without a leading slash) -> the override chain cannot find them
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walkDir(full, rel, cb);
    else {
      const norm = normalizeKey(rel);  // Folder packs support the same assets/<ns>/ three-layer structure
      if (norm) cb(norm, fs.readFileSync(full));
    }
  }
}

/** Scan packs in a directory (zip files + folder packs) into layers low->high; a folder pack's name = pack root after stripping the base prefix */
function scanPackDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e: any) => e.name !== BUILTIN_NAME)
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const layer = new Map<string, Bytes>();
      walkDir(full, "", (rel, bytes) => {
        overrides.set(rel, bytes);
        layer.set(rel, bytes);
      });
      packLayers.push(layer);
    } else if (/\.zip$/i.test(e.name)) {
      const layer = readZip(full);
      for (const [rel, bytes] of layer) overrides.set(rel, bytes);
      packLayers.push(layer);
    }
  }
}

function scanPacks(): void {
  if (scanned) return;
  scanned = true;
  packLayers.length = 0;
    // The builtin layer enters first (lowest priority, overridden when user packs/mods merge)
  const builtinFile = path.join(packsDir, BUILTIN_NAME);
  if (fs.existsSync(builtinFile)) {
    builtin = readZip(builtinFile);
    if (builtin) packLayers.push(builtin);
  }
  scanPackDir(modsDir);  // mods directory (middle priority: content baseline, provides blocks.json/own textures)
  scanPackDir(packsDir);  // User resource packs (highest priority, MC semantics: packs are the final authority, can reskin mods/engine content)
}

/** Return the bytes of every pack containing the file, low->high priority (for merging registry files like blocks.json across packs); empty array = no pack has it */
export function resolveAllBytes(rel: string): Bytes[] {
  scanPacks();
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

/** Resolve raw bytes with resource-pack semantics (user packs > built-in default.zip, whole-file override); shared by non-texture resources like language files */
export function resolveBytes(rel: string): Bytes | null {
  scanPacks();
  return overrides.get(rel) ?? builtin?.get(rel) ?? null;
}

/** Resolve a texture with resource-pack semantics: resource pack/mod same-name file > procedural checkerboard; returns a data URL */
export function resolveTexture(rel: string): string {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  scanPacks();
  const bytes = overrides.get(rel) ?? builtin?.get(rel);
  const url = bytes ? `data:image/png;base64,${bytesToB64(bytes)}` : CHECKER_TEXTURE_URL;
  cache.set(rel, url);
  return url;
}

/** Whether the target texture is missing (no user pack/built-in pack has it) — used for transparency decisions */
export function textureMissing(rel: string): boolean {
  scanPacks();
  return !(overrides.get(rel) ?? builtin?.get(rel));
}

export interface PackInfo {
  name: string;
  builtin: boolean;
  fileCount: number;
}

/** List packs in the resource pack directory (built-in default.zip fixed last, user packs reverse-name order = priority high to low) */
export function listPacks(): PackInfo[] {
  const out: PackInfo[] = [];
  if (!fs.existsSync(packsDir)) return out;
  for (const e of fs.readdirSync(packsDir, { withFileTypes: true })) {
    if (e.name === BUILTIN_NAME) {
      out.push({ name: BUILTIN_NAME, builtin: true, fileCount: readZip(path.join(packsDir, e.name)).size });
      continue;
    }
    const full = path.join(packsDir, e.name);
    if (e.isDirectory()) {
      let n = 0;
      walkDir(full, e.name, () => n++);
      out.push({ name: e.name, builtin: false, fileCount: n });
    } else if (/\.zip$/i.test(e.name)) {
      out.push({ name: e.name, builtin: false, fileCount: readZip(full).size });
    }
  }
  return out.sort((a: any, b: any) => (a.builtin ? 1 : b.builtin ? -1 : b.name.localeCompare(a.name)));
}