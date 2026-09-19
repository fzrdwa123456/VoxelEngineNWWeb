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
import { defineResource, type Resource } from "../World";

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
  const scrollRoles: UiRecipe[] = ["kb.chips", "settings.scrollArea"];
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
      keyBg: "#3a3a3a",
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
      "@keyframes capScroll{from{transform:translateX(0)}to{transform:translateX(var(--cap-shift))}}" +
      // **光标形状只有一个来源。** recipeStyle() 里有 7 处 `cursor:pointer`（按钮、滑块、格子键、
      // 列表行、chip、hotbar 槽位），于是鼠标一碰到控件就变手型。这条把**所有**元素的形状强制成
      // "继承"，一路继承到 body —— 而 body 的唯一值就是游戏的策略（游戏中 none / 界面 default），
      // 由 platform/pointerlock.ts 的 applyCursor() 写入。
      //
      // 为什么必须是 `inherit` 而不是 `default`：用 `default` 会把游戏中那个 `none` 也一起废掉
      // （important 样式表压过 body 的普通内联），而且子元素会各自变 default、不再继承 body 的 none。
      // 为什么 body 自己不受影响：它虽然也命中 `*`，但 applyCursor() 是用 **important 内联**写的，
      // 内联 important 赢过样式表 important。
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
  | "settings.btnRow"
  | "settings.choice"
  | "settings.scrollArea"
  | "settings.row"
  | "settings.rowName"
  | "settings.rowMeta"
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
  /** The modal panel face, in the three widths the settings surfaces use */
  const settingsPanel = (width: string): string =>
    `width:${width};background:${c.menuPanel};border-radius:0.625rem;padding:1.25rem;` +
    `text-align:center;color:${c.text};font:1rem ${theme.font.ui};box-shadow:0 0.25rem 1.25rem rgba(0,0,0,.5);`;
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
    case "settings.title":
      return "font-size:1.375rem;margin-bottom:0.875rem;";
    case "settings.label":
      return "text-align:left;font-size:0.9375rem;margin:0.5rem 0 0.25rem;";
    case "settings.value":
      return "text-align:center;font-size:1.25rem;font-weight:600;margin:0.125rem 0 0.375rem;";
    case "settings.range":
      return `width:100%;margin:0 0 0.625rem;accent-color:${c.accentBg};cursor:pointer;`;
    case "settings.columns":
      return "display:flex;gap:1.25rem;margin-bottom:0.875rem;";
    case "settings.column":
      return "flex:1;text-align:left;";
    case "settings.columnLabel":
      return `font-size:0.9375rem;color:${c.textDim};margin-bottom:0.5rem;`;
    // The bar-style button every settings entry uses.
    case "settings.btn":
      return `display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:${theme.size.btn} ${theme.font.ui};` +
        `color:${c.btnText};background:${state.hovered || state.pressed ? c.btnBgHover : c.btnBg};border:none;` +
        `border-radius:0.375rem;cursor:pointer;`;
    case "settings.btnRow":
      return "display:flex;gap:0.375rem;margin:0 0 0.375rem;";
    // A CHOICE: one of a small set (language, font, world type). Blue while selected.
    case "settings.choice":
      return `display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:${theme.size.btn} ${theme.font.ui};` +
        `color:${c.btnText};background:${
          state.selected ? (state.hovered ? c.accentBgHover : c.accentBg) : state.hovered ? c.btnBgHover : c.btnBg
        };border:none;border-radius:0.375rem;cursor:pointer;text-align:center;`;
    case "settings.scrollArea":
      return "max-height:12.5rem;overflow-y:auto;margin-bottom:0.375rem;";
    case "settings.row":
      return `display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0.625rem;` +
        `margin:0.25rem 0;background:${c.menuRow};border-radius:0.375rem;font-size:${theme.size.label};`;
    case "settings.rowName":
      return "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    case "settings.rowMeta":
      return `flex-shrink:0;margin-left:0.5rem;color:${c.textFainter};font-size:${theme.size.small};`;
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
    case "kb.side":
      return "width:11rem;flex-shrink:0;max-height:20rem;display:flex;flex-direction:column;gap:0.375rem;" +
        `background:${c.menuSide};border-radius:0.5rem;padding:0.625rem;overflow:hidden;`;
    case "kb.sideTitle":
      return `font-size:${theme.size.btn};color:${c.textDim};text-align:center;`;
    case "kb.chips":
      return "flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:0.375rem;padding-right:0.5rem;";
    case "kb.chip":
      return `width:100%;padding:0.4375rem 0.625rem;font:0.8125rem ${theme.font.ui};color:${c.btnText};border:none;` +
        `border-radius:0.3125rem;cursor:pointer;background:${
          state.selected ? c.accentBg : state.hovered ? c.btnBgHover : c.btnBg
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
        `background:${state.active ? c.accentBg : c.keyBg};display:flex;align-items:center;justify-content:center;overflow:hidden;` +
        `outline:${state.selected ? `2px solid ${c.text}` : "none"};`;
    case "kb.keyLegend":
      return `font-family:${theme.font.ui};font-size:0.6875rem;line-height:1.15;white-space:nowrap;` +
        "overflow:hidden;text-overflow:ellipsis;max-width:100%;";
    case "kb.bottom":
      return "display:flex;gap:1.25rem;justify-content:flex-start;align-items:flex-end;margin-top:0.25rem;";
    case "kb.title":
      return "font-size:1.375rem;margin-bottom:0.375rem;";
    case "kb.tower":
      return "display:grid;grid-template-columns:repeat(3,2.2rem);grid-auto-rows:1.8rem;gap:0.125rem;";
    case "kb.mouse":
      return "display:grid;grid-template-columns:repeat(6,1.1rem);grid-auto-rows:1.8rem;gap:0.125rem;";
    case "kb.numpad":
      return "display:grid;grid-template-columns:repeat(4,2.2rem);grid-auto-rows:1.8rem;gap:0.125rem;";

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
