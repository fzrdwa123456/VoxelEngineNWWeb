// ===== Pause menu + shared settings panel (FPS cap/vsync/language/UI scale/window mode); the main menu reuses the settings panel =====
//
// Structure of this file:
//   1. Shared cross-instance state     — all panel instances (pause menu + main menu) sync
//                                        through keybindRenderers/capRegistry; never query a
//                                        single instance's DOM.
//   2. Binding interaction state       — the click shield + capture-free drag + physical
//                                        capture listeners. This is timing-sensitive: it works
//                                        around Chromium click synthesis. Read the block
//                                        comments before touching anything.
//   3. DOM helpers                     — el()/panelCss()/button()/choiceButton().
//   4. buildSettingsPanel()            — the settings panels (shared by pause menu + main menu).
//   5. Menu                            — the pause menu class.
//
// Behavior contracts (do not break; verified flows: click-rebind, drag-bind, Esc unbind,
// double-instance redraw, wheel blocking, click-synthesis suppression):
//   - A left-button mousedown in capture mode binds immediately; Chromium synthesizes a click
//     afterwards which would re-trigger panel handlers -> one-shot click shield, armed WITHOUT
//     a self-clearing timeout (a long press would fire the timeout before the synthetic click
//     arrives and let it through, re-entering capture on the chip). Cleared by the click shield
//     when consumed, or by the global mouseup fallback when no click is synthesized.
//   - A capture-free drag RELEASE arms the same shield WITH a 0ms timeout (the synthetic click
//     follows mouseup synchronously and consumes it first; drags that pressed a second mouse
//     button break click synthesis, so the timeout is the fallback). The two arm paths differ
//     on purpose — merging them reintroduces the regression.
//   - Only the left button synthesizes clicks (right/middle/side produce contextmenu/auxclick),
//     which is why only mousedown-with-button-0 arms the shield in capture mode.
import { t, getLang, setLang, onLangChange } from "./i18n";
import { getUIScaleMode, setUIScaleMode, onUIScaleModeChange, onResizeMerged, getCurrentScale, uiStage } from "./uiscale";
import { getFontId, setFontId, onFontChange, type FontId } from "./fonts";
import { listPacks } from "../rendering/textures";
import { onWindowModeChange, type WindowMode, sendLog } from "../platform/shell";
import { getBind, setBind, beginCapture, endCapture, getCapturing, onBindsChange, codeDisplayName, codeToButton, buttonToCode, type BindAction } from "../platform/keybinds";

// ===== 1. Shared cross-instance state =====
// buildSettingsPanel is instantiated once by the pause menu and once by the main menu, each
// with independent DOM and renderBinds. The document-level capture listeners are shared state,
// so all instances redraw together — otherwise a refresh would hit a hidden panel and the
// visible panel's chips would stay stuck selected (cross-instance desync bug).
const keybindRenderers = new Set<() => void>();

// Every keycap element from every instance registers here; elementFromPoint hits the visible
// instance's elements, so drag hit-testing must consult this cross-instance table — looking up
// by code alone would hit a hidden panel's twin keycap registered earlier.
const capRegistry: { code: string; el: HTMLButtonElement }[] = [];

// ===== 2. Binding interaction state (click shield + capture-free drag + physical capture) =====

// Capture-free drag binding: hold an action chip and drop it onto a keycap — no capture mode
// needed first. Either mouse button can start; button records the initiator — presses/releases
// of the OTHER button during the drag must be ignored (no interruptions/misbinds). Movement
// beyond the threshold makes it a drag; a plain click falls through to the native click's
// select toggle.
let chipDrag: {
  action: BindAction;
  button: number;
  anchorX: number;
  anchorY: number;
  moved: boolean;
} | null = null;
let capHoverEl: HTMLButtonElement | null = null;

/** One-shot synthetic-click shield. See the arm paths below for why clearing differs per gesture. */
let suppressNextClick = false;

/** Arm the shield. schedSelf=false (capture-mode mousedown): cleared by the click shield when
 *  the synthetic click is consumed, or by the global mouseup fallback if none is synthesized.
 *  schedSelf=true (drag release): also schedule a 0ms self-clear — the synthetic click follows
 *  mouseup synchronously and consumes the flag first; the timeout only covers the no-click paths. */
function armSuppressNextClick(schedSelf: boolean): void {
  suppressNextClick = true;
  if (schedSelf) {
    setTimeout(() => {
      suppressNextClick = false;
    }, 0);
  }
}

/** Drag rubber band (single reusable SVG overlay) */
function showCapLine(x1: number, y1: number, x2: number, y2: number): void {
  let svg = document.getElementById("cap-line-svg") as SVGSVGElement | null;
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "cap-line-svg";
    svg.setAttribute("style", "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;display:none;");
    const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
    lineEl.setAttribute("stroke", "#4a9eff");
    lineEl.setAttribute("stroke-width", "2");
    lineEl.setAttribute("stroke-linecap", "round");
    svg.appendChild(lineEl);
    document.body.appendChild(svg);
  }
  svg.style.display = "block";
  const line = svg.querySelector("line") as SVGLineElement;
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
}

function hideCapLine(): void {
  const svg = document.getElementById("cap-line-svg");
  if (svg) svg.style.display = "none";
  if (capHoverEl) {
    capHoverEl.style.outline = "";
    capHoverEl = null;
  }
}

/** Hit test: matches keycaps registered by any instance, returning the code and the actual
 *  keycap element hit. Highlighting must use the el returned here — looking up by code would
 *  hit a hidden panel's twin keycap registered earlier. */
