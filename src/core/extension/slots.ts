// ===== The built-in extension points =====
// Every slot a plugin may contribute into today. They are declared HERE (in the core) and contributed to
// by `plugins/*/index.ts` — that direction is the whole point: the core defines the shape of an
// extension, a plugin fills it in.
//
// `SLOT_SYSTEMS` is the one the schedule consumes; the other three describe what a plugin OWNS, which is
// what makes the boot report ("who brought what") possible and what a future uninstall has to undo.
// NOT declared yet, because nothing contributes them: views / settings / blocks / languages / uiActions /
// uiSources (the UI's action and source tables are the working prototype of the same idea, but they are
// still registered by the views that own them).
import type { SystemDef } from "../flow/schedule";
import type { Resource } from "../data/resource";
import type { UiHudElement } from "../../data/globals/ui-hud";
import type { UiPage } from "../../data/globals/ui-pages";
import { defineExtensionPoint } from "./point";

/** Systems a plugin wants in the schedule (each carries its own stage/edges/access declaration). */
export const SLOT_SYSTEMS = defineExtensionPoint<SystemDef>("systems");

/** Component schemas a plugin owns. */
export const SLOT_COMPONENTS = defineExtensionPoint<{ readonly name: string }>("components");

/** Resource TOKENS a plugin owns (the shapes live in `data/globals/`; a plugin may also bring its own). */
export const SLOT_RESOURCES = defineExtensionPoint<Resource<unknown>>("resources");

/** The LANGUAGES a content plugin brings. The engine validates a language against this set instead of
 *  against a list baked into the code (see plugins/content-default). */
export const SLOT_LANGUAGES = defineExtensionPoint<{ readonly id: string }>("languages");

/** UI PAGES a plugin brings (a settings tab, a panel). Materialized by the ui lane's HOST system, so a page
 *  contributed at RUNTIME appears without a restart — see data/globals/ui-pages.ts and P1.29. */
export const SLOT_UI_PAGES = defineExtensionPoint<UiPage>("uiPages");

/** HUD ELEMENTS a plugin brings (crosshair, hotbar, armor, xp, boss bar...). Painted by the ui lane's HUD
 *  host, each from its OWN gate — see data/globals/ui-hud.ts. */
export const SLOT_UI_HUD = defineExtensionPoint<UiHudElement>("uiHud");

/** Command types a plugin owns. */
export const SLOT_COMMANDS = defineExtensionPoint<{ readonly name: string }>("commands");
