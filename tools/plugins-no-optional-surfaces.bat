@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\plugins.json" echo {"plugins":[{"id":"ui-debug","enabled":false},{"id":"ui-keybind","enabled":false}]}
echo [plugins] BOTH optional surfaces OFF: no F3/F4 debug surface, no key bind page.
type "%PACK%\plugins.json"
echo [next]    start the game; the log should say: PLUGIN installed 7/9 ...
pause
