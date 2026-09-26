// ===== UI theme and style recipes =====
// Every COLOUR the UI uses lives HERE, as a named token. A widget declares a RECIPE ("settings.btn");
// the table below turns (recipe, widget state) into a style string built from the tokens. That is what
// makes the UI themeable: the ~120 hex literals the hand-written DOM carried all over src/ui collapse
// into the token block in defaultUiTheme().
//
// GEOMETRY stays a literal inside the recipe on purpose: it is not what a theme changes, and
// tokenising every padding would hide the shape of a role behind a lookup. COLOUR is the axis that
// matters (light/dark/contrast), so colour is the axis that is named.
//
// Recipes are named by ROLE, not by raw box properties: a surface cannot invent its own layout, it
// picks an existing role or adds one here where the whole set is visible at once.
//
// This module is DOM-free and i18n-free on purpose — it is pure data plus one pure function, so the
// Node gate can assert it.
import { defineResource, type Resource } from "../../core/world";

export interface UiTheme {
  readonly color: {
    readonly text: string;
    /** Secondary labels ("Key binds", column headings) */
    readonly textDim: string;
    /** Hints and empty-state lines */
    readonly textFaint: string;
    /** The dimmest tier: list metadata */
    readonly textFainter: string;
    /** Floating surfaces (the F3+F4 picker) */
    readonly panel: string;
    /** Modal menu panels */
    readonly menuPanel: string;
    /** A row inside a list */
    readonly menuRow: string;
    /** The dark well the key bind chips scroll in */
    readonly menuSide: string;
    readonly panelEdge: string;
    readonly overlay: string;
    readonly accent: string;
    /** Text shadow recipe, reused by everything that sits on top of the world */
    readonly shadow: string;
    readonly titleShadow: string;
    readonly subtitleShadow: string;
    // --- buttons ---------------------------------------------------------------------
    readonly btnText: string;
    readonly btnBg: string;
    readonly btnBgHover: string;
    readonly btnEdge: string;
    readonly btnEdgeLight: string;
    readonly btnShadow: string;
    readonly btnTextShadow: string;
    /** A selected/active CHOICE (the blue of the settings and language picks) */
    readonly accentBg: string;
    readonly accentBgHover: string;
    /** The visual keyboard's key faces */
    readonly keyBg: string;
    /** An empty inventory slot: its face, its selected face, and its edge */
    readonly slotBg: string;
    readonly slotBgSelected: string;
    readonly slotEdge: string;
    /** The stack count sits on the icon, so it needs its own shadow */
    readonly countShadow: string;
    readonly crosshairShadow: string;
    readonly debugBg: string;
    readonly toastBg: string;
    /** The scrollbar thumb of every scrollable role (see `scroll`/`stylesheet`) */
    readonly scrollThumb: string;
  };
  /** The three dimmers the menus put over the world, by role */
  readonly backdrop: { readonly panorama: string; readonly scrim: string; readonly menu: string };
  readonly space: { readonly sm: string; readonly md: string; readonly lg: string };
  readonly radius: string;
  /** The two CSS custom properties that ui/fonts.ts writes — the only font surface that already existed */
  readonly font: { readonly ui: string; readonly mono: string };
  readonly size: {
    readonly small: string;
    readonly label: string;
    readonly btn: string;
    readonly title: string;
    readonly subtitle: string;
  };
  /** Rules an inline style CANNOT express (a ::-webkit-scrollbar, an @keyframes, for instance). The
   *  reconciler injects this ONCE as a <style> element, so a surface still never touches the document.
   *  Rules address a role through the `data-ui-recipe` attribute the reconciler stamps on every widget
   *  — that is what lets a recipe have pseudo-element styling without inventing a class name per
   *  surface. The scrollbar rules are GENERATED from `scroll`, so a newly scrollable role cannot get a
   *  browser-default bar by accident (that is how the key bind chips and the resource-pack list ended
   *  up looking like two different widgets). */
  readonly stylesheet: string;
  /** Recipes whose text SCROLLS when it does not fit (the visual keyboard's long legends). Text
   *  overflow is a rendering fact, so the reconciler measures it — a surface cannot. */
  readonly marquee: readonly UiRecipe[];
  /** Recipes that SCROLL (the key bind chip list, the resource-pack list). This list does two things:
   *  it GENERATES their scrollbar rules (above), so no role can end up with the browser's default bar by
   *  accident, and it tells the reconciler which widgets return to the TOP when their panel appears.
   *  Their position is deliberately NOT stored anywhere: a list starts at the top on every visit, and
   *  while the panel stays up the position is the browser's business. */
  readonly scroll: readonly UiRecipe[];
}

export const UI_THEME: Resource<UiTheme> = defineResource<UiTheme>("uiTheme");

/** Every token below is referenced by at least one recipe — there is no decorative palette. The values
 *  are the ones the hand-written surfaces used, so a migration is a move, not a redesign. */