function capHitAtPoint(x: number, y: number): { code: string; el: HTMLButtonElement } | null {
  const elAt = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!elAt) return null;
  for (const c of capRegistry) {
    if (c.el === elAt || c.el.contains(elAt)) return { code: c.code, el: c.el };
  }
  return null;
}

/** Redraw every panel instance's bindings (the visible one is necessarily included) */
function renderAllPanels(reason: string): void {
  let panels = 0;
  keybindRenderers.forEach((r) => {
    r();
    panels++;
  });
  sendLog(`KBCAP ${reason} (panels=${panels})`);
}

// Global click shield (capture phase: runs before all elements' own onclick). Swallows every
// synthetic click while capture/drag is active or the shield is armed — the physical press
// already completed the binding, so the browser-generated click must not re-trigger chip
// reselect/keycap pick/back button. Consuming the shield clears it (except during drags,
// where a drag may outlive one click — preserving the original semantics).
document.addEventListener(
  "click",
  (ev) => {
    if (getCapturing() || chipDrag || suppressNextClick) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (!chipDrag) suppressNextClick = false;
    }
  },
  true,
);

// Capture-mode mouseup fallback: if the shield armed at mousedown is still alive after release
// (no synthetic click to consume — e.g. the drag pressed a second mouse button, breaking
// Chromium's click synthesis), a 0ms timer clears it so the next real click is not swallowed.
document.addEventListener("mouseup", () => {
  if (!suppressNextClick) return;
  setTimeout(() => {
    suppressNextClick = false;
  }, 0);
});

// Capture-free drag move: past the 6px threshold the gesture becomes a drag — draw the rubber
// band and highlight the keycap under the cursor.
document.addEventListener("mousemove", (ev) => {
  if (!chipDrag) return;
  if (!chipDrag.moved && Math.hypot(ev.clientX - chipDrag.anchorX, ev.clientY - chipDrag.anchorY) < 6) {
    return; // Within the threshold, treated as a plain click
  }
  chipDrag.moved = true;
  showCapLine(chipDrag.anchorX, chipDrag.anchorY, ev.clientX, ev.clientY);
  const hitEl = capHitAtPoint(ev.clientX, ev.clientY)?.el ?? null;
  if (capHoverEl !== hitEl) {
    if (capHoverEl) capHoverEl.style.outline = "";
    capHoverEl = hitEl;
    if (capHoverEl) capHoverEl.style.outline = "2px solid #fff";
  }
});

// Capture-free drag end: releasing the initiating button beyond the threshold binds the
// keycap under the cursor; a plain release falls back to the native click (select toggle).
document.addEventListener("mouseup", (ev) => {
  if (!chipDrag) return;
  if (ev.button !== chipDrag.button) return; // Release of the non-initiating button: ignore, do not interrupt the drag
  const { action, anchorX, anchorY } = chipDrag;
  chipDrag = null;
  hideCapLine();
  const dragged = Math.hypot(ev.clientX - anchorX, ev.clientY - anchorY) >= 6;
  if (!dragged) return; // Plain click: hand over to the native click for the select toggle
  armSuppressNextClick(true); // mouseup-armed: schedule the timeout fallback immediately (the synthetic click consumes it first)
  if (getCapturing()) return; // A capture started mid-drag (abnormal path): abort the bind
  const code = capHitAtPoint(ev.clientX, ev.clientY)?.code ?? null;
  sendLog(`KBCAP drag release action=${action} code=${code ?? "no hit"}`);
  if (!code) return; // Released on empty space: no-op
  setBind(action, code);
  renderAllPanels(`drag bind done (${code})`);
});

// Capture state / capture-free drag in progress: forbid all wheel scrolling (prevents the bind
// options list drifting under the operation). passive:false must be explicit — Chrome makes
// document-level wheel listeners passive by default, otherwise preventDefault is ineffective.
document.addEventListener(
  "wheel",
  (ev) => {
    if (getCapturing() || chipDrag) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  },
  { passive: false },
);

// Physical key capture (module-level: behavior is instance-independent, and per-instance
// registration used to double every diagnostic log). Esc during a drag cancels the drag;
// with an action selected every key binds (Esc = unbind) without closing the menu.
document.addEventListener("keydown", (ev) => {
  const action = getCapturing();
  if (!action && chipDrag) {
    // Drag in progress: keys have no default role here — Space/Enter/Tab would otherwise
    // scroll the panel or jump focus (browser defaults; the wheel is already blocked above).
    // Esc cancels the drag; every other key is swallowed (default prevented, other
    // listeners unaffected — matching the old non-intervention except for the default).
    ev.preventDefault();
    if (ev.code === "Escape") {
      ev.stopImmediatePropagation();
      endCapture();
      chipDrag = null;
      hideCapLine();
      sendLog("KBCAP Esc cancels drag");
    }
    return;
  }
  sendLog(`KBCAP keydown code=${ev.code} capturing=${action ?? "null"}`);
  if (!action) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  endCapture();
  setBind(action, ev.code === "Escape" ? "" : ev.code); // Esc = unbind the action
  try {
    renderAllPanels(`renderBinds done (code=${ev.code})`);
  } catch (e) {
    sendLog(`KBCAP renderBinds error!! ${e instanceof Error ? e.stack : String(e)}`);
  }
});

