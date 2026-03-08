/**
 * PortolanCAST — Electron Main Process
 *
 * Purpose:
 *   Desktop shell for PortolanCAST. Spawns the PyInstaller-frozen Python
 *   backend, waits for it to become healthy, then opens a BrowserWindow
 *   pointing at the local FastAPI server.
 *
 * Architecture:
 *   Electron main process
 *     ├─ Spawns: portolan-server/main (PyInstaller binary) or python main.py (dev)
 *     ├─ Shows: splash.html during backend startup
 *     ├─ Polls: GET /api/health every 500ms (30s timeout)
 *     └─ Opens: BrowserWindow → http://localhost:{port}/
 *
 * Security assumptions:
 *   - Backend runs on localhost only (127.0.0.1)
 *   - No remote content loaded — web security policies apply
 *   - contextIsolation: true, nodeIntegration: false
 *   - Only the preload script bridges IPC channels
 *
 * Threat model:
 *   - Port conflicts: mitigated by dynamic port selection (bind to 0)
 *   - Orphan processes: mitigated by SIGTERM on quit + force kill after 3s
 *   - Backend crash: health poll timeout → error dialog with log path
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-03-07
 *
 * Usage:
 *   Production: electron .
 *   Dev mode:   ELECTRON_DEV=1 electron .
 */

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');

// =============================================================================
// CONFIGURATION
// =============================================================================

// How long to wait for the backend to start (ms)
// PyInstaller-frozen backends can take 30-60s on first launch (antivirus scanning, DLL loading)
const HEALTH_TIMEOUT_MS = 90_000;

// How often to poll /api/health (ms)
const HEALTH_POLL_INTERVAL_MS = 500;

// How long to wait for graceful shutdown before force-killing (ms)
const SHUTDOWN_GRACE_MS = 3_000;

// Dev mode: skip PyInstaller binary, use live Python backend
const IS_DEV = process.env.ELECTRON_DEV === '1';

// =============================================================================
// STATE
// =============================================================================

/** @type {import('child_process').ChildProcess|null} */
let backendProcess = null;

/** @type {BrowserWindow|null} */
let splashWindow = null;

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {number} */
let serverPort = 0;

/** @type {boolean} Guard against re-entrant before-quit calls */
let isQuitting = false;

// =============================================================================
// PORT SELECTION
// =============================================================================

/**
 * Finds a free TCP port by binding to port 0 and reading the assigned port.
 * This avoids conflicts with other services on the default port.
 *
 * @returns {Promise<number>} A free TCP port number
 */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

// =============================================================================
// BACKEND PROCESS MANAGEMENT
// =============================================================================

/**
 * Returns the path to the PyInstaller-frozen backend binary.
 * In production, this is inside the app's extraResources directory.
 * In dev mode, returns the path to main.py instead.
 *
 * @returns {{ command: string, args: string[] }}
 */
function getBackendCommand() {
    if (IS_DEV) {
        // Dev mode: run live Python backend directly
        // SECURITY: Only available when ELECTRON_DEV=1 is explicitly set
        return {
            command: process.platform === 'win32' ? 'python' : 'python3',
            args: [
                path.join(__dirname, '..', 'main.py'),
                '--port', String(serverPort),
                '--no-reload'
            ]
        };
    }

    // Production: use PyInstaller-frozen binary from extraResources
    const resourcesPath = process.resourcesPath;
    const binaryName = process.platform === 'win32' ? 'main.exe' : 'main';
    const binaryPath = path.join(resourcesPath, 'portolan-server', binaryName);

    return {
        command: binaryPath,
        args: ['--port', String(serverPort), '--no-reload']
    };
}

/**
 * Spawns the backend Python server as a child process.
 * Sets PORTOLANCAST_DATA_DIR to the Electron userData path so that
 * user data (projects, DB, photos) survives app upgrades.
 */