export function defaultUiTheme(): UiTheme {
  const scrollThumb = "#444";
  /** The scrollable roles. ONE list feeds three things: the reconciler's "back to the top on appearance"
   *  edge, their scrollbar rules (generated into the stylesheet below) and their documentation. */
  const scrollRoles: UiRecipe[] = ["kb.chips", "settings.scrollArea", "settings.content"];
  return {
    color: {
      text: "#ffffff",
      textDim: "#bbbbbb",
      textFaint: "#999999",
      textFainter: "#aaaaaa",
      panel: "rgba(20,20,30,.92)",
      menuPanel: "#222222",
      menuRow: "#333333",
      menuSide: "#1a1a1a",
      panelEdge: "#555555",
      overlay: "rgba(0,0,0,.45)",
      accent: "rgba(255,255,255,.25)",
      shadow: "0 0.0625rem 0.125rem #000",
      titleShadow: "0 0.25rem 0 #2a2a2a,0 0.375rem 0.75rem rgba(0,0,0,.6)",
      subtitleShadow: "0 0.125rem 0 rgba(0,0,0,.5)",
      btnText: "#ffffff",
      btnBg: "#444444",
      btnBgHover: "#555555",
      btnEdge: "#1a1a1a",
      btnEdgeLight: "#7a7a7a",
      btnShadow: "inset 0 0.0625rem 0 rgba(255,255,255,.15),0 0.125rem 0.25rem rgba(0,0,0,.6)",
      btnTextShadow: "0 0.125rem 0 rgba(0,0,0,.5)",
      accentBg: "#4a9eff",
      accentBgHover: "#3b83d6",
      // P1.49w: a translucent DARKENING, not a white tint - the key faces darken the board behind them
      // (which still shows through) instead of lightening it, so the keys read as recessed and the bound
      // blue is the only thing that looks lit.
      keyBg: "rgba(0,0,0,0.3)",
      slotBg: "rgba(0,0,0,.35)",
      slotBgSelected: "rgba(255,255,255,.2)",
      slotEdge: "rgba(255,255,255,.25)",
      countShadow: "0 0.0625rem 0.0625rem #000",
      crosshairShadow: "0 0 0.125rem rgba(0,0,0,.8)",
      debugBg: "rgba(0,0,0,.55)",
      toastBg: "rgba(0,0,0,.8)",
      scrollThumb,
    },
    backdrop: {
      panorama: "rgba(0,0,0,.35)",
      scrim: "rgba(0,0,0,.5)",
      menu: "rgba(0,0,0,.55)",
    },
    space: { sm: "0.25rem", md: "0.5rem", lg: "0.875rem" },
    radius: "0.25rem",
    font: { ui: "var(--font-ui)", mono: "var(--font-mono)" },
    size: {
      small: "0.75rem",
      label: "0.875rem",
      btn: "0.9375rem",
      title: "3.25rem",
      subtitle: "1.4rem",
    },
    stylesheet:
      scrollRoles
        .map(
          (role) =>
            `[data-ui-recipe="${role}"]::-webkit-scrollbar{width:6px}` +
            `[data-ui-recipe="${role}"]::-webkit-scrollbar-thumb{background:${scrollThumb};border-radius:3px}` +
            `[data-ui-recipe="${role}"]::-webkit-scrollbar-track{background:transparent}`,
        )
        .join("") +
      // P1.49j: the SEAM between the language and font columns. It cannot be an inline style: a recipe is
      // per-ROLE and both columns share one, so "the second column only" would need an adjacent-sibling
      // selector - and drawing it on a column would put the line hard against that column is own padding
      // instead of in the 1.25rem gutter. An `::after` of the group, absolutely positioned at 50%, lands in
      // the middle of the gutter at ANY column widths, and `pointer-events:none` keeps the 1px line out of
      // the way of a click that happens to land on the column boundary.
      // P1.49k: the line runs the FULL height of the board. It used to be inset by 0.75rem (the board is own
      // vertical padding), which read as a gap rather than a divider - and the reason for the inset was wrong:
      // a board is rounded corners sit at its LEFT and RIGHT ends, so a line at 50% cannot reach one.
      '[data-ui-recipe="settings.columns"]::after{content:"";position:absolute;left:50%;top:0;' +
      'bottom:0;width:0.0625rem;pointer-events:none;background:rgba(255,255,255,0.1)}' +
      // P1.49m: the FPS slider is INVISIBLE until its ROW is hovered. This is CSS `:hover`, not the
      // reconciler is hover DATA, and deliberately: `:hover` also matches while the pointer is over a
      // DESCENDANT, which is exactly the relation wanted here, and it costs no frame of latency.
      // `pointer-events:none` while hidden is what keeps an invisible slider from being draggable; the
      // moment the pointer enters the row it fades in AND becomes interactive. `:focus-visible` is the
      // keyboard is way in (an invisible-but-focusable control must not be a trap).
      '[data-ui-recipe="settings.range"]{opacity:0;pointer-events:none;transition:opacity 120ms ease}' +
      '[data-ui-recipe="settings.optRow"]:hover [data-ui-recipe="settings.range"],' +
      '[data-ui-recipe="settings.range"]:focus-visible{opacity:1;pointer-events:auto}' +
      // P1.49s: the WHOLE ROW answers the pointer (an option is ring only covers the option is own box, so
      // the blank between the name and its control used to be inert). It has to be CSS `:hover`: the
      // reconciler tracks hover ONLY for widgets that carry a UI_ACTION (reconcile.ts, `tracksPointer`), so
      // a row panel - a plain div - never receives `state.hovered`, and no ancestor of it does either.
      // `:hover` matches while the pointer is over any DESCENDANT, which is exactly "the name, the control,
      // or the blank in between". The radius matches the option rings so the band reads as one row.
      '[data-ui-recipe="settings.optRow"]:hover{background:rgba(0,0,0,0.45);border-radius:0.375rem}' +
      "@keyframes capScroll{from{transform:translateX(0)}to{transform:translateX(var(--cap-shift))}}" +
      // **The cursor shape has exactly ONE source.** `recipeStyle()` carries 7 `cursor:pointer`s (button,
      // slider, grid key, list row, chip, hotbar slot), so the pointer becomes a hand as soon as it touches
      // a control. This rule forces **every** element's shape to `inherit`, all the way to `body` — whose
      // only value is the game's policy (`none` in game / `default` in a UI), written by `applyCursor()` in
      // platform/pointerlock.ts.
      //
      // Why it must be `inherit` and not `default`: `default` would cancel the in-game `none` as well (an
      // important stylesheet beats `body`'s ordinary inline style), and the children would each become
      // `default` instead of inheriting `body`'s `none`.
      // Why `body` itself is unaffected: it matches `*` too, but `applyCursor()` writes an **important
      // inline** style, and inline important beats stylesheet important.
      "*{cursor:inherit !important}",
    marquee: ["kb.keyLegend"],
    scroll: scrollRoles,
  };
}

