// ===== THE GAME-SIDE ADAPTER: implements the UI's ports over the player + input plugins =====
//
// This file is one of the only two places in the tree that know BOTH sides (the other is `adapters/ui.ts`).
// The UI declares its needs in `src/ui/ports.ts`; here they are answered with real components, commands and
// the bind table. Nothing here is UI: it is the game, handed over through an interface.
//
// WHY THE PLAYER ENTITY IS RESOLVED PER CALL: the port is created at wiring time, before the plugins are
// installed, and LOCAL_PLAYER is a data resource that may be re-pointed; a closure that captured the entity
// once would be a stale-handle bug waiting for a long-lived run.
import type { World } from "../core/world";
import { LOCAL_PLAYER } from "../data/globals/resources";
import {
  CONTROL,
  HOTBAR_SLOTS,
  INVENTORY,
  INVENTORY_SLOTS,
  MODE_NAMES,
} from "../plugins/player/components";
import { SelectSlot, SetMode, SwapSlots } from "../plugins/player/commands";
import { installBindGestureHandlers } from "../plugins/input/bind-gesture";
import type { BindGestureDeviceDeps } from "../plugins/input/bind-gesture";
import {
  beginCapture,
  buttonToCode,
  codeDisplayName,
  endCapture,
  getBind,
  getCapturing,
  isCapturing,
  setBind,
} from "../plugins/input/keybinds";
import type { BindAction } from "../data/globals/binds";
import type { UiGamePort, UiKeybindPort } from "../plugins/ui/ports";

/** The bind table, narrowed to the UI's contract. The casts are the seam: the UI speaks plain action ids,
 *  the input plugin's table is typed by its own `BindAction` union. */
function createKeybindPort(): UiKeybindPort {
  return {
    get: (action) => getBind(action as BindAction),
    set: (action, code) => setBind(action as BindAction, code),
    isCapturing,
    capturing: () => getCapturing(),
    begin: (action) => beginCapture(action as BindAction),
    end: endCapture,
    codeName: codeDisplayName,
    buttonToCode,
    installGesture: (deps) =>
      installBindGestureHandlers(deps as unknown as BindGestureDeviceDeps),
  };
}

export function createUiGamePort(world: World): UiGamePort {
  const player = () => world.resource(LOCAL_PLAYER);
  return {
    hotbarSlots: HOTBAR_SLOTS,
    inventorySlots: INVENTORY_SLOTS,
    inventory: INVENTORY,
    modeNames: MODE_NAMES,
    readMode: () => world.get(player(), CONTROL)?.mode ?? "walk",
    setMode: (mode) => world.commands.send(SetMode, { entity: player(), mode }),
    selectSlot: (slot) => world.commands.send(SelectSlot, { entity: player(), slot }),
    swapSlots: (a, b) => world.commands.send(SwapSlots, { entity: player(), a, b }),
    keybinds: createKeybindPort(),
  };
}
