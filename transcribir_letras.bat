@echo off
chcp 65001 >nul 2>&1
title Demucs + Whisper - Transcriptor / Transcriber
echo.
echo ============================================================
echo   TRANSCRIPTOR PROFESIONAL DE LETRAS / PROFESSIONAL LYRICS TRANSCRIBER
echo   Demucs htdemucs_ft + Whisper large-v3
echo ============================================================
echo.

set "PYTHON=%~dp0ACE-Step-1.5_\python_embeded\python.exe"
if not exist "%PYTHON%" (
    echo [!] Python no encontrado / not found, usando / using system python
    set "PYTHON=python"
)

echo Opciones / Options:
echo   1. Completo / Full: separar stems + transcribir / separate stems + transcribe (calidad alta / high quality, shifts=5)
echo   2. Completo / Full: calidad maxima / max quality (shifts=10, mas lento / slower)
echo   3. Completo / Full: calidad rapida / fast quality (shifts=1, rapido / fast)
echo   4. Solo separar stems / Stems only (sin transcribir / no transcription)
echo   5. Solo transcribir / Transcribe only (stems ya separados / stems already separated)
echo   6. Todo con sobreescritura / Overwrite all (calidad alta / high quality)
echo.
set /p OPCION="Elige / Choose (1-6) [1]: "
if "%OPCION%"=="" set OPCION=1

set "ARGS=--calidad alta"
if "%OPCION%"=="2" set "ARGS=--calidad maxima"
if "%OPCION%"=="3" set "ARGS=--calidad rapida"
if "%OPCION%"=="4" set "ARGS=--solo-stems --calidad alta"
if "%OPCION%"=="5" set "ARGS=--solo-transcribir"
if "%OPCION%"=="6" set "ARGS=--sobreescribir --calidad alta"

echo.
"%PYTHON%" "%~dp0transcribir_letras.py" %ARGS%

echo.
pause