// Capture-state mouse capture: any mouse button (incl. left) binds its code on press.
// preventDefault stops the focused button being activated by Space/Enter and middle-click
// autoscroll; stopImmediatePropagation blocks the later-registered main.ts ESC handler and
// F3/F4 (the earlier-registered inventory E key yields via isCapturing()).
document.addEventListener("mousedown", (ev) => {
  const action = getCapturing();
  sendLog(`KBCAP mousedown button=${ev.button} capturing=${action ?? "null"}`);
  if (!action) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  endCapture();
  // One-shot shield for the upcoming synthetic click: only button 0 synthesizes one
  // (right/middle/side produce contextmenu/auxclick). Armed without a self-timeout —
  // cleared by the click shield on consumption or by the mouseup fallback above.
  if (ev.button === 0) armSuppressNextClick(false);
  const code = buttonToCode(ev.button); // Left/middle/right/X1/X2 all bind immediately
  if (!code) return;
  setBind(action, code);
  renderAllPanels(`mousedown bind done (${code})`);
});

// ===== 3. DOM helpers =====

/** Create an element with a cssText style and optional text content */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Standard menu button with the static hover shade */
function button(css: string): HTMLButtonElement {
  const b = el("button", css);
  b.onmouseover = () => (b.style.background = "#555");
  b.onmouseout = () => (b.style.background = "#444");
  return b;
}

/** Selection button: hover/backgrounds reflect isSel() (blue when selected); onPick runs on click.
 *  Text content and background are driven by the caller's render callback. */
function choiceButton(css: string, isSel: () => boolean, onPick: () => void): HTMLButtonElement {
  const b = el("button", css);
  b.onmouseover = () => (b.style.background = isSel() ? "#3b83d6" : "#555");
  b.onmouseout = () => (b.style.background = isSel() ? "#4a9eff" : "#444");
  b.onclick = onPick;
  return b;
}

const BTN_CSS =
  "display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:0.9375rem var(--font-ui);color:#fff;" +
  "background:#444;border:none;border-radius:0.375rem;cursor:pointer;";
const panelCss = (width: string) =>
  `width:${width};background:#222;border-radius:0.625rem;padding:1.25rem;text-align:center;color:#fff;` +
  "font:1rem var(--font-ui);box-shadow:0 0.25rem 1.25rem rgba(0,0,0,.5);display:none;";
const TITLE_CSS = "font-size:1.375rem;margin-bottom:0.875rem;";
const LABEL_CSS = "text-align:left;font-size:0.9375rem;margin:0.5rem 0 0.25rem;";
const COL_CSS = "flex:1;text-align:left;";
const COL_LABEL_CSS = "font-size:0.9375rem;color:#bbb;margin-bottom:0.5rem;";
const CHOICE_CSS =
  "display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:0.9375rem var(--font-ui);color:#fff;" +
  "background:#444;border:none;border-radius:0.375rem;cursor:pointer;text-align:center;";
const CAP_MAIN_CSS =
  "font-family:var(--font-ui);font-size:0.6875rem;line-height:1.15;white-space:nowrap;overflow:hidden;max-width:100%;";

// ===== 4. Shared settings panel =====

export interface SettingsCallbacks {
  getFpsCap: () => number;
  onFpsCap: (cap: number) => void;
  getGpuVsyncState: () => boolean;
  onToggleGpuVsync: (on: boolean) => boolean;
  getWindowMode: () => WindowMode;
  onSetWindowMode: (mode: WindowMode) => void;
}

// Pause menu callbacks: the settings panel's six items + resume / back to main menu
export interface MenuCallbacks extends SettingsCallbacks {
  onResume: () => void;
  onToMainMenu: () => void;
}