/** The style roles a widget may use. Add a role here when a surface genuinely needs a new one. */
export type UiRecipe =
  // --- generic ------------------------------------------------------------------------
  | "text.label"
  // --- startup / world-entry loading screen -------------------------------------------
  | "loading.root"
  | "loading.title"
  | "loading.status"
  | "loading.track"
  | "loading.segment"
  | "loading.note"
  | "loading.noteText"
  // --- HUD ----------------------------------------------------------------------------
  | "hud.crosshair"
  | "hud.crosshairH"
  | "hud.crosshairV"
  | "hud.toast"
  | "debug.panel"
  | "debug.line"
  | "picker.panel"
  | "picker.row"
  | "picker.title"
  | "picker.item"
  // --- modal menu shells (main menu + pause menu) --------------------------------------
  | "menu.root"
  | "menu.backdrop"
  | "menu.backdropImage"
  | "menu.panel"
  | "menu.title"
  | "menu.subTitle"
  | "menu.btn"
  | "menu.stack"
  // --- shared settings panel ----------------------------------------------------------
  | "settings.panel"
  | "settings.panelWide"
  | "settings.panelXl"
  | "settings.title"
  | "settings.label"
  | "settings.value"
  | "settings.range"
  | "settings.columns"
  | "settings.column"
  | "settings.columnLabel"
  | "settings.btn"
  | "settings.btnSolid"
  | "settings.btnRow"
  | "settings.pageRows"
  | "settings.pageFill"
  | "settings.split"
  | "settings.nav"
  | "settings.content"
  | "settings.panelAuto"
  | "ui.frost"
  | "settings.choice"
  | "settings.scrollArea"
  | "settings.row"
  | "settings.rowName"
  | "settings.rowMeta"
  | "settings.optRow"
  | "settings.rowCtl"
  | "settings.rowBtn"
  | "settings.rowChoice"
  | "settings.list"
  | "settings.catcher"
  | "settings.empty"
  // --- visual keyboard (key bind panel) -----------------------------------------------
  | "kb.board"
  | "kb.hint"
  | "kb.flex"
  | "kb.keys"
  | "kb.side"
  | "kb.sideTitle"
  | "kb.chips"
  | "kb.chip"
  | "kb.row"
  | "kb.key"
  | "kb.keycap"
  | "kb.keyLegend"
  | "kb.line"
  | "kb.bottom"
  | "kb.title"
  | "kb.tower"
  | "kb.mouse"
  | "kb.numpad"
  // --- inventory ----------------------------------------------------------------------
  | "inv.hotbar"
  | "inv.panel"
  | "inv.inner"
  | "inv.grid"
  | "inv.title"
  | "inv.cell"
  | "inv.slot"
  | "inv.icon"
  | "inv.count";

export interface UiWidgetState {
  readonly selected: boolean;
  /** Engaged by data rather than by a pick (a keycap that carries a binding) */
  readonly active: boolean;
  /** True while the pointer is over the element. DOM-transient: the reconciler owns it, a surface
   *  cannot set it — but it must reach the style table, or hover shades would live in event handlers
   *  (which is exactly what the hand-written menus did). */
  readonly hovered: boolean;
  /** True while the element is held down (the pressed-in look the main-menu buttons had) */
  readonly pressed: boolean;
}

