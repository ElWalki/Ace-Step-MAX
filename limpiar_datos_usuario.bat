@echo off
chcp 65001 >nul 2>&1
title ProdIA pro - Limpiar datos / Clear User Data
cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║      ProdIA pro - Limpiar datos de usuario               ║
echo ║      Clear User Data                                     ║
echo ║   Elimina: base de datos, audios generados               ║
echo ║   Removes: database, generated audio                     ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo  ADVERTENCIA / WARNING: Se eliminaran todos los usuarios, canciones
echo  y audios generados / All users, songs and generated audio will be removed.
echo  Los modelos y el codigo NO se tocan / Models and source code are NOT affected.
echo.
set /p CONFIRM= ¿Confirmas? / Confirm? (s=yes/N): 
if /i not "%CONFIRM%"=="s" (
    echo  Cancelado / Cancelled.
    pause
    exit /b 0
)

echo.
echo  [1/2] Eliminando / Removing base de datos / database...
if exist "%~dp0ace-step-ui\server\data\acestep.db" (
    del /f /q "%~dp0ace-step-ui\server\data\acestep.db"
    echo       OK - acestep.db eliminada / removed
) else (
    echo       No existe / Not found, nada que borrar / nothing to remove
)

echo  [2/2] Eliminando / Removing audios generados / generated audio...
if exist "%~dp0ace-step-ui\server\public\audio\" (
    del /f /q /s "%~dp0ace-step-ui\server\public\audio\*.*" >nul 2>&1
    echo       OK - audios eliminados / removed
) else (
    echo       No existe / Not found, nada que borrar / nothing to remove
)

echo.
echo  ✓ Limpieza completada / Cleanup complete.
echo    Al iniciar la app / On next app start, a fresh database will be created.
echo.
pause
