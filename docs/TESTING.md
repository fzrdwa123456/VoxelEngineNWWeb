# Manual test checklist

The engine has no test runner. The automated half of the verification loop is
`node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (strict) plus
`node scripts/check-ecs.mjs` (see the gate's description in AGENTS.md). This file is the OTHER half —
the flythrough — because a change is not "done" until it has been walked through by hand once.

Why it is a separate file: AGENTS.md is the architecture guide and has a size budget, and a
click-by-click list is neither architecture nor something every task needs to read.

launch → the window must appear ALREADY showing the startup screen (title, a stage line, a percentage
and a bar that fills), and the main menu must appear when the bar is full — never a white or black
rectangle first → hand-edit `game\config\settings.json` to `"fpsCap": 1` (also try `"language": "de"`,
`"windowMode": 5` and a junk keybind code) and relaunch: the startup screen must report
`Repaired settings` and list them, the file must have been rewritten with the values in force, and
`debug.log` must carry the same list → delete a brace so the JSON is invalid and relaunch: the screen
must say the file was rebuilt, `config/settings.bad.json` must hold the old bytes, and the game must
still start → the startup now ends at the MAIN MENU (`BOOT graphics ready at NNNms`, `BOOT ready in
NNNms`), and entering a world is where the work happens: clicking Singleplayer must put the loading
screen up again (spawn → terrain → chunk meshes, with the bar advancing) and then reveal a world that
is ALREADY there — no streaming-in. Press ESC or E while that screen is up: nothing may appear (the
pause menu and the backpack are refused until a world runs). Then go back to the main menu and enter
again: the second entry must be INSTANT, with no screen at all (the window around the spawn point is
still built — `WORLD already warm, entering without a screen` in `debug.log`).
At the MAIN MENU (and on the loading screen) the GAMEPLAY UI must be absent: no crosshair, no hotbar,
and the hotbar's slots must not respond to a click. F3 must do nothing there, and F3+F4 must not open
the mode picker — check the same at the pause menu, where F3 MUST still work (a world is running). Then
enter a world and confirm all of it comes back: crosshair, hotbar, F3 panel, F3+F4 picker. Coming back
to the main menu with the F3 panel or the picker open must take them down, not leave them on screen.
enter the game → you land on the flat voxel surface at WORLD_SURFACE_Y and can walk and jump
(if you fall forever instead, the entry's warm-up did not run — check `enterWorld`/`chunkStream.prime`
in `debug.log`)
→ nothing streams in: the spawn window was meshed before the screen came down → fly (double-tap Space) down into
the ground and confirm you STOP rather than pass through → Shift ×25 sprint → look past the
zenith: pitch CLAMPS at ±89.4° in EVERY mode (no wrap) → F3 shows a real `top` and the loaded
chunk count → aim at a block: the white outline follows the crosshair → LEFT-click breaks it and
the hole appears the same frame → RIGHT-click puts it back → dig a 1x1 shaft down and jump out
of it → build a pillar UP from the surface (this is the one thing that used to be impossible: the
writable range ended exactly where the ground started) → hold a mouse button and open a menu: no
block may change (the freeze is applied per entity via the PLAYER marker) → press 1..9: the hotbar
highlight moves, and E opens the backpack where clicking a slot swaps it with the selected one
(selection and swaps are COMMANDS, drawn by the `ui.inventory` reconcile — if the highlight never
moves, the command barrier or that system is the place to look) → with the backpack OPEN, the world
must keep running behind the panel (chunks still stream, the F3 panel keeps ticking, NPCs keep
falling) and the player must keep FALLING if it was airborne — it loses its keys, not its body; the
freeze is `canControl()` (input only), so if the whole frame freezes instead, something put
`setLoopMode("game")` back into the inventory callback, and if an airborne player HANGS, `movement` is
skipping the entity instead of just its input
→ F3+F4 switches the movement mode
→ ESC: the pause menu is a WIDGET tree now, so check what a migration could have broken: Resume,
Settings → every entry (the FPS slider drags in steps of 2 across 30..240, its right end reads the
"unlimited" word, and setting it in ONE panel and then opening the other shows the SAME value — the
slider is bound to the value in force, so the two settings panels cannot drift; vsync shows a toast;
Language and
Fonts switch language and font LIVE — the labels re-translate without a reload; Resource packs lists
what is in `game\resourcepacks\`; UI scale and Window mode apply), then Back, then ESC steps back one
level instead of closing everything → with the FPS cap set to something small (say 60), quit and
relaunch: the slider must still say 60 (it used to reset to "unlimited" every launch while showing
"unlimited", as if it had never been changed) → Key binds: click an action chip (it turns blue and shows the bare
name), then click a keycap on the visual keyboard (the bound keycap turns blue), then hold a chip and
DRAG it onto a keycap (a rubber band follows the cursor and the target keycap gets a white outline) —
then bind something to a mouse button by clicking a keycap with no chip selected, unbind with Esc (the
action clears and the panel STAYS on this page — see the P1.13 note at the end), and
close the panel → E: the backpack opens; clicking a bag slot swaps it with the selected hotbar slot and
the hotbar highlight moves; icons show the block texture (fetched from the bake cache in ONE write, so
a stack move does not flash a placeholder; a first-ever bake shows the magenta/black checker until it
lands); hovering a slot shows the block name as a tooltip
→ back at the main menu, click Multiplayer: the
placeholder TOAST must appear, and it is drawn by the MENU frame (the mode with no simulation and no
world draw, which still runs the ui lane) — if it stays
silent, the menu frame is not running or the toast's widget was never reconciled (a UI write with no
reconcile is invisible, which is exactly how that regression happened once).
The system order is checked at BOOT: if `world.start()` throws, a system's `after`/`before` is
wrong and nothing runs — the message names the system. The same boot also logs what is parallel:
grep `SCHEDULE` in `logs\debug.log` for the batch grouping of each stage, and treat a changed
grouping as a real change (it means a system's access moved). `logs\debug.log`'s ESC line now starts
with `modal=<bool>` — that is the UI_MODAL resource the freeze gate reads, next to the individual
container flags it came from.

AFTER the presentation objects became resources (`host/browser/presentation.ts`, §5.2 P1.7: the scene, the
camera, the renderer, the frame sampler, the canvas host, the UI mount root and the chunk-mesh cache —
a system resolves what it uses instead of being handed it). Nothing should LOOK different, so what is
worth walking is the four places a wiring mistake would show up: the camera still follows the player
and mouse-look still rotates it (`camera-view.ts` resolving CAMERA3D); chunks still stream in and out
while walking and a dug block re-meshes in the same frame (`chunk.stream` resolving CHUNK_MESHES — if
the world stays empty instead, the resource is not the cache the mesher fills); F3 still shows a GPU
ms figure (`diagnostics` resolving RENDERER3D + PERF_SAMPLER — a blank there means the renderer's
timestamps no longer reach the sampler); clicking still captures the mouse and ESC still releases it
(`input.ts` taking its canvas from `RENDERER3D.domElement` — if clicks do nothing, the listeners went
onto a different element); and the UI still appears on the loading screen, in the menus and on the HUD
(the reconciler resolving UI_MOUNT). Then resize the window: the aspect must still follow.

AFTER the input race guards' state moved into the `INPUT_TIMING` resource (§5.2 P1.8 — the fields only;
the logic and its order are untouched BY DESIGN). This one is worth walking carefully because a field
move is exactly where a copy-paste slip would hide, and the symptoms are the races rule 3 warns about:
press ESC or E to open a menu and close it — the view must NOT snap or slide, and mouse look must be
live again IMMEDIATELY after closing (a stale grace window shows up as "the first ~100 ms of movement
does nothing"); click into the game to capture the mouse — the FIRST mousemove after the capture must
not rotate the view (that is `skipFirstMove`), and neither must the capture itself; double-tap Space to
toggle flying (that is `lastSpaceDown`, and it must still need the SECOND press within 250 ms); open F3
and confirm the SPACE/MOUSE log lines still appear and still number up (`spaceSeq`/`mouseSeq`); and drag
the window partly off the screen while playing — the raw-input takeover must still engage exactly once
(one `RAWINPUT takeover (movementX suspended)` line in `debug.log`, not one per frame — that is
`rawTakeoverActive` plus the offscreen cache), and it must hand back with a single
`RAWINPUT hands back to movementX` once the window is fully on screen again.

AFTER P1.9 (the window listener, the menu background, the diagnostics dependencies, the hotbar keys and the
drag's rubber band). Four things to walk: (1) RESIZE the window in every mode — while playing, in the pause
menu and at the main menu: the aspect must follow in all three (the projection, the renderer size and the
menu-background camera all read the VIEWPORT resource now; the projection is cameraView's, the canvas size
is the FRAME's `applyViewportSize` — it must run in EVERY mode, which is exactly the bug a first version had
when the size was applied inside `renderer.draw`: a menu frame never runs that lane, so the panorama's canvas
kept its old size and the background stopped scaling. If the picture stretches somewhere, a consumer ignored
the resource; if the background stops scaling at the MAIN MENU, the size is being applied in a lane that
menu frames do not run); (2) drag a bind chip onto a keycap —
the rubber band must appear from the anchor to the cursor, follow it, rotate correctly, sit ABOVE the panel,
and vanish on release (it is a widget whose UI_LAYOUT `ui.keybind` rewrites; if it never appears, the
POINTER resource is not being published, and if it appears at 0,0 the layout string is not reaching the
reconciler); (3) press 1..9 — in a world they select the hotbar slot, and at the main menu, on the loading
screen and behind the pause menu they must do NOTHING (that was a real bug: the view listened with no gate);

AFTER P1.10 (the window-geometry signal). The reported bug was: drag the window's border WHILE a world is
loading, the entry locks the mouse on top of the drag, and from then on the drag and the view rotation both
work with the cursor roaming afterwards. Walk it: (1) start a resize-drag while the world entry is running —
the moment the world starts the capture must be handed back and the PAUSE MENU must appear (one
`WINGEOM …` line and `GEOMETRY changed -> pause menu` in `debug.log`); the view must NOT rotate while you
are still dragging; (2) after releasing, the cursor must be free, visible and NOT clamped to a stale
rectangle (no "it only moves inside an invisible box" feel); (3) resize while the pause menu is already open
— nothing may change (no second pause, no capture); (4) **switch to fullscreen and back** from the settings
panel — the pause menu must NOT appear (that is the suppressed programmatic mode change) and the canvas must
fill the screen with the right aspect; (5) click during the LOADING screen — the mouse must NOT be captured
(the `LOCK click grab` line must not appear before `world entered`); (6) minimize/restore — the game must
pause on the way out (blur) and, if a resize comes with the restore, not pause twice.

AFTER the FOREGROUND gate (the second half of P1.10 — same symptom, different mechanism): the reproduction
is to switch to ANOTHER application during a world entry. (1) Alt-Tab away right after clicking Singleplayer,
wait for the loading to finish, then come back: the world must have entered PAUSED (`WORLD entered while not
foreground -> pause menu (no capture)` in `debug.log`), NOT captured — while you are away the cursor must stay
free in the other app (no invisible box, no hidden cursor) and the game view must not rotate; (2) repeat it
and click back into the game window instead of using the menu: with the pause menu up, focus return must NOT
capture (menus never auto-close — resume manually); (3) `debug.log` must never show `LOCK request [world
entered]` while the app is in the background, and if a capture ever does end up live out of the foreground,
the Rust net must report `CAPTURELOST not foreground` within ~32ms and the pause must follow; (4) Alt-Tab
away while PLAYING — unchanged: pause menu + cursor back.
(4) F3 — the panel's text must still show FPS/XYZ/chunks/GPU and the SPACE/MOUSE logs, with the GPU ms
figure present (the F3 text is written by `diagnostics` now, from the F3_PANEL resource — an empty panel
means the resource was not published, a panel that never hides means the picker stopped toggling it).

AFTER the view/listener sweep and the input-side fixes (P1.9/P1.11 — the inventory reconcile became a system,
the window-level listeners moved into `host/browser/window-guards.ts`, the key bind gesture's device half moved
into `plugins/input/bind-gesture.ts`, and the input intent queue became a resource). Six things to walk:
(1) **backpack / hotbar** (`plugins/ui/systems/inventory.ts` is the system now, `plugins/ui/views/inventory.ts` only spawns):
icons, counts, tooltips, the selected highlight, clicking a bag slot to swap, and a first-ever block icon
showing the checker before it bakes — an EMPTY hotbar means `INVENTORY_WIDGETS` was not published, a hotbar
that never updates means the reconcile did not move with the view;
(2) **window guards** (`host/browser/window-guards.ts`): ESC still opens/closes the pause menu, right-click
places a block instead of raising a menu, and SPACE does not scroll a list while a menu is open;
(3) **the bind gesture** (`plugins/input/bind-gesture.ts`): drag a chip onto a keycap (rubber band follows, the
target lights up), release over empty space is a no-op, the click shield stops the synthetic click from
re-triggering whatever is under the cursor, the wheel is blocked during the drag, and **ESC during a drag
cancels the drag and must NOT step a menu level back** (that decision belongs to `ui.navigation`, the one
ESC decision-maker);
(4) **TAB** while the mouse is captured: still no pause menu and no `WINFOCUS blur` line in debug.log after a
`code=Tab` line — the browser's focus traversal is CANCELLED — but the key itself is no longer SWALLOWED, so
**if TAB is bound to an action (the bind panel accepts Tab), that action must now fire while playing** (bind
it to, say, jump or forward and use it); in a menu (not captured) TAB still moves focus normally;
(5) **the menu/Apps key and Shift+F10**: no cursor flash, no menu. Shift+F10 is already fixed by cancelling
the gesture; the Apps key is a race — hammer it in a world, in the pause menu, with the backpack open and at
the main menu, and if a frame ever survives, tighten the re-assert burst in `window-guards.ts`;
(6) `debug.log` must show exactly three `HOOKPROBE seen=0 …` lines per run and never a growing `seen`: a
non-zero `seen` would mean the low-level keyboard hook finally started working (see AGENTS.md's known gaps)
and the cursor race could be reconsidered.

AFTER the DELEGATED UI events (P1.11 follow-up — `plugins/ui/systems/reconcile.ts` used to attach SIX listeners to every
widget at mount time; it now attaches ONE per event type to the UI MOUNT ROOT and finds the widget by walking
up from `ev.target`; hover is an ancestor-chain diff over the bubbling `mouseover`). Nothing should look
different — that is the point — so walk the paths where the resolution could differ:
(1) **click the TEXT, not the edge**: every button, choice, language item, Back button and bag/hotbar slot
must still work when the click lands on the label INSIDE it (that walk up from `ev.target` is the new part;
if a click only works on the button's padding, the chain walk stopped at the label);
(2) **keyboard activation is OFF** (deliberate): TAB to focus a button and press ENTER (or SPACE) — nothing
may happen (no menu opens, no setting changes, no key gets bound). The filter is on the EVENT
(`ev.detail === 0` = a keyboard-generated or programmatic click), so the focus ring itself and everything
mouse-driven are unchanged;
(3) **sliders**: click the TRACK — the thumb must jump to the pointer and the value must follow (that is the
browser's own behaviour and it stays); drag the thumb and the FPS cap label must follow; a slider's arrows
while it is FOCUSED still move it (only `click` is filtered, not `input`) — tell me if that should go too;
(4) **hover**: every button/choice must still highlight (the main-menu buttons brighten) and must UN-highlight
when the pointer leaves; move the pointer from a button ONTO its inner label span and back — the parent must
stay highlighted the whole time (a chain diff recomputes the whole ancestor set per event, so a parent + child
CAN both be lit);
(5) **press**: hold the mouse down on a main-menu button — the pressed-in look must appear — then drag OFF the
button and release over the canvas: the pressed look must clear (the per-widget listener only heard releases
on the widget itself, so a press that ended elsewhere used to stay pressed until the pointer left and came
back — that is the one behaviour that deliberately CHANGED);
(6) move the pointer out of the UI entirely (onto the game view, or out of the window) — nothing may stay
highlighted or pressed;
(7) tooltips still appear on the inventory slots, and a click on a hidden (display:none) surface — through
the pause menu onto the HUD — still does nothing.

AFTER the DELAYED INTENTS became data (P1.11 follow-up — `DELAYED_INTENTS` + `ui.delays`; four `setTimeout`s
are gone from `host/browser/pointerlock.ts`, `host/browser/window-guards.ts` and the composition root). The mechanism
changed from "a timer fires on its own" to "the ui lane applies whatever deadline has passed", so the things
worth walking are the ones that depend on WHEN it happens:
(1) **close the backpack** (E twice): the mouse must be captured again at once (`LOCK request [inventory E]`
in `debug.log`, no `LOCK skipped` unless the window is not in the foreground) and mouse look must be live
immediately — if the view stays dead after closing the bag, the `relock` deadline never fired;
(2) **the lock retry**: if `debug.log` ever shows `LOCK rejected [<reason>], retrying in 1300ms`, then ~1.3 s
later it must show `DELAY lockRetry [<reason>]` immediately followed by `LOCK retry [<reason>]` and the
capture must end up live (that path is hard to force by hand; the log line is new, the retry is not);
(3) **focus return**: Alt-Tab away and back — the cursor must be correct in both states (visible with a menu
up, hidden while playing); `reapplyCursor`'s 0/120 ms re-asserts are deadlines now, so a wrong cursor here
means the deadline never fired;
(4) **the menu/Apps key and Shift+F10** (the re-assert burst is now 0/32/80 ms applied ONE PER FRAME instead
of three timers): no cursor flash in a world, with the backpack open, in the pause menu and AT THE MAIN MENU —
the main menu is the mode where the ui lane is the only lane running, which is exactly what the deadline
system relies on;
(5) `debug.log` must contain no new timer noise: the only new line is `DELAY lockRetry […]`.

AFTER the presentation-state tail (P1.12 — the icon baker, the chunk material, both counter blocks, the UI
mount root, the widget order counter and the target wireframe all became resources, and `player.interaction`
stopped writing three.js from the fixed lane; `plugins/render/systems/outline.ts` + `block.outline` paint it now). Seven
things to walk:
(1) **the target wireframe** (`BLOCK_OUTLINE` + `block.outline`): aim at a block — the white box must sit
exactly ON the block's faces, i.e. the same as before the change (it is placed at voxel + 0.5; a box half a
block off means a voxel INDEX is being used as a position). Look at the sky: it must vanish the same frame.
Open the backpack, or press ESC, then resume: it must be gone while a UI owns the mouse and back at once
afterwards (it is written from `TARGET_HIT.active`, which the interaction system clears when the player is
uncontrolled). A wireframe that never appears while a block is in reach means `block.outline` did not run,
or the local player carries no `TARGET_HIT`;
(2) **item icons** (`ICON_BAKE` + `peekBlockIcon`/`requestBlockIcon`, no more `.then` writing a widget): an
icon that has never been baked shows the engine's checker for a FEW FRAMES and then the real 3D icon (the
system notices the finished bake on a later frame — that is deliberate). Now the sharp case: shuffle the
same block between two slots — the icon must appear in ONE write, with NO checker frame (a checker flash on
a stack move means the peek missed and the slot went through the waiting path). An icon that NEVER appears
means the bake failed or `collectFinishedBakes` did not redraw it; a checker that never stops means the
request was never issued at all;
(3) **the shared chunk material** (`CHUNK_MATERIAL`): the world must draw exactly as before (the same
checker texture, the same lighting) and streaming into new chunks must not change the look — the material is
created ONCE, on the first mesh. New chunks drawn PLAIN GREY/untextured would mean the lazy creation ran
before the pack chain was installed;
(4) **the two counter lines** (`InputDiagnostics.raw` + `.look`, both printed by `player.input`): `debug.log`
must still carry one `LOOK raw=… app=…` line and one `RAWLAG ev=…/s gapMax=…ms backlogAvg=…ms
backlogMax=…ms` line per second while playing, with plausible numbers (raw ≈ 250/s, gapMax ≈ 4 ms, app ≈
frames with displacement). A missing `RAWLAG` line means the device layer never received the counters
object; a `RAWLAG` that is all zeros means the listener is writing a different object than the one the
system prints;
(5) **the diagnostic switch still covers both**: toggle "Diagnostic log" OFF in the settings panel — BOTH
`LOOK` and `RAWLAG` must stop (they share one printer now); turn it back on and both return;
(6) **the UI mount root and the widget order** (`createUiMount()` + `UI_ORDER`): the UI must be laid out
byte-for-byte as before — the menus, the HUD, the hotbar, the F3 panel in their usual places, in their usual
child order (the reconciler appends in creation order, which is now read from the resource). A totally
EMPTY UI means the mount root was not created/inserted; a panel whose children come out in the wrong order
(a label drawn under its own background) means the order counter is not the one the spawns draw from — it
would throw at the first spawn instead if the resource were missing;
(7) `debug.log` must carry the boot `SCHEDULE render: 5 systems, 2 batches, 6 parallel pair(s)
[(cameraView.render ~ chunk.stream ~ block.outline ~ diagnostics) | renderer.draw]` line — the new system
must be IN the batch, and `block.outline` must not appear as its own batch (that would mean it declares a
target the others write).

AFTER the ESC-owns-the-capture fix (P1.13 — `plugins/player/systems/input.ts::onKeyDown` no longer publishes an
ESCAPE edge while a rebind capture is armed, because the capture's handler in `plugins/input/bind-gesture.ts` is
mounted LATER than that listener and its `stopImmediatePropagation()` cannot recall an edge that is already
in `KEY_EVENTS`; before the fix ESC unbound the action AND stepped the panel one level back):
(1) open the key binds panel (pause menu or main menu → Settings → Key binds), click an action row so it
turns blue and shows the bare name (that is the CAPTURE), then press ESC — the action must end up UNBOUND
(its chip shows the action name with no key) and **the panel must STAY on the key binds page**: it must NOT
fall back to the settings list. If the page still moves, the ESC gate is not being hit — check the boot
order in `main.ts` (`new PlayerInputSystem` must precede `bindKeybindDrag`);
(2) the ESC ladder still works everywhere else: with nothing capturing, ESC closes the key binds page →
the settings list → the pause menu → and in a world opens/closes the pause menu as before. `debug.log`
shows one `ESC modal=… settings=…` line per press; while capturing, that line must NOT appear at all for
that press — with the diagnostic switch ON the only trace is `KBCAP bind done (code=Escape)`, and with it
OFF that press writes nothing at all (KBCAP is a probe — see the switch section below);
(3) bind a key after the unbind (click the same action row, press a key): it must bind normally — the gate
is ESC-only, so no other key may be swallowed by the capture;
(4) TAB is still BINDABLE: select an action, press TAB, then use it (the menu-level TAB default is
cancelled while the mouse is captured but the key itself still reaches the game — see the P1.11 note).

AFTER the data/behaviour pass (P1.14 — the view paint caches, the host state, the asset caches, the rebind
capture, the frame loop's state and the two boot/entry drivers all became world data; `core/flow/boot.ts` walks a
stage LIST and `ui.keybind` applies queued rebind decisions). NOTHING should look different — that is the
point — so walk the paths where the split could have broken something:
(1) **the startup, in order**: launch and watch the loading screen. It must appear with a bar and a stage
line ("checking settings" → "initialising graphics" → "ready"), the window must be revealed with that screen
already painted (never a white or black flash), the main menu must come up in well under a second, and
`debug.log` must still show `SETTINGS …`, `BOOT graphics ready at …ms` and `BOOT ready in …ms`. A stage line
that NEVER changes, or a window that appears only after the GPU is ready, means the stage list or the
walker's announce-then-run order is wrong;
(2) **entering a world**: click Singleplayer — the screen must come back with the world's stages
(`world.spawn` → `world.terrain` → `world.chunks` → `world.ready`), the bar must fill while the chunks are
meshed, and the world must appear with the game frame (never an empty frame). Then go back to the main menu
and enter AGAIN: the second entry into a warm window shows NO screen and lands instantly (`WORLD already warm,
entering without a screen`);
(3) **the key bind panel** (this is the one whose logic moved into the lane): click an action row (it selects
/ shows the bare name), then press a key — it must bind; press ESC — it must UNBIND and the panel must stay
on the page (the P1.13 rule, unchanged); release a drag on a keycap — it must bind; `debug.log` must still
carry one `KBCAP bind done (code=…)` per bind and `KBCAP mousedown …` per click, and the click that follows a
physical press must still be swallowed (no double-select);
(4) **the UI itself**: the HUD, the hotbar, the backpack (icons, counts, selection), the F3 panel (F3 and
F3+F4), the toast, every settings panel and the language switch — the reconciler's element tables and its
"what did I draw last" cache are resource data now, so a widget that fails to appear, fails to UPDATE or
flickers is the symptom to report (an ELEMENT TABLE that got lost shows as "the whole UI is missing", a lost
diff cache as "one widget is stale");
(5) **the loop and its probes**: FPS must be unchanged, a resize at the main menu must still resize the
panorama's canvas (the frame applies it, not the draw), and with the diagnostic switch ON `FRAME`/`PHYS`
lines must keep coming — the mode, the accumulators and the counters are `LOOP_STATE`/`FRAME_PROBE` now;
(6) **the settings file**: change the language, the FPS cap, a key bind and the diagnostic switch, quit, and
relaunch — all four must persist (`SHELL_STATE` holds the file snapshot the modules read).

AFTER the diagnostic-log switch (the settings panel's "Diagnostic log", default ON — `settings.json`'s `diagLog`):
the probe lines (`FRAME`/`LOOK`/`RAWLAG`/`RAWMON`/`STALL`/`PHYS`/`SPACE#`/`MOUSE#`/`HOOKPROBE`, plus the two
that fire on ordinary activity — `KBCAP …` once per click of the key bind UI and `RAWINPUT takeover` /
`RAWINPUT hands back` when the raw channel takes over) are
what made the "held key" investigation possible, and they are also the only thing that keeps writing for as
long as the app runs. (1) open the settings panel (pause menu or main menu) — the toggle must read
"Diagnostic log: ON (probes included)"; (2) click it → the label switches to
"Diagnostic log: OFF (events only)" and `debug.log` must
write a `DIAGLOG probes disabled` line and then STOP getting `FRAME`/`LOOK`/`RAWLAG`/`RAWMON`/`PHYS` lines
while everything else (BOOT/SETTINGS/WORLD/LOCK/CURSOR/ESC/GEOMETRY/ERROR) keeps being written; (3) play for
a while with the switch OFF — click through the menus, open/close the pause menu, enter and leave a world, and
press ESC a few times: **no probe line may appear**, `KBCAP` included (a line still arriving means its prefix
is missing from the table in `host/desktop/shell.ts`); (4) toggle it back on → the probes resume; (5) restart the
game — the
setting must persist (it is a normal field of `settings.json`, repaired by type if hand-edited), and with it
OFF the file must contain no probe line at all from the first frame — while one of the first lines of that
run reports the state it booted in:
`DIAGLOG probes disabled at boot (settings.json diagLog=false; no probe lines in this run)`. That line is an
EVENT (written whether the switch is off or on), and it is what makes "the switch is off" distinguishable
from "the probes never registered" when reading a log that has no probe lines in it.

