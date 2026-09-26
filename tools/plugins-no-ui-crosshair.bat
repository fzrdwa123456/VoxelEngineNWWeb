@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\plugins.json" echo {"plugins":[{"id":"ui-crosshair","enabled":false}]}
echo [plugins] ui-crosshair OFF: no aiming reticle at all (a clean, HUD-less view).
echo [try]     with the game running, F5 installs and uninstalls it: the crosshair comes and goes.
type "%PACK%\plugins.json"
echo [next]    start the game; the log should say: PLUGIN installed 11/12 ...
pause