function startBackend() {
    // User data lives in the platform-appropriate app data directory:
    //   Windows: %APPDATA%/PortolanCAST/data
    //   Linux:   ~/.config/PortolanCAST/data
    const dataDir = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const { command, args } = getBackendCommand();

    console.log(`[PortolanCAST] Starting backend: ${command} ${args.join(' ')}`);
    console.log(`[PortolanCAST] Data directory: ${dataDir}`);
    console.log(`[PortolanCAST] Port: ${serverPort}`);

    backendProcess = spawn(command, args, {
        env: {
            ...process.env,
            PORTOLANCAST_DATA_DIR: dataDir
        },
        // Don't detach — we want to control the lifecycle
        stdio: ['ignore', 'pipe', 'pipe']
    });

    // Forward backend stdout/stderr to Electron console for debugging
    backendProcess.stdout.on('data', (data) => {
        console.log(`[backend] ${data.toString().trim()}`);
    });

    backendProcess.stderr.on('data', (data) => {
        console.error(`[backend] ${data.toString().trim()}`);
    });

    backendProcess.on('error', (err) => {
        console.error(`[PortolanCAST] Failed to start backend: ${err.message}`);
        dialog.showErrorBox(
            'PortolanCAST — Backend Error',
            `Could not start the PortolanCAST server.\n\n${err.message}\n\n` +
            'Please check the installation and try again.'
        );
        app.quit();
    });

    backendProcess.on('exit', (code, signal) => {
        console.log(`[PortolanCAST] Backend exited: code=${code}, signal=${signal}`);
        backendProcess = null;
    });
}

/**
 * Gracefully shuts down the backend process.
 * Sends SIGTERM first, waits up to SHUTDOWN_GRACE_MS, then force-kills.
 *
 * @returns {Promise<void>}
 */
function stopBackend() {
    return new Promise((resolve) => {
        if (!backendProcess) {
            resolve();
            return;
        }

        const pid = backendProcess.pid;
        console.log(`[PortolanCAST] Stopping backend (PID ${pid})...`);

        // Set a force-kill timer in case graceful shutdown hangs
        const forceKillTimer = setTimeout(() => {
            if (backendProcess) {
                console.log(`[PortolanCAST] Force-killing backend (PID ${pid})`);
                try {
                    // SIGKILL on Unix, taskkill on Windows
                    if (process.platform === 'win32') {
                        spawn('taskkill', ['/PID', String(pid), '/F', '/T']);
                    } else {
                        backendProcess.kill('SIGKILL');
                    }
                } catch (e) {
                    // Process may already be gone
                }
            }
            resolve();
        }, SHUTDOWN_GRACE_MS);

        backendProcess.once('exit', () => {
            clearTimeout(forceKillTimer);
            resolve();
        });

        // Graceful shutdown: SIGTERM (Unix) or taskkill without /F (Windows)
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/PID', String(pid), '/T']);
            } else {
                backendProcess.kill('SIGTERM');
            }
        } catch (e) {
            clearTimeout(forceKillTimer);
            resolve();
        }
    });
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

/**
 * Polls GET /api/health until the backend responds with HTTP 200.
 * Rejects after HEALTH_TIMEOUT_MS if the backend never becomes healthy.
 *
 * @returns {Promise<void>}
 */
function waitForHealth() {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        // Sequential polling: each poll fully completes (success, error, or
        // timeout) before the next one starts. This prevents connection flooding
        // which caused ECONNRESET on Windows when multiple concurrent requests
        // overwhelmed the TCP stack / Windows Defender inspection.
        const poll = () => {
            // Overall timeout check
            if (Date.now() - startTime > HEALTH_TIMEOUT_MS) {
                reject(new Error(
                    `Backend did not respond within ${HEALTH_TIMEOUT_MS / 1000}s`
                ));
                return;
            }

            // Backend died before becoming healthy
            if (!backendProcess) {
                reject(new Error('Backend process exited before becoming healthy'));
                return;
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[PortolanCAST] Health poll (${elapsed}s) → 127.0.0.1:${serverPort}`);

            // Track whether THIS poll has completed to prevent double-scheduling
            let pollDone = false;
            const scheduleNext = () => {
                if (!pollDone) {
                    pollDone = true;
                    setTimeout(poll, HEALTH_POLL_INTERVAL_MS);
                }
            };

            const req = http.get(
                `http://127.0.0.1:${serverPort}/api/health`,
                // 10s timeout per request — Windows Defender can delay localhost
                { timeout: 10_000 },
                (res) => {
                    // Consume body to free the socket
                    res.resume();

                    console.log(`[PortolanCAST] Health response: ${res.statusCode}`);
                    if (res.statusCode === 200) {
                        pollDone = true;
                        console.log('[PortolanCAST] Health check passed — backend is ready');
                        resolve();
                    } else {
                        scheduleNext();
                    }
                }
            );

            req.on('error', (err) => {
                // Connection refused = server not ready yet (normal during startup)
                if (err.code !== 'ECONNREFUSED') {
                    console.log(`[PortolanCAST] Health poll error: ${err.code || err.message}`);
                }
                scheduleNext();
            });

            req.on('timeout', () => {
                console.log('[PortolanCAST] Health poll timeout — destroying request');
                req.destroy();
                scheduleNext();
            });
        };

        poll();
    });
}

