@echo off
title PortolanCAST Launcher

REM ============================================================
REM  PortolanCAST — Windows Desktop Launcher
REM
REM  WSL2 runs in a VM with its own IP that changes on reboot.
REM  Windows cannot reach WSL ports directly due to the VM
REM  network boundary. This script handles all of that:
REM
REM    1. Gets the current WSL2 IP dynamically
REM    2. Starts the FastAPI server in WSL
REM    3. Starts a TCP relay: Windows localhost:8000 → WSL:8000
REM    4. Opens http://localhost:8000 once the server is ready
REM
REM  SETUP: Copy this file to your Windows Desktop and double-click.
REM  REQUIRES: WSL2 with PortolanCAST cloned to the path below.
REM ============================================================

REM Get the current WSL2 IP address (changes on every reboot)
for /f "tokens=1" %%i in ('wsl hostname -I') do set WSL_IP=%%i
echo WSL2 IP: %WSL_IP%

REM Check if PortolanCAST is already running in WSL
wsl bash -c "ss -tlnp | grep -q ':8000'" >nul 2>&1
if %errorlevel% == 0 (
    echo PortolanCAST already running — opening browser...
    start http://localhost:8000
    exit /b 0
)

REM Start the FastAPI server in WSL (new visible window — this is your server log)
echo Starting PortolanCAST server...
start "PortolanCAST Server" wsl bash -c "cd ~/projects/PortolanCAST && venv/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000"

REM Start TCP relay: Windows localhost:8000 → WSL IP:8000
REM Runs hidden in background. No admin rights required.
echo Starting port relay localhost:8000 ^→ %WSL_IP%:8000 ...
start "PortolanCAST Relay" powershell -WindowStyle Hidden -Command ^
    "$ip='%WSL_IP%';" ^
    "$l=New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback,8000);" ^
    "try{$l.Start()}catch{exit 1};" ^
    "while($true){try{" ^
    "$c=$l.AcceptTcpClient();" ^
    "$u=New-Object System.Net.Sockets.TcpClient($ip,8000);" ^
    "$cs=$c.GetStream();$us=$u.GetStream();" ^
    "[System.Threading.Tasks.Task]::Run({try{$cs.CopyTo($us)}catch{};try{$us.Close()}catch{}}) | Out-Null;" ^
    "[System.Threading.Tasks.Task]::Run({try{$us.CopyTo($cs)}catch{};try{$cs.Close()}catch{}}) | Out-Null" ^
    "}catch{}}"

REM Poll WSL until the server is actually listening (up to 15 seconds)
set /a attempts=0
:waitloop
timeout /t 1 /nobreak >nul
set /a attempts+=1
wsl bash -c "ss -tlnp | grep -q ':8000'" >nul 2>&1
if %errorlevel% == 0 goto ready
if %attempts% lss 15 goto waitloop
echo WARNING: Server slow to start — opening browser anyway...

:ready
REM Brief pause to let the relay finish binding on the Windows side
timeout /t 1 /nobreak >nul
start http://localhost:8000
