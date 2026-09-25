@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\plugins.json" echo {"plugins":[{"id":"ui-debug","enabled":false},{"id":"ui-toast","enabled":false},{"id":"ui-keybind","enabled":false},{"id":"ui-inventory","enabled":false}]}
echo [plugins] ALL FOUR optional surfaces OFF: no F3/F4 debug surface, no HUD message, no key bind page,
echo [plugins] no hotbar and no backpack. The CROSSHAIR stays: it is the core's own HUD element.
type "%PACK%\plugins.json"
echo [next]    start the game; the log should say: PLUGIN installed 7/11 ...
pause