AFTER the HUD HOST and the plugin hot-plug keys (P1.34: F8 ui-debug, F9 ui-keybind, F10 ui-toast,
F11 ui-inventory; `tools\*.bat` writes each variant of `plugins.json` and `plugins-status.bat` prints the
lines to look for). Each key must change the RUNNING game with no restart, and `debug.log` must show
`HOT-INSTALLED` / `HOT-UNINSTALLED` next to `PLUGIN installed N/11`. F11 is the one that proves the HUD is
DYNAMIC - the crosshair and the hotbar are not spawned during wiring any more, `ui.hud` builds them when
its element is mounted and despawns them when it goes:
(1) start with the inventory layer OFF (`tools\plugins-no-ui-inventory.bat`): the CROSSHAIR must be there and
the hotbar must never appear anywhere - not at the main menu, not on the loading screen, not over the pause
menu (it was a HUD element that did not exist yet, not a hidden one: the boot log has `HUD element mounted
crosshair` and NO `mounted hotbar` line), and `E` must open nothing;
(2) press F11 -> the strip appears WITH its items drawn. A strip that comes back blank means the reconcile
cache was not invalidated when its cells were respawned (`buildHotbar` marks the hotbar range dirty);
(3) press F11 again -> the strip and the bag are gone and NOTHING is left on screen: a frozen strip is the
residue the host's deferred unmount exists to prevent (the log says `HUD element unmounted hotbar`);
(4) F11 off/on five times: no duplicated strip, no `frame error`, the selection highlight still follows the
1..9 keys, and the items are still drawn every round - this is the leak test: every round must end with
the same one strip and the same log lines;
(5) `tools\plugins-no-optional-surfaces.bat` (four surfaces off) -> `PLUGIN installed 7/11`, a plain
crosshair-only HUD, and no `PAGE`/`HUD element` mount line for the surfaces that are off.