// Shared settings panel: FPS cap slider + vsync toggle + language collection + resource pack
// collection + key binds + window mode + UI scale + back (shared by pause menu/main menu).
// Returns four panels; the caller mounts them on the same root container and toggles visibility.
export function buildSettingsPanel(opts: SettingsCallbacks & { onBack: () => void }): {
  settingsPanel: HTMLDivElement;
  langPanel: HTMLDivElement;
  packPanel: HTMLDivElement;
  keybindPanel: HTMLDivElement;
} {
  const settingsPanel = el("div", panelCss("17.5rem"));
  const sTitle = el("div", TITLE_CSS);
  settingsPanel.appendChild(sTitle);

  // --- FPS cap slider: 30..240, maxed = unlimited (0) ---
  const capLabel = el("div", LABEL_CSS);
  settingsPanel.appendChild(capLabel);
  const capValue = el("div", "text-align:center;font-size:1.25rem;font-weight:600;color:#fff;margin:0.125rem 0 0.375rem;");
  settingsPanel.appendChild(capValue);
  const CAP_MIN = 30;
  const CAP_MAX = 240;
  const capSlider = el("input", "width:100%;margin:0 0 0.625rem;accent-color:#4a9eff;cursor:pointer;");
  capSlider.type = "range";
  capSlider.min = String(CAP_MIN);
  capSlider.max = String(CAP_MAX);
  capSlider.step = "2";
  capSlider.value = String(Math.max(CAP_MIN, Math.min(CAP_MAX, opts.getFpsCap() || CAP_MAX)));
  const renderCap = (): void => {
    capValue.textContent = Number(capSlider.value) >= CAP_MAX ? t("settings.unlimited") : `${capSlider.value} FPS`;
  };
  capSlider.oninput = () => {
    renderCap();
    opts.onFpsCap(Number(capSlider.value) >= CAP_MAX ? 0 : Number(capSlider.value));
  };
  settingsPanel.appendChild(capSlider);

  // --- GPU vsync toggle ---
  let gpuVsyncOn = opts.getGpuVsyncState();
  const gpuBtn = button(BTN_CSS);
  const renderGpuBtn = (): void => {
    gpuBtn.textContent = gpuVsyncOn ? t("settings.vsyncOff") : t("settings.vsyncOn");
  };
  gpuBtn.onclick = () => {
    const next = !gpuVsyncOn;
    if (opts.onToggleGpuVsync(next)) {
      gpuVsyncOn = next;
      renderGpuBtn();
    }
  };
  settingsPanel.appendChild(gpuBtn);

  // --- Language & fonts: entry button + two-column sub-panel ---
  const langBtn = button(BTN_CSS);
  langBtn.onclick = () => {
    settingsPanel.style.display = "none";
    langPanel.style.display = "block";
  };
  settingsPanel.appendChild(langBtn);

  const langPanel = el("div", panelCss("34rem"));
  const langTitle = el("div", TITLE_CSS);
  langPanel.appendChild(langTitle);
  const choiceWrap = el("div", "display:flex;gap:1.25rem;margin-bottom:0.875rem;");
  langPanel.appendChild(choiceWrap);

  const langCol = el("div", COL_CSS);
  langCol.appendChild(el("div", COL_LABEL_CSS));
  const langBtns = (["zh", "en", "ja"] as const).map((lang) => {
    const b = choiceButton(CHOICE_CSS, () => getLang() === lang, () => setLang(lang));
    langCol.appendChild(b);
    return [lang, b] as const;
  });
  choiceWrap.appendChild(langCol);

  const fontCol = el("div", COL_CSS);
  fontCol.appendChild(el("div", COL_LABEL_CSS));
  const fontBtns = (["pixel", "system"] as const).map((id) => {
    const b = choiceButton(CHOICE_CSS, () => getFontId() === id, () => setFontId(id));
    fontCol.appendChild(b);
    return [id, b] as const;
  });
  choiceWrap.appendChild(fontCol);

  const renderLang = (): void => {
    for (const [lang, b] of langBtns) b.style.background = getLang() === lang ? "#4a9eff" : "#444";
  };
  const renderFont = (): void => {
    for (const [id, b] of fontBtns) b.style.background = getFontId() === id ? "#4a9eff" : "#444";
  };
  const langBackBtn = button(BTN_CSS);
  langBackBtn.onclick = () => {
    langPanel.style.display = "none";
    settingsPanel.style.display = "block";
  };
  langPanel.appendChild(langBackBtn);

  // --- Resource packs: entry button + sub-panel listing game\resourcepacks\ ---
  const packBtn = button(BTN_CSS);
  packBtn.onclick = () => {
    settingsPanel.style.display = "none";
    packPanel.style.display = "block";
    renderPacks();
  };
  settingsPanel.appendChild(packBtn);

  const packPanel = el("div", panelCss("17.5rem"));
  const packTitle = el("div", TITLE_CSS);
  packPanel.appendChild(packTitle);
  const packList = el("div", "max-height:12.5rem;overflow-y:auto;margin-bottom:0.375rem;");
  packPanel.appendChild(packList);
  const packEmpty = el("div", "font-size:0.9375rem;color:#999;padding:0.5rem 0;");
  packPanel.appendChild(packEmpty);

  const renderPacks = (): void => {
    packList.textContent = "";
    const packs = listPacks();
    packEmpty.style.display = packs.length ? "none" : "block";
    packEmpty.textContent = t("settings.packsEmpty");
    for (const p of packs) {
      const row = el(
        "div",
        "display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0.625rem;margin:0.25rem 0;" +
          "background:#333;border-radius:0.375rem;font-size:0.875rem;",
      );
      const name = el("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", p.name);
      const meta = el("span", "flex-shrink:0;margin-left:0.5rem;color:#aaa;font-size:0.75rem;", `${p.builtin ? t("settings.packsBuiltin") + " · " : ""}${p.fileCount}`);
      row.append(name, meta);
      packList.appendChild(row);
    }
  };
  const packBackBtn = button(BTN_CSS);
  packBackBtn.onclick = () => {
    packPanel.style.display = "none";
    settingsPanel.style.display = "block";
  };
  packPanel.appendChild(packBackBtn);

  // --- Key binds: entry button + sub-panel (action chips + visual keyboard) ---
  const keybindBtn = button(BTN_CSS);
  keybindBtn.onclick = () => {
    settingsPanel.style.display = "none";
    keybindPanel.style.display = "block";
    renderBinds();
  };
  settingsPanel.appendChild(keybindBtn);

  // Key bind sub-panel: action chips + visual keyboard (full 104-key ANSI layout, fixed QWERTY
  // reference geometry = KeyboardEvent.code physical positions). Interaction: click an action
  // chip to select -> click a keyboard key to bind; conflict preemption handled by setBind.
  const keybindPanel = el("div", panelCss("40rem"));
  const kbTitle = el("div", "font-size:1.375rem;margin-bottom:0.375rem;");
  keybindPanel.appendChild(kbTitle);
  const kbHint = el("div", "font-size:0.75rem;color:#999;margin-bottom:0.625rem;");
  keybindPanel.appendChild(kbHint);

  const KB_ACTIONS: { action: BindAction; labelKey: string }[] = [
    { action: "forward", labelKey: "bind.forward" },
    { action: "back", labelKey: "bind.back" },
    { action: "left", labelKey: "bind.left" },
    { action: "right", labelKey: "bind.right" },
    { action: "jump", labelKey: "bind.jump" },
    { action: "sneak", labelKey: "bind.sneak" },
    { action: "inventory", labelKey: "bind.inventory" },
    { action: "break", labelKey: "bind.break" },
    { action: "place", labelKey: "bind.place" },
  ];

  // Two columns: left = keyboard board (main rows + bottom clusters), right = action chip column
  const kbFlex = el("div", "display:flex;gap:0.75rem;align-items:flex-start;margin-bottom:0.625rem;");
  keybindPanel.appendChild(kbFlex);
  const kbBoard = el("div", "flex:1 1 auto;min-width:0;user-select:none;");
  kbFlex.appendChild(kbBoard);
  const kbSide = el(
    "div",
    "width:11rem;flex-shrink:0;max-height:20rem;display:flex;flex-direction:column;gap:0.375rem;" +
      "background:#1a1a1a;border-radius:0.5rem;padding:0.625rem;overflow:hidden;",
  );
  kbFlex.appendChild(kbSide);
  const kbSideTitle = el("div", "font-size:0.9375rem;color:#bbb;text-align:center;");
  kbSide.appendChild(kbSideTitle);
  const chipList = el("div", "flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:0.375rem;padding-right:0.5rem;");
  chipList.id = "kb-chip-list";
  kbSide.appendChild(chipList);

  // Thin scrollbar style (injected globally only once)
  if (!document.getElementById("kb-chip-scrollbar")) {
    const st = el("style", "", "#kb-chip-list::-webkit-scrollbar{width:6px}" +
      "#kb-chip-list::-webkit-scrollbar-thumb{background:#444;border-radius:3px}" +
      "#kb-chip-list::-webkit-scrollbar-track{background:transparent}");
    st.id = "kb-chip-scrollbar";
    document.head.appendChild(st);
  }

  const chipCss =
    "width:100%;padding:0.4375rem 0.625rem;font:0.8125rem var(--font-ui);color:#fff;border:none;" +
    "border-radius:0.3125rem;cursor:pointer;background:#444;text-align:center;";
  const kbChips = new Map<BindAction, HTMLButtonElement>();
  for (const { action } of KB_ACTIONS) {
    const chip = el("button", chipCss);
    chip.dataset.action = action; // Drop-target marker for capture-free drags
    // Drag start: holding a chip and moving past the threshold enters capture-free drag binding.
    // Capture state: let the mousedown bubble to the document handler (both buttons bind);
    // drag in progress: ignore other buttons starting a drag (anti-hijack) — events are not cut.
    chip.addEventListener("mousedown", (ev) => {
      if (getCapturing() || chipDrag) return;
      if (ev.button !== 0) return; // Only the left button starts a drag (right-button drag removed)
      ev.preventDefault(); // Prevent text selection while dragging
      chipDrag = { action, button: ev.button, anchorX: ev.clientX, anchorY: ev.clientY, moved: false };
    });
    chip.onclick = () => {
      sendLog(`KBCAP click interactive button action=${action} capturing=${getCapturing() ?? "null"}`);
      if (getCapturing() === action) endCapture();
      else beginCapture(action);
      renderBinds();
    };
    chipList.appendChild(chip);
    kbChips.set(action, chip);
  }

  // Visual keyboard main area: [code, width unit u]; code="" is an empty spacer. Each row sums
  // to 18.5u (main 15 + gap 0.5 + nav 3); flex-grow splits widths proportionally.
  const KB_ROWS: [string, number][][] = [
    // Function key row (PrtSc group moved to the bottom right tower)
    [["Escape", 1], ["", 1], ["F1", 1], ["F2", 1], ["F3", 1], ["F4", 1], ["", 0.5], ["F5", 1], ["F6", 1], ["F7", 1], ["F8", 1], ["", 0.5], ["F9", 1], ["F10", 1], ["F11", 1], ["F12", 1]],
    // Main number row (nav area moved to the bottom right tower)
    [["Backquote", 1], ["Digit1", 1], ["Digit2", 1], ["Digit3", 1], ["Digit4", 1], ["Digit5", 1], ["Digit6", 1], ["Digit7", 1], ["Digit8", 1], ["Digit9", 1], ["Digit0", 1], ["Minus", 1], ["Equal", 1], ["Backspace", 2]],
    // Tab row
    [["Tab", 1.5], ["KeyQ", 1], ["KeyW", 1], ["KeyE", 1], ["KeyR", 1], ["KeyT", 1], ["KeyY", 1], ["KeyU", 1], ["KeyI", 1], ["KeyO", 1], ["KeyP", 1], ["BracketLeft", 1], ["BracketRight", 1], ["Backslash", 1.5]],
    // Caps row
    [["CapsLock", 1.75], ["KeyA", 1], ["KeyS", 1], ["KeyD", 1], ["KeyF", 1], ["KeyG", 1], ["KeyH", 1], ["KeyJ", 1], ["KeyK", 1], ["KeyL", 1], ["Semicolon", 1], ["Quote", 1], ["Enter", 2.25]],
    // Shift row (arrow keys moved to the bottom area)
    [["ShiftLeft", 2.25], ["KeyZ", 1], ["KeyX", 1], ["KeyC", 1], ["KeyV", 1], ["KeyB", 1], ["KeyN", 1], ["KeyM", 1], ["Comma", 1], ["Period", 1], ["Slash", 1], ["ShiftRight", 2.75]],
    // Bottom row (arrow keys moved to the bottom area)
    [["ControlLeft", 1.25], ["MetaLeft", 1.25], ["AltLeft", 1.25], ["Space", 6.25], ["AltRight", 1.25], ["MetaRight", 1.25], ["ContextMenu", 1.25], ["ControlRight", 1.25]],
  ];

  const capMains = new Map<string, HTMLElement>(); // code -> legend span (highlight/legends)
  const capKeys = new Map<string, HTMLButtonElement>(); // code -> keycap button

  const capKeyCss = (extra: string): string =>
    `${extra}padding:0.0625rem;color:#fff;border:none;border-radius:0.25rem;cursor:pointer;` +
    "background:#3a3a3a;display:flex;align-items:center;justify-content:center;overflow:hidden;";

  /** Register a keycap button (flex row variant) */
  const addRowKey = (rowEl: HTMLElement, code: string, unit: number): void => {
    const key = el("button", capKeyCss(`flex:${unit} ${unit} 0%;min-width:0;height:1.8rem;`));
    key.onclick = () => {
      const sel = getCapturing();
      if (!sel) return; // Clicking the keyboard with no action selected is a no-op
      setBind(sel, code);
      endCapture();
      renderBinds();
    };
    const main = el("span", CAP_MAIN_CSS);
    key.append(main);
    rowEl.appendChild(key);
    capMains.set(code, main);
    capKeys.set(code, key);
    capRegistry.push({ code, el: key }); // Cross-instance hit testing
  };

  for (const row of KB_ROWS) {
    const rowEl = el("div", "display:flex;gap:0.125rem;margin-bottom:0.125rem;");
    for (const [code, unit] of row) {
      if (code === "") {
        rowEl.appendChild(el("div", `flex:${unit} ${unit} 0%;min-width:0;`));
        continue;
      }
      addRowKey(rowEl, code, unit);
    }
    kbBoard.appendChild(rowEl);
  }

  // Bottom area: right tower (left) + standard numpad (middle) + mouse buttons (right)
  const kbBottom = el("div", "display:flex;gap:1.25rem;justify-content:flex-start;align-items:flex-end;margin-top:0.25rem;");
  kbBoard.appendChild(kbBottom);

  /** Grid keycap helper (bottom clusters): grid-area placement, registered like row keys.
   *  No hardcoded height: grid-auto-rows sizes single-row keys; spanning keys stretch. */
  const mkCapKey = (parent: HTMLElement, code: string, area: string): void => {
    const key = el("button", capKeyCss(`grid-area:${area};`));
    key.onclick = () => {
      const sel = getCapturing();
      if (!sel) return;
      setBind(sel, code);
      endCapture();
      renderBinds();
    };
    const main = el("span", CAP_MAIN_CSS, codeDisplayName(code));
    key.append(main);
    parent.appendChild(key);
    capMains.set(code, main);
    capKeys.set(code, key);
    capRegistry.push({ code, el: key });
  };

  // Arrow cluster: Up centered on top, Left/Down/Right below (track width aligned with the main grid)
  const towerGrid = el("div", "display:grid;grid-template-columns:repeat(3,2.2rem);grid-auto-rows:1.8rem;gap:0.125rem;");
  mkCapKey(towerGrid, "PrintScreen", "1 / 1 / 2 / 2");
  mkCapKey(towerGrid, "ScrollLock", "1 / 2 / 2 / 3");
  mkCapKey(towerGrid, "Pause", "1 / 3 / 2 / 4");
  mkCapKey(towerGrid, "Insert", "2 / 1 / 3 / 2");
  mkCapKey(towerGrid, "Home", "2 / 2 / 3 / 3");
  mkCapKey(towerGrid, "PageUp", "2 / 3 / 3 / 4");
  mkCapKey(towerGrid, "Delete", "3 / 1 / 4 / 2");
  mkCapKey(towerGrid, "End", "3 / 2 / 4 / 3");
  mkCapKey(towerGrid, "PageDown", "3 / 3 / 4 / 4");
  mkCapKey(towerGrid, "ArrowUp", "4 / 2 / 5 / 3");
  mkCapKey(towerGrid, "ArrowLeft", "5 / 1 / 6 / 2");
  mkCapKey(towerGrid, "ArrowDown", "5 / 2 / 6 / 3");
  mkCapKey(towerGrid, "ArrowRight", "5 / 3 / 6 / 4");
  kbBottom.appendChild(towerGrid);

  // Numpad: standard 4-column grid; + and Enter span two rows restoring the real shape, 0 spans two columns
  const numGrid = el("div", "display:grid;grid-template-columns:repeat(4,2.2rem);grid-auto-rows:1.8rem;gap:0.125rem;");
  const NUM_GRID: { code: string; area: string }[] = [
    { code: "NumLock", area: "1 / 1 / 2 / 2" },
    { code: "NumpadDivide", area: "1 / 2 / 2 / 3" },
    { code: "NumpadMultiply", area: "1 / 3 / 2 / 4" },
    { code: "NumpadSubtract", area: "1 / 4 / 2 / 5" },
    { code: "Numpad7", area: "2 / 1 / 3 / 2" },
    { code: "Numpad8", area: "2 / 2 / 3 / 3" },
    { code: "Numpad9", area: "2 / 3 / 3 / 4" },
    { code: "NumpadAdd", area: "2 / 4 / 4 / 5" },
    { code: "Numpad4", area: "3 / 1 / 4 / 2" },
    { code: "Numpad5", area: "3 / 2 / 4 / 3" },
    { code: "Numpad6", area: "3 / 3 / 4 / 4" },
    { code: "Numpad1", area: "4 / 1 / 5 / 2" },
    { code: "Numpad2", area: "4 / 2 / 5 / 3" },
    { code: "Numpad3", area: "4 / 3 / 5 / 4" },
    { code: "NumpadEnter", area: "4 / 4 / 6 / 5" },
    { code: "Numpad0", area: "5 / 1 / 6 / 3" },
    { code: "NumpadDecimal", area: "5 / 3 / 6 / 4" },
  ];
  for (const n of NUM_GRID) mkCapKey(numGrid, n.code, n.area);
  kbBottom.appendChild(numGrid);

  // Mouse buttons: full five-button layout. 6 half-column tracks: top-row main keys span 2
  // tracks each, bottom-row side keys span 3 tracks filling the row without gaps
  const mouseGrid = el("div", "display:grid;grid-template-columns:repeat(6,1.1rem);grid-auto-rows:1.8rem;gap:0.125rem;");
  mkCapKey(mouseGrid, "MouseLeft", "1 / 1 / 2 / 3");
  mkCapKey(mouseGrid, "MouseMiddle", "1 / 3 / 2 / 5");
  mkCapKey(mouseGrid, "MouseRight", "1 / 5 / 2 / 7");
  mkCapKey(mouseGrid, "MouseX1", "2 / 1 / 3 / 4");
  mkCapKey(mouseGrid, "MouseX2", "2 / 4 / 3 / 7");
  kbBottom.appendChild(mouseGrid);

  // Keycap legends: prefer the OS's actual layout (Keyboard Map API), fall back to QWERTY
  // reference letters on failure. Positions are always correct (code IS the physical position).
  let layoutLegends: Map<string, string> | null = null;
  const legendFor = (code: string): string => {
    const real = layoutLegends?.get(code);
    if (real) return real.length === 1 ? real.toUpperCase() : real;
    return codeDisplayName(code);
  };

  const renderBinds = (): void => {
    // Action chips: name + current key (position name), blue when selected
    for (const { action, labelKey } of KB_ACTIONS) {
      const chip = kbChips.get(action)!;
      const code = getBind(action);
      const sel = getCapturing() === action;
      chip.textContent = sel
        ? t(labelKey)
        : `${t(labelKey)} · ${code ? codeDisplayName(code) : t("bind.unbound")}`;
      chip.style.background = sel ? "#4a9eff" : "#444";
    }
    // Keyboard keycaps: legend = layout print, blue background = bound (details in the chips).
    // Legend wider than the keycap -> marquee back-and-forth animation.
    const byCode = new Map<string, BindAction>();
    for (const { action } of KB_ACTIONS) {
      const code = getBind(action);
      if (code) byCode.set(code, action);
    }
    for (const [code, main] of capMains) {
      const key = capKeys.get(code)!;
      main.textContent = legendFor(code);
      key.style.background = byCode.has(code) ? (getCapturing() ? "#2f6cb3" : "#4a9eff") : "#3a3a3a";
      const over = main.scrollWidth - key.clientWidth;
      if (over > 1) {
        main.style.justifyContent = "flex-start";
        main.style.setProperty("--cap-shift", `${-over - 2}px`);
        main.style.animation = "capScroll 2.4s ease-in-out infinite alternate";
      } else if (main.style.animation) {
        main.style.animation = "";
        main.style.justifyContent = "";
        main.style.removeProperty("--cap-shift");
      }
    }
  };
  keybindRenderers.add(renderBinds);

  // Keycap scroll animation (injected globally only once); slide distance per key's --cap-shift
  if (!document.getElementById("cap-scroll-kf")) {
    const st = el("style", "", "@keyframes capScroll{from{transform:translateX(0)}to{transform:translateX(var(--cap-shift))}}");
    st.id = "cap-scroll-kf";
    document.head.appendChild(st);
  }

  // Async fetch of the OS keyboard layout for legends; redraw on arrival (silent fallback)
  void (async () => {
    try {
      const kbApi = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
      if (kbApi?.getLayoutMap) {
        layoutLegends = await kbApi.getLayoutMap();
        keybindRenderers.forEach((r) => r());
      }
    } catch {
      /* Fall back to reference letters */
    }
  })();

  // (The physical key/mouse capture listeners are module-level — see the top of this file.)
  onBindsChange(renderBinds);

  const kbBackBtn = button(BTN_CSS);
  kbBackBtn.onclick = () => {
    endCapture(); // Leaving the panel cancels an unfinished selection
    keybindPanel.style.display = "none";
    settingsPanel.style.display = "block";
  };
  keybindPanel.appendChild(kbBackBtn);

  // --- UI scale: small/normal/large/auto (MC-style GUI Scale) ---
  const scaleLabel = el("div", LABEL_CSS);
  settingsPanel.appendChild(scaleLabel);
  const scaleRow = el("div", "display:flex;gap:0.375rem;margin:0 0 0.375rem;");
  const scaleBtnCss = "flex:1;padding:0.5rem;font:0.875rem var(--font-ui);color:#fff;border:none;border-radius:0.375rem;cursor:pointer;";
  const scaleBtns = (["small", "normal", "large", "auto"] as const).map((k) => ({
    k,
    b: choiceButton(scaleBtnCss, () => getUIScaleMode() === k, () => setUIScaleMode(k)),
  }));
  const renderScale = (): void => {
    for (const { k, b } of scaleBtns) {
      b.textContent = t(`uiScale.${k}`);
      b.style.background = getUIScaleMode() === k ? "#4a9eff" : "#444";
    }
  };
  // The scale label shows the live effective multiplier (auto follows the window)
  const renderScaleLabel = (): void => {
    scaleLabel.textContent = `${t("settings.uiScale")}: ${t(`uiScale.${getUIScaleMode()}`)} (${getCurrentScale().toFixed(2)}x)`;
  };
  onResizeMerged(renderScaleLabel);
  for (const { b } of scaleBtns) scaleRow.appendChild(b);
  settingsPanel.appendChild(scaleRow);

  // --- Window mode: windowed / fullscreen (NW.js runtime switch, no restart) ---
  const wmLabel = el("div", LABEL_CSS);
  settingsPanel.appendChild(wmLabel);
  const wmRow = el("div", "display:flex;gap:0.375rem;margin:0 0 0.375rem;");
  const wmBtnCss = "flex:1;padding:0.5rem;font:0.875rem var(--font-ui);color:#fff;border:none;border-radius:0.375rem;cursor:pointer;";
  const wmBtns = (["windowed", "fullscreen"] as const).map((k) => ({
    k,
    b: choiceButton(wmBtnCss, () => opts.getWindowMode() === k, () => opts.onSetWindowMode(k)),
  }));
  const renderWm = (): void => {
    for (const { k, b } of wmBtns) {
      b.textContent = t(`windowMode.${k}`);
      b.style.background = opts.getWindowMode() === k ? "#4a9eff" : "#444";
    }
  };
  for (const { b } of wmBtns) wmRow.appendChild(b);
  settingsPanel.appendChild(wmRow);

  onUIScaleModeChange(renderScale);
  onWindowModeChange(renderWm);
  onFontChange(renderFont);

  const backBtn = button(BTN_CSS);
  backBtn.onclick = () => {
    settingsPanel.style.display = "none";
    opts.onBack();
  };
  settingsPanel.appendChild(backBtn);

  const refresh = (): void => {
    sTitle.textContent = t("menu.settings");
    capLabel.textContent = t("settings.fpsCap");
    renderCap();
    renderGpuBtn();
    langBtn.textContent = t("settings.languageFont");
    langTitle.textContent = t("settings.languageFont");
    langCol.querySelector("div")!.textContent = t("settings.language");
    fontCol.querySelector("div")!.textContent = t("settings.font");
    for (const [lang, b] of langBtns) b.textContent = t(`lang.${lang}`);
    for (const [id, b] of fontBtns) b.textContent = t(`fonts.${id}`);
    renderLang();
    renderFont();
    packBtn.textContent = t("settings.resourcepacks");
    packTitle.textContent = t("settings.resourcepacks");
    packBackBtn.textContent = t("menu.back");
    if (packPanel.style.display === "block") renderPacks();
    renderScale();
    renderScaleLabel();
    wmLabel.textContent = t("settings.windowMode");
    renderWm();
    backBtn.textContent = t("menu.back");
    langBackBtn.textContent = t("menu.back");
    keybindBtn.textContent = t("settings.keybinds");
    kbTitle.textContent = t("settings.keybinds");
    kbHint.textContent = t("bind.hint");
    kbSideTitle.textContent = t("settings.bindOptions");
    kbBackBtn.textContent = t("menu.back");
    renderBinds();
  };
  onLangChange(refresh);
  refresh();

  return { settingsPanel, langPanel, packPanel, keybindPanel };
}

