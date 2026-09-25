// ===== Plugin: content-default =====
// The engine's BUILT-IN CONTENT, as a plugin's declaration rather than a list baked into the code.
//
// Why a plugin: "which languages does this install support" is content, and content is what a player
// replaces. Turn this plugin off in plugins.json and the engine still boots — it simply has no declared
// language set of its own (the locale then keeps its own default, and `loadLang` loads nothing).
//
// IT NOW DRIVES THE LOADER (P1.36). Until this round the set was declared here but LOADED from a literal in
// `boot/main.ts` (`DEFAULT_LANGUAGES`, read before the install), so the contribution could not have any
// effect even if a pack had added a language. Two things changed: the set is DISCOVERED from the pack chain
// (`data/assets/languages.ts` reads every `lang/<id>.json` in it), and the root loads the language set AFTER
// the install, from `SLOT_LANGUAGES` — i.e. from what this plugin declared. That is the shape the rest of
// the content work needs: the contributions are an INPUT to the config loaders, not a consumer of them.
import { declaredLanguages, BUILTIN_LANGUAGES } from "../../data/assets/languages";
import { SLOT_LANGUAGES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";

export const contentDefaultPlugin = definePlugin({
  id: "content-default",
  deps: [],
  setup(api) {
    // Discovered at INSTALL time, which is after `preloadPacks()`: a pack that ships `lang/fr.json` is in
    // the chain by now, so "fr" is declared without anyone editing this file.
    api.contribute(
      SLOT_LANGUAGES,
      declaredLanguages().map((id) => ({ id })),
    );
  },
  /** A content plugin is exactly what `start` is for: by now the pack chain has been scanned, so it can
   *  report what this install actually has instead of what the code assumes — including which languages
   *  came from a PACK rather than from the engine. */
  start(api) {
    const all = declaredLanguages();
    const fromPacks = all.filter((id) => !BUILTIN_LANGUAGES.includes(id));
    api.log(
      `content: ${all.length} declared language(s) [${all.join(", ")}]` +
        (fromPacks.length > 0 ? ` - ${fromPacks.length} of them from the pack chain [${fromPacks.join(", ")}]` : ""),
    );
  },
});