AFTER the language-pack demo (`tools\lang-demo.bat` writes `lang/fr.json` into the sample resource pack, so
the pack ships a FOURTH language): (1) the boot log must gain it and say so twice -
`content: 4 declared language(s) [zh, en, ja, fr] - 1 of them from the pack chain [fr]` and
`I18N dictionaries loaded (lang/*.json layered merge): zh=NN en=NN ja=NN fr=9 entries` - a set of three, or an
`fr=0`, means the discovery or the build did not happen; (2) pause menu -> Settings -> Language/Font must list
FOUR choices, the new one labelled `Francais (FROM THE PACK)`: that label is looked up in the pack's OWN
dictionary (a raw `lang.fr` there means the label key is missing from it); (3) pick it -> the pause menu, the
main menu and the settings rows the pack defines turn into its text, and `settings.json` gains
`"language": "fr"`; (4) quit and relaunch -> it comes back in the pack's language (an UNDECLARED value is the
case the repair pass would rewrite, so this is what proves the declared set is what validates it); (5) delete
`lang\fr.json` and relaunch -> back to three choices, and a `settings.json` still saying `fr` comes up in
ENGLISH: an undeclared language reads as the fallback language (the same one a missing WORD uses), the boot
log gains a `SETTINGS repaired: language` line, and the file is rewritten to `"language": "en"`. The
removed-pack case must not paint raw keys, and must not silently turn the install Chinese. The same holds for
a value the install does not declare at all (`"language": "xx"`, or a number): fallback language,
`SETTINGS repaired: language`, file rewritten. DELETING the `language` key is the other case and must keep the
engine's first-run default (Chinese) — those two must not be confused, because that confusion is what made the
first fix look right while the game still came up Chinese.

