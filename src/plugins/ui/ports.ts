// ===== THE UI's PORTS: what this module needs from the GAME, declared HERE =====
//
// The UI owns these interfaces (dependency inversion): the widget layer, the menus and the five optional
// surfaces may not import `src/plugins/**` at all. `src/adapters/game.ts` implements them over the player and
// input plugins, and the composition root hands the implementation in as a host instance (`uiGame`).
//
// WHAT IS NOT HERE: `core/` and `data/` stay directly importable — they are mechanism and values, not "the
// game". Everything that IS game vocabulary (the INVENTORY component's identity, the SelectSlot/SwapSlots/
// SetMode commands, the bind table) crosses through the port instead.
import type { RecordComponent } from "../../core/data/component";
import type { KeybindGesture, RebindIntent } from "../../data/globals/keybind-gesture";
import type { UiHit } from "../../shared/types/ui";

/** One inventory stack, as the UI reads it (a structural view of the player's record). */
export interface UiItem {
  readonly type: string;
  readonly count: number;
}

/** The inventory record the widget layer renders. Same object the player plugin stores; the UI never writes
 *  it (the SwapSlots/SelectSlot commands do), so it is read-only here. */
export interface UiInventory {
  readonly slots: ReadonlyArray<UiItem | null>;
  readonly selected: number;
}

/** The game modes the debug picker cycles through. */
export type UiMoveMode = "walk" | "fly" | "spectator";

/** The bind gesture's DEVICE half reads these; the UI view supplies them. The types are data-layer ones,
 *  so this stays a UI-owned contract (no `plugins/input` import). */
export interface UiBindGestureDeps {
  readonly gesture: () => KeybindGesture | null;
  readonly capturing: () => string | null;
  readonly endCapture: () => void;
  readonly queueRebind: (intent: RebindIntent) => void;
  readonly chipAction: string;
  readonly keycapCodeAt: (x: number, y: number) => string | null;
  readonly hitTest: (x: number, y: number) => UiHit | null;
  readonly armShield: (schedSelf: boolean) => void;
  readonly buttonToCode: (button: number) => string | null;
  readonly log: (line: string) => void;
}

/** The bind table, as the keybind page needs it (actions are plain ids here). */
export interface UiKeybindPort {
  get(action: string): string;
  set(action: string, code: string): void;
  isCapturing(): boolean;
  capturing(): string | null;
  begin(action: string): void;
  end(): void;
  codeName(code: string): string;
  buttonToCode(button: number): string | null;
  /** Install the gesture's document listeners (the device layer's half); returns the disposer. */
  installGesture(deps: UiBindGestureDeps): () => void;
}

/** Everything the UI needs from the running game. One object, handed in as `host.instances.uiGame`. */
export interface UiGamePort {
  /** The hotbar/bag sizes, replacing the player plugin's constants. */
  readonly hotbarSlots: number;
  readonly inventorySlots: number;
  /** The inventory COMPONENT itself: the schedule's access declaration and the column reads need its
   *  identity, so it crosses as an opaque typed record rather than as a copy. */
  readonly inventory: RecordComponent<UiInventory>;
  readonly modeNames: Readonly<Record<UiMoveMode, string>>;
  readMode(): UiMoveMode;
  setMode(mode: UiMoveMode): void;
  /** The two player commands the UI dispatches; the adapter owns the entity and the command queue. */
  selectSlot(slot: number): void;
  swapSlots(a: number, b: number): void;
  readonly keybinds: UiKeybindPort;
}
