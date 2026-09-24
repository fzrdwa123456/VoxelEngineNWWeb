// ===== The key bind page's WIDGETS and its drag gesture =====
// Everything that used to live in `plugins/ui/views/menu.ts`: the action chips, the visual keyboard (chips,
// keycaps, legends, the OS-layout fetch), the entry button, the two mouse-button arm paths and the click
// shield's arming, the hit test the device layer asks, and the rubber-band widget's prefab.
//
// WHY IT MOVED (P1.26): the BEHAVIOUR moved in P1.25 (`ui.keybind`), but the page's widgets did not — so the
// ui plugin still had to know what a keycap is, and "turn the page off" could only hide it. Now the plugin
// owns both halves and the ui plugin owns neither: the settings panel asks for the tab through the
// `KEYBIND_TAB` resource, which THIS plugin's `setup` inserts, and a build without the plugin has no tab,
// no entry and no rubber band.
//
// THE DIRECTION OF THE DEPENDENCY IS WHAT DECIDES WHERE EACH PIECE LIVES. This file may import the ui
// plugin's components and the input plugin's bind table (both declared in `deps`); `ui` may import NEITHER
// this file nor its types, which is why the mount shape it is handed comes from a data module
// (`data/globals/keybind-tab.ts`) instead of from either plugin.
import { t } from "../../../data/assets/i18n";
import { installBindGestureHandlers } from "../../input/bind-gesture";
import { getBind, beginCapture, endCapture, getCapturing, codeDisplayName, buttonToCode, setBind } from "../../input/keybinds";
import { KB_ACTIONS, type BindAction } from "../../../data/globals/binds";
import { KB_ROWS, TOWER_GRID, NUM_GRID, MOUSE_GRID } from "../../../data/globals/keylayout";
import { ACTION_KEYBIND_CHIP, ACTION_KEYBIND_KEY, onUiAction, UI_ACTIONS, type UiActionHandler } from "../../../data/globals/actions";
import type { KeybindTabMount, KeybindTabSurfaces } from "../../../data/globals/keybind-tab";
import {
  registerKeybindPanel,
  type KeybindChip,
  type KeybindGesture,
  type KeybindKeycap,
} from "../../../data/globals/keybind-gesture";
import type { Entity, World } from "../../../core/world";
import type { UiHit } from "../../../shared/types/ui";
import { setUiVisible, spawnButton, spawnGridKey, spawnLabel, spawnLayoutBox, spawnPanel } from "../../ui/components";

/** What the document-level drag needs in order to reach the widget tree: the world (for the theme), the
 *  hit test (which only the UI system can answer — it owns the elements) and the GESTURE STATE, which is
 *  the world resource `ui.keybind` declares. The object is created by the composition root, handed over
 *  here AND inserted as that resource, so the listeners below and the system that applies them see the
 *  same data. Set once during wiring, because the gesture outlives any one panel. */
export interface KeybindDragDeps {
  /** The platform's log sink, INJECTED (a plugin may not import `host/`). */
  log: (line: string) => void;
  readonly world: World;
  readonly hitTest: (x: number, y: number) => UiHit | null;
  readonly gesture: KeybindGesture;
}
let dragDeps: KeybindDragDeps | null = null;
export function bindKeybindDrag(deps: KeybindDragDeps): void {
  dragDeps = deps;
  // Install the gesture's DEVICE listeners (plugins/input/bind-gesture.ts) — the click shield, the drag's
  // start/end, the wheel block and the key capture. They live in the device layer because every one of them
  // decides something inside the event itself; what is injected here is the state they read and the two
  // facts only this file knows: which action ids a chip/keycap carries, and the hit test that finds one.
  // A BIND is not written here: the listener queues the decision (KEYBIND_GESTURE.rebinds) and `ui.keybind`
  // applies it in the ui lane.
  installBindGestureHandlers({
    gesture: gestureState,
    capturing: getCapturing,
    endCapture,
    queueRebind: (intent) => deps.gesture.rebinds.push(intent),
    chipAction: ACTION_KEYBIND_CHIP,
    keycapCodeAt: (x, y) => keycapAt(x, y)?.code ?? null,
    hitTest: (x, y) => deps.hitTest(x, y),
    armShield: armSuppressNextClick,
    buttonToCode: (button) => buttonToCode(button),
    log: deps.log,
  });
}

/** The gesture, for the event-time readers below. They MUST see the live state synchronously (the click
 *  shield decides inside the click it swallows), which is why it is data they read rather than a step
 *  they wait for. */
function gestureState(): KeybindGesture | null {
  return dragDeps?.gesture ?? null;
}

/** The codes bound to an action right now — the keycap "blue face" state. Injected into `ui.keybind`,
 *  because the bind table is input state this file happens to know the layout of. */
export function boundCodes(): Set<string> {
  const bound = new Set<string>();
  for (const { action } of KB_ACTIONS) {
    const code = getBind(action);
    if (code) bound.add(code);
  }
  return bound;
}

