@echo off
title ACE-Step Studio - Piano Roll ^& F0 Editor
echo ============================================
echo   ACE-Step Studio - Iniciando...
echo ============================================
echo.

set VENV=d:\espacios de trabajo\vscode\acestep\ACE-Step-1.5_\.venv\Scripts\python.exe
set SCRIPT=d:\espacios de trabajo\vscode\acestep\estudio\explorador_dnni.py

if not exist "%VENV%" (
    echo [ERROR] No se encuentra el entorno virtual de ACE-Step.
    echo Ruta esperada: %VENV%
    pause
    exit /b 1
)

if not exist "%SCRIPT%" (
    echo [ERROR] No se encuentra explorador_dnni.py
    echo Ruta esperada: %SCRIPT%
    pause
    exit /b 1
)

echo Verificando dependencias...
"%VENV%" -c "import numpy, soundfile, librosa; print('  numpy:', numpy.__version__); print('  soundfile:', soundfile.__version__); print('  librosa:', librosa.__version__); print('  OK - Todas las dependencias disponibles')"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Faltan dependencias. Instalando...
    "%VENV%" -m pip install numpy soundfile librosa
)

echo.
echo Abriendo ACE-Step Studio...
echo.
"%VENV%" "%SCRIPT%"