AFTER the block-pack demo (`tools\blocks-demo.bat` writes `assets\voxel\data\blocks.json` into the sample
resource pack: one NEW block plus an OVERRIDE of a mod block): (1) the boot log must gain
`BLOCKREG registry loaded: 7 blocks -> [grass, default, missing, ruby, stone, gold, demo]` next to
`[content-default] content: ... 7 block(s) declared from the pack chain` - six blocks means the declaration
never reached the registry, eight means the merge ran twice, and `BLOCKREG` appearing BEFORE the
`PLUGIN installed` line means the build moved back above the install; (2) the inventory must show a seventh
slot with a CHECKER icon (the pack ships no texture: that is the missing-texture path, not a bug) and the
tooltips must read the pack's labels - `Demo Block (from the pack)` and the reskinned `Stone`; (3) delete the
file and relaunch: seven becomes six and the tooltip goes back to the mod's label.


AFTER the explicit-only capture (P1.58 - the Win-key focus FLAP, cured at the root). The flap is a Windows
behaviour, so walk it with both logs open (`logs\boot.log` for the `[cursor]` probes, `logs\debug.log` for
`WINFOCUS`/`LOCK`):
(1) **the Win key, in a world**: enter a world (mouse captured, view turns), press Win once and move the
pointer around the Start menu for a few seconds. The cursor must stay VISIBLE and must NOT blink. `boot.log`
may show `[cursor] focus LOST` / `focus GAIN` pairs, but a `[cursor] capture on=true` line after a
`focus GAIN` is the bug back; `debug.log` must show one `WINFOCUS blur` + `-> pause menu` and NO
`FOCUS focused -> relock` line at all (that line does not exist any more);
(2) **coming back**: click into the window - the pause menu is up, the cursor is visible, the world is
frozen; Resume captures again (one `LOCK request [menu resume]`). Alt-Tab away and back WITHOUT resuming:
the mouse must stay free every time (no capture, no hidden cursor, no view rotation) - Alt+Tab never takes
the mouse back on its own any more;
(3) **the pathological case** (a blur whose pause menu does not appear): the cursor still must not be
hidden - check that no `capture on=true` follows the `focus GAIN` in `boot.log`, and that clicking the
canvas in the world re-grabs the mouse (`LOCK click grab`) and hides the cursor again;
(4) **the drag flood is gone**: drag the title bar or a border for a second - `boot.log` must now hold a
handful of `capture on=false` lines (one per real release) instead of one per geometry event;
(5) the standing regressions: ESC -> pause menu -> Resume (cursor back, view live); the backpack (E) opens
with a visible cursor and closing it re-captures at once; fullscreen/windowed from the settings panel does
NOT pause; the menu/Apps key still produces no cursor flash.

