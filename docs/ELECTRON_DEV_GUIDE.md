# PortolanCAST Desktop — Quick Start Guide

## Overview

PortolanCAST Desktop wraps the web app in an Electron shell so you can run it by double-clicking an icon. During development, **dev mode** uses your live source code — no rebuild needed after code changes.

---

## Running in Dev Mode (Daily Development)

### Prerequisites (one-time)

| Tool | Version | Check | Install |
|------|---------|-------|---------|
| Python | 3.10+ | `python --version` | [python.org](https://www.python.org/downloads/) |
| Node.js | 18+ | `node --version` | [nodejs.org](https://nodejs.org/) |
| PortolanCAST deps | — | `pip list` | `pip install uvicorn fastapi python-multipart jinja2 pymupdf pillow` |

### First-time setup

```cmd
cd C:\Users\User1\ClaudeProjects\PortolanCAST\electron
npm install
```

### Launch (every time)

Open **Command Prompt** (Win+R → `cmd` → Enter):

```cmd
cd C:\Users\User1\ClaudeProjects\PortolanCAST\electron
set ELECTRON_DEV=1
npx electron .
```

That's it. You'll see a splash screen, then the PortolanCAST UI opens.

### After code changes

1. Close the app: **Ctrl+C** in the cmd window
2. Run again: `npx electron .` (no rebuild needed)
3. `ELECTRON_DEV=1` stays set for the life of your cmd session

---

## How It Works

```
Electron main process (main.js)
  ├─ 1. Finds a free TCP port
  ├─ 2. Shows splash screen (Ship of Theseus + spinner)
  ├─ 3. Spawns: python main.py --port {port} --no-reload
  ├─ 4. Polls GET /api/health until 200 OK
  ├─ 5. Opens BrowserWindow → http://localhost:{port}/
  └─ 6. On quit: graceful shutdown (SIGTERM → 3s → force kill)
```

**Dev mode** (`ELECTRON_DEV=1`): Electron spawns `python main.py` from your source folder.

**Production mode** (default): Electron spawns the PyInstaller-frozen binary from `resources/portolan-server/main.exe`. Only works inside an installed app.

---

## Data Directory

User data (projects, database, photos) is stored separately from app code:

| Mode | Data Location |
|------|---------------|
| Dev mode | `%APPDATA%\portolancast\data\` |
| Installed app | `%APPDATA%\PortolanCAST\data\` |
| CLI (`python main.py`) | `PortolanCAST\data\` (project folder) |

This location is set by `PORTOLANCAST_DATA_DIR` environment variable. The Electron wrapper sets it automatically.

---

## Building the Installer

For distributing to users who don't have the source code. See [electron/INSTALL_GUIDE.md](../electron/INSTALL_GUIDE.md) for full details.

### Quick build (Windows)

```cmd
cd C:\Users\User1\ClaudeProjects\PortolanCAST

REM Step 1: Freeze Python backend
python -m PyInstaller electron\pyinstaller.spec --distpath electron --workpath build\pyinstaller --clean --noconfirm

REM Step 2: Generate icon (if not already done)
cd electron
python generate-icons.py

REM Step 3: Build installer
npm install
npm run build:win
```

Output: `electron\dist\PortolanCAST Setup 1.0.0.exe`

### Requirements for building

- **Native Windows Python** (not WSL) — PyInstaller creates binaries for the platform it runs on
- **Windows Developer Mode enabled** — Settings → System → For Developers → Developer Mode → On
- All Python runtime deps installed: `pip install uvicorn fastapi python-multipart jinja2 pymupdf pillow pyinstaller`

---

## Troubleshooting

### App shows splash screen but never opens

The health check is waiting for the backend. Common causes:

1. **`ELECTRON_DEV=1` not set** — without it, Electron looks for the frozen binary (which doesn't exist in dev)
2. **Orphan Python process** from a previous run:
   ```cmd
   taskkill /IM python.exe /F
   ```
   Then try again.

### "Backend did not respond within 90s"

Same as above — kill orphan processes and make sure `ELECTRON_DEV=1` is set.

### PowerShell doesn't work

`set ELECTRON_DEV=1` is cmd.exe syntax. In PowerShell, use:
```powershell
$env:ELECTRON_DEV="1"
npx electron .
```

Or just use cmd.exe — it's simpler.

### "npx electron" does nothing / errors

Make sure you include the dot: `npx electron .` — the `.` tells Electron to run the app in the current directory.

### Port conflict

The app automatically finds a free port, so conflicts are rare. If you see errors about ports, kill any orphan processes:
```cmd
taskkill /IM python.exe /F
taskkill /IM main.exe /F
```

---

## File Structure

```
electron/
├── main.js              ← Electron main process (port, spawn, health, windows)
├── preload.js           ← Secure IPC bridge (version only)
├── splash.html          ← Startup splash screen (Ship of Theseus)
├── package.json         ← Electron + electron-builder config
├── pyinstaller.spec     ← PyInstaller build specification
├── build.bat            ← Windows build script
├── build.sh             ← Linux build script
├── generate-icons.py    ← Icon generator (Pillow)
├── INSTALL_GUIDE.md     ← Full build guide with lessons learned
├── build/
│   └── icon.ico         ← App icon (multi-resolution)
├── portolan-server/     ← PyInstaller output (gitignored)
└── dist/                ← Installer output (gitignored)
```