/** The whole visual language, in one switch. Pure: (recipe, state, theme) -> style string. */
export function recipeStyle(recipe: UiRecipe, state: UiWidgetState, theme: UiTheme): string {
  const c = theme.color;
  const s = theme.space;
  /** The modal panel face, in the three widths the settings surfaces use. TRANSLUCENT on purpose: the ui lane
   *  paints a full-screen frosted layer behind every menu (`menu.backdrop`), so a solid board would hide the
   *  very thing the blur exists to show. The alpha is a weight, not a decoration: it is what keeps the text
   *  readable over a bright world. */
  const settingsPanelBg = "rgba(12,12,16,0.45)";
  const settingsPanel = (width: string): string =>
    `width:${width};background:${settingsPanelBg};border-radius:0.625rem;padding:1.25rem;` +
    `text-align:center;color:${c.text};font:1rem ${theme.font.ui};box-shadow:0 0.25rem 1.25rem rgba(0,0,0,.5);`;
  // THE OPTION SURFACES (P1.49f). With no card of its own the settings screen has to say "this is a
  // control" some other way, so an option is a DARKENED TRANSLUCENT strip: it darkens whatever the frost
  // blurred behind it instead of painting an opaque grey chip, and the SELECTED state is the accent colour
  // with alpha, so the backdrop still shows through it. Deliberately NOT tokens: this is the settings
  // screens own three-state palette, while `c.*` stays the general one (the pause card keeps using it).
  const option = "rgba(0,0,0,0.28)";
  const optionHover = "rgba(0,0,0,0.45)";
  const optionOn = "rgba(74,158,255,0.5)";
  const optionOnHover = "rgba(59,131,214,0.65)";
  // THE SELECTION RING (P1.49r): every text-only option wears a thin INSET ring, so a control with no fill
  // still reads as something selectable. An inset shadow and NOT a border: a border adds 2px to the box
  // (content-box) and would shift the row it sits in, while an inset ring costs no layout and follows the
  // border radius. Three weights - visible at rest, brighter under the pointer, brightest when chosen.
  const ring = "inset 0 0 0 0.0625rem rgba(255,255,255,0.12)";
  const ringHover = "inset 0 0 0 0.0625rem rgba(255,255,255,0.28)";
  const ringOn = "inset 0 0 0 0.0625rem rgba(255,255,255,0.4)";
  // THE SCREEN ITSELF: `position:absolute;inset:0` fills `menu.root` / `menu.backdrop` (both are fixed,
  // full-screen flex containers). The scrim is deliberately NEARLY transparent - the frost already blurs
  // and darkens the whole viewport - and the option strips carry the rest of the darkening. The screen is
  // a COLUMN: title, split (flex:1), Back - with `overflow:hidden`, so the screen can never scroll.
  const settingsScreenBg = "rgba(10,10,14,0.12)";
  const settingsScreen =
    // THE CONTENT BAND (P1.49r): the screen is full-bleed, but its CONTENT is capped at 56rem and centred.
    // Without this the rows were as wide as the window (62.75rem at 1280, the same in rem on a 1920 screen),
    // and a name-left/control-right row then had an empty middle a thousand pixels wide - the same missing
    // cap that made the value buttons look impossibly long. `max(1.5rem, ...)` keeps the old behaviour on a
    // window too narrow for the band, and because the PADDING does it, the title, the nav, the sections and
    // Back all sit in the same band.
    `position:absolute;inset:0;background:${settingsScreenBg};` +
    `padding:0.75rem max(1.5rem, calc((100% - 56rem) / 2)) 1rem;` +
    `text-align:center;color:${c.text};font:1rem ${theme.font.ui};display:flex;flex-direction:column;overflow:hidden;`;
  switch (recipe) {
    case "text.label":
      return `color:${c.text};text-shadow:${c.shadow};`;

    // --- loading screen (startup, and a world entry) ------------------------------------
    // The first thing the window ever shows, and the only surface up while the GPU is still being
    // initialised — so its root is OPAQUE (there is nothing behind it yet, and a transparent root
    // would flash the window's white before the canvas exists) and it outranks every other layer,
    // the toast (60) and the main menu (50) included.
    case "loading.root":
      return "position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;align-items:center;" +
        `justify-content:center;gap:${s.lg};background:${c.menuSide};color:${c.text};` +
        `font-family:${theme.font.ui};`;
    case "loading.title":
      return `font-size:${theme.size.title};font-weight:800;letter-spacing:0.125rem;text-shadow:${c.titleShadow};`;
    case "loading.status":
      return `font-size:${theme.size.label};color:${c.textDim};`;
    // The bar: a fixed-width track of N segments. Progress is which segments are ENGAGED — the bar
    // reads `state.active`, so the data behind it is a boolean per segment, not a width percentage.
    case "loading.track":
      return "display:flex;gap:0.125rem;width:16rem;height:0.75rem;padding:0.125rem;" +
        `border:0.125rem solid ${c.panelEdge};border-radius:${theme.radius};`;
    case "loading.segment":
      return `flex:1 1 0%;border-radius:0.0625rem;background:${state.active ? c.accentBg : c.keyBg};`;
    // The settings check's outcome: a translated label ("repaired settings") over a literal list of
    // setting names, and hidden entirely when the check found nothing.
    case "loading.note":
      return "display:flex;flex-direction:column;align-items:center;gap:0.125rem;max-width:34rem;text-align:center;";
    case "loading.noteText":
      return `font-size:${theme.size.small};color:${c.textFaint};white-space:pre-wrap;word-break:break-word;`;

    // --- crosshair: a full-screen layer holding two self-centring bars -----------------
    // Sizes, z-index and the dark outline are the ones the hand-written HUD used.
    case "hud.crosshair":
      return "position:fixed;inset:0;pointer-events:none;z-index:10;";
    case "hud.crosshairH":
      return `position:absolute;left:50%;top:50%;width:1.25rem;height:0.125rem;background:${c.text};` +
        `transform:translate(-50%,-50%);box-shadow:${c.crosshairShadow};`;
    case "hud.crosshairV":
      return `position:absolute;left:50%;top:50%;width:0.125rem;height:1.25rem;background:${c.text};` +
        `transform:translate(-50%,-50%);box-shadow:${c.crosshairShadow};`;

    // --- toast: bottom-centred feedback line (the hidden flag supplies display:none) ----
    case "hud.toast":
      return `position:fixed;left:50%;bottom:3.75rem;transform:translateX(-50%);z-index:60;color:${c.text};` +
        `font:${theme.size.label}/1.6 ${theme.font.ui};background:${c.toastBg};padding:0.5rem 1.125rem;` +
        `border-radius:0.375rem;max-width:80vw;text-align:center;white-space:pre-wrap;`;

    // --- F3 debug panel: monospace, top-left ------------------------------------------
    case "debug.panel":
      return `position:fixed;top:0.5rem;left:0.5rem;z-index:20;color:${c.text};` +
        `font:${theme.size.small}/1.7 ${theme.font.mono};background:${c.debugBg};padding:0.375rem 0.625rem;` +
        `border-radius:${theme.radius};white-space:pre;`;
    case "debug.line":
      return `color:${c.text};`;

    // --- F3+F4 game-mode picker: a centred row of choices, one selected ---------------
    case "picker.panel":
      return `position:fixed;bottom:6.25rem;left:50%;transform:translateX(-50%);z-index:25;text-align:center;font:${theme.size.label}/1.6 ${theme.font.ui};`;
    case "picker.row":
      return `display:flex;gap:${s.md};justify-content:center;`;
    case "picker.title":
      return `color:${c.text};text-shadow:${c.shadow};font-weight:600;margin-bottom:${s.sm};`;
    case "picker.item":
      return `padding:${s.sm} ${s.lg};border-radius:${theme.radius};color:${c.text};` +
        `background:${state.selected ? c.accent : c.overlay};` +
        `border:0.125rem solid ${state.selected ? c.text : "transparent"};text-shadow:${c.shadow};`;

    // --- modal menu shells -------------------------------------------------------------
    // The root is a full-screen flex layer; z-index is what orders the two menus against each
    // other and against the HUD. A menu root that must sit ABOVE another (the main menu above the
    // pause menu, a settings sub-panel above its parent) uses menu.backdrop.
    case "menu.root":
      return "position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;" +
        `background:${theme.backdrop.menu};font-family:${theme.font.ui};`;
    // The main menu: the highest z-index of the modal surfaces because it owns the whole screen. Two
    // variants, because the background decision (panorama vs image) is made at wiring time: the
    // panorama lets the canvas show through behind a dimmer, the image variant paints an opaque black
    // face that UI_IMAGE then fills (with the scrim the reconciler adds).
    case "menu.backdrop":
      return "position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;" +
        `image-rendering:pixelated;background:${theme.backdrop.panorama};font-family:${theme.font.ui};`;
    case "menu.backdropImage":
      return "position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;" +
        "image-rendering:pixelated;background:#000 center/cover no-repeat;" +
        `font-family:${theme.font.ui};`;
    case "menu.panel":
      return "width:18.75rem;text-align:center;";
    case "menu.title":
      return `font-size:${theme.size.title};font-weight:800;color:${c.text};margin-bottom:1.75rem;` +
        `letter-spacing:0.125rem;text-shadow:${c.titleShadow};`;
    case "menu.subTitle":
      return `font-size:${theme.size.subtitle};font-weight:700;color:${c.text};margin-bottom:1rem;` +
        `text-shadow:${c.subtitleShadow};`;
    // The chunky main-menu button: gradient face, inset light edge, pressed-in travel.
    case "menu.btn":
      return `display:block;width:100%;padding:0.75rem;margin:0.5rem 0;font:1rem ${theme.font.ui};` +
        `color:${c.btnText};background:linear-gradient(${c.btnEdgeLight},#4d4d4d);` +
        `border:0.125rem solid ${c.btnEdge};border-top-color:${c.btnEdgeLight};border-left-color:${c.btnEdgeLight};` +
        `box-shadow:${c.btnShadow};cursor:pointer;text-shadow:${c.btnTextShadow};` +
        (state.pressed ? "transform:translateY(0.0625rem);" : "") +
        (state.hovered ? "filter:brightness(1.25);" : "");
    case "menu.stack":
      return "display:flex;flex-direction:column;align-items:center;";

    // --- shared settings panel ---------------------------------------------------------
    case "settings.panel":
      return settingsPanel("17.5rem");
    case "settings.panelWide":
      return settingsPanel("34rem");
    case "settings.panelXl":
      return settingsPanel("40rem");
    // THE SETTINGS SCREEN (P1.49f): not a floating card any more. It fills the menu root, so it has no
    // width to choose and no cap to hit, and being the viewport it CANNOT overflow - it can never grow a
    // scrollbar. The two columns scroll inside themselves instead (settings.content), which is what keeps
    // the title at the top and Back at the bottom while a long page moves.
    // The history explains the shape: P1.49c made this box `min(64rem,94vw)` with its own `overflow:auto`
    // (a card that scrolled on a small window) and P1.49d then made the key bind page compress so that
    // card could never actually grow one. Both are superseded here.
    // `ui.frost` still does the BLURRING (one full-screen layer, up behind every menu), so this surface
    // adds only a hint of scrim and must NOT repeat the `backdrop-filter`: a second blur over the same
    // area is a second blur pass for no visual gain.
    case "settings.panelAuto":
      return settingsScreen;
    case "settings.title":
      return "font-size:1.375rem;margin-bottom:0.875rem;";
    case "settings.label":
      return "text-align:left;font-size:0.9375rem;margin:0.5rem 0 0.25rem;";
    case "settings.value":
      // Compact and right-aligned since P1.49m: it is the LAST thing in its row, and `min-width` is what
      // keeps the slider (which sits to its left) from moving as the text goes 60 FPS -> Unlimited.
      return "text-align:right;font-size:0.9375rem;font-weight:600;margin:0;min-width:4.5rem;";
    case "settings.range":
      // NARROW and inline now: the slider lives INSIDE its row, and the stylesheet below hides it until
      // that row is hovered (P1.49m).
      return `width:11rem;margin:0;accent-color:${c.accentBg};cursor:pointer;`;
    // THE SPLIT (P1.49): ONE settings screen with a LEFT section nav and a RIGHT content area. It replaced
    // the sub-panel chain (a list that navigated into sibling panels, each with its own Back button).
    // P1.49f: `flex:1;min-height:0` makes it FILL the screen between the title and Back, and
    // `align-items:stretch` gives both columns the full height so each one scrolls on its own.
    case "settings.split":
      return "display:flex;gap:1.25rem;align-items:stretch;flex:1;min-height:0;text-align:left;";
    // P1.49g: the nav column gets its own BACKPLATE. Without one the section buttons floated on the
    // translucent screen and the left side read as four loose strips with nothing behind them. The block
    // is a shade DARKER than the options (option = rgba(0,0,0,0.28)) so the strips sit ON something.
    // It is FULL HEIGHT because `settings.split` uses `align-items:stretch`; an `align-self:flex-start`
    // here would shrink it to hug the buttons instead.
    case "settings.nav":
      return "display:block;flex:0 0 11rem;background:rgba(0,0,0,0.55);border-radius:0.5rem;padding:0.5rem;";
    // The CONTENT column is the scroll container of the screen (P1.49f): a long page (the key bind one)
    // moves HERE, so the title, the nav and Back stay where they are. `min-height:0` is what lets a flex
    // item actually scroll instead of stretching its parent.
    case "settings.content":
      return "flex:1;min-width:0;min-height:0;overflow-y:auto;background:rgba(0,0,0,0.34);border-radius:0.5rem;padding:0.75rem 1rem;";
    // P1.49i: the language + font GROUP has a backplate of its own. It is the same 0.34 as the nav and the
    // content column, and that is deliberate: alpha STACKS, so this block still reads clearly darker than
    // the content backplate it sits on, while the options inside it (0.28) stay the LIGHTER strips - the
    // exact relationship the nav column already has. Same colour on same colour is the layering here.
    // P1.49j: `position:relative` is for the SEAM below - the divider is an absolute `::after` of this
    // block (see the stylesheet), so it needs a positioned ancestor. The two columns stay EXACTLY as they
    // were: equal `flex:1` halves with a 1.25rem gap, whose midpoint is this block is 50%.
    // A page that FILLS its plate VERTICALLY (P1.49z). `settings.pageRows` above is deliberately a plain
    // block, and it must stay one for the sections whose rows rely on margin collapsing - so the two
    // sections that want to fill get their OWN container instead of changing it for everyone. `min-height`
    // and not `height`: the page then fills the plate when its content is short, and still GROWS (and lets
    // the plate scroll) when it is tall, which a fixed `height:100%` could not do.
    case "settings.pageFill":
      return "display:flex;flex-direction:column;min-height:100%;margin:0;padding:0;border:0;";
    case "settings.columns":
      // `flex:1` makes the board take the rest of the FILL page (P1.49z) - the buttons stay at the top of
      // their columns, the board is what stretches to the bottom of the plate.
      return "display:flex;flex:1;gap:1.25rem;margin-bottom:0.875rem;background:rgba(0,0,0,0.34);" +
        "border-radius:0.5rem;padding:0.75rem 1rem;position:relative;";
    case "settings.column":
      return "flex:1;text-align:left;";
    case "settings.columnLabel":
      return `font-size:0.9375rem;color:${c.textDim};margin-bottom:0.5rem;`;
    // The bar-style button every settings entry uses - a GHOST since P1.49l: no box until the pointer is on
    // it (hover/press) or the value is chosen (selected). The hit area is UNCHANGED, because the padding
    // that drew the box is also what pads the text - only the fill is gone. The pause card keeps a filled
    // face of its own (settings.btnSolid) so the change stays inside the settings screen.
    case "settings.btn":
      return `display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:${theme.size.btn} ${theme.font.ui};` +
        `color:${c.btnText};background:${state.hovered || state.pressed ? optionHover : "transparent"};border:none;` +
        `border-radius:0.375rem;box-shadow:${state.hovered || state.pressed ? ringHover : ring};cursor:pointer;`;
    case "settings.btnRow":
      return "display:flex;gap:0.375rem;margin:0 0 0.375rem;";
    // The container PAGE ROWS are mounted into (P1.29). It must be LAYOUT-NEUTRAL, and the reason is subtler
    // than "no margins": the settings panel is a plain BLOCK box, so the spacing between two rows comes from
    // their own `margin:0.375rem 0` COLLAPSING (0.375rem between neighbours, not 0.75). A `display:flex`
    // wrapper turns its child into a flex item, where margins do NOT collapse — the row then sits 0.375rem
    // further from everything around it, which reads as "almost right, but the gap is bigger". A plain block
    // wrapper collapses through, so the row ends up exactly where it was as a direct child.
    case "settings.pageRows":
      return "display:block;margin:0;padding:0;border:0;";
    // THE FROST (P1.30): a full-screen, click-transparent layer UNDER every menu. `backdrop-filter` blurs what
    // is painted below it — the WebGPU canvas — so opening a menu blurs and darkens the WORLD, while the
    // panels and their text stay sharp (they are painted above this layer).
    //   * `pointer-events:none` is load-bearing: the layer covers the canvas, and without it a click meant for
    //     the world (or a UI element below it) would be swallowed by a full-screen div;
    //   * `z-index:1` keeps it under the panels (z-30/31) and above the canvas;
    //   * the alpha is the DARKENING the user asked for (0.25 = medium).
    // NOT `menu.backdrop` — that name is TAKEN (the main menu's full-screen background, z-50 opaque). The
    // first version of this layer reused it, so the widget inherited THAT style: an opaque z-50 sheet over
    // everything, which covered the backpack and swallowed its clicks, while this case was unreachable.
    case "ui.frost":
      return "position:fixed;left:0;top:0;right:0;bottom:0;z-index:1;pointer-events:none;" +
        "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);background:rgba(0,0,0,0.25);";
    // P1.49l: the FILLED button is its own role now. `settings.btn` went ghost for the settings screen, and
    // the pause card - the one surface outside it - keeps exactly the face it has today through this role.
    case "settings.btnSolid":
      return `display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:${theme.size.btn} ${theme.font.ui};` +
        `color:${c.btnText};background:${state.hovered || state.pressed ? optionHover : option};border:none;` +
        `border-radius:0.375rem;cursor:pointer;`;
    // A CHOICE: one of a small set (language, font, world type). Blue while selected - and since P1.49l
    // boxed around the TEXT only while hovered or selected, so the list reads as text, not as blocks.
    case "settings.choice":
      return `display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:${theme.size.btn} ${theme.font.ui};` +
        `color:${c.btnText};background:${
          state.selected ? (state.hovered ? optionOnHover : optionOn) : state.hovered ? optionHover : "transparent"
        };border:none;border-radius:0.375rem;box-shadow:${
          state.selected ? ringOn : state.hovered ? ringHover : ring
        };cursor:pointer;text-align:center;`;
    case "settings.scrollArea":
      return "max-height:12.5rem;overflow-y:auto;margin-bottom:0.375rem;";
    case "settings.row":
      return `display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0.625rem;` +
        `margin:0.25rem 0;background:${option};border-radius:0.375rem;font-size:${theme.size.label};`;
    case "settings.rowName":
      return "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    case "settings.rowMeta":
      return `flex-shrink:0;margin-left:0.5rem;color:${c.textFainter};font-size:${theme.size.small};`;
    // --- a settings ROW (P1.49m): the NAME on the left, the CONTROL on the right -------------------
    // The section used to STACK a label, a value and a control, so one option was three lines tall and the
    // page read as a form. A row says the same thing in one line - and it is also what makes the reveal in
    // the stylesheet possible: the FPS slider lives INSIDE the row that owns it.
    // `position:relative` is the ANCHOR of this row is dropdown popup (P1.49n).
    case "settings.optRow":
      // P1.49t: the horizontal padding and margin are a PAIR. The row band is what lights up on hover, and at
      // `padding:0.25rem` its edge sat 4px from the name and from the control ring, which read as the band
      // cutting into the text. Raising the padding alone would have shifted every name 8px right, out of line
      // with the other sections, so the negative margin gives the band its room OUTWARD instead: the text and
      // the controls stay at exactly the x they were at, and only the band grows (into the plate is 1rem
      // padding, i.e. it still stops 0.5rem short of the plate edge).
      return "position:relative;display:flex;justify-content:space-between;align-items:center;gap:0.75rem;" +
        "padding:0.4375rem 0.75rem;margin:0.0625rem -0.5rem;";
    case "settings.rowCtl":
      return "display:flex;align-items:center;gap:0.5rem;flex-shrink:0;";
    // The row is VALUE button: compact, ghost, and it is what OPENS a dropdown list.
    case "settings.rowBtn":
      return `display:inline-block;width:auto;padding:0.375rem 0.75rem;margin:0;font:0.875rem ${theme.font.ui};` +
        `color:${c.btnText};background:${state.hovered || state.pressed ? optionHover : "transparent"};border:none;` +
        `border-radius:0.3125rem;box-shadow:${state.hovered || state.pressed ? ringHover : ring};` +
        `cursor:pointer;white-space:nowrap;`;
    // One ENTRY of a dropdown list: a FULL-WIDTH menu ROW with CENTRED text, so the popup reads as a
    // vertical list under its button (the button above it is centred too - a left-aligned entry looked
    // like a stray label).
    //   * `display` lives HERE and not in a stylesheet rule beside the popup, because a recipe writes its
    //     style as an INLINE style and inline beats the stylesheet - a rule saying `display:block` for the
    //     entries silently lost to this `inline-block`, which is exactly why the first version of the popup
    //     laid its entries out side by side.
    //   * the language/font page does NOT use this role (it uses `settings.choice`), so a vertical entry is
    //     safe here.
    case "settings.rowChoice":
      return `display:block;width:100%;text-align:center;padding:0.4375rem 0.625rem;margin:0;font:0.8125rem ${theme.font.ui};` +
        `color:${c.btnText};background:${
          state.selected ? (state.hovered ? optionOnHover : optionOn) : state.hovered ? optionHover : "transparent"
        };border:none;border-radius:0.3125rem;box-shadow:${
          state.selected ? ringOn : state.hovered ? ringHover : ring
        };cursor:pointer;white-space:nowrap;`;
    // THE DROPDOWN POPUP (P1.49n): it is a child of its ROW and absolutely positioned under it, so it is a
    // real dropdown - opening one does NOT reflow the rows below it. `top:100%;right:0` puts it flush under
    // the row and aligns its right edge with the row is (i.e. with the value button). Its visibility is
    // DATA (`UI_MODAL.settingsList`), painted by ui.navigation like every other panel.
    // It is a COLUMN of full-width entries - the stylesheet below turns the chips into menu rows when they
    // sit in here, which is why one entry recipe can serve both the popup and an inline choice.
    // THE CLICK CATCHER (P1.49q): a transparent, full-VIEWPORT button that exists only while its dropdown
    // is open, so a click anywhere else dismisses the list (the standard dropdown behaviour). It is a
    // button because that is what carries a UI_ACTION, and `position:fixed` because that also makes it
    // escape the content column is scroll clipping. `z-index:4` puts it above every row and below the
    // popup (5), so an entry is still clickable; nothing is drawn - no background, border or padding.
    case "settings.catcher":
      return "position:fixed;inset:0;z-index:4;background:transparent;border:none;padding:0;";
    case "settings.list":
      return "position:absolute;top:100%;right:0;z-index:5;display:block;min-width:7.5rem;" +
        "background:rgba(12,12,16,0.94);border:0.0625rem solid rgba(255,255,255,0.14);" +
        "border-radius:0.375rem;padding:0.25rem;box-shadow:0 0.5rem 1.25rem rgba(0,0,0,.55);";
    case "settings.empty":
      return `font-size:${theme.size.btn};color:${c.textFaint};padding:0.5rem 0;`;

    // --- visual keyboard ---------------------------------------------------------------
    case "kb.board":
      return "flex:1 1 auto;min-width:0;user-select:none;";
    case "kb.hint":
      return `font-size:${theme.size.small};color:${c.textFaint};margin-bottom:0.625rem;`;
    case "kb.flex":
      return "display:flex;gap:0.75rem;align-items:flex-start;margin-bottom:0.625rem;";
    case "kb.keys":
      return "flex:1 1 auto;min-width:0;user-select:none;";
    // The chip column is the TALLEST thing on the key bind page (the list alone is `max-height:20rem`),
    // so its cap is viewport-relative like the rows: 20rem IS 45vh while the UI scale follows the window
    // height (20rem = 0.444h), so the rem wins at every ordinary size and the vh branch only takes over
    // under the 8px FONT_MIN floor - where the page would otherwise be taller than the box and scroll.
    case "kb.side":
      return "width:11rem;flex-shrink:0;max-height:min(20rem,45vh);display:flex;flex-direction:column;gap:0.375rem;" +
        `background:${option};border-radius:0.5rem;padding:0.625rem;overflow:hidden;`;
    case "kb.sideTitle":
      return `font-size:${theme.size.btn};color:${c.textDim};text-align:center;`;
    case "kb.chips":
      return "flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:0.375rem;padding-right:0.5rem;";
    // The key bind drag's RUBBER BAND. It is a widget now (ui/menu.ts used to own an SVG element and
    // mutate its line per mousemove): the theme gives it the accent colour and the stacking, and its
    // GEOMETRY arrives as the widget's own UI_LAYOUT string, written by ui.keybind each frame — a layout
    // string is appended after the recipe, so it is what decides left/top/width/rotate.
    case "kb.line":
      return `position:fixed;height:0.125rem;z-index:9999;pointer-events:none;border-radius:0;background:${c.accentBg};`;
    case "kb.chip":
      return `width:100%;padding:0.4375rem 0.625rem;font:0.8125rem ${theme.font.ui};color:${c.btnText};border:none;` +
        `border-radius:0.3125rem;cursor:pointer;background:${
          state.selected ? optionOn : state.hovered ? optionHover : "transparent"
        };text-align:center;`;
    case "kb.row":
      return "display:flex;gap:0.125rem;margin-bottom:0.125rem;";
    case "kb.key":
      return "flex:1 1 0%;min-width:0;";
    // A keycap: blue face while it CARRIES a binding (active), white outline while it is the target of
    // a drag or a pick (selected) — the two states the hand-written panel wrote as inline
    // `style.background` / `style.outline`.
    case "kb.keycap":
      return "padding:0.0625rem;color:" + c.text + ";border:none;border-radius:0.25rem;cursor:pointer;" +
        // The BOUND key keeps the accent hue but gains alpha, for the same reason: one translucent face per
        // state, so a bound key and a free key are the same material in two colours.
        `background:${state.active ? "rgba(74,158,255,0.55)" : c.keyBg};` +
        `display:flex;align-items:center;justify-content:center;overflow:hidden;` +
        `outline:${state.selected ? `2px solid ${c.text}` : "none"};`;
    case "kb.keyLegend":
      return `font-family:${theme.font.ui};font-size:0.6875rem;line-height:1.15;white-space:nowrap;` +
        "overflow:hidden;text-overflow:ellipsis;max-width:100%;";
    case "kb.bottom":
      return "display:flex;gap:1.25rem;justify-content:flex-start;align-items:flex-end;margin-top:0.25rem;";
    case "kb.title":
      return "font-size:1.375rem;margin-bottom:0.375rem;";
    // THE THREE BOTTOM CLUSTERS ARE COMPRESSIBLE (P1.49d). They were fixed-track grids
    // (`repeat(3,2.2rem)`), and a fixed track does not shrink: a grid is then at least the SUM of its
    // tracks wide, so as flex items of `kb.bottom` these three bottomed out at ~25.75rem, spilled past
    // the board is right edge and became the settings box HORIZONTAL scrollbar on a small window, while
    // the main keyboard - whose keys are flex - shrank to slivers. `minmax(0,1fr)` gives every track a
    // ZERO minimum, so a cluster shrinks with its row, and `flex:0 1 <its old width>` keeps the rendered
    // size EXACTLY as it was: no grow (they stay left-aligned) and any ordinary window is wider than the
    // bases, so nothing shrinks at all. The row height is `min(1.8rem,4vh)` for one level down: 1.8rem IS
    // 4vh exactly whenever the UI scale follows the window height, and past the 8px root-font floor
    // (data/globals/uiscale.ts, under 360px tall) the rem stops shrinking while the viewport keeps going -
    // the vh branch takes over, so the page fits its max-height instead of growing a scrollbar.
    // tower: 3 columns (PrtSc / arrow cluster)
    case "kb.tower":
      return "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:min(1.8rem,4vh);gap:0.125rem;flex:0 1 6.85rem;min-width:0;";

    // mouse: 6 half-column tracks
    case "kb.mouse":
      return "display:grid;grid-template-columns:repeat(6,minmax(0,1fr));grid-auto-rows:min(1.8rem,4vh);gap:0.125rem;flex:0 1 7.225rem;min-width:0;";

    // numpad: 4 columns
    case "kb.numpad":
      return "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:min(1.8rem,4vh);gap:0.125rem;flex:0 1 9.175rem;min-width:0;";

    // --- inventory ---------------------------------------------------------------------
    case "inv.hotbar":
      return "position:fixed;bottom:0.25rem;left:50%;transform:translateX(-50%);z-index:31;display:flex;gap:0.1875rem;";
    case "inv.panel":
      return `position:fixed;inset:0;z-index:30;background:${c.overlay};display:flex;align-items:center;justify-content:center;`;
    case "inv.inner":
      return `background:${c.panel};border:0.125rem solid ${c.panelEdge};border-radius:0.375rem;padding:0.875rem;`;
    case "inv.grid":
      return "display:grid;grid-template-columns:repeat(9,3rem);gap:0.1875rem;";
    case "inv.title":
      return `color:${c.text};font:600 1rem/1.5 ${theme.font.ui};margin-bottom:0.5rem;text-align:center;`;
    case "inv.cell":
      return `background:${c.menuSide};border-radius:0.25rem;display:flex;align-items:center;justify-content:center;`;
    // A slot: the old view wrote `style.borderColor`/`style.background` on selection, so the pick has to
    // reach the style table — which is exactly what `selected` is for.
    case "inv.slot":
      return "width:3rem;height:3rem;position:relative;display:flex;align-items:center;justify-content:center;" +
        `border:0.125rem solid ${state.selected ? c.text : c.slotEdge};border-radius:0.25rem;cursor:pointer;` +
        `background:${state.selected ? c.slotBgSelected : c.slotBg};` +
        (state.hovered ? "filter:brightness(1.2);" : "");
    case "inv.icon":
      return "width:2.5rem;height:2.5rem;background-size:cover;background-position:center;";
    case "inv.count":
      return `position:absolute;right:0.125rem;bottom:0;color:${c.text};font:600 0.75rem/1.4 ${theme.font.mono};` +
        `text-shadow:${c.countShadow};`;
  }
}
