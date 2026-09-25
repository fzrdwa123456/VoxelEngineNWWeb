@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "DIR=%GAME%\resourcepacks\VoxelEngineNWWebrp\assets\voxel\data"
if not exist "%DIR%" mkdir "%DIR%"
> "%DIR%\blocks.json" echo {"demo":{"label":"Demo Block (from the pack)","color":"#c0392b"},"stone":{"label":"Stone (reskinned by the pack)","color":"#9aa0a6"}}
echo [blocks] wrote %DIR%\blocks.json -- one NEW block and one OVERRIDE (P1.37).
echo [next]   start the game; the log must say:
echo [next]     content: N declared language(s) [...], 7 block(s) declared from the pack chain
echo [next]     BLOCKREG registry loaded: 7 blocks -> [grass, default, missing, ruby, stone, gold, demo]
echo [next]   the inventory must show a 7th slot (a checker icon: the pack ships no texture), and the
echo [next]   tooltips must read "Demo Block (from the pack)" and "Stone (reskinned by the pack)".
echo [note]   6 blocks means the declaration did not reach the registry; 8 means the merge ran twice.
echo [undo]   delete "%DIR%\blocks.json" to go back to the six blocks the mod ships.
pause
