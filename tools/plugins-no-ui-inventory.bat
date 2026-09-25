@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\plugins.json" echo {"plugins":[{"id":"ui-inventory","enabled":false}]}
echo [plugins] ui-inventory OFF: no hotbar, no backpack (E does nothing), and the crosshair stays.
echo [plugins] The hotbar is a HUD ELEMENT since P1.34: the strip is not spawned at all while this is off.
type "%PACK%\plugins.json"
echo [next]    start the game; the log should say: PLUGIN installed 10/11 ...
echo [try]     with the game running, press F11 to install it again: the hotbar must appear, with its
echo [try]     items drawn (not blank) - that is the HUD host mounting the element at a barrier, and the
echo [try]     log must say "HUD element mounted hotbar". The earlier F11 left "HUD element unmounted hotbar".
pause
