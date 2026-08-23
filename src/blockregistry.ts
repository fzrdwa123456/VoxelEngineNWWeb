// ===== 方块注册表: 数据驱动 (包内 data\blocks.json, 跨包合并) =====
// "本体即 mod": 本体方块与用户内容地位完全相同。
// mod (game\mods\<名字>\) 或资源包在包内放 data\blocks.json 即可新增方块(不同 id 并集)
// 或改已有方块(同 id 高优先级包胜)。优先级 (低→高): mods < resourcepacks 用户包
// (MC 语义: 资源包是最终权威, mod 提供内容基线, 玩家用资源包给 mod 方块换皮)。
// 包内路径 (MC 分类法): assets\<ns>\data\blocks.json (数据类进 data\, 与 textures\/lang\ 平级);
// 归一化后全局路径 data/blocks.json。
// 条目字段: label(显示名,缺省 id) / color(纯色材质,CSS 色值) / top/side/bottom(贴图路径,
// 包根相对) / all(三面同图简写); 引用的贴图缺失 -> transparent(面不剔除, alphaTest 丢面片后可透视)。
import { resolveAllBytes, textureMissing } from "./textures";
import { sendLog } from "./shell";

export interface BlockDef {
  id: string;
  label: string; // 显示名 (物品栏 tooltip)
  color?: string; // 纯色材质 (无贴图时)
  top?: string; // 贴图路径; top/bottom 缺省回退 side
  side?: string;
  bottom?: string;
  transparent: boolean; // 任一引用贴图缺失 -> 邻居面不剔除
}

type RawDef = { label?: unknown; color?: unknown; top?: unknown; side?: unknown; bottom?: unknown; all?: unknown };

const registry = new Map<string, BlockDef>();
let loaded = false;

// 兜底: 整条包链都没有 blocks.json (本体 mod 被删光) 时仅注册缺失方块,
// 保证物品栏/世界 set 不至于完全无方块可用 (本体三件套已迁入 mods\defaultmod.zip, 引擎不再内置)
const FALLBACK_DEFS: Record<string, RawDef> = {
  missing: { label: "缺失方块", side: "block/nonexistent.png" },
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
    transparent: false,
  };
  def.transparent = [def.top, def.side, def.bottom].some((p) => p !== undefined && textureMissing(p));
  return def;
}

/** 启动时载入一次: 合并所有包的 blocks.json (低→高优先级, 同 id 后合并者胜) */
export function loadBlockRegistry(): void {
  if (loaded) return;
  loaded = true;
  const layers = resolveAllBytes("data/blocks.json");
  let merged: Record<string, RawDef> = {};
  for (const bytes of layers) {
    try {
      const p = JSON.parse(new TextDecoder().decode(bytes));
      if (p && typeof p === "object") merged = { ...merged, ...p };
    } catch {
      /* 坏 json: 该层忽略, 不影响其他层 */
    }
  }
  if (!Object.keys(merged).length) merged = FALLBACK_DEFS; // 空链兜底
  for (const [id, raw] of Object.entries(merged)) {
    if (!raw || typeof raw !== "object") continue;
    registry.set(id, defFrom(id, raw as RawDef));
  }
  sendLog(`BLOCKREG 注册表载入: ${registry.size} 方块 (${layers.length} 层 blocks.json) -> [${[...registry.keys()].join(", ")}]`);
}

export function getBlockDef(id: string): BlockDef | undefined {
  loadBlockRegistry();
  return registry.get(id);
}

/** 全部已注册方块 id (物品栏填充用) */
export function allBlockIds(): string[] {
  loadBlockRegistry();
  return [...registry.keys()];
}
