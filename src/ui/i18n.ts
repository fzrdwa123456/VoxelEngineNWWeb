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
// ===== One Tauri-side change: the dictionaries are built **lazily** =====
// The original built them at module scope:
//     const STRINGS = { zh: loadPackDict("zh"), en: ..., ja: ... };
// That worked because `fs.readFileSync` is **synchronous**: the pack chain is on disk when the module is
// evaluated. A Tauri pack only arrives through `await preloadPacks()` (top of main.ts), and **an ESM
// import is evaluated before the module body** — copying the original builds the dictionaries on an empty
// chain, and that empty result is cached forever:
//     I18N dictionaries loaded: zh=0 en=0 ja=0 entries (1 layer(s) of zh.json)
// The UI then showed raw keys such as `main.single`. It is lazy now, plus "do not build and do not cache
// before the packs are installed" (see `packsInstalled()` in textures.ts).
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
/** Stand-in used while the packs are not installed: it allocates nothing and caches nothing */
const NOTHING: Record<Lang, Dict> = { zh: EMPTY, en: EMPTY, ja: EMPTY };

/** The three built dictionaries; **built and cached only once the packs are installed** (see the header) */
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
  // Read the dictionaries once here: the packs are installed by now, so the build really happens. The
  // three numbers in the log are the evidence that the pack chain works, and an all-zero line is shouted
  // out explicitly — that is how this bug slipped through the log in the first release.
  const s = dicts();
  const zh = Object.keys(s.zh).length;
  const en = Object.keys(s.en).length;
  const ja = Object.keys(s.ja).length;
  logDebug(
    `I18N dictionaries loaded (lang/*.json layered merge): zh=${zh} en=${en} ja=${ja} entries ` +
      `(${resolveAllBytes("lang/zh.json").length} layer(s) of zh.json)` +
      (zh + en + ja === 0 ? "  <- 0 entries! the UI will show raw keys" : ""),
  );
}
