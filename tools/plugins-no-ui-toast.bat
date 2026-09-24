@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\plugins.json" echo {"plugins":[{"id":"ui-toast","enabled":false}]}
echo [plugins] ui-toast OFF: no HUD message at all - no settings toasts, no multiplayer placeholder, and the
echo [plugins] hot-plug keys F8/F9/F10 report only in debug.log. Everything else is unaffected.
type "%PACK%\plugins.json"
echo [next]    start the game; the log should say: PLUGIN installed 9/10 ...
pause
