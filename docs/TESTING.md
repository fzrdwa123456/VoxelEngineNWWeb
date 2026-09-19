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
then bind something to a mouse button by clicking a keycap with no chip selected, unbind with Esc, and
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

