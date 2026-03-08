# PortolanCAST Session Log — 2026-03-07

## Electron Desktop Wrapper + Installer Scaffolding

**Duration:** ~30 minutes
**Goal:** Wrap PortolanCAST in Electron so it launches as a desktop app (double-click, no terminal)

---

## What Was Built

### Architecture
```
PortolanCAST.exe (or .AppImage)
  └─ Electron main process (main.js)
       ├─ Spawns: PyInstaller-frozen Python backend
       │    └─ FastAPI on localhost:{dynamic-port}
       ├─ Shows: splash.html while backend starts
       ├─ Polls: GET /api/health every 500ms (30s timeout)
       └─ Opens: BrowserWindow → http://localhost:{port}/
```

### Files Modified
| File | Change |
|------|--------|
| `main.py` | Added `DATA_DIR` via `PORTOLANCAST_DATA_DIR` env var; replaced all `BASE_DIR / "data"` refs. Added `argparse` with `--port` and `--no-reload` flags. |
| `db.py` | `DEFAULT_DB_PATH` now honors `PORTOLANCAST_DATA_DIR` with fallback to `data/` alongside source. |
| `.gitignore` | Added `electron/node_modules/`, `electron/dist/`, `electron/portolan-server/`, `build/`, `main.spec`. |

### Files Created (electron/)
| File | Purpose |
|------|---------|
| `main.js` | Electron main process — port finder, backend spawn, splash, health poll, graceful shutdown |
| `preload.js` | Secure IPC bridge — exposes `getVersion()` only, contextIsolation: true |
| `splash.html` | 400×300 frameless window — Ship of Theseus SVG, CSS spinner, dark cockpit aesthetic |
| `package.json` | electron-builder config — NSIS (Windows) + AppImage (Linux) targets |
| `pyinstaller.spec` | One-directory mode, hidden imports for uvicorn, excludes heavy unused packages |
| `build.sh` | Linux/WSL build script (PyInstaller → electron-builder) |
| `build.bat` | Windows build script (must use native Windows Python, not WSL) |
| `generate-icons.js` | SVG→PNG (512×512) + ICO (multi-res) via sharp + png-to-ico |

---

## Key Design Decisions

### 1. Data Directory Separation
- **Problem:** PyInstaller freezes app into a read-only install directory. User data (projects, DB, photos) can't live there.
- **Solution:** `PORTOLANCAST_DATA_DIR` env var. Electron sets it to `app.getPath('userData')/data` (e.g. `%APPDATA%/PortolanCAST/data`). In dev, unset → falls back to `BASE_DIR/data`.
- **Backward compatible:** When env var is unset, behavior is identical to before.

### 2. Dynamic Port Selection
- **Problem:** Port 8000 might be in use.
- **Solution:** `net.createServer()` binds to port 0, reads `.address().port`, closes. Guaranteed free port.

### 3. One-Directory Mode (PyInstaller)
- **Why not one-file?** One-file mode extracts to a temp dir on every launch (slow startup, 5-10s). One-directory starts instantly and is easier to debug.

### 4. Graceful Shutdown
- SIGTERM → wait 3s → SIGKILL. Windows uses `taskkill` (with /T for tree kill).
- Safety net: `process.on('exit')` force-kills if `before-quit` handler didn't fire.

### 5. Dev Mode
- `ELECTRON_DEV=1 npm start` skips PyInstaller binary, spawns `python3 main.py --port {port}` directly.
- Useful for testing the Electron shell without rebuilding the frozen backend.

---

## Test Results

**1062 tests passing, 0 failures, 37 suites** — env var changes fully backward-compatible.

---

## Git History

| Commit | Description |
|--------|-------------|
| `5ff7722` | Stage 3B: Equipment Tab, Entity Modal, Ship of Theseus brand icon (31 files) |
| `9753905` | Electron desktop wrapper + installer scaffolding (11 files) |

Both pushed to `origin/master`.

---

## Next Steps

1. **Generate icons:** `cd electron && npm install sharp png-to-ico && node generate-icons.js`
2. **Dev mode test:** `cd electron && npm install && ELECTRON_DEV=1 npm start`
3. **Frozen build test:** `pyinstaller electron/pyinstaller.spec` → `./portolan-server/main --port 9000 --no-reload` → `curl localhost:9000/api/health`
4. **Full package:** `npm run build:win` → install → launch → upload PDF → verify Equipment tab
5. **Future:** Code signing (Windows SmartScreen), auto-updates, Tesseract bundling

---

## Gotchas for Future Sessions

- **PyInstaller must run on native Windows Python** — WSL Python produces Linux binaries
- **uvicorn hidden imports** — PyInstaller misses lazy imports; explicit list in spec file
- **Bundle size** — expect ~200MB+ (Python + PyMuPDF + dependencies); document in README
- **Windows SmartScreen** — unsigned exe gets blocked; "Advanced → Run Anyway" until code-signed
- **Tesseract OCR** — not bundled by default; either add to PyInstaller datas or document as optional install
