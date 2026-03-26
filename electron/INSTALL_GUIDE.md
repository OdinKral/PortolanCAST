# PortolanCAST Desktop — Installation & Build Guide

## Table of Contents
- [Quick Install (Pre-built)](#quick-install-pre-built)
- [Building from Source](#building-from-source)
- [Prerequisites](#prerequisites)
- [Step-by-Step Build](#step-by-step-build)
- [Troubleshooting](#troubleshooting)
- [Lessons Learned](#lessons-learned)
- [Architecture Overview](#architecture-overview)
- [Version History](#version-history)

---

## Quick Install (Pre-built)

If you already have a `PortolanCAST Setup 1.0.0.exe` installer:

1. Double-click `PortolanCAST Setup 1.0.0.exe`
2. Choose installation directory (or accept the default)
3. Click **Install**
4. Launch PortolanCAST from the Start Menu or Desktop shortcut

**Windows SmartScreen warning:** The app is not code-signed yet. If Windows blocks it:
- Click **More info**
- Click **Run anyway**

**Where is my data stored?**
- User data (projects, database, photos): `%APPDATA%\PortolanCAST\data\`
- This location survives app upgrades — your work is safe

---

## Building from Source

### Prerequisites

| Tool | Version | Check Command | Install |
|------|---------|---------------|---------|
| **Python** | 3.10+ (native Windows, NOT WSL) | `python --version` | [python.org](https://www.python.org/downloads/) |
| **Node.js** | 18+ | `node --version` | [nodejs.org](https://nodejs.org/) |
| **npm** | 8+ | `npm --version` | Included with Node.js |
| **Git** | Any | `git --version` | [git-scm.com](https://git-scm.com/) |

**CRITICAL:** Python must be **native Windows Python** (e.g. `C:\Python314\python.exe`), not WSL Python. PyInstaller produces binaries for the platform it runs on — WSL Python would create Linux binaries.

### Python Dependencies

Install PortolanCAST's runtime dependencies in your Windows Python:

```cmd
python -m pip install uvicorn fastapi python-multipart jinja2 pymupdf pillow pyinstaller
```

### Windows Developer Mode (Required)

electron-builder needs symlink permissions. Without this, the build fails with "Cannot create symbolic link" errors.

1. Open **Settings** (Win+I)
2. Go to **System → For Developers**
3. Toggle **Developer Mode → On**
4. Confirm the dialog

This is a one-time setting.

---

### Step-by-Step Build

#### Step 1: Clone the Repository

```cmd
git clone https://github.com/OdinKral/PortolanCAST.git
cd PortolanCAST
```

#### Step 2: Build the Python Backend (PyInstaller)

```cmd
python -m PyInstaller electron\pyinstaller.spec --distpath electron --workpath build\pyinstaller --clean --noconfirm
```

This freezes the FastAPI server into `electron\portolan-server\main.exe` — a standalone binary that doesn't need Python installed on the target machine.

**Expected output:** `Build complete!` and a `portolan-server\` directory inside `electron\`.

**Verify:**
```cmd
dir electron\portolan-server\main.exe
```

#### Step 3: Generate the App Icon

```cmd
cd electron
python generate-icons.py
```

This creates `build\icon.ico` (multi-resolution: 256, 128, 64, 48, 32, 16 px) from the Ship of Theseus brand mark.

#### Step 4: Install Electron Dependencies

```cmd
cd electron
npm install
```

Ignore deprecation warnings — they're from electron-builder's transitive dependencies and don't affect the build.

#### Step 5: Build the Installer

**Windows (NSIS installer):**
```cmd
npm run build:win
```

**Linux (AppImage):**
```bash
npm run build:linux
```

**Output location:** `electron\dist\`
- Windows: `PortolanCAST Setup 1.0.0.exe`
- Linux: `PortolanCAST-1.0.0.AppImage`

#### Step 6: Verify

```cmd
dir electron\dist\*.exe
```

---

### One-Command Build (after first setup)

Once prerequisites are installed, the full build is:

```cmd
cd \\wsl$\Ubuntu\home\odikral\projects\PortolanCAST
electron\build.bat
```

Or step by step if the batch script gives trouble:

```cmd
cd \\wsl$\Ubuntu\home\odikral\projects\PortolanCAST
python -m PyInstaller electron\pyinstaller.spec --distpath electron --workpath build\pyinstaller --clean --noconfirm
cd electron
npm install
npm run build:win
```

---

## Troubleshooting

### `'pyinstaller' is not recognized`

**Cause:** PyInstaller's script wrapper isn't on PATH.
**Fix:** Use `python -m PyInstaller` instead of bare `pyinstaller`.

### `ERROR: script 'main.py' not found`

**Cause:** PyInstaller is resolving paths incorrectly.
**Fix:** Run PyInstaller from the project root (`PortolanCAST\`), not from `electron\`.

### `Hidden import 'uvicorn.logging' not found`

**Cause:** uvicorn (or other dependencies) aren't installed in your Windows Python.
**Fix:**
```cmd
python -m pip install uvicorn fastapi python-multipart jinja2 pymupdf pillow
```

### `icon directory doesn't contain icons` / `index out of range`

**Cause:** electron-builder's icon auto-detection is buggy with certain PNG formats.
**Fix:** Use a pre-generated `.ico` file and point to it explicitly in `package.json`:
```json
"icon": "build/icon.ico"
```
Delete any `icons/` directory to prevent auto-scanning.

### `Cannot create symbolic link : A required privilege is not held`

**Cause:** Windows blocks symlink creation without admin or Developer Mode.
**Fix (recommended):** Enable Developer Mode:
- Settings → System → For Developers → Developer Mode → On

**Fix (alternative):** Run the terminal as Administrator.

### `npm error ENOENT: package.json not found`

**Cause:** You're in the wrong directory.
**Fix:** `cd electron` before running `npm` commands.

### Build succeeds but app won't start

**Cause:** Backend dependencies missing from the frozen build.
**Fix:** Ensure ALL runtime dependencies are installed in the same Python that PyInstaller uses, then rebuild:
```cmd
python -m pip install uvicorn fastapi python-multipart jinja2 pymupdf pillow
python -m PyInstaller electron\pyinstaller.spec --distpath electron --workpath build\pyinstaller --clean --noconfirm
```

### App starts but shows error dialog about backend

**Cause:** The frozen backend couldn't start (missing DLL, port conflict, etc.).
**Debug:** Run the backend standalone to see the error:
```cmd
electron\portolan-server\main.exe --port 9000 --no-reload
```
Then check `http://localhost:9000/api/health` in a browser.

---

## Lessons Learned

These lessons were discovered during the first build on 2026-03-07/08. Future developers: save yourself hours by reading this.

### 1. PyInstaller SPECPATH is a Directory, Not a File
`SPECPATH` in a `.spec` file is the **directory** containing the spec file, not the file path itself. Using `os.path.dirname(SPECPATH)` goes up one level too many. Correct usage:
```python
project_root = os.path.dirname(SPECPATH)  # electron/ → PortolanCAST/
```

### 2. Batch File Trailing Backslash Escapes Quotes
`%~dp0` always includes a trailing `\`. Inside quotes, `"C:\path\"` — the `\"` becomes an escaped quote, breaking argument parsing. Avoid using `%~dp0` inside quoted arguments. Use a variable without a trailing backslash instead.

### 3. Use `python -m` Instead of Bare Commands
On Windows, `pip`, `pyinstaller`, etc. are script wrappers in Python's `Scripts\` directory, which may not be on PATH. `python -m PyInstaller` always works if `python` works.

### 4. Batch `^` Line Continuation Is Fragile
Multi-line commands with `^` interact poorly with quoted strings. Trailing spaces get included in arguments. Put long commands on a single line instead — ugly but reliable.

### 5. electron-builder Icon Auto-Detection Is Buggy
The built-in PNG→ICO converter crashes on certain valid PNGs (`index out of range [-1]`). Pre-generate a proper `.ico` file and specify `"icon": "build/icon.ico"` explicitly in `package.json`.

### 6. Windows Developer Mode Is Required for Builds
electron-builder extracts archives containing macOS symlinks. Windows blocks symlink creation without Developer Mode or admin rights. Enable Developer Mode once — it's permanent.

### 7. PyInstaller Bundles What's Installed
If a dependency (uvicorn, python-multipart, etc.) isn't installed in the Windows Python environment, PyInstaller can't freeze it. The build may "succeed" with warnings, but the exe will crash at runtime. Install ALL runtime deps first.

### 8. Native Windows Python Required
PyInstaller produces binaries for the platform it runs on. WSL Python creates Linux binaries. Always use `C:\Python314\python.exe` (or wherever your native Windows Python lives) for the PyInstaller step.

---

## Architecture Overview

```
PortolanCAST.exe (installed via NSIS)
  └─ Electron main process (main.js)
       ├─ Finds free TCP port (bind to port 0)
       ├─ Sets PORTOLANCAST_DATA_DIR → %APPDATA%\PortolanCAST\data
       ├─ Spawns: portolan-server\main.exe --port {port} --no-reload
       │    └─ FastAPI on localhost:{port}
       ├─ Shows: splash.html (Ship of Theseus + spinner)
       ├─ Polls: GET /api/health every 500ms (30s timeout)
       ├─ Opens: BrowserWindow → http://localhost:{port}/
       └─ On quit: SIGTERM → 3s grace → force kill
```

**Data locations:**

| Content | Location | Survives Upgrade? |
|---------|----------|:-:|
| App code (Python, templates, static) | `C:\Program Files\PortolanCAST\` | No (replaced) |
| User data (projects, DB, photos) | `%APPDATA%\PortolanCAST\data\` | Yes |

**Dev mode:**

For development, skip the installer and run against the live Python backend:
```cmd
cd PortolanCAST\electron
set ELECTRON_DEV=1
npm start
```
This spawns `python main.py --port {port}` directly instead of the frozen binary.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-03-08 | Initial Electron wrapper — PyInstaller backend, NSIS installer, Ship of Theseus splash |
