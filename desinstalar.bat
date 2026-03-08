@echo off
chcp 65001 >nul 2>&1
title ProdIA pro - Desinstalar / Uninstall
cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║       ProdIA pro - Desinstalar / Uninstall               ║
echo ║   Elimina venv, node_modules y datos de usuario          ║
echo ║   Removes venv, node_modules and user data               ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo  Esto eliminara / This will remove:
echo    - ACE-Step-1.5_\.venv  (entorno Python / Python environment)
echo    - ace-step-ui\node_modules
echo    - ace-step-ui\server\node_modules
echo    - ace-step-ui\server\data\acestep.db
echo    - ace-step-ui\server\public\audio\*
echo.
echo  NO se eliminaran / Will NOT be removed: modelos, LoRAs, codigo fuente / models, LoRAs, source code.
echo.
set /p CONFIRM= ¿Confirmas? / Confirm? (s=yes/N): 
if /i not "%CONFIRM%"=="s" (
    echo  Cancelado / Cancelled.
    pause
    exit /b 0
)

set "ACESTEP_DIR=%~dp0ACE-Step-1.5_"
set "UI_DIR=%~dp0ace-step-ui"

echo.
echo  [1/5] Eliminando / Removing entorno Python / Python environment (.venv)...
if exist "%ACESTEP_DIR%\.venv" (
    rmdir /s /q "%ACESTEP_DIR%\.venv"
    echo       OK
) else (
    echo       No existe / Not found, omitiendo / skipping.
)

echo  [2/5] Eliminando / Removing node_modules frontend...
if exist "%UI_DIR%\node_modules" (
    rmdir /s /q "%UI_DIR%\node_modules"
    echo       OK
) else (
    echo       No existe / Not found, omitiendo / skipping.
)

echo  [3/5] Eliminando / Removing node_modules backend...
if exist "%UI_DIR%\server\node_modules" (
    rmdir /s /q "%UI_DIR%\server\node_modules"
    echo       OK
) else (
    echo       No existe / Not found, omitiendo / skipping.
)

echo  [4/5] Eliminando / Removing base de datos / database...
if exist "%UI_DIR%\server\data\acestep.db" (
    del /f /q "%UI_DIR%\server\data\acestep.db"
    echo       OK
) else (
    echo       No existe / Not found, omitiendo / skipping.
)

echo  [5/5] Eliminando / Removing audios generados / generated audio...
if exist "%UI_DIR%\server\public\audio\" (
    del /f /q /s "%UI_DIR%\server\public\audio\*.*" >nul 2>&1
    echo       OK
) else (
    echo       No existe / Not found, omitiendo / skipping.
)

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║   Desinstalacion completada / Uninstall complete         ║
echo ║   Para reinstalar / To reinstall: setup.bat              ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
pause