/** Arm the one-shot click shield. schedSelf=false (capture-mode mousedown): cleared by the click shield
 *  when the synthetic click is consumed, or by the global mouseup fallback if none is synthesized.
 *  schedSelf=true (drag release): also schedule a 0ms self-clear — the synthetic click follows
 *  mouseup synchronously and consumes the flag first; the timeout only covers the no-click paths. */
function armSuppressNextClick(schedSelf: boolean): void {
  const g = gestureState();
  if (!g) return;
  g.shield = true;
  if (schedSelf) {
    setTimeout(() => {
      g.shield = false;
    }, 0);
  }
}

/** The drag RUBBER BAND, as a widget prefab. One layout-only box: its UI_LAYOUT string carries
 *  left/top/width/rotate and is rewritten by `ui.keybind` once per frame while a drag is past its
 *  threshold, so the geometry is DATA (derived from the gesture + the POINTER resource) and the
 *  reconciler paints it. Spawned by the composition root during wiring — spawning is a structural change,
 *  which a system may not make (iron rule 1). */
export function spawnKeybindLine(world: World): Entity {
  const line = spawnLayoutBox(world, null, "kb.line", "left:0;top:0;width:0;");
  // HIDDEN through the widget's own UI_STATE, like every other widget — the layout string carries the
  // geometry only, so `ui.keybind` rewriting it cannot accidentally reveal the line.
  setUiVisible(world, line, false);
  return line;
}

/** The drag's hover target for `ui.keybind`: the keycap under a point. Only a widget whose action IS a
 *  keycap counts — a drag released over an action chip must not bind the chip's own value as a key. */
export function keycapAtPoint(x: number, y: number): Entity | null {
  return keycapAt(x, y)?.entity ?? null;
}

/** Cancel the drag in progress: clear the gesture and end a rebind capture. `ui.navigation` calls this for
 *  ESC — the ONE decision-maker for that key (see its Escape branch). The device listener in
 *  plugins/input/bind-gesture.ts only neutralizes keyboard defaults while a drag is live; deciding there
 *  too is what made ESC both cancel the drag AND walk up a menu level once the registration order changed. */
export function cancelKeybindDrag(reason: string, log: (line: string) => void): void {
  const g = gestureState();
  if (!g?.drag) return;
  g.drag = null;
  g.hover = null;
  endCapture();
  log(`KBCAP drag cancelled (${reason})`);
}

/** The KEYCAP under a point, if any. Only a widget whose action IS a keycap counts: a drag released
 *  over an action chip must not bind the chip's own value as a key. */
function keycapAt(x: number, y: number): { entity: Entity; code: string } | null {
  const hit = dragDeps?.hitTest(x, y) ?? null;
  if (!hit || hit.action !== ACTION_KEYBIND_KEY) return null;
  return { entity: hit.entity, code: hit.value };
}

/** The key bind panel's two actions are DATA (`data/globals/actions.ts`). This flag is the file's own
 *  "registered once" bit: they are instance-independent (the capture state and the binds are global), so
 *  both settings instances dispatch to the same handlers — registered once, or the second instance would
 *  collide on the id. */
let keybindActionsReady = false;

function registerKeybindActions(actions: Map<string, UiActionHandler>, log: (line: string) => void): void {
  if (keybindActionsReady) return;
  keybindActionsReady = true;
  onUiAction(actions, ACTION_KEYBIND_CHIP, (value) => {
    const action = value as BindAction; // the chip's value IS a BindAction (see the spawn loop)
    log(`KBCAP click interactive button action=${action} capturing=${getCapturing() ?? "null"}`);
    if (getCapturing() === action) endCapture();
    else beginCapture(action);
  });
  onUiAction(actions, ACTION_KEYBIND_KEY, (code) => {
    const selected = getCapturing();
    if (!selected) return; // Clicking the keyboard with no action selected is a no-op
    setBind(selected, code);
    endCapture();
    log(`KBCAP keycap bind done (${code})`);
  });
}

/** Build the key bind tab inside one settings panel: the entry button (spawned HIDDEN — `ui.keybind` is
 *  what shows it), the panel's title/hint/back, the action chips and the whole visual keyboard.
 *
 *  Called by `buildSettingsPanel` through the `KEYBIND_TAB` resource, i.e. exactly when this plugin is
 *  installed; the panel container is spawned by the caller (it is part of the settings layout) and handed
 *  over in the mount. Interaction: click an action chip to select, then a keyboard key to bind it; conflict
 *  preemption is `setBind`'s (the bind table's) business. */
