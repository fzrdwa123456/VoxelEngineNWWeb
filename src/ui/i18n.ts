// ===== i18n: dictionary files (pack lang\*.json merged in layers) + t() + runtime switching =====
// Dictionaries are no longer hardcoded: at build time src\assets\lang is packed into default.zip (lang/zh.json, lang/en.json),
// identical-name dictionaries from all packs (default.zip / mods / resource packs) merge layer by layer — a mod/resource pack dropping lang\*.json
// incrementally adds entries or overrides existing ones (same key: higher-priority layer wins; priority: resource packs > mods > default.zip).
// Missing words fall back to English (aligning with MC's en_us convention), then to the key itself. Only user-visible UI copy is covered;
// debug.log diagnostic lines stay Chinese.
import { resolveAllBytes } from "../rendering/textures";
import { logDebug } from "../platform/shell";

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

const STRINGS: Record<Lang, Dict> = { zh: loadPackDict("zh"), en: loadPackDict("en"), ja: loadPackDict("ja") };

let current: Lang = "zh";
const listeners = new Set<() => void>();

/** Copy for the current language; missing words fall back to English, then to the key itself */
export function t(key: string): string {
  return STRINGS[current][key] ?? STRINGS.en[key] ?? key;
}

export function getLang(): Lang {
  return current;
}

/** Switch language: notify all registered UI refreshes immediately (does not persist; main.ts subscribes onLangChange to save) */
export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  listeners.forEach((cb) => cb());
}

/** Subscribe to language changes (UI registers refresh) */
export function onLangChange(cb: () => void): void {
  listeners.add(cb);
}

/** Load the language from config at startup (invalid values fall back to Chinese); entry counts logged to debug.log to confirm the file chain works */
export function loadLang(l: unknown): void {
  if (l === "zh" || l === "en" || l === "ja") current = l;
  logDebug(
        `I18N dictionaries loaded (lang/*.json layered merge): zh=${Object.keys(STRINGS.zh).length} en=${Object.keys(STRINGS.en).length} ja=${Object.keys(STRINGS.ja).length} entries (${resolveAllBytes("lang/zh.json").length} layer(s) of zh.json)`,
  );
}
