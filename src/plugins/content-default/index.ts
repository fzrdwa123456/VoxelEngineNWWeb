// ===== Plugin: content-default =====
// The engine's BUILT-IN CONTENT, as a plugin's declaration rather than a list baked into the code.
//
// Why a plugin: "which languages does this install support" is content, and content is what a player
// replaces. Turn this plugin off in plugins.json and the engine still boots — it simply has no declared
// language set of its own.
//
// WHAT IT DOES NOT OWN YET, and why (recorded in ROADMAP.md as P1.20): the locale is LOADED before the
// plugins install (the loading screen's own text needs it), so the contributed set cannot yet drive
// `loadLang`. Making it do so means moving the install above the config/content phase — a boot-sequence
// change, not a content change.
import { SLOT_LANGUAGES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";

/** The languages the engine ships dictionaries for. A pack may ship more; the engine validates a language
 *  against what the content plugins DECLARED, so this list is data, not a rule in the i18n module. */
export const DEFAULT_LANGUAGES: readonly string[] = ["zh", "en", "ja"];

export const contentDefaultPlugin = definePlugin({
  id: "content-default",
  deps: [],
  setup(api) {
    api.contribute(
      SLOT_LANGUAGES,
      DEFAULT_LANGUAGES.map((id) => ({ id })),
    );
  },
  /** A content plugin is exactly what `start` is for: by now the pack chain has been scanned, so it can
   *  report what this install actually has instead of what the code assumes. */
  start(api) {
    api.log(`content: ${DEFAULT_LANGUAGES.length} declared language(s) [${DEFAULT_LANGUAGES.join(", ")}]`);
  },
});