// =============================================================================
// WINDOWS
// =============================================================================

/**
 * Creates and shows the splash screen — a small frameless window
 * with the Ship of Theseus icon and a loading spinner.
 */
function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 400,
        height: 300,
        frame: false,
        resizable: false,
        transparent: false,
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#1a1a2e',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    splashWindow.loadFile(path.join(__dirname, 'splash.html'));
    splashWindow.once('ready-to-show', () => splashWindow.show());
}

/**
 * Creates the main application window pointing at the backend server.
 * Closes the splash screen once the main window is ready.
 */
function createMainWindow() {
    const url = `http://127.0.0.1:${serverPort}/`;
    console.log(`[PortolanCAST] Creating main window → ${url}`);

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        show: false,
        title: 'PortolanCAST',
        backgroundColor: '#1a1a2e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Diagnostic: track page load lifecycle
    mainWindow.webContents.on('did-start-loading', () => {
        console.log('[PortolanCAST] Main window: did-start-loading');
    });

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('[PortolanCAST] Main window: did-finish-load');
    });

    // CRITICAL: catch page load failures — without this, a failed loadURL
    // leaves an invisible window and no error feedback
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`[PortolanCAST] Main window load failed: ${errorDescription} (code ${errorCode}) for ${validatedURL}`);

        // Show the window with an error message rather than leaving it invisible
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }

        dialog.showErrorBox(
            'PortolanCAST — Page Load Failed',
            `Could not load the application UI.\n\n` +
            `URL: ${validatedURL}\n` +
            `Error: ${errorDescription} (${errorCode})\n\n` +
            `The backend is running but the page failed to load.`
        );
    });

    mainWindow.loadURL(url);

    mainWindow.once('ready-to-show', () => {
        console.log('[PortolanCAST] Main window: ready-to-show — displaying');
        // Close splash, show main window
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        console.log('[PortolanCAST] Main window closed');
        mainWindow = null;
    });
}

// =============================================================================
// IPC HANDLERS
// =============================================================================

// Expose app version to renderer via preload bridge
ipcMain.handle('get-version', () => {
    return app.getVersion();
});

// =============================================================================
// APP LIFECYCLE
// =============================================================================

app.whenReady().then(async () => {
    try {
        // Step 1: Find a free port
        serverPort = await findFreePort();

        // Step 2: Show splash screen
        createSplashWindow();

        // Step 3: Start the backend
        startBackend();

        // Step 4: Wait for backend to become healthy
        await waitForHealth();
        console.log(`[PortolanCAST] Backend healthy on port ${serverPort}`);

        // Step 5: Open the main window
        createMainWindow();

    } catch (err) {
        console.error(`[PortolanCAST] Startup failed: ${err.message}`);

        // Close splash if it's still showing
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
        }

        dialog.showErrorBox(
            'PortolanCAST — Startup Failed',
            `The PortolanCAST server could not be started.\n\n` +
            `Error: ${err.message}\n\n` +
            `If another instance is already running, please close it first.\n` +
            `Data directory: ${path.join(app.getPath('userData'), 'data')}`
        );

        app.quit();
    }
});

// macOS: re-create window when dock icon is clicked and no windows exist
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort > 0) {
        createMainWindow();
    }
});

// Graceful shutdown — stop backend before quitting
// Guard flag prevents re-entrant loop: before-quit → stopBackend → app.quit → before-quit
app.on('before-quit', async (event) => {
    if (backendProcess && !isQuitting) {
        isQuitting = true;
        event.preventDefault();
        await stopBackend();
        app.quit();
    }
});

// Safety net: ensure backend is killed even on unexpected exit
process.on('exit', () => {
    if (backendProcess) {
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/PID', String(backendProcess.pid), '/F', '/T']);
            } else {
                backendProcess.kill('SIGKILL');
            }
        } catch (e) {
            // Best-effort cleanup
        }
    }
});

// Quit when all windows are closed (except macOS convention)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
