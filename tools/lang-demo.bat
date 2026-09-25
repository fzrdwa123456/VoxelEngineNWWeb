@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%game\resourcepacks" (set "GAME=%HERE%game") else (set "GAME=%HERE%..\release\VoxelEngineTauri\game")
set "PACK=%GAME%\resourcepacks\VoxelEngineNWWebrp\assets\voxel\lang"
if not exist "%PACK%" mkdir "%PACK%"
> "%PACK%\fr.json" echo {"lang.fr":"Francais (FROM THE PACK)","main.single":"Solo (pack)","main.multi":"Multijoueur (pack)","main.quit":"Quitter (pack)","menu.paused":"En pause (pack)","menu.resume":"Reprendre (pack)","menu.settings":"Options (pack)","menu.back":"Retour (pack)","settings.language":"Langue (pack)"}
echo [lang]   wrote %PACK%\fr.json -- the pack now ships a FOURTH language (P1.36).
echo [next]   start the game; the log must say:
echo [next]     content: 4 declared language(s) [zh, en, ja, fr] - 1 of them from the pack chain [fr]
echo [next]     I18N dictionaries loaded (lang/*.json layered merge): zh=NN en=NN ja=NN fr=9 entries
echo [next]   then: pause menu - Settings - Language/Font -- the list must show FOUR choices, and the new
echo [next]   one is labelled "Francais (FROM THE PACK)": that label comes from the pack's OWN dictionary.
echo [next]   pick it: every menu word it defines turns into the pack's own text (Solo / Options / Retour).
echo [undo]   delete "%PACK%\fr.json" to go back to three languages. plugins-default.bat does NOT remove it.
pause
