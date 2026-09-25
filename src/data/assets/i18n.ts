// ===== i18n: dictionary files (pack lang\*.json merged in layers) + t() + runtime switching =====
// Dictionaries are data: identical-name dictionaries from all packs (default.zip / mods / resource packs)
// merge layer by layer — a mod/resource pack dropping lang\*.json incrementally adds entries or overrides
// existing ones (same key: higher-priority layer wins; priority: resource packs > mods > default.zip).
// Missing words fall back to the fallback language (en — MC's en_us convention), then to the key itself.
// An undeclared LANGUAGE falls back the same way (see `langOf`): one rule, not two.
//
// ===== WHICH languages exist is a DECLARED SET, not a literal (P1.36) =====
// It used to be a `Lang = "zh" | "en" | "ja"` union, i.e. a language a pack shipped could never be loaded:
// `dicts()` built exactly those three, so `lang/fr.json` was a file no code path knew the name of. The set
// now arrives as an ARGUMENT (`loadLang`, from the content plugin's `SLOT_LANGUAGES` contribution, which
// `data/assets/languages.ts` discovers from the pack chain) and the dictionaries are built PER DECLARED ID.
// The built set is the CACHE KEY, so a different install rebuilds instead of answering with the previous
// one's dictionaries. This module still imports no plugin: content is handed in.
//
// The language IN FORCE is a RESOURCE (`LOCALE`): the reconciler re-derives every widget's text from it
// every frame, so it is read on the tick and every reader declares it. The DICTIONARIES are assets — loaded
// once from the pack chain, never changed — and live in the I18N_STRINGS resource (one object, inserted by
// the composition root, so the cache has a name and an owner instead of being module-private state).
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

/** A language id is the name of its `lang/<id>.json`, so it is DATA — see `data/assets/languages.ts`. */
export type Lang = string;

type Dict = Record<string, string>;

/** The language the engine starts in when nothing else is declared or stored, and the one `t()` falls back
 *  to when a key is missing in the language in force (MC's `en_us` convention). */
const DEFAULT_LANGUAGE: Lang = "zh";
const FALLBACK_LANGUAGE: Lang = "en";

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

/** Stand-in used while the packs are not installed: it allocates nothing and caches nothing */
const NOTHING: Map<Lang, Dict> = new Map();

/** The built dictionaries, as DATA. They are built lazily (only once the packs are installed) and cached —
  *  the cache used to be a module-level `let`. The object exists at import time, because a dictionary may be
  *  asked for before the World does, and the composition root INSERTS it as I18N_STRINGS: the cache has a
  *  name, an owner and a reader that is not this module. */
export interface I18nStringsState {
  /** The DECLARED language set in force — the content plugin's contribution, which `loadLang` re-declares.
   *  It is also the cache key of `strings`: a set that changed means a different install. */
  declared: readonly Lang[];
  /** The set the dictionaries below were built from (`declared.join`), so a re-declaration rebuilds. */
  builtFrom: string;
  /** The dictionaries in force, by language id; null until the first build. */
  strings: Map<Lang, Dict> | null;
}

export const I18N_STRINGS: Resource<I18nStringsState> =
  defineResource<I18nStringsState>("i18nStrings");

const i18nState: I18nStringsState = { declared: [], builtFrom: "", strings: null };

/** The one instance, for the composition root to insert. */
export function i18nStringsState(): I18nStringsState {
  return i18nState;
}

/** The declared set in force, re-declared by `loadLang` (the content plugin's contribution). */
export function declaredLangs(): readonly Lang[] {
  return i18nState.declared;
}

function dicts(): Map<Lang, Dict> {
  if (!packsInstalled()) return NOTHING;
  const signature = i18nState.declared.join("\u0000");
  if (!i18nState.strings || i18nState.builtFrom !== signature) {
    const built = new Map<Lang, Dict>();
    for (const id of i18nState.declared) built.set(id, loadPackDict(id));
    i18nState.strings = built;
    i18nState.builtFrom = signature;
  }
  return i18nState.strings;
}

/** The LOCALE resource, adopted at boot. Null only before `loadLang` (a unit test with no World), in
  *  which case the declared default answers — which is what the module starts with anyway. */
let locale: LocaleState | null = null;

/** The language a value the install does not declare resolves to: the FALLBACK language (en) when it is
 *  declared, else the first-run default, else whatever the install does declare.
 *
 *  ONE function, used by the READER (`langOf`) and by the LOADER (`loadLang`), because letting the two
 *  answer separately is what shipped as "I deleted the pack's `lang/fr.json` and the game came back
 *  Chinese": the loader left the DEFAULT in place and the reader never saw the undeclared value at all, so
 *  the reader-side fallback could not fire (P1.36b). */