AFTER the cursor diagnostic channel (P1.59 - pinning the Win-key report down). Everything about the
cursor now lands in ONE file, `logs\boot.log`, from BOTH sides and in order. Reproduce: enter a world,
press Win once, wait ~2 s, come back WITHOUT clicking anything, then read the last ~40 lines.

The lines to know:
```
[cursor] focus LOST  before=[…]              Rust: the window event, with its own table + GetCursorInfo
[cursor] focus LOST  after =[…]              …after win::on_foreground_lost (capture released, intent forgotten)
[cursor] … winlost JS t=+…                 the front end: locked / free / modal / canControl / css / computed
[cursor] … winlost RUST […]               the SAME instant, read back from Rust
[cursor] capture on=false ok=… […]         the front end released the native capture
[cursor] intent visible=… want->… […]       WHO ordered what shape (the front end's cursor_intent)
[cursor] apply clip=… shape=… forced=… […] the 8 ms reconciler really changing something (budgeted)
[cursor] focus GAIN  before=/after =[…]      Rust: the window came back
[cursor] wingain t0/t120/t500/t1500 …        the front end's timeline after the regain (3 per 2 s max)
```

Decoding - what the last `RUST`/`apply` line says about the moment you SAW no cursor:
```
want=2 relative=false showing=false   the front end ORDERED hidden with no capture: read the
                                      [cursor] intent line just above and the locked=/free=/modal=
                                      fields of the JS line that caused it (that is a real bug)
want=1 relative=false showing=false   nobody asked for hidden and we hold no clip, so the NULL cursor
                                      is CHROMIUM's (its cached shape answers WM_SETCURSOR): a
                                      computed=none here is a CSS bug, computed=default is the case below
showing=true and still invisible      the state is right and the desktop did not REPAINT the overlay
                                      (the "only appears after I move the mouse" report). enforced= counts
                                      our pushes; under=other means the pointer is over another process,
                                      where nothing we push can matter at all
```

Report back: the `boot.log` block around the Win press, plus whether the cursor was visibly gone at the
moment the last `RUST` line said `showing=true`.

AFTER the arrow guard and the CSS nudge (P1.60 - the invisible cursor after the Win key). The check is
smooth: enter a world (captured), press Win, and **watch the cursor while the pointer is NOT moved**.
```
(1) the cursor must stay VISIBLE on the Start menu and must not blink; move it afterwards - it must
    still be visible (this is the case that used to need the movement to come back)
(2) boot.log must show, right after the Win press:
      [cursor] focus LOST  after =[… shape=Arrow … showing=true …]   <- the arrow is back IN THE SAME CALL
      [cursor] JS nudge [… winlost] auto -> default                  <- the CSS two-step
      [cursor] intent visible=true want->1 […]
    and in debug.log the RAWMON line of that second must read desired=1 showing=1 (it used to sit at
    desired=1 showing=0 for four windows). If `showing` stays 0, look at `[cursor] apply …` lines: a
    repeating `forced=true` means the guard is pushing and the system keeps refusing (tell me, that is a
    different disease); NO apply lines at all means the guard was not armed
(3) on the way back in, the focus gain must log `[cursor] refresh sent=true` - it used to be silent
    because the ownership test compared PROCESS ids while the window under the pointer belongs to
    WebView2 (a different process). `sent=false` means the pointer is genuinely over another app
(4) while playing (captured), nothing new may appear: no nudge lines (the nudge must refuse to run while
    we hold the mouse) and no `[cursor] apply … forced=true` storm
```