export function spawnKeybindPanel(mount: KeybindTabMount): KeybindTabSurfaces {
  const { world, id } = mount;
  const actions = world.resource(UI_ACTIONS);
  registerKeybindActions(actions, mount.log);

  const entry = spawnButton(world, mount.settingsPanel, "settings.btn", `${id}.openKeybind`, "", "settings.keybinds");
  // Invisible until `ui.keybind` runs: the tab is the PLUGIN's, so the way in is its to hand out.
  setUiVisible(world, entry, false);
  onUiAction(actions, `${id}.openKeybind`, () => mount.show("keybind"));

  // Key bind sub-panel: action chips + visual keyboard (full 104-key ANSI layout, fixed QWERTY
  // reference geometry = KeyboardEvent.code physical positions).
  spawnLabel(world, mount.panel, "kb.title", "settings.keybinds");
  spawnLabel(world, mount.panel, "kb.hint", "bind.hint");
  const kbFlex = spawnPanel(world, mount.panel, "kb.flex");
  const kbBoard = spawnPanel(world, kbFlex, "kb.board");
  const kbSide = spawnPanel(world, kbFlex, "kb.side");
  spawnLabel(world, kbSide, "kb.sideTitle", "settings.bindOptions");
  const chipList = spawnPanel(world, kbSide, "kb.chips");

  // Keycap legends: prefer the OS's actual layout (Keyboard Map API), fall back to QWERTY
  // reference letters on failure. Positions are always correct (code IS the physical position).
  let layoutLegends: Map<string, string> | null = null;
  const legendFor = (code: string): string => {
    const real = layoutLegends?.get(code);
    if (real) return real.length === 1 ? real.toUpperCase() : real;
    return codeDisplayName(code);
  };

  // What `ui.keybind` re-derives every frame from the bind table: one spec per panel INSTANCE, so the
  // pause menu and the main menu show the same thing by construction (they render from the same data,
  // not from two copies of it).
  const chipSpecs: KeybindChip[] = [];
  const capSpecs: KeybindKeycap[] = [];
  for (const { action, labelKey } of KB_ACTIONS) {
    const entity = spawnButton(world, chipList, "kb.chip", ACTION_KEYBIND_CHIP, action, "");
    chipSpecs.push({
      action,
      entity,
      labelKey,
      // Selected: the bare name (a KEY the reconciler re-resolves). Otherwise the name plus the current
      // key — a literal, because it carries a value.
      format: (code) => `${t(labelKey)} · ${code ? codeDisplayName(code) : t("bind.unbound")}`,
    });
  }

  /** code -> the keycap and its legend. The legend is a separate widget because the keycap is a
   *  `<button>` and its face is a `<span>` (the flex/grid centring relies on that). */
  const addKeycap = (parent: Entity, layout: string, code: string): void => {
    const key = spawnGridKey(world, parent, "kb.keycap", layout, ACTION_KEYBIND_KEY, code);
    const legend = spawnLabel(world, key, "kb.keyLegend", "", { raw: true });
    capSpecs.push({ code, key, legend, legendText: () => legendFor(code) });
  };

  for (const row of KB_ROWS) {
    const rowEl = spawnPanel(world, kbBoard, "kb.row");
    for (const [code, unit] of row) {
      const flex = `flex:${unit} ${unit} 0%;min-width:0;`;
      if (code === "") {
        // An empty cell: it is a ROW CELL with no key on it, so it uses the row-cell recipe and takes
        // its width from the layout table (the layout string always comes after the recipe, so the
        // exact flex wins over the recipe's default).
        spawnLayoutBox(world, rowEl, "kb.key", flex);
        continue;
      }
      addKeycap(rowEl, `${flex}height:1.8rem;`, code);
    }
  }
  const kbBottom = spawnPanel(world, kbBoard, "kb.bottom");
  const towerGrid = spawnPanel(world, kbBottom, "kb.tower");
  for (const cap of TOWER_GRID) addKeycap(towerGrid, `grid-area:${cap.area};`, cap.code);
  const numGrid = spawnPanel(world, kbBottom, "kb.numpad");
  for (const cap of NUM_GRID) addKeycap(numGrid, `grid-area:${cap.area};`, cap.code);
  const mouseGrid = spawnPanel(world, kbBottom, "kb.mouse");
  for (const cap of MOUSE_GRID) addKeycap(mouseGrid, `grid-area:${cap.area};`, cap.code);

  spawnButton(world, mount.panel, "settings.btn", `${id}.keybindBack`, "", "menu.back");
  onUiAction(actions, `${id}.keybindBack`, () => {
    endCapture(); // Leaving the panel cancels an unfinished selection
    mount.show("settings");
  });

  // This instance's chips and keycaps are now DATA `ui.keybind` renders every frame. Registering the
  // spec replaces the old `keybindRenderers.add(renderBinds)` + `renderAllPanels(...)` fan-out: a bind
  // change, a language switch and the OS layout arriving asynchronously all land on the next frame with
  // no call site to remember.
  registerKeybindPanel({ chips: chipSpecs, keycaps: capSpecs });

  // Async fetch of the OS keyboard layout for legends (silent fallback to the QWERTY reference)
  void (async () => {
    try {
      const kbApi = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
      if (kbApi?.getLayoutMap) {
        layoutLegends = await kbApi.getLayoutMap();
      }
    } catch {
      /* Fall back to reference letters */
    }
  })();

  return { panel: mount.panel, entry };
}
