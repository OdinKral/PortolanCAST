/**
 * PortolanCAST — Electron Preload Script
 *
 * Purpose:
 *   Exposes a minimal, secure API from the Electron main process to the
 *   renderer (web page). Uses contextBridge to avoid exposing Node.js
 *   globals to the web content.
 *
 * Security assumptions:
 *   - contextIsolation: true (default in Electron 12+)
 *   - nodeIntegration: false (default)
 *   - Only whitelisted IPC channels are exposed
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-03-07
 */

const { contextBridge, ipcRenderer } = require('electron');

// SECURITY: Only expose specific, read-only methods — no arbitrary IPC
contextBridge.exposeInMainWorld('electronAPI', {
    /**
     * Returns the application version from package.json.
     * @returns {Promise<string>} Semantic version string
     */
    getVersion: () => ipcRenderer.invoke('get-version')
});