AFTER the crosshair on hand-back (P1.62g). The report was "pressing Win no longer centres the cursor" - the
cursor became visible wherever the physical mouse had left it:
```
(1) play (mouse captured), press Win: the pause menu comes up and the cursor must appear ON THE CROSSHAIR.
    boot.log shows it as an `apply … warp=true` line whose `pos=` is the client centre, with the move done
    while `showing=false`
(2) Alt+Tab away and back: same
(3) ESC (explicit release) must still centre (it always did - that path keeps the shape Hidden until the
    reconciler plans the Arrow)
(4) while HOLDING the title bar (a capture request, or a release) the pointer must still NOT be moved - the
    hand-back warp refuses a pointer outside our window
```

AFTER the QUERIED session check (P1.62f - the entry asks instead of trusting the push). The report was "if I
do not move it, it does not pause; the moment I move, it pauses", with boot.log saying `window session
moving=true` 158ms before the entry captured anyway:
```
(1) hold the title bar (do not move it) and enter a world: the pause menu must come up, and debug.log must
    read `WORLD entered while the window is being moved/resized -> pause menu (no capture) [moving=true …]`
    - `moving=true` is the QUERIED value; if it is `false` while `pushed=true`, the query is the problem
(2) the same for a held border (resize)
(3) `WINSESSION pushed moving=…` must appear in debug.log for each press/release; compare its timestamp with
    the platform's own `[cursor] window session moving=…` in boot.log - they should be milliseconds apart. A
    large gap (or a missing line) is a delivery problem, not a policy problem
(4) release and click Resume: it must capture normally (the session is over)
```

AFTER the held-window entry (P1.62e - a hand on the frame starts paused). The report was "hold the title bar,
enter, let go: it does not pause; it pauses only once I move". Walk:
```
(1) HOLD the title bar (mouse button down, do not move) and enter a world: the pause menu must come up as
    soon as the loading finishes, with NO capture at all (debug.log: `WORLD entered while the window is being
    moved/resized -> pause menu (no capture)`, and no `LOCK request [world entered]`); boot.log must show
    `[cursor] window session moving=true` from the press and `moving=false` when you let go
(2) the same with a BORDER (resize) held
(3) drag the window at some point DURING the loading and let go before it finishes: the entry must still
    start PAUSED (`the window was moved during loading` in the log line)
(4) hold the frame and click Resume from the pause menu with the other hand? Impossible - the click needs the
    window - but a Resume click right after letting go must capture (the session is over by then)
(5) the lock manager's new refusal: with the window being moved (hold the title bar), any path that asks for
    the mouse - closing the backpack, the world entry - must log `LOCK skipped […]: the window is being moved
    or resized` and NOT fall back to `requestPointerLock`
```

AFTER the window-rect clip (P1.62d - the clip must contain the pointer). The one to walk first:
```
(1) START A DRAG AND ENTER A WORLD IN THE MIDDLE OF IT (grab the title bar, then click Singleplayer/Resume
    while the window is still held): the window must NOT jump. `boot.log` must show the capture's clip as
    the WINDOW rect - `clipped=(…)` clearly larger than the client - and the pointer position must be
    IDENTICAL in the `before=` and `after=` traces of the `capture on=true` line. A few px of difference is
    the P1.62d bug (6px was reported)
(2) play normally: the clip is the client area again (the sentinel tightens it within a tick), the pointer is
    hidden, nothing is centred and nothing drifts
(3) the standing ones: pause menu lands on the crosshair (one `warp=true` while hidden), drag/resize does not
    tow and pauses, and no `native refused, falling back to requestPointerLock` in debug.log
```

AFTER the client-area clip (P1.62c - the capture no longer centres, and a capture request is never refused).
This is the one to walk first, because it is the behaviour the whole arc was aiming at:
```
(1) enter a world and play: the pointer is hidden and the view turns from raw deltas - WHERE the invisible
    pointer sits must not matter at all, and nothing may ever yank it to the middle
(2) open the pause menu: the cursor must land on the crosshair (the hidden -> visible warp). `boot.log`
    shows it as ONE `apply … warp=true` line with the pointer already moved while `showing=false`
(3) enter a world again WHILE the pointer is on the title bar or a border (drag the window a little first,
    then click Singleplayer/Resume): `boot.log` must show `capture on=true ok=true` - never
    `MOUSE CAPTURE native refused, falling back to requestPointerLock` in debug.log. A fallback means the
    native capture refused a pointer that was outside the window, which is the P1.62b bug
(4) drag/resize the window while captured: no tow, no view turn, pause menu on the way out (P1.62/62b lines:
    `capture dropped: the pointer left the client`)
(5) the standing ones: the backpack, ESC/Resume, fullscreen<->windowed (must NOT pause), Alt+Tab and the
    Win key (cursor visible, no flash)