function fallbackLang(langs: readonly string[]): Lang {
  if (langs.includes(FALLBACK_LANGUAGE)) return FALLBACK_LANGUAGE;
  if (langs.includes(DEFAULT_LANGUAGE)) return DEFAULT_LANGUAGE;
  return langs[0] ?? FALLBACK_LANGUAGE;
}

/** The language in force, validated against the DECLARED set. An undeclared value is a MISSING LANGUAGE,
 *  not a missing WORD: it reads as the fallback (`en`), the same one a missing KEY uses. `DEFAULT_LANGUAGE`
 *  (zh) is only what a fresh install with NO stored value starts in. */
function langOf(): Lang {
  const l = locale?.lang;
  const declared = i18nState.declared;
  if (typeof l === "string" && declared.includes(l)) return l;
  return fallbackLang(declared);
}

/** Copy for the current language; a missing word falls back to the fallback language, then to the key itself */
export function t(key: string): string {
  const s = dicts();
  const here = s.get(langOf());
  const fallback = s.get(FALLBACK_LANGUAGE);
  return here?.[key] ?? fallback?.[key] ?? key;
}

export function getLang(): Lang {
  return langOf();
}

/** Switch language: writes the RESOURCE and announces it (it does not persist — the composition root
  *  subscribes through the host's config bus to save). A language the install does not declare is refused:
  *  the set is content, and the picker is built from it. */
export function setLang(l: Lang): void {
  if (!i18nState.declared.includes(l)) return;
  if (l === langOf()) return;
  if (!locale) adoptLocale({ lang: l });
  else locale.lang = l;
  notifyConfigChange("lang");
}

/** Adopt the LOCALE resource (idempotent); exposed so the gate can drive this module standalone. */
export function adoptLocale(target: LocaleState): void {
  locale = target;
}

/** Load the language from config at startup into the LOCALE resource (an invalid value falls back to the
  *  resource's own default) and RETURN the line that says what the pack chain produced.
  *
  *  `langs` is the set the CONTENT PLUGIN declares (`plugins/content-default`, `SLOT_LANGUAGES`, discovered
  *  from the pack chain), handed in by the composition root: which languages an install has is content, and
  *  this DATA module may not import a plugin to learn it. It is BOTH the validation set and the list the
  *  dictionaries are built for — that is what makes a pack's new language actually load (P1.36).
  *
  *  It does not log: this is a DATA module, so it has no side effects — the composition root (which owns
  *  the log sink) prints the returned summary. */
export function loadLang(localeState: LocaleState, l: unknown, langs: readonly string[]): string {
  adoptLocale(localeState);
  // The declared set is the cache KEY of the dictionaries, so it lands before anything is built.
  i18nState.declared = [...langs];
  // THE VALUE IN FORCE IS RESOLVED HERE, in the loader (P1.36b). `localeState` arrives from
  // `createLocale()`, so it ALREADY holds the first-run default ("zh") — which means "do not write when the
  // stored value is undeclared" did not leave the stored value in place, it left the DEFAULT in place. And
  // the default is a DECLARED language, so every reader (and the settings repair, which compares the file
  // with the value in force) agreed on Chinese while the file said `fr`. Three cases, and they stay apart:
  //   * a declared value        -> the language in force (what the user picked);
  //   * a value this install does NOT declare (its pack was deleted, a hand-edit, a wrong type) -> the
  //     fallback (`en`), so the repair writes `en` rather than silently `zh`;
  //   * NO value at all         -> the default the object came with (a first run has no key in the file).
  if (typeof l === "string" && langs.includes(l)) localeState.lang = l;
  else if (l !== undefined) localeState.lang = fallbackLang(langs);
  // Read the dictionaries once here: the packs are installed by now, so the build really happens.
  const s = dicts();
  // One count per DECLARED language (a pack may add one): the summary reports the set actually in force.
  const counts = langs.map((id) => `${id}=${Object.keys(s.get(id) ?? {}).length}`).join(" ");
  const total = langs.reduce((n, id) => n + Object.keys(s.get(id) ?? {}).length, 0);
  return (
    `I18N dictionaries loaded (lang/*.json layered merge): ${counts} entries ` +
    `(${resolveAllBytes("lang/zh.json").length} layer(s) of zh.json)` +
    (total === 0 ? "  <- 0 entries! the UI will show raw keys" : "")
  );
}
