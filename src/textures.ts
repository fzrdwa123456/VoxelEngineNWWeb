// ===== MC 式资源包贴图: 内置 default.zip + 用户资源包(文件夹或 zip) 覆盖 =====
// 优先级(MC 语义): 用户包按目录名字典序倒序(后放的胜) > 内置 default.zip > 内置兜底
import { unzipSync } from "fflate";

const req = eval("require") as (id: string) => any;
const path = req("node:path");
const fs = req("node:fs");

// game\ 根目录: process.execPath = game\core\core.exe -> 上级即 game\
const gameRoot = path.join(path.dirname(process.execPath), "..");
const packsDir = path.join(gameRoot, "resourcepacks");
const BUILTIN_NAME = "default.zip";

type Bytes = Uint8Array;

const overrides = new Map<string, Bytes>();
let builtin: Map<string, Bytes> | null = null;
let scanned = false;

function bytesToB64(bytes: Bytes): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function readZip(file: string): Map<string, Bytes> {
  const map = new Map<string, Bytes>();
  try {
    const out = unzipSync(fs.readFileSync(file));
    for (const [name, data] of Object.entries(out)) {
      if (!data) continue;
      const rel = name.replace(/\\/g, "/").replace(/^\/+/, "");
      if (rel) map.set(rel, data);
    }
  } catch {
    // 坏包忽略, 不影响其他包
  }
  return map;
}

function walkDir(dir: string, base: string, cb: (rel: string, bytes: Bytes) => void): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.join(base, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) walkDir(full, rel, cb);
    else cb(rel, fs.readFileSync(full));
  }
}

function scanPacks(): void {
  if (scanned) return;
  scanned = true;
  if (!fs.existsSync(packsDir)) return;
  const entries = fs
    .readdirSync(packsDir, { withFileTypes: true })
    .filter((e: any) => e.name !== BUILTIN_NAME)
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const full = path.join(packsDir, e.name);
    if (e.isDirectory()) walkDir(full, e.name, (rel, bytes) => overrides.set(rel, bytes));
    else if (/\.zip$/i.test(e.name)) {
      for (const [rel, bytes] of readZip(full)) overrides.set(rel, bytes);
    }
  }
  const builtinFile = path.join(packsDir, BUILTIN_NAME);
  if (fs.existsSync(builtinFile)) builtin = readZip(builtinFile);
}

// 1x1 透明 PNG (R=0 G=0 B=0 A=0, 已验证), 整个资源链(用户包/内置包/missing)都没有时最后兜底 (永不炸)
const FALLBACK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY2BgYGAAAAAFAAGKM+MAAAAAAElFTkSuQmCC";

// 缺失贴图通用兜底: 包根目录的 missing.png (资源, 可被用户资源包覆盖/删除)
const MISSING_REL = "missing.png";

const cache = new Map<string, string>();

/** 按资源包语义解析原始字节 (用户包 > 内置 default.zip, 文件级整体覆盖); 语言文件等非贴图资源共用此链 */
export function resolveBytes(rel: string): Bytes | null {
  scanPacks();
  return overrides.get(rel) ?? builtin?.get(rel) ?? null;
}

/** 按资源包语义解析贴图: 用户包 > 内置 default.zip > missing.png > 1x1 透明; 返回 data URL */
export function resolveTexture(rel: string): string {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  scanPacks();
  const bytes = overrides.get(rel) ?? builtin?.get(rel) ?? overrides.get(MISSING_REL) ?? builtin?.get(MISSING_REL);
  const url = bytes ? `data:image/png;base64,${bytesToB64(bytes)}` : FALLBACK;
  cache.set(rel, url);
  return url;
}

/** 目标贴图是否缺失 (用户包/内置包都没有该贴图) — 用于透明判定 */
export function textureMissing(rel: string): boolean {
  scanPacks();
  return !(overrides.get(rel) ?? builtin?.get(rel));
}

export interface PackInfo {
  name: string;
  builtin: boolean;
  fileCount: number;
}

/** 列出资源包目录下的包 (内置 default.zip 固定排最后, 用户包按名字倒序 = 优先级从高到低) */
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