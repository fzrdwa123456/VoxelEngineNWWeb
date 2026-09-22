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
import { packsInstalled, resolveAllBytes } from "./textures";
import type { LocaleState } from "../globals/resources";
import { defineResource, type Resource } from "../../core/world";
// The NOTIFICATION half ("who has to be told this changed") is behaviour, so it lives in the host
// (`logic/host/config-bus.ts`) — this module keeps the VALUE and nothing else.
import { notifyConfigChange } from "../../core/services/bus";

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

/** The three built dictionaries, as DATA. They are built lazily (only once the packs are installed) and
 *  cached — the cache used to be a module-level `let`. The object exists at import time, because a
 *  dictionary may be asked for before the World does, and the composition root INSERTS it as
 *  I18N_STRINGS: the cache has a name, an owner and a reader that is not this module. */
export interface I18nStringsState {
  strings: Record<Lang, Dict> | null;
}

export const I18N_STRINGS: Resource<I18nStringsState> =
  defineResource<I18nStringsState>("i18nStrings");

const state: I18nStringsState = { strings: null };

/** The one instance, for the composition root to insert. */
export function i18nStringsState(): I18nStringsState {
  return state;
}

function dicts(): Record<Lang, Dict> {
  if (!packsInstalled()) return NOTHING;
  if (!state.strings) {
    state.strings = { zh: loadPackDict("zh"), en: loadPackDict("en"), ja: loadPackDict("ja") };
  }
  return state.strings;
}

/** The LOCALE resource, adopted at boot. Null only before `loadLang` (a unit test with no World), in
 *  which case the default language answers — which is what the module starts with anyway. */
let locale: LocaleState | null = null;

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

/** Switch language: writes the RESOURCE and announces it (it does not persist — the composition root
 *  subscribes through the host's config bus to save) */
export function setLang(l: Lang): void {
  if (l === langOf()) return;
  if (!locale) adoptLocale({ lang: l });
  else locale.lang = l;
  notifyConfigChange("lang");
}

/** Adopt the LOCALE resource (idempotent); exposed so the gate can drive this module standalone. */
export function adoptLocale(state: LocaleState): void {
  locale = state;
}

/** Load the language from config at startup into the LOCALE resource (an invalid value falls back to the
 *  resource's own default) and RETURN the line that says what the pack chain produced.
 *
 *  `langs` is the set the CONTENT PLUGIN declares (`plugins/content-default`, `SLOT_LANGUAGES`), handed in
 *  by the composition root: which languages an install has is content, and this DATA module may not import
 *  a plugin to learn it. That is why it is an argument and not a literal here any more.
 *
 *  It does not log: this is a DATA module, so it has no side effects — the composition root (which owns
 *  the log sink) prints the returned summary. */
export function loadLang(state: LocaleState, l: unknown, langs: readonly string[]): string {
  adoptLocale(state);
  if (typeof l === "string" && langs.includes(l)) state.lang = l;
  // Read the dictionaries once here: the packs are installed by now, so the build really happens.
  const s = dicts();
  // One count per DECLARED language (a pack may add one): the summary reports the set actually in force.
  const byId = s as Record<string, Dict>;
  const counts = langs.map((id) => `${id}=${Object.keys(byId[id] ?? {}).length}`).join(" ");
  const total = langs.reduce((n, id) => n + Object.keys(byId[id] ?? {}).length, 0);
  return (
    `I18N dictionaries loaded (lang/*.json layered merge): ${counts} entries ` +
    `(${resolveAllBytes("lang/zh.json").length} layer(s) of zh.json)` +
    (total === 0 ? "  <- 0 entries! the UI will show raw keys" : "")
  );
}
