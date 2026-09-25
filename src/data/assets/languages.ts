// ===== THE LANGUAGE SET, as DATA the PACK CHAIN delivers (P1.36) =====
// "Which languages does this install support" used to be a literal in TWO places — the content plugin's
// `["zh","en","ja"]` and i18n's `Lang = "zh" | "en" | "ja"` union — so a pack that shipped `lang/fr.json`
// had a file on disk that nothing knew the name of. The set is DISCOVERED now: the engine's built-in three,
// plus every `lang/<id>.json` any layer of the pack chain delivers.
//
// ONE function, three readers, so they cannot drift: the CONTRIBUTION (what the content plugin declares into
// `SLOT_LANGUAGES`, which is what validates a language), the LOADER (which dictionaries `loadLang` builds)
// and the PICKER (the settings panel's language choices). A pack adding `lang/fr.json` therefore gets a
// language that is selectable, loadable and savable in `settings.json` — content, not a code change.
import { listPackPaths } from "./textures";

/** The dictionaries the ENGINE itself ships (the built-in pack carries `lang/<id>.json` for these). A pack
 *  may ADD languages; the built-in three stay declared even if a pack drops one of their files — a missing
 *  dictionary simply reads as its key, which is a missing TRANSLATION, not a missing language. */
export const BUILTIN_LANGUAGES: readonly string[] = ["zh", "en", "ja"];

/** Every `<id>` the pack chain delivers a `lang/<id>.json` for. The file NAME is the language id, which is
 *  what a settings file stores (`"language": "fr"`) and what the dictionaries are keyed by. */
export function declaredLanguages(): string[] {
  const ids = new Set<string>(BUILTIN_LANGUAGES);
  for (const rel of listPackPaths("lang/")) {
    const hit = /^lang\/([A-Za-z0-9_-]+)\.json$/.exec(rel);
    if (hit) ids.add(hit[1]);
  }
  return [...ids];
}
