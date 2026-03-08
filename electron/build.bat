@echo off
REM ==========================================================================
REM PortolanCAST — Windows Build Script
REM
REM Purpose:
REM   Builds the PortolanCAST desktop app in two stages:
REM   1. PyInstaller: Freezes the Python backend into a standalone directory
REM   2. electron-builder: Packages Electron + frozen backend into an NSIS installer
REM
REM Prerequisites:
REM   - Python 3.10+ with pip (native Windows Python, NOT WSL)
REM   - Node.js 18+ with npm
REM   - All Python dependencies installed (pip install -r requirements.txt)
REM
REM IMPORTANT: PyInstaller must run on native Windows Python. WSL Python
REM produces Linux binaries that won't work on Windows.
REM
REM Usage:
REM   cd PortolanCAST
REM   electron\build.bat
REM
REM Output:
REM   electron\dist\ — contains the built NSIS installer (.exe)
REM ==========================================================================

setlocal enabledelayedexpansion

REM Navigate to project root (parent of electron\)
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."

echo === PortolanCAST Desktop Build ===
echo Project root: %PROJECT_ROOT%
echo.

REM -------------------------------------------------------------------------
REM Step 1: PyInstaller — freeze the Python backend
REM -------------------------------------------------------------------------
echo --- Step 1: Building Python backend with PyInstaller ---

cd /d "%PROJECT_ROOT%"

REM Install PyInstaller if not present
python -m pip install --quiet pyinstaller
if errorlevel 1 (
    echo ERROR: Failed to install PyInstaller
    exit /b 1
)

REM Clean previous build artifacts
if exist "%PROJECT_ROOT%\electron\portolan-server" rmdir /s /q "%PROJECT_ROOT%\electron\portolan-server"
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

REM Run PyInstaller with the spec file
REM Note: --distpath uses forward path to avoid trailing-backslash quote escaping
python -m PyInstaller "%PROJECT_ROOT%\electron\pyinstaller.spec" --distpath "%PROJECT_ROOT%\electron" --workpath build\pyinstaller --clean --noconfirm

if errorlevel 1 (
    echo ERROR: PyInstaller build failed
    exit /b 1
)

echo Backend built successfully.
echo.

REM -------------------------------------------------------------------------
REM Step 2: Electron — package the desktop app
REM -------------------------------------------------------------------------
echo --- Step 2: Building Electron app ---

cd /d "%PROJECT_ROOT%\electron"

REM Install Electron dependencies
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    exit /b 1
)

REM Build for Windows (NSIS installer)
call npm run build:win
if errorlevel 1 (
    echo ERROR: electron-builder failed
    exit /b 1
)

echo.
echo === Build complete ===
echo Output: %PROJECT_ROOT%\electron\dist\
dir "%PROJECT_ROOT%\electron\dist" 2>nul

endlocal
