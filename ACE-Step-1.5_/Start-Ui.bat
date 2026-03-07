@echo off
chcp 65001 >nul 2>&1
title ACE Studio Pro - Start UI
cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║   ACE Studio Pro - New UI                                ║
echo ║   Gradio API + Backend + Pro Frontend                    ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

REM ─── Rutas / Paths ──────────────────────────────────────────
set "ACESTEP_DIR=%~dp0"
set "UI_DIR=%~dp0..\ace-step-ui"
set "PRO_DIR=%~dp0..\ace-step-ui-pro"

REM ─── Verificar Node.js / Check Node.js ──────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js no encontrado / Node.js not found.
    echo          Instala Node.js 18+ desde / Install Node.js 18+ from:
    echo          https://nodejs.org/
    pause
    exit /b 1
)

REM ─── Detectar Python / Detect Python ────────────────────────
set "PYTHON="
if exist "%ACESTEP_DIR%python_embeded\python.exe" (
    set "PYTHON=%ACESTEP_DIR%python_embeded\python.exe"
    echo  [Python] Usando python_embeded / Using embedded python
    goto :PYTHON_OK
)
if exist "%ACESTEP_DIR%.venv\Scripts\python.exe" (
    set "PYTHON=%ACESTEP_DIR%.venv\Scripts\python.exe"
    echo  [Python] Usando .venv / Using .venv
    goto :PYTHON_OK
)
python --version >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON=python"
    echo  [Python] Usando Python del sistema / Using system Python
    goto :PYTHON_OK
)
echo  [ERROR] Python no encontrado / Python not found.
pause
exit /b 1

:PYTHON_OK

REM ─── Instalar dependencias Pro UI si es necesario ────────────
if not exist "%PRO_DIR%\node_modules" (
    echo.
    echo  [Setup] Instalando dependencias Pro UI / Installing Pro UI deps...
    cd /d "%PRO_DIR%"
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install fallo / failed en Pro UI.
        pause
        exit /b 1
    )
    echo  [OK] Dependencias Pro UI instaladas / Pro UI deps installed.
) else (
    echo  [OK] Dependencias Pro UI ya instaladas / Pro UI deps already installed.
)

REM ─── Verificar backend deps ─────────────────────────────────
if not exist "%UI_DIR%\server\node_modules" (
    echo  [Setup] Instalando dependencias backend / Installing backend deps...
    cd /d "%UI_DIR%\server"
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install backend fallo / failed.
        pause
        exit /b 1
    )
)
cd /d "%~dp0"

REM ─── Obtener IP local / Get local IP ────────────────────────
set LOCAL_IP=
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do set LOCAL_IP=%%b
)

REM ─── Comprobar si Gradio ya esta corriendo ──────────────────
echo.
echo  [1/3] Comprobando Gradio API (puerto 8001)...
netstat -aon | findstr ":8001 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo  [OK] Gradio API ya esta corriendo / already running on port 8001.
    goto GRADIO_CONTINUE
)

echo  [1/3] Iniciando / Starting Gradio API (puerto/port 8001)...
start "ACE-Step Gradio API" cmd /s /k "title ACE-Step Gradio API && cd /d "%ACESTEP_DIR%" && set "ACESTEP_CACHE_DIR=%ACESTEP_DIR%.cache\acestep" && set "HF_HOME=%ACESTEP_DIR%.cache\huggingface" && "%PYTHON%" -m acestep.acestep_v15_pipeline --port 8001 --enable-api --backend pt --server-name 127.0.0.1 --config_path acestep-v15-turbo"

echo.
echo  Esperando / Waiting for Gradio to start...
set ATTEMPTS=0
set MAX_ATTEMPTS=60

:WAIT_GRADIO
set /a ATTEMPTS+=1
if %ATTEMPTS% gtr %MAX_ATTEMPTS% (
    echo  [AVISO] Gradio no respondio tras 5 min. Continuando...
    goto GRADIO_CONTINUE
)
netstat -aon | findstr ":8001 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    powershell -Command "try { Invoke-WebRequest -Uri 'http://localhost:8001/gradio_api/info' -TimeoutSec 3 -ErrorAction Stop; exit 0 } catch { exit 1 }" >nul 2>&1
    if %errorlevel% equ 0 (
        echo  [OK] Gradio API listo / ready!
        goto GRADIO_CONTINUE
    )
)
set /a SECS=%ATTEMPTS%*5
echo    ... %SECS%s esperando (intento %ATTEMPTS%/%MAX_ATTEMPTS%)
timeout /t 5 /nobreak >nul
goto WAIT_GRADIO

:GRADIO_CONTINUE

REM ─── Comprobar si Backend ya esta corriendo ─────────────────
echo.
echo  [2/3] Comprobando Backend (puerto 3001)...
netstat -aon | findstr ":3001 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo  [OK] Backend ya esta corriendo / already running on port 3001.
    goto BACKEND_CONTINUE
)

echo  [2/3] Iniciando / Starting Backend (puerto/port 3001)...
start "ACE-Step Backend" cmd /s /k "title ACE-Step Backend && cd /d "%UI_DIR%\server" && set "ACESTEP_PATH=%ACESTEP_DIR%" && set "DATASETS_DIR=%ACESTEP_DIR%datasets" && npm run dev"
echo  Esperando backend...
timeout /t 5 /nobreak >nul

:BACKEND_CONTINUE

REM ─── Iniciar Pro Frontend ──────────────────────────────────
echo.
echo  [3/3] Iniciando / Starting ACE Studio Pro (puerto/port 3002)...

REM Liberar puerto 3002 si esta ocupado
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":3002 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1
)
timeout /t 1 /nobreak >nul

start "ACE Studio Pro" cmd /s /k "title ACE Studio Pro && cd /d "%PRO_DIR%" && npm run dev"

timeout /t 5 /nobreak >nul

REM ═══════════════════════════════════════════════════════════
echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║   ACE Studio Pro - LISTO / READY                         ║
echo ╠══════════════════════════════════════════════════════════╣
echo ║                                                          ║
echo ║   Gradio API:     http://localhost:8001                  ║
echo ║   Backend:        http://localhost:3001                  ║
echo ║   ACE Studio Pro: http://localhost:3002                  ║
echo ║                                                          ║
if defined LOCAL_IP (
echo ║   LAN:            http://%LOCAL_IP%:3002                 ║
echo ║                                                          ║
)
echo ║   La UI legacy sigue disponible en puerto 3000           ║
echo ║   Legacy UI still available on port 3000                 ║
echo ║                                                          ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

echo  Abriendo navegador / Opening browser...
timeout /t 3 /nobreak >nul
start http://localhost:3002

echo.
echo  Pulsa cualquier tecla para cerrar esta ventana.
echo  (Los servicios seguiran corriendo en sus ventanas)
pause >nul
