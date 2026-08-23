// ===== 多语言: 词典文件化 (资源包内 lang\*.json) + t() + 运行时切换 =====
// 词典不再硬编码: 构建时 src\assets\lang 打进 default.zip (lang/zh.json, lang/en.json),
// 用户资源包放同名文件即可整体覆盖 (与贴图同一条覆盖链)。缺词回退英文 (对齐 MC 的
// en_us 兜底惯例), 再缺返回 key。只覆盖用户可见 UI 文案; debug.log 诊断行保持中文。
import { resolveBytes } from "../textures";
import { sendLog } from "../shell";

export type Lang = "zh" | "en" | "ja";

type Dict = Record<string, string>;

/** 从资源包链读词典: lang/{lang}.json (用户包 > default.zip, 文件级覆盖); 缺文件/坏 JSON 返回空词典 */
function loadPackDict(lang: Lang): Dict {
  const bytes = resolveBytes(`lang/${lang}.json`);
  if (!bytes) return {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed === "object" && parsed !== null) return parsed as Dict;
  } catch {
    /* 坏文件: 空词典, t() 回退显示 key */
  }
  return {};
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
    `I18N 词典载入 (lang/*.json): zh=${Object.keys(STRINGS.zh).length} en=${Object.keys(STRINGS.en).length} ja=${Object.keys(STRINGS.ja).length} 词条`,
  );
}
