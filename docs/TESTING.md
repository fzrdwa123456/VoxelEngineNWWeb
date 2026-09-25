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
menu (it was a HUD element that did not exist yet, not a hidden one), and `E` must open nothing;
(2) press F11 -> the strip appears WITH its items drawn. A strip that comes back blank means the reconcile
cache was not invalidated when its cells were respawned (`buildHotbar` marks the hotbar range dirty);
(3) press F11 again -> the strip and the bag are gone and NOTHING is left on screen: a frozen strip is the
residue the host's deferred unmount exists to prevent (the log says `HUD element unmounted hotbar`);
(4) F11 off/on five times: no duplicated strip, no `frame error`, the selection highlight still follows the
1..9 keys, and the items are still drawn every round - this is the leak test: every round must end with
the same one strip and the same log lines;
(5) `tools\plugins-no-optional-surfaces.bat` (four surfaces off) -> `PLUGIN installed 7/11`, a plain
crosshair-only HUD, and no `PAGE`/`HUD element` mount line for the surfaces that are off.