```

AFTER the window-session guard (P1.62 - dragging/resizing the window towed the cursor). In a world, with
the mouse captured:
```
(1) DRAG THE TITLE BAR: the pointer must not be pulled anywhere, the view must not turn, and the pause menu
    must come up (that is onWinGeometry's existing behaviour). Before this, the cursor was towed by the
    window and the view yanked once
(2) DRAG A BORDER / CORNER TO RESIZE: same - no yank, no view turn; the window must resize normally (a
    stale 1px clip would freeze the pointer and make the drag impossible, which is why the session RELEASES
    it rather than leaving it alone)
(3) boot.log must show, once per session, `[cursor] window session -> clip released [...]` and NOT a single
    `apply clip=Some(...)` line between the start and the end of the drag; `reclip` is skipped for the whole
    session
(4) after the drag: the cursor must be visible (the arrow guard was armed but not ticked) and the pause
    menu's Resume must capture again with one LOCK request. `boot.log` should carry exactly one
    `[cursor] capture dropped: the pointer left the client [...]` per drag and NO `apply clip=Some(...)`
    line with a moving rectangle: that clamp is the tow. If a drag still tows the pointer, that line is
    what tells us WHERE the capture was still alive
(4b) the case the log exposed: start a drag while a world is ENTERING (the entry 's `LOCK request [world
    entered]` can land right after the geometry release). The capture must be dropped within a tick, the
    pause menu must be up, and the pointer must not be towed - the 4-second, 324-px-at-a-time walk in the
    P1.62b log is the bug
(4c) fullscreen <-> windowed from the settings panel still must NOT pause: the windowed client stays centred
    on the screen, so the parked pointer is still inside it (a drop only happens when it is genuinely outside)
(5) the suppressed case - switch fullscreen/windowed from the settings panel: no pause, no yank, and the
    clip must follow the new geometry (the pointer is inside the new client, so rule 2 keeps it put)
(6) Aero Snap (drag the title bar to a screen edge and release): same as (1), and the clip must be right
    afterwards
```

AFTER the CENTRE DEBT (P1.71 - the centring is OWED when it cannot be done invisibly). This supersedes the
P1.70 expectations for Win+; and Win+L: the report was "Win+L still does not centre, and Win+; shows the
cursor and THEN moves it to the middle". Both are the same mistake - a move was issued at a moment it could
not be invisible (a background window for Win+L, a cursor somebody else is drawing for Win+;) - so the move
is DEFERRED to the first moment the system reports no cursor displayed at all. Enter a world (captured):
```
(1) Win+L, then unlock (this is THE case): the pause menu must come up with the cursor ON THE CROSSHAIR, and
    it must never sit in a corner. boot.log must show, in this order: `foreground LOST (measured)`; one
    `[cursor] we owe a centring: the hand-back could not be centred here (P1.71)` (its trace ends `debt=true`);
    `foreground REGAINED (measured)`; then ONE `apply … warp=true` whose `pos=` is the client centre - with
    `showing=false` on that line, which is what proves the move happened while nothing was displayed
(2) Win+; (the emoji/symbol overlay) and Win+.: the cursor must sit STILL where it was when the menu appeared
    (NO jump to the middle) - the debt is owed, not paid, because the overlay is still drawing a cursor
    (`showing=true`). boot.log: the `cannot hide the cursor (an overlay is showing it)` line, then
    `we owe a centring … debt=true`, and NO `warp=true`, because there is no invisible moment while the
    overlay is up. If the overlay closes and the system reports no cursor on a later tick, ONE `warp=true`
    appears then - and the cursor must not visibly move at that instant
(3) ESC -> pause menu, Resume -> capture -> ESC again: still centred IMMEDIATELY (this path is a hand-back
    while we ARE the foreground, so nothing is deferred). The regression tells: no `we owe a centring` line on
    this path, and `warp=true` on the same tick as the release
(4) the debt must never fire into a running session: after (1) or (2), press Resume and play for a few
    seconds - nothing may move the pointer, and `debt=` must go back to `false` (boot.log's first
    `capture on=true` after the pause clears it)
(5) the case that must never move: HOLD THE TITLE BAR (or a border) and release - `user_holding=true`, so no
    warp and no debt (`we owe a centring` must NOT appear). Same for a drag/resize drop
(6) the standing ones: drag/resize never tows the pointer, the backpack opens with a visible centred cursor,
    fullscreen <-> windowed does not pause, and while captured nothing new appears in the log
```
Report back: for Win+L the `foreground LOST/REGAINED` block with the `apply … warp=` line between them, and
for Win+; whether any `warp=true` line appears at all.
```

AFTER NATIVE-ONLY (P1.72 - the Pointer Lock API is gone; one mechanism, MC-style). There is nothing new to
learn here, and that is the point: every check below should behave exactly as it did, and the FAILURES are
the interesting ones. The engine now captures the mouse itself (ClipCursor + a hidden cursor) and takes the
view from raw input; `requestPointerLock` no longer exists anywhere, so the browser can no longer unlock,
cooldown, or move the cursor back on its own. Start by confirming the mechanism is up: `debug.log` must
contain `RAWINPUT listener started` and `RAWINPUT active=true` (once per run).
```
(1) the basics must be untouched: enter a world -> the cursor is hidden and the view turns; ESC -> pause menu
    with the cursor ON THE CROSSHAIR; Resume -> captured again with ONE `LOCK request [menu resume]` /
    `MOUSE CAPTURE on (native ClipCursor; browser pointer lock not used)` and NO `LOCK rejected … retrying`
(2) **ESC is a plain key now** (this is the visible change): press ESC in a world and the pause menu must
    open on the FIRST press, with no `esc`-synthesised key event in the log. A key bound to Escape (the bind
    panel refuses ESC, so nothing to rebind) and ESC inside a settings sub-page keep walking the ladder
    exactly as before
(3) **the screen edge must not freeze the view**: hold the mouse against any window edge and keep pushing —
    the view must keep turning (deltas are WM_INPUT). If it freezes, look at `RAWMON … wmIn=` in debug.log:
    `wmIn=0` means WM_INPUT is not being delivered, which is the one state this design cannot survive (the
    game then refuses to capture: `MOUSE CAPTURE refused: raw input is not running`)
(4) **the menu key must not flash the cursor**: with the mouse captured, press the menu/Apps key and
    Shift+F10 — the cursor must not blink, and no window menu may appear. `MENU HOOK installed` in debug.log
    is the happy case; `MENU HOOK NOT installed` means the hook failed (fail open, a flash is expected)
(5) the standing cursor set: Win-key -> pause menu with the cursor centred and no blinking; Win+L + unlock ->
    centred on the return; Win+; -> no jump; Alt+Tab away and back -> cursor free, world paused, no
    auto-recapture; drag/resize the title bar -> no tow, the pause menu comes up
(6) the backpack (E) opens with the cursor visible and closing it recaptures; the settings panel's
    fullscreen <-> windowed still does NOT pause; F3 panel and the hotbar are unaffected
(7) `LOCK skipped […]: window is not foreground` / `the window is being moved or resized` are still the only
    two refusals of a capture request; there must never be a `falling back to requestPointerLock` line (it
    does not exist any more)
```

AFTER the centre lock and the raw buttons (P1.76 - the two things Minecraft does). Enter a world (the mouse is
captured) and check, in this order:
```
(1) **THE POINTER MUST NOT MOVE AT ALL.** While captured, push the mouse around as hard as you like - the
    pointer is pinned by `ClipCursor` to a **1x1 px box on the crosshair** (SDL's `relative_mode_center`; 5x1
    only over a remote desktop), so the view turns (raw deltas) and the pointer stays put. Not even the clip
    rect moves: `boot.log`'s `clipped=` is the same one-pixel box all session, and the `pos=` values stop
    changing entirely (they used to roam the whole client area, and with the 3x1 box of P1.76 they still slid
    1 px). If you can see ANY movement, report the `clipped=` value from boot.log
(2) **Win+L, then unlock (P1.78 - this one changed again):** after the unlock the cursor behaves as it does in
    any other Windows application - **Windows may keep it hidden until you move the mouse**, and we no longer
    force it to appear (the injected-input repair of P1.73 is deleted; `boot.log` must NOT contain
    `the arrow is SET but not displayed -> nudging the overlay` any more). Whatever Windows does here is the
    expected result, and the pause menu's cursor must be usable as soon as it is shown
(2) **Win+; / Win+.**: the overlay shows ITS cursor - and it now appears ON THE CROSSHAIR and cannot be moved
    either (it is the system cursor, and the system cursor is inside our box). The game does NOT pause, the
    view still turns, and boot.log keeps saying `an overlay is showing the cursor: keeping the capture and
    pausing nothing (P1.75)`
(3) **BREAK/PLACE MUST WORK WITH THE PANEL IN FRONT** (this is the point of the raw buttons): with Win+; open,
    left-click and right-click - blocks must break and place, because the buttons now come from the raw device
    stream rather than from a DOM event the panel swallowed. debug.log's `RAWMON … btn=` counts them (0 while you
    click = the parse is not reaching us)
(4) no double counting: with the mouse FREE (a menu open, the pause menu up) the buttons must behave exactly as
    before - one click, one action - because the DOM path owns them there. The switch is by state: raw while
    captured, DOM while free
(5) no stuck button: hold the LEFT button (breaking), then open the backpack / press ESC / lose focus - and
    Resume. The block must NOT keep breaking by itself (a handed-back mouse clears its held mouse binds)
(6) the standing set: ESC -> pause menu (the pointer was already on the crosshair, so nothing may move), Resume,
    the backpack (E), fullscreen <-> windowed must not pause, drag/resize the title bar -> no tow and the pause
    menu comes up, Win+L -> nothing moves on the unlock
```

AFTER the two switches the report asked for (P1.75 - Win+L no longer centres, and Win+; no longer pauses).
This SUPERSEDES the centring expectations of P1.73/P1.74 below: the centring a hand-back performs now happens
ONLY while we are in front (the deliberate release: ESC, Resume, the backpack), and the overlay keeps the mouse
instead of handing it back. Enter a world (the mouse is captured) and then:
```
(1) Win+; (or Win+.) - THE reported case: **the game must NOT pause.** The overlay shows its own cursor over the
    screen, the world keeps running, the view keeps turning (raw deltas do not care where the cursor is), and
    boot.log shows `an overlay is showing the cursor: keeping the capture and pausing nothing (P1.75)` (at most
    one per 500 ms) with **NO** `capture dropped` and **NO** `capture-lost`-driven pause. Nothing jumps to the
    middle. When the overlay closes, play carries on as if nothing had happened
