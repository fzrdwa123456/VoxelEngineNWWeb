// ===== MC 式资源包贴图: 内置 default.zip + 用户资源包(文件夹或 zip) 覆盖 =====
// 优先级(MC 语义): 用户包按目录名字典序倒序(后放的胜) > 内置 default.zip > 内置兜底
import { unzipSync } from "fflate";

const req = eval("require") as (id: string) => any;
const path = req("node:path");
const fs = req("node:fs");

// game\ 根目录: process.execPath = game\core\core.exe -> 上级即 game\
const gameRoot = path.join(path.dirname(process.execPath), "..");
const packsDir = path.join(gameRoot, "resourcepacks");
const modsDir = path.join(gameRoot, "mods"); // 独立 mods 目录 (优先级高于 resourcepacks 用户包)
const BUILTIN_NAME = "default.zip";

type Bytes = Uint8Array;

const overrides = new Map<string, Bytes>();
let builtin: Map<string, Bytes> | null = null;
let scanned = false;
// 资源包分层 (低优先级在前: builtin 最先, 用户包按扫描处理序): 供注册表类 JSON 跨包合并
// (多个包各带 blocks.json 时, 单值 overrides 只留一份 —— 分层保留每份数据按优先级合并)
const packLayers: Map<string, Bytes>[] = [];

function bytesToB64(bytes: Bytes): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ===== MC 式命名空间归一化 =====
// 包内路径规范: assets/<命名空间>/<路径> (如 assets/minecraft/textures/block/dirt.png)。
// 加载时剥掉 assets/ 与命名空间层 (及可选的 textures/ 分类层, MC 惯例), 归一化为全局路径:
//   assets/voxel/textures/block/dirt.png  ->  block/dirt.png   (MC 全结构)
//   assets/voxel/block/dirt.png           ->  block/dirt.png   (省 textures 层)
//   block/dirt.png                        ->  block/dirt.png   (拍平结构)
// 三种结构等价; lang/sounds 等非贴图类无 textures 分类层, 剥法一致不影响。
// 查询端 (resolveTexture/resolveBytes) 永远用归一化路径, 不感知命名空间与 textures 层
function normalizeKey(name: string): string | null {
  const rel = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) return null;
  const parts = rel.split("/");
  if (parts[0] === "assets" && parts.length >= 3) {
    const rest = parts.slice(2); // 剥 assets/ 与命名空间层
    // 剥可选 textures/ 分类层 (MC: assets/<ns>/textures/... 是图片资源的标准家)
    if (rest[0] === "textures" && rest.length >= 2) return rest.slice(1).join("/");
    return rest.join("/");
  }
  return rel; // 拍平结构原样 (含 assets/ 下直贴文件等非常规布局)
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
    // 坏包忽略, 不影响其他包
  }
  return map;
}

function walkDir(dir: string, base: string, cb: (rel: string, bytes: Bytes) => void): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    // rel 手拼正斜杠且 base 为空不加前导斜杠: path.join Windows 反斜杠 + 空串拼接 "/blocks.json"
    // 都会与 zip 内路径 key (无斜杠前缀的正斜杠路径) 失配 -> 覆盖链查不到
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walkDir(full, rel, cb);
    else {
      const norm = normalizeKey(rel); // 文件夹包同样支持 assets/<ns>/ 三层结构
      if (norm) cb(norm, fs.readFileSync(full));
    }
  }
}

/** 扫一个目录下的包 (zip 文件 + 文件夹包) 按优先级低→高入层; 文件夹包名 = base 前缀剥掉后的包根 */
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
  // builtin 层最先入列 (最低优先级, 被用户包/mod 合并时覆盖)
  const builtinFile = path.join(packsDir, BUILTIN_NAME);
  if (fs.existsSync(builtinFile)) {
    builtin = readZip(builtinFile);
    if (builtin) packLayers.push(builtin);
  }
  scanPackDir(modsDir); // mods 目录 (中优先级: 内容基线, 提供 blocks.json/自带贴图)
  scanPackDir(packsDir); // 用户资源包 (最高优先级, MC 语义: 资源包是最终权威, 可换 mod/本体的皮)
}

/** 按优先级低→高返回所有包含该文件的包的字节 (blocks.json 等注册表文件跨包合并用); 空数组=全链无此文件 */
export function resolveAllBytes(rel: string): Bytes[] {
  scanPacks();
  const out: Bytes[] = [];
  for (const layer of packLayers) {
    const b = layer.get(rel);
    if (b) out.push(b);
  }
  return out;
}

// 缺失贴图兜底: 程序化 2x2 紫黑棋盘格 PNG (洋红 FF00FF 与黑对角), 硬编码 data URL。
// 引擎自带兜底, 删资源包也不会丢; 不可被覆盖 —— 缺资源 = 永远显示这格棋盘
export const CHECKER_TEXTURE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z/CfAQKALAAb8gP9tnmFggAAAABJRU5ErkJggg==";

const cache = new Map<string, string>();

/** 按资源包语义解析原始字节 (用户包 > 内置 default.zip, 文件级整体覆盖); 语言文件等非贴图资源共用此链 */
export function resolveBytes(rel: string): Bytes | null {
  scanPacks();
  return overrides.get(rel) ?? builtin?.get(rel) ?? null;
}

/** 按资源包语义解析贴图: 资源包/mod 同名文件 > 程序化棋盘格; 返回 data URL */
export function resolveTexture(rel: string): string {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  scanPacks();
  const bytes = overrides.get(rel) ?? builtin?.get(rel);
  const url = bytes ? `data:image/png;base64,${bytesToB64(bytes)}` : CHECKER_TEXTURE_URL;
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