// ===== 5. Pause menu =====

export class Menu {
  visible = false;

  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly settingsPanel: HTMLDivElement;
  private readonly langPanel: HTMLDivElement;
  private readonly packPanel: HTMLDivElement;
  private readonly keybindPanel: HTMLDivElement;
  private readonly onResume: () => void;
  private readonly onToMainMenu: () => void;
  private readonly title: HTMLDivElement;

  constructor(cb: MenuCallbacks) {
    this.onResume = cb.onResume;
    this.onToMainMenu = cb.onToMainMenu;

    this.root = el("div", "position:fixed;inset:0;z-index:30;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);");
    uiStage.appendChild(this.root);

    this.panel = el("div", panelCss("17.5rem").replace("display:none;", ""));
    this.root.appendChild(this.panel);
    this.title = el("div", TITLE_CSS);
    this.panel.appendChild(this.title);

    const resumeBtn = button(BTN_CSS);
    resumeBtn.onclick = () => {
      this.hide();
      this.onResume();
    };
    this.panel.appendChild(resumeBtn);
    const settingsBtn = button(BTN_CSS);
    settingsBtn.onclick = () => {
      this.panel.style.display = "none";
      this.settingsPanel.style.display = "block";
    };
    this.panel.appendChild(settingsBtn);
    const toMainMenuBtn = button(BTN_CSS);
    toMainMenuBtn.onclick = () => {
      this.hide();
      this.onToMainMenu();
    };
    this.panel.appendChild(toMainMenuBtn);

    const panels = buildSettingsPanel({
      getFpsCap: cb.getFpsCap,
      onFpsCap: cb.onFpsCap,
      getGpuVsyncState: cb.getGpuVsyncState,
      onToggleGpuVsync: cb.onToggleGpuVsync,
      getWindowMode: cb.getWindowMode,
      onSetWindowMode: cb.onSetWindowMode,
      onBack: () => {
        this.panel.style.display = "block";
      },
    });
    this.settingsPanel = panels.settingsPanel;
    this.langPanel = panels.langPanel;
    this.packPanel = panels.packPanel;
    this.keybindPanel = panels.keybindPanel;
    this.root.append(this.settingsPanel, this.langPanel, this.packPanel, this.keybindPanel);

    const refresh = (): void => {
      this.title.textContent = t("menu.paused");
      resumeBtn.textContent = t("menu.resume");
      settingsBtn.textContent = t("menu.settings");
      toMainMenuBtn.textContent = t("menu.toMainMenu");
    };
    onLangChange(refresh);
    refresh();
  }

  get settingsVisible(): boolean {
    return this.settingsPanel.style.display === "block";
  }

  get langVisible(): boolean {
    return this.langPanel.style.display === "block";
  }

  get packVisible(): boolean {
    return this.packPanel.style.display === "block";
  }

  get keybindVisible(): boolean {
    return this.keybindPanel.style.display === "block";
  }

  goBack(): void {
    if (this.packVisible) {
      this.packPanel.style.display = "none";
      this.settingsPanel.style.display = "block";
    } else if (this.langVisible) {
      this.langPanel.style.display = "none";
      this.settingsPanel.style.display = "block";
    } else if (this.keybindVisible) {
      this.keybindPanel.style.display = "none";
      this.settingsPanel.style.display = "block";
    } else if (this.settingsVisible) {
      this.settingsPanel.style.display = "none";
      this.panel.style.display = "block";
    }
  }

  show(): void {
    this.visible = true;
    this.root.style.display = "flex";
  }

  hide(): void {
    this.visible = false;
    this.root.style.display = "none";
  }
}
