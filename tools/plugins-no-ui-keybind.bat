@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\plugins.json" echo {"plugins":[{"id":"ui-keybind","enabled":false}]}
echo [plugins] ui-keybind OFF: no key bind page in either menu, no rubber band. Everything else is unaffected.
type "%PACK%\plugins.json"
echo [next]    start the game; the log should say: PLUGIN installed 11/12 ...
pause