(2) Win+L, then unlock: the cursor must NOT be moved to the crosshair any more - it stays wherever it was (the
    report's choice: the move is not worth the delayed jump it used to cause). boot.log must show `foreground
    LOST` → `foreground REGAINED` with **NO** `apply … warp=true` in between and **NO** `we owe a centring` line.
    If the unlock leaves the cursor invisible, the `the arrow is SET but not displayed -> nudging the overlay`
    repair still runs (that part is untouched)
(3) Alt+Tab away and back: same - nothing moves, nothing is owed. The world is paused after the blur (that is
    the focus policy, not the cursor) and Resume recaptures and parks the pointer on the crosshair once
(4) ESC → pause menu, and Resume → capture → ESC again: **this is now the only way a hand-back centres** - the
    cursor must land on the crosshair at once, and boot.log must show exactly one `apply … warp=true pos=(client
    centre)` on the release tick. After the menu is up the mouse must move freely (no second warp)
(5) the standing set: drag/resize the title bar → no tow, the pause menu comes up, the cursor is NOT yanked; the
    backpack (E); fullscreen <-> windowed must not pause; while captured nothing new appears in the log
```

AFTER the hand-back centring (P1.73 - historical; see P1.75 above for what replaced it). The report was "the
cursor is visible but not on the crosshair, and clicking puts it back on the crosshair". Enter a world and then:
```
(1) Win+; (the emoji/symbol overlay) - the pause menu comes up and the cursor is left exactly where the overlay
    left it: the move is visible there, because the cursor on screen belongs to the overlay
(2) Alt+Tab away: the hand-back centred it right there, while the window was still in the background
(3) Win+L, then unlock: after the unlock the cursor was on the crosshair, and `the arrow is SET but not displayed
    -> nudging the overlay (P1.73)` forced Windows to DRAW it when it refused (at most one per 500 ms)
(4) ESC → pause menu, Resume → capture → ESC again: centred at once
(5) the standing set: drag/resize the title bar → no tow; the backpack (E); fullscreen <-> windowed must not pause
```

---

## Resource pack reload (P1.49ab) — F7, or a pack toggle in the settings panel

The chain used to be read once at boot, so a pack change needed a restart. It can now be re-run while the
game is running, the MC way: rescan -> re-run the content phase -> drop the derived caches -> mark the
world's chunks stale (they are re-meshed at the per-frame budget, not in one hitch).

**A. At the main menu (no world needed)**
1. Start the game and let the main menu appear.
2. Look at `game\logs\debug.log`: line 1 is `PACKS installed: ... files=N`, and the boot prints
   `PALETTE <n> block(s) numbered, <k> added`.
3. Create a file the chain did not have: `game\resourcepacks\VoxelEngineNWWebrp\assets\voxel\lang\fr.json`,
   containing `{"main.single": "Solo"}` (save it as UTF-8 **without** a BOM — a BOM makes `JSON.parse`
   fail and the layer is ignored, which is itself worth seeing once).
4. Press **F7**. Expected: the loading screen appears with four stages
   (`重新扫描资源包…` / `重建语言与方块表…` / `应用新资源包…` / `重画区块…`), then a toast
   `pack reload OK — PACKS installed: ... files=N+1; I18N ... fr=1; BLOCKREG ...; palette ...; M chunk(s) marked stale`.
5. The log gets one `PACKS reloaded #1: ...` line with the SAME summary. `files` and the language list are
   the proof that the folders were re-read (this was verified by hand: `files=12 ... zh/en/ja/fr` at boot
   became `files=13 ... zh/en/ja/de=1/fr=2` after a reload that ran while a new `de.json` was created).
6. **Failure path**: put a deliberately broken `data/blocks.json` (`{ this is not json`) in a pack, press F7.
   Expected: the toast says `pack reload FAILED — ...`, the log says the previous chain is still in force,
   and the game keeps running on the OLD chain (nothing is half-applied).

**B. In a world (the part that proves the world is not rebuilt)**
7. Enter a world and walk around until the chunks are meshed.
8. Edit a texture a visible block uses (e.g. `assets/voxel/textures/block/grass_block_top.png` in a pack),
   then press **F7**. Expected: the loading screen comes and goes, the toast reports
   `N chunk(s) marked stale` with N > 0, and the blocks change appearance over the next second or two
   (`chunk.stream` rebuilds `MESH_BUDGET_PER_FRAME` = 24 per frame) — the player keeps walking, nothing
   freezes, and the position/inventory are untouched.
9. Add a block to a pack's `data/blocks.json`, F7, then look in the backpack: the new block is there and
   placing it puts the right texture in the world (the palette MERGES, so the blocks already placed keep
   their numbers — that is the MC lesson this copies, see `VoxelWorld.mergePalette`).

**B2. The main menu background (the case that shipped broken)**

The sample pack ships `backgrounds/background.json` with `mode: panorama`, and the backdrop used to be decided
once at wiring time — so a reload left the old picture up and never showed the new one. It is re-derived now.

- At the main menu, note the background (the spinning panorama).
- While the game runs, edit
  `game\resourcepacks\VoxelEngineNWWebrp\assets\voxel\textures\backgrounds\background.json` to
  `{"mode": "static"}`, then press **F7**. Expected: the log gets
  `PACKS menu backdrop re-derived: kind=static`, and the panorama is replaced by the pack's
  `backgrounds/mainmenu.png` — the old panorama must NOT stay behind it.
- Switch it back to `{"mode": "panorama"}` and press **F7** again: the image goes away and the panorama
  comes back (its scene is rebuilt lazily, from the new chain).
- Still in `panorama`: edit `panorama.png` (or drop in a pack that ships a different one) and press **F7** —
  the panorama changes, and the previous scene is disposed (no leaked texture per reload).
- Switch every pack off in the settings panel so nothing supplies `background.json`: the backdrop must fall to
  the magenta/black checkerboard — no stale image, no black hole.

**C. The settings toggle**
10. Pause menu -> Settings -> Resource Packs: switch one off. Expected: the choice is saved AND a reload
    starts at once (the note under the list says so; it used to say "after a restart"), so the pack's
    textures/language are gone without relaunching.


**D. Inventory icons + files added/removed inside a pack (P1.49ac)**

- Enter a world, look at the hotbar icons, then change one of those blocks' textures in a pack
  (`assets/voxel/textures/block/...png`) and press **F7**: the hotbar/backpack icons must change too (they are
  re-baked — one checker frame is expected while the bake runs), and the log must show
  `chain gen N` + `inventory memory cleared (36 slot signature(s))`.
- Add a file to a pack (e.g. a new `textures/block/x.png`) and press F7: the reload summary's `files=` goes up
  by one. Remove it, press F7 again: `files=` goes back down.
- Add a BLOCK to `data/blocks.json`, press F7: the block is placeable and draws (the palette merges), but it
  does NOT appear in the hotbar — that is deliberate (the starting stack set is seeded at spawn; MC needs a
  creative inventory for the same reason).
- Open Settings -> Resource Packs, keep that page OPEN, press **F7** (or toggle a pack): the rows and their
  file counts must refresh instead of showing the previous chain's numbers.
**F3+T equivalent / gotcha**: F7 is handled by `ui.navigation` like the hot-plug keys, so it works at the
main menu too. Synthetic keys sent from another process (SendKeys) do NOT reach the WebView — press it on
the real keyboard.
