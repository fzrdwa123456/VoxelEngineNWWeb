// ===== MC-style resource pack textures: built-in default.zip + user resource packs (folder or zip) override =====
// Priority (MC semantics): user packs in reverse directory-name order (later loaded wins) > built-in default.zip > built-in fallback
//
// **Tauri 版的改动只有"包从哪来"这一层**：
//   原版自己用 node:fs 去 resourcepacks/ 和 mods/ 列目录、读文件、解 zip；
//   这里改成启动时 `await preloadPacks()` 一次性从 Rust 取（src-tauri/src/packs.rs），
//   之后 resolveTexture()/resolveBytes() 依旧是**同步**的，所有调用点（blockregistry、i18n、
//   blockicons、inventory...）一行都没动。
//
// 分工是刻意的：Rust 只做"列目录 + 读字节"（Node 的 fs 干的那点事），
// MC 命名空间归一化 / 优先级 / layering 全部留在下面 —— 那是纯逻辑，check:ecs 也覆盖着它。
// zip 仍然由前端的 fflate 解（Rust 不解 zip，省一个依赖）。
import { unzipSync } from "fflate";
import { invoke } from "@tauri-apps/api/core";

import { logDebug } from "../platform/shell";

type Bytes = Uint8Array;

/** Rust `preload_packs` 返回的形状（serde 的 camelCase） */
interface PackEntryPayload {
  name: string;
  builtin: boolean;
  /** 文件夹包：相对路径 -> base64 */
  files: Record<string, string>;
  /** zip 包：整个 zip 的 base64（前端 fflate 解） */
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
/** preloadPacks() 跑完了没。没跑完之前所有解析都走引擎兜底，并且**不写缓存** —— 
 *  否则第一次问到的"缺贴图"会被永久缓存住，装包之后再也不会变。 */
let installed = false;
// Pack layering (low priority first: builtin earliest, user packs in scan order): for registry-style JSON merged across packs
// (when several packs each carry blocks.json, single-value overrides keep only one — layering preserves every copy for priority merging)
const packLayers: Map<string, Bytes>[] = [];
/** resourcepacks 目录的包信息（不含 mods —— 原版 listPacks() 也只列这一个目录） */
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

/** 一个包 -> 归一化后的 路径:字节 表（原版 readZip()/walkDir() 的合体，只是字节来自 Rust 而不是 fs） */
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

/** 把一个包装进覆盖链（原版 scanPackDir 循环体里的那三行） */
function installEntry(entry: PackEntryPayload, listInfos: boolean): void {
  const layer = decodePack(entry);
  for (const [rel, bytes] of layer) overrides.set(rel, bytes);
  packLayers.push(layer);
  if (listInfos) resourcepackInfos.push({ name: entry.name, builtin: false, fileCount: layer.size });
}

/** 把一个目录的条目装进来。Rust 按**名字升序**给，这里从后往前（后加载的优先级高）—— 原版 scanPackDir 的循环。 */
function installDir(entries: PackEntryPayload[]): void {
  for (let i = entries.length - 1; i >= 0; i--) installEntry(entries[i], false);
}

/** 启动时调一次：把 Rust 扫到的所有包装进内存 */
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
  // resourcepacks 的条目信息（listPacks 用）：名字升序进来的，从后往前推
  for (let i = snap.resourcepacks.length - 1; i >= 0; i--) {
    const e = snap.resourcepacks[i];
    const layer = packLayers[packLayers.length - (snap.resourcepacks.length - i)];
    if (layer) resourcepackInfos.push({ name: e.name, builtin: false, fileCount: layer.size });
  }
  installed = true;
  scanned = true;
}

/** preloadPacks() 跑完了没。
 *
 *  **所有"在模块作用域或首次调用时读包，并把结果缓存下来"的地方都必须先问这一句**：
 *  i18n 的三本词典、blockregistry 的注册表、background 的菜单背景结论。
 *  原版这里不需要问 —— `fs.readFileSync` 是同步的，模块求值时包就在磁盘上；
 *  Tauri 的包要 `await preloadPacks()` 才到，而 ESM 的 import 在模块体之前求值，
 *  照搬原版就会把"空结果"永久缓存住（第一版就是这个 bug：词典 zh=0 en=0 ja=0，
 *  界面把 `menu.paused` 这种原始 key 直接显示出来了）。 */
export function packsInstalled(): boolean {
  return installed;
}

/** 启动预载：main.ts 顶部 await 一次。失败不致命 —— 所有解析走引擎兜底（洋红/黑棋盘）*/
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
    logDebug("PACKS not installed yet (preloadPacks() 还没跑完) — 本次解析走引擎兜底，不写缓存");
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
  if (!installed) return CHECKER_TEXTURE_URL;  // 不写缓存：装包之后同一个 key 要能变
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
