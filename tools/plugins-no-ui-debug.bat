@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\plugins.json" echo {"plugins":[{"id":"ui-debug","enabled":false}]}
echo [plugins] ui-debug OFF: no F3 debug panel, no F3+F4 mode chord. Everything else is unaffected.
type "%PACK%\plugins.json"
echo [next]    start the game; the log should say: PLUGIN installed 10/11 ...
pause
