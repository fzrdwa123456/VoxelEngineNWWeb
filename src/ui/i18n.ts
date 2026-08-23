// ===== 多语言: 词典文件化 (包内 lang\*.json 多层合并) + t() + 运行时切换 =====
// 词典不再硬编码: 构建时 src\assets\lang 打进 default.zip (lang/zh.json, lang/en.json),
// 所有包 (default.zip / mods / 资源包) 的同名词典逐层合并 —— mod/资源包放 lang\*.json
// 即可增量补词条或覆盖已有词条 (同 key 高优先级层胜, 优先级: 资源包 > mods > default.zip)。
// 缺词回退英文 (对齐 MC 的 en_us 兜底惯例), 再缺返回 key。只覆盖用户可见 UI 文案;
// debug.log 诊断行保持中文。
import { resolveAllBytes } from "../textures";
import { sendLog } from "../shell";

export type Lang = "zh" | "en" | "ja";

type Dict = Record<string, string>;

/** 合并整条包链的词典: lang/{lang}.json 逐层并入 (低→高优先级, 同 key 后并入者胜);
 *  mod 自带语言即此机制 —— 新词条增量进词典, 同 key 覆盖本体词条 */
function loadPackDict(lang: Lang): Dict {
  const merged: Dict = {};
  for (const bytes of resolveAllBytes(`lang/${lang}.json`)) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && typeof parsed === "object") Object.assign(merged, parsed);
    } catch {
      /* 坏 json: 该层忽略, 不影响其他层 */
    }
  }
  return merged;
}

const STRINGS: Record<Lang, Dict> = { zh: loadPackDict("zh"), en: loadPackDict("en"), ja: loadPackDict("ja") };

let current: Lang = "zh";
const listeners = new Set<() => void>();

/** 取当前语言的文案; 缺词回退英文, 再缺返回 key 本身 */
export function t(key: string): string {
  return STRINGS[current][key] ?? STRINGS.en[key] ?? key;
}

export function getLang(): Lang {
  return current;
}

/** 切换语言: 立即通知所有已注册的 UI 刷新 (不负责存盘, 存盘由 main.ts 订阅 onLangChange 完成) */
export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  listeners.forEach((cb) => cb());
}

/** 订阅语言变更 (UI 注册 refresh) */
export function onLangChange(cb: () => void): void {
  listeners.add(cb);
}

/** 启动时从配置载入语言 (无效值回退中文); 词条数写 debug.log 供确认文件链生效 */
export function loadLang(l: unknown): void {
  if (l === "zh" || l === "en" || l === "ja") current = l;
  sendLog(
    `I18N 词典载入 (lang/*.json 多层合并): zh=${Object.keys(STRINGS.zh).length} en=${Object.keys(STRINGS.en).length} ja=${Object.keys(STRINGS.ja).length} 词条 (${resolveAllBytes("lang/zh.json").length} 层 zh.json)`,
  );
}
