@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
if not exist "%PACK%" mkdir "%PACK%"
if exist "%PACK%\plugins.json" del "%PACK%\plugins.json"
echo [plugins] RESTORED TO DEFAULT: plugins.json deleted, so the engine uses its built-in list (all plugins on).
echo [pack]    %PACK%
echo [next]    start voxelengine-tauri.exe and look for: PLUGIN installed 10/10 ...
pause
