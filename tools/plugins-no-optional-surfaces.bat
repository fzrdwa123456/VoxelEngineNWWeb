@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\plugins.json" echo {"plugins":[{"id":"ui-debug","enabled":false},{"id":"ui-toast","enabled":false},{"id":"ui-keybind","enabled":false},{"id":"ui-inventory","enabled":false},{"id":"ui-crosshair","enabled":false}]}
echo [plugins] ALL FIVE optional surfaces OFF: no F3/F4 debug surface, no HUD message, no key bind page,
echo [plugins] no hotbar, no backpack and no crosshair. The crosshair is a PLUGIN element since P1.48.
type "%PACK%\plugins.json"
echo [next]    start the game; the log should say: PLUGIN installed 7/12 ...
pause
