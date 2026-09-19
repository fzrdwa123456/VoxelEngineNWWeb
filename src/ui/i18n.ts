// ===== i18n: dictionary files (pack lang\*.json merged in layers) + t() + runtime switching =====
// Dictionaries are no longer hardcoded: at build time src\assets\lang is packed into default.zip (lang/zh.json, lang/en.json),
// identical-name dictionaries from all packs (default.zip / mods / resource packs) merge layer by layer — a mod/resource pack dropping lang\*.json
// incrementally adds entries or overrides existing ones (same key: higher-priority layer wins; priority: resource packs > mods > default.zip).
// Missing words fall back to English (aligning with MC's en_us convention), then to the key itself. Only user-visible UI copy is covered;
// debug.log diagnostic lines stay Chinese.
//
// The language IN FORCE is a RESOURCE (`LOCALE`, see ecs/resources.ts): the reconciler re-derives every
// widget's text from it every frame, so it is read on the tick and every reader declares it. The
// DICTIONARIES are assets — loaded once from the pack chain, never changed — and stay module-private.
//
// ===== Tauri 版的一处改动：词典改成**惰性**构建 =====
// 原版这里是在模块作用域直接建词典：
//     const STRINGS = { zh: loadPackDict("zh"), en: ..., ja: ... };
// 那时没问题，因为 `fs.readFileSync` 是**同步**的，模块求值时包已经在磁盘上。
// Tauri 的包要 `await preloadPacks()` 才到（main.ts 顶部），而 **ESM 的 import 在模块体之前求值**
// —— 照搬原版就等于在空包链上建词典，而且这个空结果会被永久缓存住：
//     I18N dictionaries loaded: zh=0 en=0 ja=0 entries (1 layer(s) of zh.json)
// 界面于是把 `main.single` 这种原始 key 直接显示出来。
// 现在改成惰性 + "包没装好就不建也不缓存"（见 textures.ts 的 packsInstalled()）。
import { packsInstalled, resolveAllBytes } from "../rendering/textures";
import { logDebug } from "../platform/shell";
import type { LocaleState } from "../ecs/resources";

export type Lang = "zh" | "en" | "ja";

type Dict = Record<string, string>;

/** Merge the whole pack chain's dictionary: lang/{lang}.json merged layer by layer (low->high priority, later layers win on same key);
  *  a mod's bundled language works through this — new entries are added, same keys override engine entries */
function loadPackDict(lang: Lang): Dict {
  const merged: Dict = {};
  for (const bytes of resolveAllBytes(`lang/${lang}.json`)) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && typeof parsed === "object") Object.assign(merged, parsed);
    } catch {
            /* Bad json: ignore this layer, other layers unaffected */
    }
  }
  return merged;
}

const EMPTY: Dict = {};
/** 包还没装好时用的替身：不分配、也不缓存 */
const NOTHING: Record<Lang, Dict> = { zh: EMPTY, en: EMPTY, ja: EMPTY };

/** 建好的三本词典；**只在包装好之后才建、才缓存**（见文件头的说明） */
let STRINGS: Record<Lang, Dict> | null = null;

function dicts(): Record<Lang, Dict> {
  if (!packsInstalled()) return NOTHING;
  if (!STRINGS) {
    STRINGS = { zh: loadPackDict("zh"), en: loadPackDict("en"), ja: loadPackDict("ja") };
  }
  return STRINGS;
}

/** The LOCALE resource, adopted at boot. Null only before `loadLang` (a unit test with no World), in
 *  which case the default language answers — which is what the module starts with anyway. */
let locale: LocaleState | null = null;
const listeners = new Set<() => void>();

/** The language in force, validated: anything the resource holds that is not a known language reads as
 *  the default (the resource is typed `string` because ecs/resources.ts knows no unions). */
function langOf(): Lang {
  const l = locale?.lang;
  return l === "zh" || l === "en" || l === "ja" ? l : "zh";
}

/** Copy for the current language; missing words fall back to English, then to the key itself */
export function t(key: string): string {
  const lang = langOf();
  const s = dicts();
  return s[lang][key] ?? s.en[key] ?? key;
}

export function getLang(): Lang {
  return langOf();
}

/** Switch language: notify all registered UI refreshes immediately (does not persist; main.ts subscribes onLangChange to save) */
export function setLang(l: Lang): void {
  if (l === langOf()) return;
  if (!locale) adoptLocale({ lang: l });
  else locale.lang = l;
  listeners.forEach((cb) => cb());
}

/** Adopt the LOCALE resource (idempotent); exposed so the gate can drive this module standalone. */
export function adoptLocale(state: LocaleState): void {
  locale = state;
}

/** Subscribe to language changes (UI registers refresh) */
export function onLangChange(cb: () => void): void {
  listeners.add(cb);
}

/** Load the language from config at startup into the LOCALE resource (invalid values fall back to
 *  Chinese); entry counts logged to debug.log to confirm the file chain works */
export function loadLang(state: LocaleState, l: unknown): void {
  adoptLocale(state);
  if (l === "zh" || l === "en" || l === "ja") state.lang = l;
  // 这里读一次词典：此时包已经装好，构建会真的发生。日志里那三个数字就是"包链通不通"的证据，
  // 全 0 时显式喊出来 —— 这个 bug 第一版就是这样从日志里溜过去的。
  const s = dicts();
  const zh = Object.keys(s.zh).length;
  const en = Object.keys(s.en).length;
  const ja = Object.keys(s.ja).length;
  logDebug(
    `I18N dictionaries loaded (lang/*.json layered merge): zh=${zh} en=${en} ja=${ja} entries ` +
      `(${resolveAllBytes("lang/zh.json").length} layer(s) of zh.json)` +
      (zh + en + ja === 0 ? "  <- 0 词条！界面会把原始 key 显示出来" : ""),
  );
}
