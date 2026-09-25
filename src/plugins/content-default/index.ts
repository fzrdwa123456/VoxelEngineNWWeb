// ===== Plugin: content-default =====
// The engine's BUILT-IN CONTENT, as a plugin's declaration rather than a list baked into the code.
//
// Why a plugin: "which languages does this install support" and "which blocks does it have" are content, and
// content is what a player replaces. Turn this plugin off in plugins.json and the engine still boots — it
// simply has no declared language set and no declared block of its own (the locale keeps its own default, the
// registry registers the discovery's `missing` entry, which is the rule the table always had for an empty
// chain).
//
// IT DRIVES THE LOADERS (P1.36 for languages, P1.37 for blocks). Both sets used to be read by the data
// modules themselves at CONFIG time, before the install, so a contribution could not have had any effect even
// if a pack added content:
//   * languages: `data/assets/languages.ts` discovers every `lang/<id>.json` in the chain, and the root calls
//     `loadLang` BELOW the install with `SLOT_LANGUAGES`;
//   * blocks:    `data/assets/blocks.ts` discovers the merged `data/blocks.json` entries, and the root calls
//     `buildBlockRegistry` BELOW the install with `SLOT_BLOCKS`.
// That is the shape the rest of the content work needs: contributions are an INPUT to the loaders.
import { declaredLanguages, BUILTIN_LANGUAGES } from "../../data/assets/languages";
import { discoverBlockEntries } from "../../data/assets/blocks";
import { SLOT_BLOCKS, SLOT_LANGUAGES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";

export const contentDefaultPlugin = definePlugin({
  id: "content-default",
  deps: [],
  setup(api) {
    // Discovered at INSTALL time, which is after `preloadPacks()`: a pack that ships `lang/fr.json` or an
    // extra entry in `data/blocks.json` is in the chain by now, so it is declared without anyone editing
    // this file.
    api.contribute(
      SLOT_LANGUAGES,
      declaredLanguages().map((id) => ({ id })),
    );
    api.contribute(SLOT_BLOCKS, discoverBlockEntries());
  },
  /** A content plugin is exactly what `start` is for: by now the pack chain has been scanned, so it can
   *  report what this install actually has instead of what the code assumes — including which languages came
   *  from a PACK rather than from the engine. */
  start(api) {
    const all = declaredLanguages();
    const fromPacks = all.filter((id) => !BUILTIN_LANGUAGES.includes(id));
    api.log(
      `content: ${all.length} declared language(s) [${all.join(", ")}]` +
        (fromPacks.length > 0 ? ` - ${fromPacks.length} of them from the pack chain [${fromPacks.join(", ")}]` : "") +
        `, ${discoverBlockEntries().length} block(s) declared from the pack chain`,
    );
  },
});
