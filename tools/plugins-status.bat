@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp"
echo --- plugins.json ---------------------------------------------
if exist "%PACK%\plugins.json" (type "%PACK%\plugins.json") else (echo (absent: the built-in default list is used = every plugin enabled))
echo.
echo --- PLUGIN lines in the log -----------------------------------
if exist "%GAME%\logs\debug.log" (findstr /C:"PLUGIN installed" /C:"is not installed" /C:"HOT-INSTALLED" /C:"HOT-UNINSTALLED" "%GAME%\logs\debug.log") else (echo (no debug.log yet: run the game once))
pause
