/**
 * PortolanCAST — Toolbar Module
 *
 * Purpose:
 *   Manages toolbar button state and connects UI controls to the viewer.
 *   Phase 0: file open, zoom controls, page navigation.
 *   Phase 1: markup tools — pen, rect, ellipse, line, highlighter, text, cloud
 *   with semantic metadata.
 *
 * Architecture:
 *   Tool buttons use data-tool attributes matched in setTool().
 *   Shape tools (rect, ellipse, line, highlighter, cloud) use mouse event
 *   handlers on the Fabric canvas: mousedown creates a shape, mousemove
 *   resizes it, mouseup finalizes. Text uses click-to-place with IText.
 *   Every created object gets markupType metadata via canvas.stampDefaults().
 *
 * Author: PortolanCAST
 * Version: 0.3.0
 * Date: 2026-02-17
 */

import { MARKUP_COLORS } from './canvas.js';

// =============================================================================
// DEFAULT HOTKEY MAP — editable via Toolbar Settings
// =============================================================================
// Key: the `e.key` value (case-sensitive — uppercase means Shift is held).
// Value: tool name matching data-tool attributes.
// System shortcuts (Ctrl+Z, arrows, etc.) are NOT in this map — they're
// hardcoded because they follow OS conventions that shouldn't be remapped.

const DEFAULT_HOTKEYS = {
    'v': 'select',
    'p': 'pen',
    'r': 'rect',
    'e': 'ellipse',
    'l': 'line',
    'h': 'highlighter',
    'g': 'hand',
    't': 'text',
    'c': 'cloud',
    'C': 'connect',         // Shift+C
    'o': 'callout',
    'w': 'polyline',
    'u': 'distance',
    'a': 'area',
    'A': 'arrow',            // Shift+A
    's': 'sticky-note',
    'i': 'image-overlay',
    'n': 'count',
    'k': 'calibrate',
    'm': 'equipment-marker',
    'x': 'eraser',
    'f': 'polygon',
    'd': 'dimension',
    'b': 'arc',
    'j': 'radius',
    'y': 'harvest',
};

/**
 * Load user hotkey overrides from localStorage.
 * Returns a merged map: defaults + user changes.
 */
function loadHotkeys() {
    const map = { ...DEFAULT_HOTKEYS };
    try {
        const stored = localStorage.getItem('portolancast-hotkeys');
        if (stored) {
            const overrides = JSON.parse(stored);
            // Clear defaults that were reassigned, then apply overrides
            for (const [key, tool] of Object.entries(overrides)) {
                map[key] = tool;
            }
        }
    } catch { /* ignore corrupt data */ }
    return map;
}

// =============================================================================
// TOOLBAR CLASS
// =============================================================================

/**
 * Connects toolbar buttons to viewer and canvas actions.
 *
 * Usage:
 *   const toolbar = new Toolbar(viewer, canvas);
 */
export class Toolbar {
    /**
     * Args:
     *   viewer: PDFViewer instance to control.
     *   canvas: CanvasOverlay instance for drawing tools and undo (optional).
     */
    constructor(viewer, canvas) {
        this.viewer = viewer;
        this.canvas = canvas || null;

        /** @type {string|null} Currently active tool name: null, 'select', 'pen' */
        this.activeTool = null;

        /**
         * Active intent mode — determines markupType and color for new markups.
         * Color-as-meaning: the intent carries the visual style.
         * @type {string} 'note' | 'issue' | 'question' | 'approval' | 'change'
         */
        this.activeMarkupType = 'note';

        /**
         * Callback fired when active markup type changes (for UI updates).
         * @type {Function|null}
         */
        this.onMarkupTypeChange = null;

        /**
         * Callback fired when the active tool changes.
         * NodeEditor hooks into this to exit vertex/endpoint edit mode when
         * the user switches tools. Set by NodeEditor.initForCanvas().
         * @type {Function|null}
         */
        this.onToolChange = null;

        /**
         * User-configurable hotkey→tool map. Loaded from localStorage with
         * fallback to DEFAULT_HOTKEYS. Rebuilt when the user edits bindings
         * in Toolbar Settings.
         * @type {Object<string, string>}
         */
        this._hotkeys = loadHotkeys();

        /**
         * Callback fired AFTER the active tool is fully configured.
         * Unlike onToolChange (which fires before cleanup), onToolSet fires
         * after this.activeTool is updated, so listeners see the new tool.
         * @type {Function|null}
         */
        this.onToolSet = null;

        /**
         * Callback fired when the node-edit tool is activated.
         * Set by app.js to call nodeEditor.enterEditModeOnSelection().
         * node-edit is a transient action: it triggers edit mode for the
         * currently-selected measurement object, then returns to select mode.
         * @type {Function|null}
         */
        this.onNodeEditRequest = null;

        /**
         * Currently visible toolbar tab: 'navigate' | 'markup' | 'measure'.
         * Persisted in localStorage so the user's last tab survives page reload.
         * @type {string}
         */
        this._activeTab = localStorage.getItem('portolancast-toolbar-tab') || 'navigate';

        /**
         * Map of tool name → tab it belongs to.
         * Used in setTool() to auto-switch the tab when a keyboard shortcut
         * activates a tool in a different tab.
         * @type {Object.<string, string>}
         */
        this._TOOL_TAB = {
            hand: 'navigate', select: 'navigate',
            pen: 'markup', rect: 'markup', ellipse: 'markup', line: 'markup',
            highlighter: 'markup', text: 'markup', cloud: 'markup', callout: 'markup',
            polyline: 'markup', polygon: 'markup', arrow: 'markup', arc: 'markup', 'sticky-note': 'markup', 'image-overlay': 'markup',
            dimension: 'markup', eraser: 'markup',
            harvest: 'markup',
            'component-stamp': 'markup',
            distance: 'measure', polylength: 'measure', area: 'measure', perimeter: 'measure', angle: 'measure', radius: 'measure',
            volume: 'measure', 'cloud-area': 'measure', sketch: 'measure', count: 'measure',
            calibrate: 'measure', 'node-edit': 'measure',
        };

        /**
         * Preset color/width override — set by ToolPresetsPanel._apply() and
         * consumed (then cleared) at the start of _initShapeDrawing().
         * Null means use the default MARKUP_COLORS[activeMarkupType].
         * @type {{strokeColor:string, strokeWidth:number}|null}
         */
        this._pendingPresetOverride = null;

        /**
         * Color used for the most recently drawn shape — read by ToolPresetsPanel
         * when saving a preset so the preset captures the actual last-used color.
         * @type {string}
         */
        this._lastStrokeColor = '';

        /**
         * Stroke width used for the most recently drawn shape.
         * @type {number}
         */
        this._lastStrokeWidth = 2;

        /**
         * Reference to MARKUP_COLORS for use by ToolPresetsPanel without
         * requiring a direct import from canvas.js in tools-panel.js.
         * Set by app.js after constructing Toolbar.
         * @type {Object|null}
         */
        this._MARKUP_COLORS_REF = null;

        this._bindButtons();
        this._bindKeyboard();
        this._bindImageOverlay();
        // Apply the persisted tab on startup (after DOM is ready via _bindButtons)
        this._setActiveTab(this._activeTab);
    }

    // =========================================================================
    // BUTTON BINDINGS
    // =========================================================================

    _bindButtons() {
        // "New blank document" button — opens the New Document modal
        const btnNew = document.getElementById('btn-new');
        if (btnNew) {
            btnNew.addEventListener('click', () => this._showNewDocModal());
        }

        // New Document modal controls
        const btnNewCancel = document.getElementById('new-doc-cancel');
        const btnNewCreate = document.getElementById('new-doc-create');
        const modalOverlay = document.getElementById('modal-new-doc-overlay');

        if (btnNewCancel) btnNewCancel.addEventListener('click', () => this._hideNewDocModal());
        if (modalOverlay) modalOverlay.addEventListener('click', () => this._hideNewDocModal());
        if (btnNewCreate) {
            btnNewCreate.addEventListener('click', () => this._handleNewDocument());
        }

        // Keyboard: Escape closes modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modal = document.getElementById('modal-new-doc');
                if (modal && modal.style.display !== 'none') {
                    this._hideNewDocModal();
                }
            }
        });

        // Apply persisted tool visibility from localStorage on startup.
        // This restores any hidden tools from the previous session without
        // requiring the settings modal to be opened.
        document.querySelectorAll('.tool-btn').forEach(btn => {
            const key = `portolancast-tool-hidden-${btn.dataset.tool}`;
            if (localStorage.getItem(key) === 'true') {
                btn.hidden = true;
            }
        });

        // Apply persisted compact mode from localStorage on startup.
        // Compact mode hides button text labels (shows icons only) via CSS class.
        if (localStorage.getItem('portolancast-toolbar-compact') === 'true') {
            document.getElementById('toolbar').classList.add('toolbar-compact');
        }

        // Toolbar mode tabs — clicking a tab switches the visible tool panel
        document.querySelectorAll('.toolbar-tab').forEach(tabBtn => {
            tabBtn.addEventListener('click', () => {
                this._setActiveTab(tabBtn.dataset.tab);
            });
        });

        // Settings gear — opens the per-tool visibility modal
        const btnSettings = document.getElementById('btn-toolbar-settings');
        if (btnSettings) {
            btnSettings.addEventListener('click', () => this._openSettings());
        }

        // Settings modal controls — wired here (modal content populated dynamically)
        const settingsClose = document.getElementById('settings-close');
        const settingsReset = document.getElementById('settings-reset');
        const settingsOverlay = document.getElementById('modal-settings-overlay');

        if (settingsClose) settingsClose.addEventListener('click', () => this._closeSettings());
        if (settingsOverlay) settingsOverlay.addEventListener('click', () => this._closeSettings());

        // Escape key closes settings modal when it is open.
        // Uses capture phase so it fires before any inner element's keydown.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modal = document.getElementById('modal-toolbar-settings');
                if (modal && modal.style.display !== 'none') {
                    e.stopPropagation();
                    this._closeSettings();
                }
            }
        }, { capture: true });

        if (settingsReset) {
            settingsReset.addEventListener('click', () => {
                // Remove all visibility overrides from localStorage and restore all buttons
                document.querySelectorAll('.tool-btn').forEach(btn => {
                    const key = `portolancast-tool-hidden-${btn.dataset.tool}`;
                    localStorage.removeItem(key);
                    btn.hidden = false;
                });
                // Reset compact mode as well
                localStorage.removeItem('portolancast-toolbar-compact');
                document.getElementById('toolbar').classList.remove('toolbar-compact');
                // Reset scroll sensitivity to default (Medium = 2)
                localStorage.removeItem('portolancast-scroll-sensitivity');
                const scrollSlider = document.getElementById('settings-scroll-sensitivity');
                if (scrollSlider) scrollSlider.value = '2';
                // Reset toolbar rows to 1
                localStorage.removeItem('portolancast-toolbar-rows');
                this._applyToolbarRows('1');
                const rowsSelect = document.getElementById('settings-toolbar-rows');
                if (rowsSelect) rowsSelect.value = '1';
                // Reset auto-landscape to on
                localStorage.removeItem('portolancast-auto-landscape');
                // Reset hotkeys to defaults
                localStorage.removeItem('portolancast-hotkeys');
                this._hotkeys = { ...DEFAULT_HOTKEYS };
                // Re-populate the settings list to reflect the reset state
                this._populateSettingsLists();
                this._populateHotkeyEditor();
            });
        }

        // Apply saved toolbar rows preference on init
        this._applyToolbarRows(localStorage.getItem('portolancast-toolbar-rows') || '1');

        // File open buttons (both toolbar and welcome screen)
        const fileInput = document.getElementById('file-input');
        const btnOpen = document.getElementById('btn-open');
        const btnWelcomeOpen = document.getElementById('btn-welcome-open');

        btnOpen.addEventListener('click', () => fileInput.click());
        btnWelcomeOpen.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this._handleFileUpload(e.target.files[0]);
            }
            // Reset so the same file can be re-selected
            fileInput.value = '';
        });

        // Zoom buttons
        document.getElementById('btn-zoom-in').addEventListener('click', () => {
            this.viewer.zoomIn();
        });

        document.getElementById('btn-zoom-out').addEventListener('click', () => {
            this.viewer.zoomOut();
        });

        document.getElementById('btn-zoom-fit').addEventListener('click', () => {
            this.viewer.fitToWidth();
        });

        // Rotate button — cycles page 90° CW server-side
        document.getElementById('btn-rotate').addEventListener('click', () => {
            this.viewer.rotate();
        });

        // L3: Persistent mode bar quick-switch buttons — always reachable
        // regardless of which toolbar tab is currently visible.
        const sbHand = document.getElementById('sb-btn-hand');
        const sbSelect = document.getElementById('sb-btn-select');
        if (sbHand) sbHand.addEventListener('click', () => this.setTool('hand'));
        if (sbSelect) sbSelect.addEventListener('click', () => this.setTool('select'));

        // Tool buttons — use event delegation on all .tool-btn elements
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setTool(btn.dataset.tool);
            });
        });

        // Export button — save markups first, then trigger PDF download
        const btnExport = document.getElementById('btn-export');
        if (btnExport) {
            btnExport.addEventListener('click', () => this._handleExport());
        }

        // Export Page as Image — layer-aware PNG/SVG page export
        const btnExportPage = document.getElementById('btn-export-page');
        if (btnExportPage) {
            btnExportPage.addEventListener('click', () => this._handleExportPage());
        }

        // Save Bundle button — export .portolan ZIP (preserves markups for re-editing)
        const btnSaveBundle = document.getElementById('btn-save-bundle');
        if (btnSaveBundle) {
            btnSaveBundle.addEventListener('click', () => this._handleBundleSave());
        }

        // Obsidian export button — export markup notes as Markdown .zip
        const btnObsidian = document.getElementById('btn-export-obsidian');
        if (btnObsidian) {
            btnObsidian.addEventListener('click', () => this._handleObsidianExport());
        }

        // Toolbar settings (now inside Settings dropdown — reuses existing _openSettings)
        // NOTE: The old gear-button binding at line ~191 also targets btn-toolbar-settings.
        // Both fire _openSettings() — safe to have two listeners on the same element.

        // Help: Keyboard Shortcuts
        const btnShortcuts = document.getElementById('btn-help-shortcuts');
        if (btnShortcuts) {
            btnShortcuts.addEventListener('click', () => this._showKeyboardShortcuts());
        }

        // Help: About
        const btnAbout = document.getElementById('btn-help-about');
        if (btnAbout) {
            btnAbout.addEventListener('click', () => this._showAbout());
        }

        // =================================================================
        // MENU BAR ITEM BINDINGS (File, Edit, View)
        // These delegate to existing viewer/canvas methods so the menu
        // is a second interface to the same behavior as toolbar buttons.
        // =================================================================

        // File → Close — return to welcome screen
        const btnClose = document.getElementById('btn-close-doc');
        if (btnClose) {
            btnClose.addEventListener('click', () => {
                const ws = document.getElementById('welcome-screen');
                if (ws) ws.style.display = '';
                const cv = document.getElementById('canvas-container');
                if (cv) cv.style.display = 'none';
                document.getElementById('filename-display').textContent = 'No file open';
            });
        }

        // File → Print
        const btnPrint = document.getElementById('btn-print');
        if (btnPrint) {
            btnPrint.addEventListener('click', () => window.print());
        }

        // File → Delete Document
        const btnDeleteDoc = document.getElementById('btn-delete-doc');
        if (btnDeleteDoc) {
            btnDeleteDoc.addEventListener('click', async () => {
                if (!this.viewer?.docId) return;
                if (!confirm('Permanently delete this document and its file?')) return;
                try {
                    await fetch(`/api/documents/${this.viewer.docId}`, { method: 'DELETE' });
                    // Return to welcome screen after deletion
                    const ws = document.getElementById('welcome-screen');
                    if (ws) ws.style.display = '';
                    const cv = document.getElementById('canvas-container');
                    if (cv) cv.style.display = 'none';
                    document.getElementById('filename-display').textContent = 'No file open';
                } catch (err) {
                    console.error('Delete failed:', err);
                }
            });
        }

        // Edit → Undo / Redo
        const btnUndo = document.getElementById('btn-undo');
        if (btnUndo) {
            btnUndo.addEventListener('click', () => this.canvas?.undo());
        }
        const btnRedo = document.getElementById('btn-redo');
        if (btnRedo) {
            btnRedo.addEventListener('click', () => this.canvas?.redo());
        }

        // Edit → Delete Selected
        const btnDeleteSel = document.getElementById('btn-delete-selected');
        if (btnDeleteSel) {
            btnDeleteSel.addEventListener('click', () => {
                if (!this.canvas?.fabricCanvas) return;
                const active = this.canvas.fabricCanvas.getActiveObject();
                if (active) {
                    this.canvas.fabricCanvas.remove(active);
                    this.canvas.fabricCanvas.renderAll();
                }
            });
        }

        // Edit → Select All
        const btnSelectAll = document.getElementById('btn-select-all');
        if (btnSelectAll) {
            btnSelectAll.addEventListener('click', () => {
                if (!this.canvas?.fabricCanvas) return;
                const fc = this.canvas.fabricCanvas;
                const objs = fc.getObjects().filter(o => o.selectable);
                if (objs.length === 0) return;
                fc.discardActiveObject();
                const sel = new fabric.ActiveSelection(objs, { canvas: fc });
                fc.setActiveObject(sel);
                fc.requestRenderAll();
            });
        }

        // Edit → Deselect All
        const btnDeselect = document.getElementById('btn-deselect');
        if (btnDeselect) {
            btnDeselect.addEventListener('click', () => {
                this.canvas?.fabricCanvas?.discardActiveObject();
                this.canvas?.fabricCanvas?.requestRenderAll();
            });
        }

        // Edit → Group (Ctrl+G)
        const btnGroup = document.getElementById('btn-group');
        if (btnGroup) {
            btnGroup.addEventListener('click', () => this._groupSelection());
        }

        // Edit → Ungroup (Ctrl+Shift+G)
        const btnUngroup = document.getElementById('btn-ungroup');
        if (btnUngroup) {
            btnUngroup.addEventListener('click', () => this._ungroupSelection());
        }

        // View → Zoom In / Out / Fit (delegate to existing viewer methods)
        const btnMenuZoomIn = document.getElementById('btn-menu-zoom-in');
        if (btnMenuZoomIn) {
            btnMenuZoomIn.addEventListener('click', () => this.viewer.zoomIn());
        }
        const btnMenuZoomOut = document.getElementById('btn-menu-zoom-out');
        if (btnMenuZoomOut) {
            btnMenuZoomOut.addEventListener('click', () => this.viewer.zoomOut());
        }
        const btnMenuZoomFit = document.getElementById('btn-menu-zoom-fit');
        if (btnMenuZoomFit) {
            btnMenuZoomFit.addEventListener('click', () => this.viewer.fitToWidth());
        }

        // View → Rotate Page
        const btnMenuRotate = document.getElementById('btn-menu-rotate');
        if (btnMenuRotate) {
            btnMenuRotate.addEventListener('click', () => this.viewer.rotate());
        }

        // View → Toggle Panels (simulate clicks on existing collapse buttons)
        const btnToggleLeft = document.getElementById('btn-toggle-left-panel');
        if (btnToggleLeft) {
            btnToggleLeft.addEventListener('click', () => {
                document.getElementById('btn-collapse-left')?.click();
            });
        }
        const btnToggleRight = document.getElementById('btn-toggle-right-panel');
        if (btnToggleRight) {
            btnToggleRight.addEventListener('click', () => {
                document.getElementById('btn-collapse-right')?.click();
            });
        }

        // Dropdown menu toggle — click trigger to open, click outside to close
        this._initDropdowns();
    }

    // =========================================================================
    // IMAGE OVERLAY
    // =========================================================================

    /**
     * Wire the hidden #image-overlay-input file picker to the placement pipeline.
     *
     * Called once from the constructor. Listens for file selection, uploads the
     * image to the existing markup-photos endpoint (reusing server infrastructure),
     * then places a fabric.Image on the canvas as a full markup object.
     *
     * Architecture:
     *   1. User triggers the picker via the Image toolbar button (setTool → .click())
     *   2. File change fires this handler
     *   3. Upload to /api/documents/{docId}/markup-photos with a pre-generated UUID
     *      so the canvas object's markupId matches the photo record from day one.
     *   4. fabric.Image.fromURL() loads the image from the same-origin static path.
     *   5. stampDefaults() stamps the full markup metadata (preserveColor skips stroke).
     *   6. canvas.add() fires object:added → layer auto-assigned by canvas.js.
     *   7. Tool reverts to select so the user can immediately reposition the image.
     *
     * Security:
     *   - SECURITY: docId is read from this.viewer (set by PDFViewer.loadDocument), not from user input.
     *   - SECURITY: upload goes through the existing server endpoint which validates
     *     file type and size — no client-side file validation needed here.
     *   - SECURITY: the returned URL is a relative same-origin path (/data/photos/...).
     */
    _bindImageOverlay() {
        const input = document.getElementById('image-overlay-input');
        if (!input) return;

        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            // Reset immediately so the same file can be re-selected next time
            input.value = '';
            // Revert to select mode before any async work so the UI is never stuck
            this.setTool('select');

            // docId lives on the PDFViewer instance, not on the canvas overlay
            const docId = this.viewer?.docId;
            if (!file || !docId) return;

            // Pre-generate the markupId so the photo record and canvas object share
            // the same stable identifier from creation. stampDefaults() checks
            // !obj.markupId and will not overwrite this pre-set value.
            const markupId = crypto.randomUUID().replace(/-/g, '');

            // Upload via the existing markup-photos endpoint — no new routes needed.
            const form = new FormData();
            form.append('markup_id', markupId);
            form.append('photo', file);
            form.append('description', '');   // description optional; user can add in properties panel

            let url;
            try {
                const resp = await fetch(
                    `/api/documents/${docId}/markup-photos`,
                    { method: 'POST', body: form }
                );
                if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
                const data = await resp.json();
                url = data.url;
            } catch (err) {
                console.error('[Toolbar] Image overlay upload failed:', err);
                return;
            }

            // Load the image from the same-origin server URL.
            // No crossOrigin option: /data/photos/ is always same-origin, and FastAPI
            // StaticFiles does not set CORS headers. Adding crossOrigin: 'anonymous'
            // would trigger CORS preflight and fail silently on same-origin servers.
            const fc = this.canvas.fabricCanvas;
            let img;
            try {
                img = await fabric.Image.fromURL(url);
            } catch (err) {
                console.error('[Toolbar] fabric.Image.fromURL failed:', err, 'url:', url);
                return;
            }

            // Scale to fit — max 60% of canvas display dimensions, maintain aspect ratio.
            // Math.min(..., 1) ensures we never upscale a small image.
            const maxW = fc.getWidth() * 0.6;
            const maxH = fc.getHeight() * 0.6;
            const scale = Math.min(maxW / img.width, maxH / img.height, 1);
            img.scale(scale);

            // Center at the current viewport center in natural (pre-zoom) coordinates.
            // vpt = [scaleX, 0, 0, scaleY, translateX, translateY]
            const vpt = fc.viewportTransform;
            const centerX = (fc.getWidth() / 2 - vpt[4]) / vpt[0];
            const centerY = (fc.getHeight() / 2 - vpt[5]) / vpt[3];
            img.set({ left: centerX, top: centerY, originX: 'center', originY: 'center' });

            // Pre-set markupId before stampDefaults so the photo record and canvas
            // object share the same UUID. stampDefaults skips markupId when already set.
            img.markupId = markupId;
            this.canvas.stampDefaults(img, {
                markupType: 'image-overlay',
                // preserveColor prevents stampDefaults from applying a stroke color.
                // Images don't have semantic stroke; we clear it explicitly below.
                preserveColor: true,
            });
            // Ensure no stroke border is rendered on the image (strokeWidth defaults
            // to 1 on fabric.Image; zero gives a clean appearance).
            img.set({ stroke: null, strokeWidth: 0 });

            fc.add(img);                        // object:added → layer auto-assigned
            fc.setActiveObject(img);
            fc.renderAll();
            this.canvas.onContentChange?.();    // trigger auto-save
        });
    }

    // =========================================================================
    // KEYBOARD SHORTCUTS
    // =========================================================================

    _bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            // Don't intercept when typing in an input field
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            // Don't intercept when editing text on the Fabric canvas (IText)
            if (this.canvas && this.canvas.fabricCanvas) {
                const active = this.canvas.fabricCanvas.getActiveObject();
                if (active && active.isEditing) return;
            }

            switch (e.key) {
                case 'ArrowRight':
                case 'PageDown':
                    e.preventDefault();
                    this.viewer.nextPage();
                    break;

                case 'ArrowLeft':
                case 'PageUp':
                    e.preventDefault();
                    this.viewer.prevPage();
                    break;

                case '+':
                case '=':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        this.viewer.zoomIn();
                    }
                    break;

                case '-':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        this.viewer.zoomOut();
                    }
                    break;

                case '0':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        this.viewer.setZoom(100);
                    }
                    break;

                case 'Home':
                    e.preventDefault();
                    this.viewer.goToPage(0);
                    break;

                case 'End':
                    e.preventDefault();
                    this.viewer.goToPage(this.viewer.pageCount - 1);
                    break;

                // Undo: Ctrl+Z
                case 'z':
                    if (e.ctrlKey && !e.shiftKey && this.canvas) {
                        e.preventDefault();
                        this.canvas.undo();
                    }
                    // Redo: Ctrl+Shift+Z
                    if (e.ctrlKey && e.shiftKey && this.canvas) {
                        e.preventDefault();
                        this.canvas.redo();
                    }
                    break;

                // Redo: Ctrl+Y (alternative) / Tool shortcut: plain y
                case 'y':
                    if (e.ctrlKey && this.canvas) {
                        e.preventDefault();
                        this.canvas.redo();
                    } else if (this._hotkeys['y']) {
                        this.setTool(this._hotkeys['y']);
                    }
                    break;

                // Ctrl+D — Duplicate selected objects
                case 'd':
                    if (e.ctrlKey && this.canvas) {
                        e.preventDefault();
                        const fc = this.canvas?.fabricCanvas;
                        if (!fc) return;
                        const active = fc.getActiveObjects();
                        if (active.length === 0) return;

                        fc.discardActiveObject();

                        (async () => {
                            const clones = [];
                            for (const obj of active) {
                                const cloned = await obj.clone();
                                cloned.set({
                                    left: (obj.left || 0) + 10,
                                    top: (obj.top || 0) + 10,
                                });
                                cloned.markupId = undefined;
                                this.canvas.stampDefaults(cloned, {
                                    markupType: obj.markupType || 'note',
                                    preserveColor: true,
                                });
                                if (obj.layerId) cloned.layerId = obj.layerId;
                                fc.add(cloned);
                                clones.push(cloned);
                            }
                            if (clones.length === 1) {
                                fc.setActiveObject(clones[0]);
                            } else {
                                const sel = new fabric.ActiveSelection(clones, { canvas: fc });
                                fc.setActiveObject(sel);
                            }
                            fc.renderAll();
                        })();
                    }
                    break;

                // Find & Replace: Ctrl+H / Tool shortcut: plain h
                case 'h':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        if (this.onFindReplace) this.onFindReplace();
                    } else if (this._hotkeys['h']) {
                        this.setTool(this._hotkeys['h']);
                    }
                    break;

                // Group: Ctrl+G / Ungroup: Ctrl+Shift+G
                case 'g':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        if (e.shiftKey) {
                            this._ungroupSelection();
                        } else {
                            this._groupSelection();
                        }
                    } else if (this._hotkeys['g']) {
                        this.setTool(this._hotkeys['g']);
                    }
                    break;

                // Escape: deselect tool, return to select/pan mode
                case 'Escape':
                    this.setTool(null);
                    break;

                // Delete/Backspace: remove selected object
                case 'Delete':
                case 'Backspace':
                    if (this.canvas && this.canvas.fabricCanvas) {
                        const active = this.canvas.fabricCanvas.getActiveObject();
                        if (active) {
                            e.preventDefault();
                            this.canvas.fabricCanvas.remove(active);
                            this.canvas.fabricCanvas.renderAll();
                        }
                    }
                    break;

                // Intent-mode shortcuts: 1-5 set markup type
                // Flow principle: express intent first, shape second
                case '1':
                    if (!e.ctrlKey) this.setMarkupType('note');
                    break;
                case '2':
                    if (!e.ctrlKey) this.setMarkupType('issue');
                    break;
                case '3':
                    if (!e.ctrlKey) this.setMarkupType('question');
                    break;
                case '4':
                    if (!e.ctrlKey) this.setMarkupType('approval');
                    break;
                case '5':
                    if (!e.ctrlKey) this.setMarkupType('change');
                    break;

                default: {
                    // Editable hotkeys: look up tool from the configurable map.
                    // Only fires for non-Ctrl keys (Ctrl combos are system shortcuts).
                    // Uppercase keys (Shift+letter) are in the map as e.g. 'A' for arrow.
                    if (!e.ctrlKey) {
                        const tool = this._hotkeys[e.key];
                        if (tool) {
                            this.setTool(tool);
                            break;
                        }
                        // Q: Quick Capture (special — not a tool, opens a panel)
                        if (e.key === 'q' && window.app?.quickCapture) {
                            window.app.quickCapture.open();
                        }
                    }
                    break;
                }
            }
        });
    }

    // =========================================================================
    // TOOL SELECTION
    // =========================================================================

    /**
     * Activate a drawing tool by name.
     *
     * Handles toggling drawing mode, updating button active states,
     * and configuring the Fabric.js canvas for the selected tool.
     * Shape tools (rect, ellipse, line) bind mouse event handlers for
     * interactive creation. All tools stamp markupType metadata.
     *
     * Args:
     *   toolName: 'select' | 'pen' | 'rect' | 'ellipse' | 'line' |
     *             'highlighter' | 'text' | 'cloud' | 'callout' | null
     *             null = deselect, pan mode
     */
    setTool(toolName) {
        // If clicking the already-active tool, deselect it (toggle off)
        if (toolName === this.activeTool && toolName !== null) {
            toolName = null;
        }

        // Notify NodeEditor (or any other subscriber) that the tool is changing.
        // NodeEditor uses this to exit vertex/endpoint edit mode cleanly.
        // Called BEFORE _cleanupShapeDrawing so the edit end doesn't interfere
        // with the new tool's setup.
        if (this.onToolChange) this.onToolChange();

        // Clean up any active shape drawing handlers from previous tool
        this._cleanupShapeDrawing();

        // Clean up ghost from stamp mode
        if (this._stampGhost) {
            const fc2 = this.canvas?.fabricCanvas;
            if (fc2) fc2.remove(this._stampGhost);
            this._stampGhost = null;
        }

        // Remove hand-mode cursor class — re-added below for hand/null tools
        // Applied to #canvas-container (the outermost wrapper) so the cursor
        // covers both the PDF image and the Fabric overlay.
        if (this.viewer && this.viewer.container) {
            this.viewer.container.classList.remove('hand-mode');
        }

        this.activeTool = toolName;

        // Update button active states
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === toolName);
        });

        // Auto-switch to the correct tab when a keyboard shortcut activates a tool
        // that lives in a different tab. This keeps the toolbar in sync with the
        // active tool even when the user hasn't clicked the tab explicitly.
        if (toolName && this._TOOL_TAB) {
            const tab = this._TOOL_TAB[toolName];
            if (tab && tab !== this._activeTab) {
                this._setActiveTab(tab);
            }
        }

        // L3: Sync persistent mode bar in status bar — always, even without canvas
        this._updateModeBar(this.activeTool);

        if (!this.canvas || !this.canvas.fabricCanvas) return;

        const fc = this.canvas.fabricCanvas;

        switch (toolName) {
            case 'pen':
                fc.isDrawingMode = true;
                fc.freeDrawingBrush = new fabric.PencilBrush(fc);
                // Color-as-meaning: pen color matches active intent mode
                fc.freeDrawingBrush.color = MARKUP_COLORS[this.activeMarkupType] || MARKUP_COLORS.note;
                fc.freeDrawingBrush.width = 3;
                fc.selection = true;
                this.canvas.setDrawingMode(true);
                break;

            case 'select':
                fc.isDrawingMode = false;
                fc.selection = true;
                this.canvas.setDrawingMode(true);
                break;

            case 'rect':
            case 'ellipse':
            case 'line':
            case 'highlighter':
            case 'cloud':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initShapeDrawing(toolName);
                break;

            case 'arc':
                // Click-drag tool: mousedown sets start, mousemove shows preview arc,
                // mouseup commits. Arc bulges perpendicular to the chord.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initArcDrawing();
                break;

            case 'arrow':
                // Click-drag tool: mousedown sets tail, mouseup places tip with filled arrowhead.
                // Produces a Group(shaft Line + arrowhead Path) so the whole arrow moves/scales
                // as a single object under select.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initArrowDrawing();
                break;

            case 'polyline':
                // Click-accumulate-dblclick tool: click to add vertices, double-click to finish.
                // Each click adds a point; double-click places the final segment and commits
                // the finished Polyline as a permanent markup object.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initPolylineDrawing();
                break;

            case 'polygon':
                // Like polyline but creates a closed, filled shape.
                // Click to add vertices, double-click to close and fill.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initPolygonDrawing();
                break;

            case 'dimension':
                // Click-drag dimension line: line with measurement text calculated from scale.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initDimensionDrawing();
                break;

            case 'eraser':
                // Click on pen strokes or markups to delete them.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initEraserMode();
                break;

            case 'sticky-note':
                // Click-to-place sticky note — Textbox with yellow background and colored border.
                // One-shot: places the box, enters editing, reverts to select.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initStickyNotePlacement();
                break;

            case 'image-overlay':
                // Upload-and-place: opens a file picker, uploads the chosen image to the
                // server's existing markup-photos endpoint, then places a fabric.Image on
                // the canvas. The actual work is done by _bindImageOverlay's change handler.
                // This case just opens the picker; the tool reverts to select after placement.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                document.getElementById('image-overlay-input').click();
                break;

            case 'harvest':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initHarvestDrawing();
                break;

            case 'component-stamp':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initStampMode();
                break;

            case 'equipment-marker':
                // Click-to-place equipment pin: places a circle+label Group on the
                // canvas, then opens the Equipment Marker panel for entity linking.
                // One-shot: reverts to select after placement.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initEquipmentMarkerPlacement();
                break;

            case 'connect':
                // Two-click connection tool: click source equipment marker → click
                // target equipment marker → draws a directed line between them and
                // saves the connection to the DB.
                // Both clicks must land on equipment markers with entityId set.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initConnectionDrawing();
                break;

            case 'text':
                // Click-to-place text — selection stays on so user can click objects too
                fc.isDrawingMode = false;
                fc.selection = true;
                this.canvas.setDrawingMode(true);
                this._initTextPlacement();
                break;

            case 'callout':
                // Two-click placement: anchor point → text box with leader line
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initCalloutPlacement();
                break;

            case 'hand':
                // Hand tool: no drawing mode — events pass through canvas to viewport.
                // The pan guard in pdf-viewer.js allows panning ONLY when drawing-active
                // is absent, so clearing it here is what makes pan work.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(false);  // no .drawing-active → pan works
                this.viewer.container.classList.add('hand-mode');
                break;

            case 'node-edit':
                // Transient action: enter vertex/endpoint edit for the selected
                // measurement object, then immediately revert to select tool.
                // Does NOT persist as a drawing mode — it's a one-shot command.
                // The onNodeEditRequest callback is wired by app.js to
                // nodeEditor.enterEditModeOnSelection().
                fc.isDrawingMode = false;
                fc.selection = true;
                this.canvas.setDrawingMode(true);  // keep drawing-active (select mode)
                if (this.onNodeEditRequest) {
                    this.onNodeEditRequest();
                }
                // Return to select tool immediately so the button doesn't stay active
                this.activeTool = 'select';
                document.querySelectorAll('.tool-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tool === 'select');
                });
                break;

            // ---------------------------------------------------------------
            // Phase 2: Measurement tools — handlers registered in MeasureTools
            // Each initXxx() stores handlers in this._shapeHandlers so
            // _cleanupShapeDrawing() removes them when the tool changes.
            // ---------------------------------------------------------------

            case 'distance':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initDistance(this.canvas, this, this.scale);
                }
                break;

            case 'polylength':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initPolylength(this.canvas, this, this.scale);
                }
                break;

            case 'area':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initArea(this.canvas, this, this.scale);
                }
                break;

            case 'perimeter':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initPerimeter(this.canvas, this, this.scale);
                }
                break;

            case 'angle':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initAngle(this.canvas, this);
                }
                break;

            case 'count':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initCount(this.canvas, this);
                }
                break;

            case 'radius':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initRadius(this.canvas, this, this.scale);
                }
                break;

            case 'volume':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initVolume(this.canvas, this, this.scale);
                }
                break;

            case 'cloud-area':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initCloudArea(this.canvas, this, this.scale);
                }
                break;

            case 'sketch':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initSketch(this.canvas, this, this.scale);
                }
                break;

            case 'calibrate':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initCalibration(this.canvas, this, this.scale);
                }
                break;

            default:
                // No tool — pan mode, pointer events pass through to viewport.
                // Same behavior as 'hand' tool: no drawing-active means pan works.
                fc.isDrawingMode = false;
                fc.selection = true;
                fc.discardActiveObject();
                fc.renderAll();
                this.canvas.setDrawingMode(false);
                this.viewer.container.classList.add('hand-mode');
                break;
        }

        // Notify listeners that the tool is now fully configured.
        // Unlike onToolChange (fires before cleanup), this fires after
        // activeTool is set and drawing mode is configured.
        if (this.onToolSet) this.onToolSet(this.activeTool);
    }

    // =========================================================================
    // TAB SWITCHING
    // =========================================================================

    /**
     * Activate a toolbar tab and show its panel, hiding the others.
     *
     * Persists the selection to localStorage so it survives page reload.
     * Called by tab button clicks AND by setTool() when a keyboard shortcut
     * activates a tool in a different tab (auto-switch).
     *
     * Args:
     *   tabName: 'navigate' | 'markup' | 'measure'
     */
    _setActiveTab(tabName) {
        this._activeTab = tabName;
        localStorage.setItem('portolancast-toolbar-tab', tabName);

        // Show/hide tab content panels
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.style.display = panel.dataset.tab === tabName ? '' : 'none';
        });

        // Update tab button active state
        document.querySelectorAll('.toolbar-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
    }

    // =========================================================================
    // L3: MODE BAR
    // =========================================================================

    /**
     * Sync the persistent mode bar (in the status bar) to reflect the
     * currently active tool.
     *
     * Updates:
     *   - #sb-tool-icon  — copies the icon glyph from the matching toolbar button
     *   - #sb-tool-name  — uses the button's title, stripping the "(X)" shortcut hint
     *   - #sb-active-tool[data-tab] — drive colour-coding by tab (navigate/markup/measure)
     *   - #sb-btn-hand/.active   — highlighted when pan/hand mode is active
     *   - #sb-btn-select/.active — highlighted when select tool is active
     *
     * Args:
     *   toolName: resolved activeTool value (null = pan/free mode)
     */
    _updateModeBar(toolName) {
        const iconEl  = document.getElementById('sb-tool-icon');
        const nameEl  = document.getElementById('sb-tool-name');
        const pillEl  = document.getElementById('sb-active-tool');
        const sbHand  = document.getElementById('sb-btn-hand');
        const sbSel   = document.getElementById('sb-btn-select');
        if (!iconEl || !nameEl || !pillEl) return;

        // Colour-code the pill border by which tab owns this tool
        const tab = (toolName && this._TOOL_TAB[toolName]) || 'navigate';
        pillEl.dataset.tab = tab;

        // Resolve icon glyph and label from the matching toolbar button (single
        // source of truth — no separate mapping tables needed).
        const toolBtn = toolName
            ? document.querySelector(`.tool-btn[data-tool="${toolName}"]`)
            : null;

        if (toolBtn) {
            const iconSpan = toolBtn.querySelector('.icon');
            // textContent of .icon is the emoji/glyph already rendered in the toolbar
            iconEl.textContent = iconSpan ? iconSpan.textContent : '⬤';
            // Strip keyboard shortcut hint "(X)" for clean label
            const rawTitle = toolBtn.title || toolBtn.dataset.tool || toolName;
            nameEl.textContent = rawTitle.replace(/\s*\([A-Z0-9]\)\s*$/i, '').trim();
        } else {
            // null → pan/free mode has no toolbar button
            iconEl.textContent = '✋';
            nameEl.textContent = 'Pan';
        }

        // Highlight the quick-switch buttons when their mode is active.
        // Both null (toggle-off) and 'hand' count as pan mode.
        if (sbHand)  sbHand.classList.toggle('active',  toolName === 'hand' || toolName === null);
        if (sbSel)   sbSel.classList.toggle('active',   toolName === 'select');
    }

    // =========================================================================
    // SETTINGS MODAL — per-tool visibility
    // =========================================================================

    // =========================================================================
    // GROUP / UNGROUP
    // =========================================================================

    /**
     * Group the current multi-selection into a single Fabric Group.
     *
     * Only acts when an ActiveSelection (multi-select) is active.
     * Custom properties from the first child are promoted to the group
     * so markup metadata (type, status, note) survives serialization.
     */
    _groupSelection() {
        const fc = this.canvas?.fabricCanvas;
        if (!fc) return;

        const active = fc.getActiveObject();
        if (!active || active.type !== 'activeselection') return;

        // Convert ActiveSelection → persistent Group.
        // Collect object references, discard the selection (returns objects to canvas),
        // then remove each from the canvas before creating the Group.
        const objects = active.getObjects().slice();  // copy the array
        fc.discardActiveObject();

        // Remove individual objects — they'll live inside the Group instead
        objects.forEach(obj => fc.remove(obj));

        const group = new fabric.Group(objects, {
            canvas: fc,
        });

        // Promote semantic metadata from the first child so the group
        // carries a markupType for the properties panel and markup list.
        const donor = objects[0];
        if (donor) {
            if (donor.markupType)      group.markupType      = donor.markupType;
            if (donor.markupStatus)    group.markupStatus    = donor.markupStatus;
            if (donor.markupNote)      group.markupNote      = donor.markupNote;
            if (donor.markupAuthor)    group.markupAuthor    = donor.markupAuthor;
            if (donor.markupTimestamp) group.markupTimestamp  = donor.markupTimestamp;
            if (donor.markupId)        group.markupId        = donor.markupId;
        }

        // Tag the group so ungroup knows it was user-created (not a measurement
        // or callout group that should not be ungrouped).
        group._isUserGroup = true;

        fc.add(group);
        fc.setActiveObject(group);
        fc.requestRenderAll();

        // Push undo snapshot
        this.canvas?._pushUndoSnapshot?.();
    }

    /**
     * Ungroup a user-created Group back into individual objects.
     *
     * Only acts on Groups tagged with _isUserGroup to avoid breaking
     * measurement groups, callouts, or equipment markers.
     */
    _ungroupSelection() {
        const fc = this.canvas?.fabricCanvas;
        if (!fc) return;

        const active = fc.getActiveObject();
        if (!active || active.type !== 'group' || !active._isUserGroup) return;

        // Get the group's transform matrix to convert child coords to canvas-space
        const groupMatrix = active.calcTransformMatrix();
        const items = active.getObjects().slice();

        // Remove the group from canvas first
        fc.discardActiveObject();
        fc.remove(active);

        // Remove children from group internals and transform to canvas coords
        items.forEach(obj => {
            // Get the object's absolute position by combining group + object transforms
            const objMatrix = obj.calcTransformMatrix();
            const fullMatrix = fabric.util.multiplyTransformMatrices(groupMatrix, objMatrix);
            const options = fabric.util.qrDecompose(fullMatrix);

            obj.set({
                left: options.translateX,
                top: options.translateY,
                scaleX: options.scaleX,
                scaleY: options.scaleY,
                angle: options.angle,
                skewX: options.skewX,
                skewY: options.skewY,
            });
            obj.setCoords();
            fc.add(obj);
        });

        // Select all ungrouped items as an ActiveSelection
        if (items.length > 1) {
            fc.discardActiveObject();
            const sel = new fabric.ActiveSelection(items, { canvas: fc });
            fc.setActiveObject(sel);
        } else if (items.length === 1) {
            fc.setActiveObject(items[0]);
        }

        fc.requestRenderAll();

        // Push undo snapshot
        this.canvas?._pushUndoSnapshot?.();
    }

    /**
     * Open the toolbar settings modal.
     *
     * Populates checkboxes for every .tool-btn element, organized by tab section.
     * Checkbox state is read from localStorage ('portolancast-tool-hidden-{toolName}').
     */
    _openSettings() {
        const modal = document.getElementById('modal-toolbar-settings');
        if (!modal) return;

        this._populateSettingsLists();
        this._populateHotkeyEditor();

        // Wire the compact mode checkbox each time the modal opens so it
        // reflects current state (in case reset was called while modal was closed).
        const compactCb = document.getElementById('settings-cb-compact');
        if (compactCb) {
            const toolbar = document.getElementById('toolbar');
            compactCb.checked = toolbar.classList.contains('toolbar-compact');
            // Replace any previous handler by cloning — avoids stacking multiple listeners
            const newCb = compactCb.cloneNode(true);
            compactCb.parentNode.replaceChild(newCb, compactCb);
            newCb.addEventListener('change', () => {
                if (newCb.checked) {
                    toolbar.classList.add('toolbar-compact');
                    localStorage.setItem('portolancast-toolbar-compact', 'true');
                } else {
                    toolbar.classList.remove('toolbar-compact');
                    localStorage.removeItem('portolancast-toolbar-compact');
                }
            });
        }

        // Wire the toolbar rows selector
        const rowsSelect = document.getElementById('settings-toolbar-rows');
        if (rowsSelect) {
            const storedRows = localStorage.getItem('portolancast-toolbar-rows') || '1';
            rowsSelect.value = storedRows;
            const newSelect = rowsSelect.cloneNode(true);
            rowsSelect.parentNode.replaceChild(newSelect, rowsSelect);
            newSelect.addEventListener('change', () => {
                localStorage.setItem('portolancast-toolbar-rows', newSelect.value);
                this._applyToolbarRows(newSelect.value);
            });
        }

        // Wire the auto-landscape checkbox
        const autoLandscapeCb = document.getElementById('settings-cb-auto-landscape');
        if (autoLandscapeCb) {
            autoLandscapeCb.checked = localStorage.getItem('portolancast-auto-landscape') !== 'false';
            const newCb2 = autoLandscapeCb.cloneNode(true);
            autoLandscapeCb.parentNode.replaceChild(newCb2, autoLandscapeCb);
            newCb2.addEventListener('change', () => {
                if (newCb2.checked) {
                    localStorage.removeItem('portolancast-auto-landscape');
                } else {
                    localStorage.setItem('portolancast-auto-landscape', 'false');
                }
            });
        }

        // Wire the scroll sensitivity slider each time the modal opens.
        // Value 1 = Low (150px threshold), 2 = Medium (80px), 3 = High (30px).
        // Uses clone-replace pattern to avoid stacking listeners across re-opens.
        const scrollSlider = document.getElementById('settings-scroll-sensitivity');
        if (scrollSlider) {
            const stored = localStorage.getItem('portolancast-scroll-sensitivity');
            scrollSlider.value = stored ?? '2';
            const newSlider = scrollSlider.cloneNode(true);
            scrollSlider.parentNode.replaceChild(newSlider, scrollSlider);
            newSlider.addEventListener('input', () => {
                localStorage.setItem('portolancast-scroll-sensitivity', newSlider.value);
            });
        }

        modal.style.display = 'flex';
    }

    /**
     * Close the toolbar settings modal.
     */
    _closeSettings() {
        const modal = document.getElementById('modal-toolbar-settings');
        if (modal) modal.style.display = 'none';
    }

    /**
     * Apply multi-row layout to the toolbar tools row.
     * Sets data-rows attribute which CSS uses for wrapping.
     */
    _applyToolbarRows(rows) {
        const toolsRow = document.querySelector('.toolbar-row-tools');
        if (toolsRow) {
            if (rows === '1' || !rows) {
                toolsRow.removeAttribute('data-rows');
            } else {
                toolsRow.setAttribute('data-rows', rows);
            }
        }
    }

    /**
     * Build the checkbox lists in the settings modal.
     *
     * Groups tool buttons by their tab (navigate/markup/measure) and creates
     * a labeled checkbox for each tool. Checking/unchecking immediately hides
     * or shows the button and persists the state in localStorage.
     *
     * WHY localStorage for tool visibility:
     *   This is a pure display preference that should persist across sessions
     *   without requiring a server round-trip. Tools themselves are never removed —
     *   just hidden — so the underlying keyboard shortcuts still work.
     */
    _populateSettingsLists() {
        const containers = {
            navigate: document.getElementById('settings-navigate-tools'),
            markup: document.getElementById('settings-markup-tools'),
            measure: document.getElementById('settings-measure-tools'),
        };

        // Clear previous content
        for (const el of Object.values(containers)) {
            if (el) el.innerHTML = '';
        }

        document.querySelectorAll('.tool-btn').forEach(btn => {
            const toolName = btn.dataset.tool;
            if (!toolName) return;

            const tabName = this._TOOL_TAB[toolName] || 'markup';
            const container = containers[tabName];
            if (!container) return;

            // Label = the button's text content (strip leading/trailing whitespace)
            const label = btn.textContent.trim();
            const key = `portolancast-tool-hidden-${toolName}`;
            const isHidden = localStorage.getItem(key) === 'true';

            const item = document.createElement('label');
            item.className = 'settings-tool-item';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !isHidden;  // checked = visible

            // Apply persisted visibility immediately (covers initial page load)
            btn.hidden = isHidden;

            cb.addEventListener('change', () => {
                const hide = !cb.checked;
                btn.hidden = hide;
                if (hide) {
                    localStorage.setItem(key, 'true');
                } else {
                    localStorage.removeItem(key);
                }
            });

            const labelText = document.createElement('label');
            labelText.textContent = label;
            // Point click events on the text label to the checkbox for UX
            const cbId = `settings-cb-${toolName}`;
            cb.id = cbId;
            labelText.htmlFor = cbId;

            item.appendChild(cb);
            item.appendChild(labelText);

            // Extract keyboard shortcut from the button's title attribute.
            // Format expected: "Tool Name (K)" — picks the last parenthesised
            // single uppercase letter or digit near the end of the title.
            const titleAttr = btn.title || '';
            const shortcutMatch = titleAttr.match(/\(([A-Z0-9])\)\s*$/i);
            if (shortcutMatch) {
                const hint = document.createElement('span');
                hint.className = 'settings-shortcut-hint';
                hint.textContent = shortcutMatch[1].toUpperCase();
                item.appendChild(hint);
            }

            container.appendChild(item);
        });
    }

    /**
     * Populate the hotkey editor in the settings modal.
     * Shows each tool with its current key binding in an editable input.
     * Pressing a key in the input rebinds that tool immediately.
     */
    _populateHotkeyEditor() {
        const container = document.getElementById('settings-hotkeys');
        if (!container) return;
        container.innerHTML = '';

        // Build reverse map: tool → key for display
        const toolToKey = {};
        for (const [key, tool] of Object.entries(this._hotkeys)) {
            toolToKey[tool] = key;
        }

        // Friendly tool names
        const TOOL_NAMES = {
            'select': 'Select', 'pen': 'Pen', 'rect': 'Rectangle',
            'ellipse': 'Ellipse', 'line': 'Line', 'highlighter': 'Highlighter',
            'hand': 'Hand/Pan', 'text': 'Text', 'cloud': 'Cloud',
            'connect': 'Connect', 'callout': 'Callout', 'polyline': 'Polyline',
            'distance': 'Distance', 'area': 'Area', 'arrow': 'Arrow',
            'sticky-note': 'Sticky Note', 'image-overlay': 'Image Overlay',
            'count': 'Count', 'calibrate': 'Calibrate', 'equipment-marker': 'Equipment Marker',
            'eraser': 'Eraser', 'polygon': 'Polygon', 'dimension': 'Dimension',
            'arc': 'Arc', 'radius': 'Radius/Diameter',
            'volume': 'Volume', 'cloud-area': 'Cloud+', 'sketch': 'Sketch to Scale',
        };

        // Get all unique tools from defaults (ensures order is stable)
        const tools = Object.values(DEFAULT_HOTKEYS);
        const seen = new Set();

        for (const tool of tools) {
            if (seen.has(tool)) continue;
            seen.add(tool);

            const row = document.createElement('div');
            row.className = 'settings-hotkey-row';

            const label = document.createElement('span');
            label.className = 'settings-hotkey-label';
            label.textContent = TOOL_NAMES[tool] || tool;

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'settings-hotkey-input';
            input.value = toolToKey[tool] || '';
            input.maxLength = 1;
            input.dataset.tool = tool;

            // Capture keypress to rebind
            input.addEventListener('keydown', (e) => {
                e.preventDefault();
                const newKey = e.key;
                if (newKey === 'Escape' || newKey === 'Tab') return;
                // Don't allow system keys
                if (['Control', 'Alt', 'Meta', 'Shift'].includes(newKey)) return;

                // Remove old binding for this tool
                const oldKey = toolToKey[tool];
                if (oldKey) delete this._hotkeys[oldKey];

                // Remove any existing binding for the new key
                const displaced = this._hotkeys[newKey];
                if (displaced) {
                    toolToKey[displaced] = '';
                    // Update the displaced tool's input
                    const displacedInput = container.querySelector(`input[data-tool="${displaced}"]`);
                    if (displacedInput) displacedInput.value = '';
                }

                // Set new binding
                this._hotkeys[newKey] = tool;
                toolToKey[tool] = newKey;
                input.value = newKey;

                // Persist overrides (only save differences from defaults)
                this._saveHotkeys();
            });

            row.appendChild(label);
            row.appendChild(input);
            container.appendChild(row);
        }
    }

    /**
     * Save hotkey overrides to localStorage.
     * Only stores keys that differ from DEFAULT_HOTKEYS to keep storage minimal.
     */
    _saveHotkeys() {
        const overrides = {};
        for (const [key, tool] of Object.entries(this._hotkeys)) {
            if (DEFAULT_HOTKEYS[key] !== tool) {
                overrides[key] = tool;
            }
        }
        // Also store removed defaults
        for (const [key, tool] of Object.entries(DEFAULT_HOTKEYS)) {
            if (!this._hotkeys[key] || this._hotkeys[key] !== tool) {
                // Find where this tool moved to
                const newKey = Object.entries(this._hotkeys).find(([, t]) => t === tool)?.[0];
                if (newKey && newKey !== key) {
                    overrides[newKey] = tool;
                }
            }
        }
        if (Object.keys(overrides).length > 0) {
            localStorage.setItem('portolancast-hotkeys', JSON.stringify(this._hotkeys));
        } else {
            localStorage.removeItem('portolancast-hotkeys');
        }
    }

    // =========================================================================
    // INTENT MODE — markup type selection
    // =========================================================================

    /**
     * Set the active markup type (intent mode).
     *
     * All new markups will be stamped with this type and colored accordingly.
     * Intent-first design: the user declares meaning first, then draws.
     * Flow benefit: one keypress (1-5) sets both meaning and color.
     *
     * If a drawing tool is active, re-applies to update pen/shape color.
     *
     * Args:
     *   type: 'note' | 'issue' | 'question' | 'approval' | 'change'
     */
    setMarkupType(type) {
        this.activeMarkupType = type;

        // If pen tool is active, update brush color immediately
        if (this.canvas && this.canvas.fabricCanvas && this.activeTool === 'pen') {
            const fc = this.canvas.fabricCanvas;
            if (fc.freeDrawingBrush) {
                fc.freeDrawingBrush.color = MARKUP_COLORS[type] || MARKUP_COLORS.note;
            }
        }

        // If a shape tool is active, re-initialize to pick up new color
        if (this.activeTool === 'polyline') {
            this._cleanupShapeDrawing();
            this._initPolylineDrawing();
        } else if (this.activeTool === 'arrow') {
            this._cleanupShapeDrawing();
            this._initArrowDrawing();
        } else if (this.activeTool === 'arc') {
            this._cleanupShapeDrawing();
            this._initArcDrawing();
        } else if (this.activeTool === 'sticky-note') {
            this._cleanupShapeDrawing();
            this._initStickyNotePlacement();
        } else if (['rect', 'ellipse', 'line', 'highlighter', 'cloud', 'callout'].includes(this.activeTool)) {
            this._cleanupShapeDrawing();
            this._initShapeDrawing(this.activeTool);
        }

        if (this.onMarkupTypeChange) this.onMarkupTypeChange(type);
    }

    // =========================================================================
    // SHAPE DRAWING (rect, ellipse, line, highlighter, cloud)
    // =========================================================================

    /**
     * Set up mouse event handlers for interactive shape creation.
     *
     * Pattern:
     *   mousedown → create shape at pointer, add to canvas
     *   mousemove → resize shape to current pointer position
     *   mouseup   → finalize shape, stamp semantic metadata
     *
     * Coordinates use Fabric's getPointer() which returns natural-coord
     * positions regardless of current zoom level.
     *
     * Args:
     *   toolName: 'rect' | 'ellipse' | 'line' | 'highlighter' | 'cloud'
     */
    _initShapeDrawing(toolName) {
        const fc = this.canvas.fabricCanvas;

        // Shared drawing state for the current shape creation gesture
        let isDrawing = false;
        let startX = 0;
        let startY = 0;
        let activeShape = null;

        // Color-as-meaning: use preset override if set (from ToolPresetsPanel._apply),
        // otherwise fall back to the active markup type's canonical color.
        // The override is consumed here and cleared so it only affects one shape.
        const override = this._pendingPresetOverride;
        this._pendingPresetOverride = null;

        const STROKE_COLOR = override?.strokeColor
            || MARKUP_COLORS[this.activeMarkupType]
            || MARKUP_COLORS.note;
        const STROKE_WIDTH = override?.strokeWidth ?? 2;
        const FILL_COLOR = 'transparent';

        // Track last-used values so ToolPresetsPanel can capture them when saving
        this._lastStrokeColor = STROKE_COLOR;
        this._lastStrokeWidth = STROKE_WIDTH;

        // --- mousedown: create the shape at the click point ---
        const onMouseDown = (opt) => {
            // Ignore if clicking on an existing object (let select behavior work)
            if (opt.target) return;

            isDrawing = true;
            const pointer = fc.getPointer(opt.e);
            startX = pointer.x;
            startY = pointer.y;

            switch (toolName) {
                case 'rect':
                    activeShape = new fabric.Rect({
                        left: startX,
                        top: startY,
                        width: 0,
                        height: 0,
                        fill: FILL_COLOR,
                        stroke: STROKE_COLOR,
                        strokeWidth: STROKE_WIDTH,
                        strokeUniform: true,
                        selectable: true,
                    });
                    break;

                case 'ellipse':
                    activeShape = new fabric.Ellipse({
                        left: startX,
                        top: startY,
                        rx: 0,
                        ry: 0,
                        fill: FILL_COLOR,
                        stroke: STROKE_COLOR,
                        strokeWidth: STROKE_WIDTH,
                        strokeUniform: true,
                        selectable: true,
                    });
                    break;

                case 'line':
                    activeShape = new fabric.Line(
                        [startX, startY, startX, startY],
                        {
                            stroke: STROKE_COLOR,
                            strokeWidth: STROKE_WIDTH,
                            strokeUniform: true,
                            selectable: true,
                        }
                    );
                    break;

                case 'highlighter':
                    // Filled semi-transparent rect — overlays text for highlighting
                    activeShape = new fabric.Rect({
                        left: startX,
                        top: startY,
                        width: 0,
                        height: 0,
                        fill: STROKE_COLOR,
                        opacity: 0.25,
                        stroke: null,
                        strokeWidth: 0,
                        selectable: true,
                    });
                    break;

                case 'cloud': {
                    // Cloud uses a Path with arc bumps — start with a tiny placeholder
                    const pathStr = this._generateCloudPath(startX, startY, 1, 1);
                    activeShape = new fabric.Path(pathStr, {
                        left: startX,
                        top: startY,
                        fill: FILL_COLOR,
                        stroke: STROKE_COLOR,
                        strokeWidth: STROKE_WIDTH,
                        strokeUniform: true,
                        selectable: true,
                    });
                    break;
                }
            }

            if (activeShape) {
                fc.add(activeShape);
                fc.renderAll();
            }
        };

        // --- mousemove: resize the shape as the user drags ---
        const onMouseMove = (opt) => {
            if (!isDrawing || !activeShape) return;

            const pointer = fc.getPointer(opt.e);
            const curX = pointer.x;
            const curY = pointer.y;

            switch (toolName) {
                case 'rect': {
                    // Support drawing in any direction (handle negative width/height)
                    const left = Math.min(startX, curX);
                    const top = Math.min(startY, curY);
                    const width = Math.abs(curX - startX);
                    const height = Math.abs(curY - startY);
                    activeShape.set({ left, top, width, height });
                    break;
                }

                case 'ellipse': {
                    // Ellipse drawn from corner — rx/ry are half-widths
                    const left = Math.min(startX, curX);
                    const top = Math.min(startY, curY);
                    const rx = Math.abs(curX - startX) / 2;
                    const ry = Math.abs(curY - startY) / 2;
                    activeShape.set({ left, top, rx, ry });
                    break;
                }

                case 'line':
                    activeShape.set({ x2: curX, y2: curY });
                    break;

                case 'highlighter': {
                    // Same resize logic as rect — drag in any direction
                    const left = Math.min(startX, curX);
                    const top = Math.min(startY, curY);
                    const width = Math.abs(curX - startX);
                    const height = Math.abs(curY - startY);
                    activeShape.set({ left, top, width, height });
                    break;
                }

                case 'cloud': {
                    // Cloud path must be regenerated since arc count changes with size.
                    // Remove old path and create new one with updated dimensions.
                    const left = Math.min(startX, curX);
                    const top = Math.min(startY, curY);
                    const w = Math.abs(curX - startX);
                    const h = Math.abs(curY - startY);
                    if (w > 2 && h > 2) {
                        fc.remove(activeShape);
                        const pathStr = this._generateCloudPath(0, 0, w, h);
                        activeShape = new fabric.Path(pathStr, {
                            left: left,
                            top: top,
                            fill: FILL_COLOR,
                            stroke: STROKE_COLOR,
                            strokeWidth: STROKE_WIDTH,
                            strokeUniform: true,
                            selectable: true,
                        });
                        fc.add(activeShape);
                    }
                    break;
                }
            }

            fc.renderAll();
        };

        // --- mouseup: finalize the shape and stamp metadata ---
        const onMouseUp = () => {
            if (!isDrawing || !activeShape) return;
            isDrawing = false;

            // Don't keep zero-size shapes (accidental clicks)
            const isTooSmall = this._isShapeTooSmall(activeShape, toolName);
            if (isTooSmall) {
                fc.remove(activeShape);
                activeShape = null;
                fc.renderAll();
                return;
            }

            // Stamp semantic metadata with active intent type — every markup is a data point
            // preserveColor: true because STROKE_COLOR already matches the type
            this.canvas.stampDefaults(activeShape, {
                markupType: this.activeMarkupType,
                preserveColor: true,
            });

            activeShape.setCoords();
            fc.setActiveObject(activeShape);
            fc.renderAll();

            activeShape = null;
        };

        // Register handlers on the Fabric canvas
        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up', onMouseUp);

        // Store references for cleanup when tool changes
        this._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up': onMouseUp,
        };
    }

    // =========================================================================
    // STAMP MODE — ghost cursor + repeat-click placement of component PNGs
    // =========================================================================

    /**
     * Initialize stamp mode — ghost cursor + repeat click placement.
     *
     * Reads this._stampComponent (set by ComponentLibrary._enterStampMode).
     * Places fabric.Image copies on each click. Escape exits.
     */
    _initStampMode() {
        const comp = this._stampComponent;
        if (!comp) {
            this.setTool('select');
            return;
        }

        const fc = this.canvas.fabricCanvas;
        let ghost = null;

        // Load the component PNG as a fabric.Image for the ghost preview
        fabric.Image.fromURL(comp.png_url).then((img) => {
            const maxDim = 200;
            const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
            img.scale(scale);
            img.set({
                opacity: 0.5,
                evented: false,
                selectable: false,
                excludeFromExport: true,
            });
            ghost = img;
            this._stampGhost = ghost;
            fc.add(ghost);
            fc.renderAll();
        }).catch((err) => {
            console.error('[Stamp] Failed to load ghost image:', err);
        });

        const onMouseMove = (opt) => {
            if (!ghost) return;
            const ptr = fc.getPointer(opt.e);
            ghost.set({
                left: ptr.x - (ghost.getScaledWidth() / 2),
                top: ptr.y - (ghost.getScaledHeight() / 2),
            });
            fc.renderAll();
        };

        const onMouseDown = async (opt) => {
            if (opt.e.button !== 0) return;
            const ptr = fc.getPointer(opt.e);

            try {
                const img = await fabric.Image.fromURL(comp.png_url);
                if (ghost) {
                    img.scale(ghost.scaleX);
                }
                img.set({
                    left: ptr.x - (img.getScaledWidth() / 2),
                    top: ptr.y - (img.getScaledHeight() / 2),
                });
                img.componentId = comp.id;
                this.canvas.stampDefaults(img, {
                    markupType: 'component-stamp',
                    preserveColor: true,
                });
                img.set({ stroke: 'transparent', strokeWidth: 0 });
                fc.add(img);
                fc.renderAll();
                console.log('[Stamp] Placed:', comp.name);

                // Auto-open entity panel for equipment symbols
                if (comp.prompt_entity && window.app?.equipmentMarkerPanel) {
                    window.app.equipmentMarkerPanel.open(img);
                }
            } catch (err) {
                console.error('[Stamp] Placement failed:', err);
            }
        };

        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:down', onMouseDown);

        this._shapeHandlers = {
            'mouse:move': onMouseMove,
            'mouse:down': onMouseDown,
        };
    }

    /**
     * Check if a shape is too small to keep (accidental click, no drag).
     *
     * Args:
     *   shape: Fabric object to check.
     *   toolName: 'rect' | 'ellipse' | 'line' | 'highlighter' | 'cloud'
     *
     * Returns:
     *   boolean — true if the shape should be discarded.
     */
    _isShapeTooSmall(shape, toolName) {
        // Minimum 3px in natural coords to be considered intentional
        const MIN_SIZE = 3;
        switch (toolName) {
            case 'rect':
            case 'highlighter':
                return shape.width < MIN_SIZE && shape.height < MIN_SIZE;
            case 'ellipse':
                return shape.rx < MIN_SIZE && shape.ry < MIN_SIZE;
            case 'line': {
                const dx = shape.x2 - shape.x1;
                const dy = shape.y2 - shape.y1;
                return Math.sqrt(dx * dx + dy * dy) < MIN_SIZE;
            }
            case 'cloud': {
                // Cloud Path — check bounding box dimensions
                const bounds = shape.getBoundingRect(true);
                return bounds.width < MIN_SIZE && bounds.height < MIN_SIZE;
            }
            default:
                return false;
        }
    }

    /**
     * Remove shape drawing mouse event handlers from the Fabric canvas.
     * Called when switching tools to prevent stale handlers.
     */
    _cleanupShapeDrawing() {
        if (!this._shapeHandlers || !this.canvas || !this.canvas.fabricCanvas) return;

        const fc = this.canvas.fabricCanvas;
        for (const [event, handler] of Object.entries(this._shapeHandlers)) {
            fc.off(event, handler);
        }
        this._shapeHandlers = null;
    }

    // =========================================================================
    // ARROW DRAWING (click-drag: tail at mousedown, tip + arrowhead at mouseup)
    // =========================================================================

    /**
     * Set up the click-drag interaction for the Arrow markup tool.
     *
     * Interaction model:
     *   mousedown → fix the tail (start) of the arrow
     *   mousemove → live preview of the shaft (plain Line — no arrowhead during drag)
     *   mouseup   → finalise: remove preview, compute arrowhead geometry, create
     *               a Fabric Group containing the shaft Line + filled arrowhead Path
     *
     * Arrowhead geometry:
     *   Two wing segments radiate backward from the tip at ±WING_ANGLE (30°).
     *   The shaft is shortened by 60% of ARROW_SIZE so the line doesn't poke
     *   through the filled arrowhead triangle.
     *
     *   Wing coordinates:
     *     wing = tip - ARROW_SIZE * [cos(lineAngle ± WING_ANGLE),
     *                                sin(lineAngle ± WING_ANGLE)]
     *
     * Why a Group:
     *   Grouping shaft + arrowhead keeps them as one selectable / moveable /
     *   deleteable unit under the Select tool without any extra tracking.
     *   markupType metadata is stamped on the Group (not on its children),
     *   consistent with how Callout uses a Group.
     */
    // =========================================================================
    // HARVEST DRAWING — drag rectangle, name + tag the captured region
    // =========================================================================

    _initHarvestDrawing() {
        const fc = this.canvas.fabricCanvas;
        let isDrawing = false;
        let startX, startY;
        let harvestRect = null;

        const onMouseDown = (opt) => {
            if (opt.e.button !== 0) return;
            const ptr = fc.getPointer(opt.e);
            startX = ptr.x;
            startY = ptr.y;
            isDrawing = true;

            harvestRect = new fabric.Rect({
                left: startX,
                top: startY,
                width: 0,
                height: 0,
                fill: 'rgba(85, 153, 204, 0.15)',
                stroke: '#5599cc',
                strokeWidth: 2,
                strokeDashArray: [6, 4],
                strokeUniform: true,
                selectable: false,
                evented: false,
            });
            fc.add(harvestRect);
        };

        const onMouseMove = (opt) => {
            if (!isDrawing || !harvestRect) return;
            const ptr = fc.getPointer(opt.e);
            const left = Math.min(startX, ptr.x);
            const top = Math.min(startY, ptr.y);
            const width = Math.abs(ptr.x - startX);
            const height = Math.abs(ptr.y - startY);
            harvestRect.set({ left, top, width, height });
            fc.renderAll();
        };

        const onMouseUp = () => {
            if (!isDrawing || !harvestRect) return;
            isDrawing = false;

            const rect = harvestRect;
            const w = rect.width;
            const h = rect.height;

            if (w < 10 || h < 10) {
                fc.remove(rect);
                fc.renderAll();
                return;
            }

            this._showHarvestDialog(rect);
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up', onMouseUp);

        this._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up': onMouseUp,
        };
    }

    _showHarvestDialog(harvestRect) {
        const fc = this.canvas.fabricCanvas;
        const dialog = document.getElementById('harvest-dialog');
        if (!dialog) return;

        const nameInput = dialog.querySelector('#harvest-name');
        const tagsInput = dialog.querySelector('#harvest-tags');
        const saveBtn = dialog.querySelector('#harvest-save');
        const cancelBtn = dialog.querySelector('#harvest-cancel');

        nameInput.value = '';
        tagsInput.value = '';
        dialog.style.display = 'block';
        nameInput.focus();

        const cleanup = () => {
            dialog.style.display = 'none';
            fc.remove(harvestRect);
            fc.renderAll();
            saveBtn.removeEventListener('click', onSave);
            cancelBtn.removeEventListener('click', onCancel);
            nameInput.removeEventListener('keydown', onKeydown);
            tagsInput.removeEventListener('keydown', onTagsKeydown);
        };

        const onSave = async () => {
            const name = nameInput.value.trim();
            if (!name) { nameInput.focus(); return; }

            const tags = tagsInput.value.split(',')
                .map(t => t.trim().toLowerCase())
                .filter(t => t.length > 0);

            const scale = 72 / 150;
            const rect = {
                x: harvestRect.left * scale,
                y: harvestRect.top * scale,
                w: harvestRect.width * scale,
                h: harvestRect.height * scale,
            };

            const docId = this.viewer?.docId;
            const page = this.viewer?.currentPage ?? 0;

            const pdfLayerPanel = window.app?.pdfLayerPanel;
            const hiddenLayers = pdfLayerPanel?._hidden
                ? [...pdfLayerPanel._hidden] : [];

            try {
                const resp = await fetch('/api/components/harvest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        doc_id: docId,
                        page: page,
                        rect: rect,
                        hidden_layers: hiddenLayers,
                        name: name,
                        tags: tags,
                    }),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                console.log('[Harvest] Component saved:', data.name, data.id);
                window.dispatchEvent(new CustomEvent('component-harvested', { detail: data }));
            } catch (err) {
                console.error('[Harvest] Failed:', err);
            }

            cleanup();
            this.setTool('select');
        };

        const onCancel = () => {
            cleanup();
            this.setTool('select');
        };

        const onKeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onSave(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        };

        const onTagsKeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onSave(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        };

        saveBtn.addEventListener('click', onSave);
        cancelBtn.addEventListener('click', onCancel);
        nameInput.addEventListener('keydown', onKeydown);
        tagsInput.addEventListener('keydown', onTagsKeydown);
    }

    // =========================================================================
    // ARC DRAWING — click start, drag end, arc bulges perpendicular to chord
    // =========================================================================

    /**
     * Initialize the arc drawing tool.
     *
     * Interaction:
     *   mousedown → record start point
     *   mousemove → preview arc (semicircle from start to cursor)
     *   mouseup → commit the arc as a Path object
     *
     * The arc is a semicircle (180 degrees) bulging perpendicular to the chord
     * (the line from start to end). The bulge direction is the left side of the
     * chord vector (counterclockwise). Users can flip/rotate after placement.
     */
    _initArcDrawing() {
        const fc = this.canvas.fabricCanvas;

        const override = this._pendingPresetOverride;
        this._pendingPresetOverride = null;
        const STROKE_COLOR = override?.strokeColor
            || MARKUP_COLORS[this.activeMarkupType]
            || MARKUP_COLORS.note;
        const STROKE_WIDTH = override?.strokeWidth ?? 2;

        this._lastStrokeColor = STROKE_COLOR;
        this._lastStrokeWidth = STROKE_WIDTH;

        let isDrawing = false;
        let startX = 0;
        let startY = 0;
        let previewPath = null;

        /**
         * Build an SVG arc path string for a semicircle from (x1,y1) to (x2,y2).
         * Uses SVG 'A' (arc) command with rx=ry=radius, sweep-flag=1 (clockwise).
         */
        const buildArcPath = (x1, y1, x2, y2) => {
            const dx = x2 - x1;
            const dy = y2 - y1;
            const chordLen = Math.sqrt(dx * dx + dy * dy);
            if (chordLen < 2) return null;

            // Radius = half the chord length (semicircle)
            const radius = chordLen / 2;

            // SVG arc: M x1,y1 A rx ry x-rotation large-arc-flag sweep-flag x2,y2
            // large-arc-flag=0 (minor arc for semicircle), sweep-flag=1 (clockwise bulge)
            return `M ${x1} ${y1} A ${radius} ${radius} 0 0 1 ${x2} ${y2}`;
        };

        const onMouseDown = (opt) => {
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);
            isDrawing = true;
            startX = pointer.x;
            startY = pointer.y;
        };

        const onMouseMove = (opt) => {
            if (!isDrawing) return;

            const pointer = fc.getPointer(opt.e);
            const pathStr = buildArcPath(startX, startY, pointer.x, pointer.y);
            if (!pathStr) return;

            // Remove old preview
            if (previewPath) {
                fc.remove(previewPath);
            }

            previewPath = new fabric.Path(pathStr, {
                fill: 'transparent',
                stroke: STROKE_COLOR,
                strokeWidth: STROKE_WIDTH,
                strokeUniform: true,
                strokeDashArray: [6, 3],
                selectable: false,
                evented: false,
            });
            fc.add(previewPath);
            fc.renderAll();
        };

        const onMouseUp = (opt) => {
            if (!isDrawing) return;
            isDrawing = false;

            if (previewPath) {
                fc.remove(previewPath);
                previewPath = null;
            }

            const pointer = fc.getPointer(opt.e);
            const dx = pointer.x - startX;
            const dy = pointer.y - startY;
            const chordLen = Math.sqrt(dx * dx + dy * dy);

            if (chordLen < 5) {
                fc.renderAll();
                return;
            }

            const pathStr = buildArcPath(startX, startY, pointer.x, pointer.y);
            if (!pathStr) return;

            const arcPath = new fabric.Path(pathStr, {
                fill: 'transparent',
                stroke: STROKE_COLOR,
                strokeWidth: STROKE_WIDTH,
                strokeUniform: true,
                selectable: true,
            });

            // Stamp semantic metadata
            this.canvas.stampDefaults(arcPath);

            fc.add(arcPath);
            fc.setActiveObject(arcPath);
            fc.renderAll();
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up', onMouseUp);

        this._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up': onMouseUp,
        };
    }

    _initArrowDrawing() {
        const fc = this.canvas.fabricCanvas;
        const STROKE_COLOR = MARKUP_COLORS[this.activeMarkupType] || MARKUP_COLORS.note;
        const STROKE_WIDTH = 2;
        /** Arrowhead wing length in canvas pixels (natural coords) */
        const ARROW_SIZE   = 14;
        /** Half-angle of the arrowhead opening (30° each side) */
        const WING_ANGLE   = Math.PI / 6;

        let isDrawing = false;
        let startX = 0, startY = 0;
        /** @type {fabric.Line|null} Preview shaft shown during drag */
        let tempLine = null;

        // ── Event handlers ────────────────────────────────────────────────────

        const onMouseDown = (opt) => {
            // Ignore clicks that land on an existing markup object
            if (opt.target) return;

            isDrawing = true;
            const pointer = fc.getPointer(opt.e);
            startX = pointer.x;
            startY = pointer.y;

            // Live shaft preview — no arrowhead until mouseup (keeps mousemove fast)
            tempLine = new fabric.Line(
                [startX, startY, startX, startY],
                {
                    stroke: STROKE_COLOR,
                    strokeWidth: STROKE_WIDTH,
                    strokeUniform: true,
                    selectable: false,
                    evented: false,
                }
            );
            fc.add(tempLine);
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (!isDrawing || !tempLine) return;
            const pointer = fc.getPointer(opt.e);
            tempLine.set({ x2: pointer.x, y2: pointer.y });
            fc.renderAll();
        };

        const onMouseUp = (opt) => {
            if (!isDrawing || !tempLine) return;
            isDrawing = false;

            const pointer = fc.getPointer(opt.e);
            const endX = pointer.x;
            const endY = pointer.y;

            // Remove the preview shaft
            fc.remove(tempLine);
            tempLine = null;

            // Discard accidental zero-length arrows (misclick, no drag)
            const dx = endX - startX;
            const dy = endY - startY;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 3) {
                fc.renderAll();
                return;
            }

            // ── Arrowhead geometry ────────────────────────────────────────────
            const angle = Math.atan2(dy, dx);

            // Wing tips: point backward from the arrowhead tip at ±WING_ANGLE
            const wing1x = endX - ARROW_SIZE * Math.cos(angle - WING_ANGLE);
            const wing1y = endY - ARROW_SIZE * Math.sin(angle - WING_ANGLE);
            const wing2x = endX - ARROW_SIZE * Math.cos(angle + WING_ANGLE);
            const wing2y = endY - ARROW_SIZE * Math.sin(angle + WING_ANGLE);

            // Shorten the shaft so it terminates inside the arrowhead, not at
            // the visible tip — prevents the line end from poking through the fill.
            const shaftEndX = endX - ARROW_SIZE * 0.6 * Math.cos(angle);
            const shaftEndY = endY - ARROW_SIZE * 0.6 * Math.sin(angle);

            // ── Shaft ─────────────────────────────────────────────────────────
            const shaft = new fabric.Line(
                [startX, startY, shaftEndX, shaftEndY],
                {
                    stroke: STROKE_COLOR,
                    strokeWidth: STROKE_WIDTH,
                    strokeUniform: true,
                    selectable: false,
                    evented: false,
                }
            );

            // ── Filled arrowhead triangle ─────────────────────────────────────
            // Path: move to tip → wing1 → wing2 → close (Z fills the triangle)
            const headPathStr = `M ${endX},${endY} L ${wing1x},${wing1y} L ${wing2x},${wing2y} Z`;
            const head = new fabric.Path(headPathStr, {
                fill: STROKE_COLOR,
                stroke: STROKE_COLOR,
                strokeWidth: 1,
                strokeLineJoin: 'round',
                strokeUniform: true,
                selectable: false,
                evented: false,
            });

            // ── Group shaft + arrowhead into one selectable markup object ──────
            const arrow = new fabric.Group([shaft, head], {
                selectable: true,
            });
            fc.add(arrow);

            // Stamp semantic metadata — preserveColor because STROKE_COLOR already
            // matches the active intent type
            this.canvas.stampDefaults(arrow, {
                markupType: this.activeMarkupType,
                preserveColor: true,
            });

            arrow.setCoords();
            fc.setActiveObject(arrow);
            fc.renderAll();
        };

        // ── Handler registration ──────────────────────────────────────────────

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up',   onMouseUp);

        this._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up':   onMouseUp,
        };
    }

    // =========================================================================
    // POLYLINE DRAWING (click to add points, double-click to finish)
    // =========================================================================

    /**
     * Set up the click-accumulate-dblclick interaction for the Polyline tool.
     *
     * Interaction model:
     *   1st click      → first vertex placed; rubber-band line begins
     *   Subsequent clicks → each adds a vertex; preview polyline extends
     *   Double-click   → finalises the polyline (min 2 segments = 3 points,
     *                    or 2 points for a single-segment polyline)
     *   Escape         → cancels via setTool(null) which calls _cleanupShapeDrawing
     *
     * Why Fabric fires mouse:down twice on dblclick:
     *   Fabric synthesises mouse:down before mouse:dblclick, so by the time
     *   onDblClick fires the last vertex has been added once by onMouseDown.
     *   We pop() that duplicate before building the final object — same
     *   technique used by the Area measurement tool.
     *
     * Temp objects (preview polyline + rubber-band line) are marked
     * evented:false so they never intercept the user's clicks.
     *
     * Cleanup override:
     *   The instance-level _cleanupShapeDrawing() override removes temp canvas
     *   objects before the standard handler-removal logic runs, then deletes
     *   itself to restore the prototype method for subsequent tool activations.
     */
    _initPolylineDrawing() {
        const fc = this.canvas.fabricCanvas;
        const STROKE_COLOR = MARKUP_COLORS[this.activeMarkupType] || MARKUP_COLORS.note;
        const STROKE_WIDTH = 2;

        /** @type {Array<{x:number, y:number}>} Accumulated vertex list in canvas coords */
        let vertices = [];

        /** @type {fabric.Polyline|null} Live preview rebuilt after each click */
        let previewPolyline = null;

        /** @type {fabric.Line|null} Rubber-band from last confirmed point to cursor */
        let rubberBand = null;

        // ── Helpers ──────────────────────────────────────────────────────────

        /** Remove all in-progress temp objects from the canvas. */
        const clearTemp = () => {
            if (previewPolyline) { fc.remove(previewPolyline); previewPolyline = null; }
            if (rubberBand)      { fc.remove(rubberBand);      rubberBand = null; }
        };

        /**
         * Rebuild the preview Polyline from the current vertex list.
         * Called after every click so the committed path is always visible.
         * Requires at least 2 vertices (a single segment) before drawing.
         */
        const rebuildPreview = () => {
            if (previewPolyline) { fc.remove(previewPolyline); previewPolyline = null; }
            if (vertices.length < 2) return;

            previewPolyline = new fabric.Polyline([...vertices], {
                stroke: STROKE_COLOR,
                strokeWidth: STROKE_WIDTH,
                strokeUniform: true,
                fill: 'transparent',
                selectable: false,    // must not respond to selection clicks during construction
                evented: false,       // must not intercept mouse events during construction
                objectCaching: false, // always re-render so path stays sharp during construction
            });
            fc.add(previewPolyline);
        };

        // ── Event handlers ────────────────────────────────────────────────────

        const onMouseDown = (opt) => {
            // Ignore clicks that land on existing permanent objects (not our temp objects).
            // previewPolyline and rubberBand have evented:false so they never appear
            // as opt.target — we only need to guard against real user objects.
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);

            if (vertices.length === 0) {
                // First click — start rubber-band from this point
                rubberBand = new fabric.Line(
                    [pointer.x, pointer.y, pointer.x, pointer.y],
                    {
                        stroke: STROKE_COLOR,
                        strokeWidth: STROKE_WIDTH,
                        strokeDashArray: [6, 4],  // dashed = in-progress indicator
                        strokeUniform: true,
                        selectable: false,
                        evented: false,
                        objectCaching: false,
                    }
                );
                fc.add(rubberBand);
            } else {
                // Subsequent click — snap rubber-band start to the new latest vertex
                rubberBand.set({ x1: pointer.x, y1: pointer.y,
                                 x2: pointer.x, y2: pointer.y });
                rebuildPreview();
            }

            vertices.push({ x: pointer.x, y: pointer.y });
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (vertices.length === 0 || !rubberBand) return;

            // Update rubber-band endpoint to follow the cursor
            const pointer = fc.getPointer(opt.e);
            rubberBand.set({ x2: pointer.x, y2: pointer.y });
            fc.renderAll();
        };

        const onDblClick = (opt) => {
            // IMPORTANT: Fabric fires mouse:down once before mouse:dblclick fires,
            // so the final click point has already been appended to vertices by
            // onMouseDown. Pop it to avoid a duplicate terminal vertex.
            if (vertices.length > 0) vertices.pop();

            // Need at least 2 points to make a valid single-segment polyline
            if (vertices.length < 2) {
                clearTemp();
                vertices = [];
                fc.renderAll();
                return;
            }

            clearTemp();

            // Build the permanent Polyline and add it to the canvas
            const finalPolyline = new fabric.Polyline([...vertices], {
                stroke: STROKE_COLOR,
                strokeWidth: STROKE_WIDTH,
                strokeUniform: true,
                fill: 'transparent',
                selectable: true,
            });

            fc.add(finalPolyline);

            // Stamp semantic metadata — same pattern as all other markup tools
            this.canvas.stampDefaults(finalPolyline, {
                markupType: this.activeMarkupType,
                preserveColor: true,
            });

            finalPolyline.setCoords();
            fc.setActiveObject(finalPolyline);
            fc.renderAll();

            vertices = [];

            // Auto-switch to select so the user can immediately move/inspect
            // the freshly created polyline — same one-shot pattern as text tool.
            this.setTool('select');
        };

        // ── Handler registration ──────────────────────────────────────────────

        fc.on('mouse:down',    onMouseDown);
        fc.on('mouse:move',    onMouseMove);
        fc.on('mouse:dblclick', onDblClick);

        // Store for the standard cleanup path (removes event listeners)
        this._shapeHandlers = {
            'mouse:down':    onMouseDown,
            'mouse:move':    onMouseMove,
            'mouse:dblclick': onDblClick,
        };

        // ── Cleanup override ──────────────────────────────────────────────────
        // Override the instance-level cleanup to also remove temp canvas objects.
        // Uses instance property so 'delete this._cleanupShapeDrawing' restores
        // the prototype method for all subsequent tool activations.
        this._cleanupShapeDrawing = () => {
            clearTemp();
            vertices = [];

            // Remove all registered event handlers
            const fc2 = this.canvas && this.canvas.fabricCanvas;
            if (fc2 && this._shapeHandlers) {
                for (const [ev, fn] of Object.entries(this._shapeHandlers)) {
                    fc2.off(ev, fn);
                }
                this._shapeHandlers = null;
            }

            // Restore prototype method for future tool activations
            delete this._cleanupShapeDrawing;
        };
    }

    // =========================================================================
    // POLYGON DRAWING (click-accumulate-dblclick, closed + filled)
    // =========================================================================

    /**
     * Set up the click-accumulate-dblclick interaction for drawing a filled polygon.
     * Same vertex accumulation pattern as polyline, but creates a closed fabric.Polygon
     * with semi-transparent fill on completion.
     */
    _initPolygonDrawing() {
        const fc = this.canvas.fabricCanvas;
        const STROKE_COLOR = MARKUP_COLORS[this.activeMarkupType] || MARKUP_COLORS.note;
        const STROKE_WIDTH = 2;

        let vertices = [];
        let previewPolyline = null;
        let rubberBand = null;
        /** @type {fabric.Line|null} Closing line preview from last vertex to first */
        let closingLine = null;

        const clearTemp = () => {
            if (previewPolyline) { fc.remove(previewPolyline); previewPolyline = null; }
            if (rubberBand)      { fc.remove(rubberBand);      rubberBand = null; }
            if (closingLine)     { fc.remove(closingLine);     closingLine = null; }
        };

        const rebuildPreview = () => {
            if (previewPolyline) { fc.remove(previewPolyline); previewPolyline = null; }
            if (closingLine)     { fc.remove(closingLine);     closingLine = null; }
            if (vertices.length < 2) return;

            // Show the accumulated path as an open polyline
            previewPolyline = new fabric.Polyline([...vertices], {
                stroke: STROKE_COLOR,
                strokeWidth: STROKE_WIDTH,
                strokeUniform: true,
                fill: 'transparent',
                selectable: false,
                evented: false,
                objectCaching: false,
            });
            fc.add(previewPolyline);

            // Show closing line (dashed) from last vertex back to first
            if (vertices.length >= 3) {
                const first = vertices[0];
                const last = vertices[vertices.length - 1];
                closingLine = new fabric.Line(
                    [last.x, last.y, first.x, first.y],
                    {
                        stroke: STROKE_COLOR,
                        strokeWidth: 1,
                        strokeDashArray: [4, 4],
                        strokeUniform: true,
                        selectable: false,
                        evented: false,
                        objectCaching: false,
                    }
                );
                fc.add(closingLine);
            }
        };

        const onMouseDown = (opt) => {
            if (opt.target) return;
            const pointer = fc.getPointer(opt.e);

            if (vertices.length === 0) {
                rubberBand = new fabric.Line(
                    [pointer.x, pointer.y, pointer.x, pointer.y],
                    {
                        stroke: STROKE_COLOR,
                        strokeWidth: STROKE_WIDTH,
                        strokeDashArray: [6, 4],
                        strokeUniform: true,
                        selectable: false,
                        evented: false,
                        objectCaching: false,
                    }
                );
                fc.add(rubberBand);
            } else {
                rubberBand.set({ x1: pointer.x, y1: pointer.y,
                                 x2: pointer.x, y2: pointer.y });
                rebuildPreview();
            }

            vertices.push({ x: pointer.x, y: pointer.y });
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (vertices.length === 0 || !rubberBand) return;
            const pointer = fc.getPointer(opt.e);
            rubberBand.set({ x2: pointer.x, y2: pointer.y });
            fc.renderAll();
        };

        const onDblClick = (opt) => {
            // Pop the duplicate vertex from the extra mousedown before dblclick
            if (vertices.length > 0) vertices.pop();

            // Need at least 3 points for a closed polygon
            if (vertices.length < 3) {
                clearTemp();
                vertices = [];
                fc.renderAll();
                return;
            }

            clearTemp();

            // Build the permanent filled Polygon
            const finalPolygon = new fabric.Polygon([...vertices], {
                stroke: STROKE_COLOR,
                strokeWidth: STROKE_WIDTH,
                strokeUniform: true,
                fill: STROKE_COLOR,
                opacity: 0.25,
                selectable: true,
            });

            fc.add(finalPolygon);
            this.canvas.stampDefaults(finalPolygon, {
                markupType: this.activeMarkupType,
                preserveColor: true,
            });

            finalPolygon.setCoords();
            fc.setActiveObject(finalPolygon);
            fc.renderAll();

            vertices = [];
            this.setTool('select');
        };

        fc.on('mouse:down',    onMouseDown);
        fc.on('mouse:move',    onMouseMove);
        fc.on('mouse:dblclick', onDblClick);

        this._shapeHandlers = {
            'mouse:down':    onMouseDown,
            'mouse:move':    onMouseMove,
            'mouse:dblclick': onDblClick,
        };

        this._cleanupShapeDrawing = () => {
            clearTemp();
            vertices = [];
            const fc2 = this.canvas && this.canvas.fabricCanvas;
            if (fc2 && this._shapeHandlers) {
                for (const [ev, fn] of Object.entries(this._shapeHandlers)) {
                    fc2.off(ev, fn);
                }
                this._shapeHandlers = null;
            }
            delete this._cleanupShapeDrawing;
        };
    }

    // =========================================================================
    // DIMENSION LINE (click-drag line with auto-calculated measurement text)
    // =========================================================================

    /**
     * Set up click-drag interaction for dimension lines.
     * Creates a Group containing the line + tick marks + measurement text.
     * Text is auto-calculated from the document's scale calibration.
     */
    _initDimensionDrawing() {
        const fc = this.canvas.fabricCanvas;
        const STROKE_COLOR = MARKUP_COLORS[this.activeMarkupType] || MARKUP_COLORS.note;
        const STROKE_WIDTH = 2;
        const TICK_SIZE = 10; // perpendicular tick height at each end

        let isDrawing = false;
        let startX = 0, startY = 0;
        let tempLine = null;

        const onMouseDown = (opt) => {
            if (opt.target) return;
            isDrawing = true;
            const pointer = fc.getPointer(opt.e);
            startX = pointer.x;
            startY = pointer.y;

            tempLine = new fabric.Line(
                [startX, startY, startX, startY],
                {
                    stroke: STROKE_COLOR,
                    strokeWidth: STROKE_WIDTH,
                    strokeUniform: true,
                    selectable: false,
                    evented: false,
                }
            );
            fc.add(tempLine);
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (!isDrawing || !tempLine) return;
            const pointer = fc.getPointer(opt.e);
            tempLine.set({ x2: pointer.x, y2: pointer.y });
            fc.renderAll();
        };

        const onMouseUp = (opt) => {
            if (!isDrawing || !tempLine) return;
            isDrawing = false;

            const pointer = fc.getPointer(opt.e);
            const endX = pointer.x;
            const endY = pointer.y;

            fc.remove(tempLine);
            tempLine = null;

            // Calculate pixel distance
            const dx = endX - startX;
            const dy = endY - startY;
            const pixelLen = Math.sqrt(dx * dx + dy * dy);

            if (pixelLen < 5) {
                fc.renderAll();
                return;
            }

            // Get real-world measurement from scale
            let label = `${Math.round(pixelLen)}px`;
            if (window.app && window.app.scale) {
                label = window.app.scale.formatDistance(pixelLen, 1);
            }

            // Calculate perpendicular direction for tick marks
            const angle = Math.atan2(dy, dx);
            const perpX = Math.cos(angle + Math.PI / 2) * TICK_SIZE / 2;
            const perpY = Math.sin(angle + Math.PI / 2) * TICK_SIZE / 2;

            // Build the dimension line group
            const mainLine = new fabric.Line([startX, startY, endX, endY], {
                stroke: STROKE_COLOR,
                strokeWidth: STROKE_WIDTH,
                strokeUniform: true,
            });

            const tick1 = new fabric.Line(
                [startX - perpX, startY - perpY, startX + perpX, startY + perpY],
                { stroke: STROKE_COLOR, strokeWidth: STROKE_WIDTH, strokeUniform: true }
            );

            const tick2 = new fabric.Line(
                [endX - perpX, endY - perpY, endX + perpX, endY + perpY],
                { stroke: STROKE_COLOR, strokeWidth: STROKE_WIDTH, strokeUniform: true }
            );

            // Measurement text at midpoint, offset above the line
            const midX = (startX + endX) / 2;
            const midY = (startY + endY) / 2;
            const textOffset = 12;
            const labelText = new fabric.IText(label, {
                left: midX + perpX * (textOffset / (TICK_SIZE / 2)),
                top: midY + perpY * (textOffset / (TICK_SIZE / 2)),
                fontSize: 14,
                fill: STROKE_COLOR,
                fontFamily: 'Arial, sans-serif',
                originX: 'center',
                originY: 'center',
                angle: (angle * 180 / Math.PI),
                selectable: false,
                evented: false,
            });

            // Flip text if it would be upside down
            if (labelText.angle > 90 || labelText.angle < -90) {
                labelText.angle += 180;
            }

            const group = new fabric.Group([mainLine, tick1, tick2, labelText], {
                selectable: true,
            });

            fc.add(group);
            this.canvas.stampDefaults(group, {
                markupType: this.activeMarkupType,
                preserveColor: true,
            });

            // Store dimension metadata for later update if scale changes
            group.dimensionPixelLength = pixelLen;
            group.dimensionLabel = label;

            group.setCoords();
            fc.setActiveObject(group);
            fc.renderAll();
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up',   onMouseUp);

        this._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up':   onMouseUp,
        };
    }

    // =========================================================================
    // ERASER (click on objects to delete them)
    // =========================================================================

    /**
     * Set up click-to-delete interaction for the eraser tool.
     * Clicking on any markup object removes it from the canvas.
     * Particularly useful for cleaning up freehand pen strokes.
     */
    _initEraserMode() {
        const fc = this.canvas.fabricCanvas;

        // Change cursor to indicate eraser mode
        if (this.viewer && this.viewer.container) {
            this.viewer.container.style.cursor = 'crosshair';
        }

        const onMouseDown = (opt) => {
            if (!opt.target) return;

            const obj = opt.target;
            // Don't erase temp/non-markup objects (measurement in progress, etc.)
            if (obj.evented === false) return;

            // Remove the object
            fc.remove(obj);
            fc.renderAll();

            // Notify canvas that markups changed (triggers auto-save)
            if (this.canvas._fireChange) {
                this.canvas._fireChange();
            } else if (this.canvas.onMarkupChange) {
                this.canvas.onMarkupChange();
            }
        };

        fc.on('mouse:down', onMouseDown);

        this._shapeHandlers = {
            'mouse:down': onMouseDown,
        };

        // Restore cursor on cleanup
        const originalCleanup = this._cleanupShapeDrawing.bind(this);
        this._cleanupShapeDrawing = () => {
            if (this.viewer && this.viewer.container) {
                this.viewer.container.style.cursor = '';
            }
            // Call prototype cleanup
            if (this._shapeHandlers && fc) {
                for (const [ev, fn] of Object.entries(this._shapeHandlers)) {
                    fc.off(ev, fn);
                }
                this._shapeHandlers = null;
            }
        };
    }

    // =========================================================================
    // TEXT PLACEMENT (click-to-place IText)
    // =========================================================================

    /**
     * Set up a one-shot click handler for placing a text annotation.
     *
     * Pattern:
     *   mouse:down on empty space → create IText → enter editing mode
     *   After placing, auto-switch to select tool (one-shot, not continuous).
     *   Empty text objects are removed on editing:exited (handled in canvas.js).
     */
    _initTextPlacement() {
        const fc = this.canvas.fabricCanvas;
        const STROKE_COLOR = MARKUP_COLORS[this.activeMarkupType] || MARKUP_COLORS.note;

        // Read persisted typography prefs — saved by properties.js when the user
        // changes font settings on a selected text object.
        let textPrefs = {};
        try {
            textPrefs = JSON.parse(localStorage.getItem('portolancast-text-prefs') || '{}');
        } catch { /* ignore corrupt data */ }
        const fontFamily  = textPrefs.fontFamily || 'Arial, sans-serif';
        const fontSize    = Math.max(8, Math.min(200, Number(textPrefs.fontSize) || 16));
        const fontWeight  = textPrefs.fontWeight === 'bold' || textPrefs.fontWeight === '700' ? 'bold' : 'normal';
        const fontStyle   = textPrefs.fontStyle === 'italic' ? 'italic' : 'normal';
        const underline   = textPrefs.underline   || false;
        const linethrough = textPrefs.linethrough || false;
        const textAlign   = textPrefs.textAlign   || 'left';

        const onMouseDown = (opt) => {
            // Ignore if clicking on an existing object
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);

            const textObj = new fabric.IText('Text', {
                left:        pointer.x,
                top:         pointer.y,
                fontFamily,
                fontSize,
                fontWeight,
                fontStyle,
                underline,
                linethrough,
                textAlign,
                fill:        STROKE_COLOR,
                // No stroke on text — use fill for the character color
                stroke:      null,
                strokeWidth: 0,
                selectable:  true,
                editable:    true,
            });

            fc.add(textObj);

            // Stamp semantic metadata — preserveColor keeps the fill we set
            this.canvas.stampDefaults(textObj, {
                markupType: this.activeMarkupType,
                preserveColor: true,
            });

            // Select, enter editing, and select-all for immediate typing
            fc.setActiveObject(textObj);
            textObj.enterEditing();
            textObj.selectAll();
            fc.renderAll();

            // Continuous placement: stay in text tool so user can click again
            // to place another text. Escape or tool-switch exits via
            // _cleanupShapeDrawing(). Empty text objects are auto-removed by
            // canvas.js text:editing:exited handler if user types nothing.
        };

        fc.on('mouse:down', onMouseDown);

        // Store for cleanup (reuses the same _shapeHandlers mechanism)
        this._shapeHandlers = {
            'mouse:down': onMouseDown,
        };
    }

    // =========================================================================
    // STICKY NOTE PLACEMENT (click-to-place Textbox with yellow background)
    // =========================================================================

    /**
     * Set up a one-shot click handler for placing a sticky note annotation.
     *
     * A sticky note = fabric.Textbox with:
     *   - Yellow background (#fffde7) — iconic sticky note colour
     *   - Coloured border (stroke) derived from the active markup type
     *   - Fixed starting width of 160px with word-wrap enabled
     *   - Immediate edit entry so the user can type straight away
     *
     * Interaction model (same as Text tool — one-shot):
     *   1. Click on empty canvas → note placed at click point, editing begins
     *   2. User types; note auto-resizes vertically as text wraps
     *   3. On editing:exited → text synced to markupNote, empty note removed
     *   4. Tool reverts to select after placement
     *
     * The Textbox gets stampDefaults (markupType, markupId) after placement.
     */
    _initStickyNotePlacement() {
        const fc = this.canvas.fabricCanvas;
        const STROKE_COLOR = MARKUP_COLORS[this.activeMarkupType] || MARKUP_COLORS.note;

        // Sticky note visual constants
        const NOTE_WIDTH   = 160;   // starting width — wraps text within this box
        const NOTE_PADDING = 8;     // inner padding (Fabric strokeWidth-derived)
        const NOTE_FONTSIZE = 12;

        const onMouseDown = (opt) => {
            // Ignore clicks on existing objects — don't start a note over a markup
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);

            const noteObj = new fabric.Textbox('', {
                left:            pointer.x,
                top:             pointer.y,
                width:           NOTE_WIDTH,
                fontSize:        NOTE_FONTSIZE,
                fontFamily:      'Arial, sans-serif',
                fill:            '#333333',    // dark text on yellow background
                backgroundColor: '#fffde7',    // classic pale-yellow sticky note colour
                stroke:          STROKE_COLOR, // border inherits markup type colour
                strokeWidth:     2,
                strokeUniform:   true,
                padding:         NOTE_PADDING,
                selectable:      true,
                editable:        true,
                splitByGrapheme: false,        // word-wrap (not character-wrap)
            });

            fc.add(noteObj);

            // Stamp semantic metadata — preserveColor keeps our fill/stroke
            this.canvas.stampDefaults(noteObj, {
                markupType: this.activeMarkupType,
                preserveColor: true,
            });

            // Select and enter editing immediately (user types straight away)
            fc.setActiveObject(noteObj);
            noteObj.enterEditing();
            fc.renderAll();

            // On editing exit: sync text → markupNote; remove if left empty
            const onEditingExited = () => {
                noteObj.off('editing:exited', onEditingExited);

                const trimmed = noteObj.text.trim();
                if (!trimmed) {
                    // User didn't type anything — remove orphan note
                    fc.remove(noteObj);
                    fc.renderAll();
                    return;
                }

                // Sync the typed text into markupNote so it appears in the
                // markup list, review brief, RFI generator, and search.
                noteObj.set('markupNote', trimmed);
                noteObj.setCoords();
                fc.renderAll();
                this.canvas.onContentChange();
            };

            noteObj.on('editing:exited', onEditingExited);

            // Continuous placement: stay in sticky-note tool so user can click
            // again to place another note. Escape or tool-switch exits via
            // _cleanupShapeDrawing(). Empty notes auto-removed by onEditingExited.
        };

        fc.on('mouse:down', onMouseDown);

        // Store for cleanup (same _shapeHandlers mechanism as all other tools)
        this._shapeHandlers = {
            'mouse:down': onMouseDown,
        };
    }

    // =========================================================================
    // CALLOUT PLACEMENT (two-click: anchor + text with leader line)
    // =========================================================================

    /**
     * Set up a two-click handler for placing a callout annotation.
     *
     * A callout = leader Line + IText label, grouped together.
     * Flow:
     *   1st click: record anchor point (what you're calling out)
     *   mousemove: rubber-band preview line from anchor to cursor
     *   2nd click: place IText at cursor, create Group(Line + IText)
     *   Auto-enter editing on the IText, switch to select tool.
     *
     * The Group gets markupType metadata via stampDefaults.
     */
    _initCalloutPlacement() {
        const fc = this.canvas.fabricCanvas;
        const STROKE_COLOR = MARKUP_COLORS[this.activeMarkupType] || MARKUP_COLORS.note;

        let anchorSet = false;
        let anchorX = 0;
        let anchorY = 0;
        let previewLine = null;

        const onMouseDown = (opt) => {
            // Ignore clicks on existing objects
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);

            if (!anchorSet) {
                // --- First click: set anchor point ---
                anchorX = pointer.x;
                anchorY = pointer.y;
                anchorSet = true;

                // Create preview line from anchor to current position
                previewLine = new fabric.Line(
                    [anchorX, anchorY, anchorX, anchorY],
                    {
                        stroke: STROKE_COLOR,
                        strokeWidth: 2,
                        strokeUniform: true,
                        strokeDashArray: [5, 3],
                        selectable: false,
                        evented: false,
                    }
                );
                fc.add(previewLine);
                fc.renderAll();
            } else {
                // --- Second click: place text box, enter editing, group on exit ---
                const textX = pointer.x;
                const textY = pointer.y;

                // Remove preview line
                if (previewLine) {
                    fc.remove(previewLine);
                    previewLine = null;
                }

                // Create the leader line (anchor → text position).
                // Added standalone first so IText can enter editing mode —
                // Fabric.js does not allow editing IText inside an active Group.
                const line = new fabric.Line(
                    [anchorX, anchorY, textX, textY],
                    {
                        stroke: STROKE_COLOR,
                        strokeWidth: 2,
                        strokeUniform: true,
                        selectable: false,
                        evented: false,
                        // Custom flag: identifies this as the leader for grouping
                        _calloutLeader: true,
                    }
                );

                // Create the text label
                const textObj = new fabric.IText('Callout', {
                    left: textX,
                    top: textY,
                    fontFamily: 'Arial, sans-serif',
                    fontSize: 14,
                    fill: STROKE_COLOR,
                    stroke: null,
                    strokeWidth: 0,
                    selectable: true,
                    editable: true,
                    _calloutText: true,
                });

                // Capture metadata before cleanup resets activeTool
                const markupType = this.activeMarkupType;

                // Clean up drawing handlers and switch to select — do this
                // BEFORE entering editing so keyboard events reach the IText.
                this._cleanupShapeDrawing();
                this.activeTool = 'select';
                document.querySelectorAll('.tool-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tool === 'select');
                });

                // Add items standalone so IText is editable
                fc.add(line);
                fc.add(textObj);
                fc.setActiveObject(textObj);
                fc.renderAll();

                // Enter editing immediately so user can type the label
                textObj.enterEditing();
                textObj.selectAll();

                // On editing exit, group line + text into a single callout object
                const onEditingExited = () => {
                    textObj.off('editing:exited', onEditingExited);

                    // Trim whitespace; revert to default if empty
                    if (!textObj.text.trim()) {
                        textObj.set('text', 'Callout');
                    }

                    // Capture standalone items' state before grouping
                    fc.remove(line);
                    fc.remove(textObj);

                    // Reset non-group properties that would conflict inside Group
                    line.set({ selectable: false, evented: false });
                    textObj.set({ selectable: true, editable: true });

                    const group = new fabric.Group([line, textObj], {
                        selectable: true,
                    });

                    // Stamp semantic metadata (markupId, markupType, etc.)
                    this.canvas.stampDefaults(group, {
                        markupType,
                        preserveColor: true,
                    });
                    // Mark as callout group for double-click editing detection
                    group._isCallout = true;

                    fc.add(group);
                    fc.setActiveObject(group);
                    fc.renderAll();
                    this.canvas.onContentChange();
                };

                textObj.on('editing:exited', onEditingExited);
            }
        };

        const onMouseMove = (opt) => {
            // Update preview line endpoint during rubber-banding
            if (anchorSet && previewLine) {
                const pointer = fc.getPointer(opt.e);
                previewLine.set({ x2: pointer.x, y2: pointer.y });
                fc.renderAll();
            }
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);

        // Store for cleanup (reuses _shapeHandlers mechanism)
        this._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
        };
    }

    // =========================================================================
    // CLOUD PATH GENERATION
    // =========================================================================

    /**
     * Generate an SVG path string for a cloud/revision-cloud shape.
     *
     * Creates arc bumps along each edge of a rectangle, producing the
     * classic "revision cloud" look that construction professionals expect.
     * Uses SVG arc commands (A) for each bump with a consistent radius.
     *
     * Args:
     *   x: Left origin (usually 0 since Fabric positions via left/top).
     *   y: Top origin (usually 0).
     *   w: Width of the cloud bounding box.
     *   h: Height of the cloud bounding box.
     *
     * Returns:
     *   string — SVG path data like "M ... A ... Z"
     */
    _generateCloudPath(x, y, w, h) {
        // Target bump spacing (~30px) — adjusts to fit edge evenly
        const TARGET_BUMP = 30;
        const parts = [];

        // Start at top-left corner
        parts.push(`M ${x} ${y}`);

        // --- Top edge (left to right): bumps arc upward ---
        const topCount = Math.max(1, Math.round(w / TARGET_BUMP));
        const topStep = w / topCount;
        for (let i = 0; i < topCount; i++) {
            const endX = x + (i + 1) * topStep;
            const endY = y;
            const r = topStep / 2;
            // Arc: rx ry rotation large-arc sweep endX endY
            // sweep=0 → arc bumps outward (upward on top edge)
            parts.push(`A ${r} ${r} 0 0 1 ${endX} ${endY}`);
        }

        // --- Right edge (top to bottom): bumps arc rightward ---
        const rightCount = Math.max(1, Math.round(h / TARGET_BUMP));
        const rightStep = h / rightCount;
        for (let i = 0; i < rightCount; i++) {
            const endX = x + w;
            const endY = y + (i + 1) * rightStep;
            const r = rightStep / 2;
            parts.push(`A ${r} ${r} 0 0 1 ${endX} ${endY}`);
        }

        // --- Bottom edge (right to left): bumps arc downward ---
        const bottomCount = Math.max(1, Math.round(w / TARGET_BUMP));
        const bottomStep = w / bottomCount;
        for (let i = 0; i < bottomCount; i++) {
            const endX = x + w - (i + 1) * bottomStep;
            const endY = y + h;
            const r = bottomStep / 2;
            parts.push(`A ${r} ${r} 0 0 1 ${endX} ${endY}`);
        }

        // --- Left edge (bottom to top): bumps arc leftward ---
        const leftCount = Math.max(1, Math.round(h / TARGET_BUMP));
        const leftStep = h / leftCount;
        for (let i = 0; i < leftCount; i++) {
            const endX = x;
            const endY = y + h - (i + 1) * leftStep;
            const r = leftStep / 2;
            parts.push(`A ${r} ${r} 0 0 1 ${endX} ${endY}`);
        }

        parts.push('Z');
        return parts.join(' ');
    }

    // =========================================================================
    // PDF EXPORT
    // =========================================================================

    // =========================================================================
    // DROPDOWN MENUS
    // =========================================================================

    /**
     * Initialize all toolbar dropdown menus.
     *
     * Click the trigger button to toggle .open on the parent .toolbar-dropdown.
     * Click any menu item or click outside to close all open dropdowns.
     * Only one dropdown can be open at a time.
     */
    _initDropdowns() {
        const dropdowns = document.querySelectorAll('.toolbar-dropdown');

        // Toggle dropdown on trigger click
        dropdowns.forEach(dd => {
            const trigger = dd.querySelector('.toolbar-dropdown-trigger');
            if (!trigger) return;
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const wasOpen = dd.classList.contains('open');
                // Close all dropdowns first
                dropdowns.forEach(d => d.classList.remove('open'));
                // Toggle the clicked one
                if (!wasOpen) dd.classList.add('open');
            });
        });

        // Close dropdown after any menu item is clicked
        document.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                dropdowns.forEach(d => d.classList.remove('open'));
            });
        });

        // Close all dropdowns on click outside
        document.addEventListener('click', () => {
            dropdowns.forEach(d => d.classList.remove('open'));
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                dropdowns.forEach(d => d.classList.remove('open'));
            }
        });
    }

    // =========================================================================
    // EXPORT PAGE AS IMAGE (layer-aware PNG/SVG)
    // =========================================================================

    /**
     * Export the current page as a PNG or SVG, respecting hidden OCG layers.
     *
     * Opens a small modal where the user picks format and DPI, then downloads
     * the rendered image. Hidden layers from the PDF Layers panel are
     * automatically applied — what you see on the canvas is what you get.
     */
    async _handleExportPage() {
        if (!this.viewer || !this.viewer.docId) {
            alert('No document open to export.');
            return;
        }

        // Show format/DPI picker modal
        const opts = await this._showExportPageModal();
        if (!opts) return;  // user cancelled

        const statusMsg = document.getElementById('status-message');
        statusMsg.textContent = `Exporting page as ${opts.format.toUpperCase()}...`;

        try {
            // Build query string with current layer visibility state
            const params = new URLSearchParams({
                format: opts.format,
                dpi: opts.dpi,
                rotate: this.viewer.rotation || 0,
            });

            // Pass currently hidden OCG layers so the export matches the canvas
            if (this.viewer.pdfHiddenLayers && this.viewer.pdfHiddenLayers.size > 0) {
                params.set('hidden_layers', [...this.viewer.pdfHiddenLayers].join(','));
            }

            const pageNum = this.viewer.currentPage;
            const url = `/api/documents/${this.viewer.docId}/page/${pageNum}/export?${params}`;

            const resp = await fetch(url);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: 'Export failed' }));
                throw new Error(err.detail || 'Page export failed');
            }

            const blob = await resp.blob();

            // Extract filename from Content-Disposition header
            const cd = resp.headers.get('Content-Disposition') || '';
            const match = cd.match(/filename="([^"]+)"/);
            const filename = match ? match[1] : `page_${pageNum + 1}.${opts.format}`;

            // Trigger browser download
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);

            const hiddenCount = this.viewer.pdfHiddenLayers?.size || 0;
            const layerNote = hiddenCount > 0 ? ` (${hiddenCount} layers hidden)` : '';
            statusMsg.textContent = `Page exported: ${filename}${layerNote}`;
        } catch (err) {
            statusMsg.textContent = `Export error: ${err.message}`;
            console.error('[Toolbar] Page export failed:', err);
        }
    }

    /**
     * Show a small modal for picking export format and DPI.
     *
     * Returns { format: 'png'|'svg', dpi: number } or null if cancelled.
     */
    _showExportPageModal() {
        return new Promise((resolve) => {
            // Build modal dynamically — lightweight, no HTML template needed
            const overlay = document.createElement('div');
            overlay.className = 'modal';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.position = 'fixed';
            overlay.style.inset = '0';
            overlay.style.zIndex = '9999';
            overlay.style.background = 'rgba(0,0,0,0.5)';

            const box = document.createElement('div');
            box.className = 'modal-box';
            box.style.cssText = 'background:#1e1e2e; border:1px solid #3a3a55; border-radius:8px; padding:20px; min-width:280px; color:#ccc;';

            const hiddenCount = this.viewer.pdfHiddenLayers?.size || 0;
            const layerInfo = hiddenCount > 0
                ? `<p style="font-size:11px; color:#cc8844; margin:0 0 12px;">
                     ${hiddenCount} PDF layer(s) hidden — export will match current view</p>`
                : '';

            box.innerHTML = `
                <h3 style="margin:0 0 12px; color:#eee; font-size:14px;">Export Page as Image</h3>
                ${layerInfo}
                <div style="margin-bottom:12px;">
                    <label style="font-size:12px; display:block; margin-bottom:4px;">Format</label>
                    <select id="export-page-format" style="width:100%; padding:6px; background:#2a2a40; color:#ccc; border:1px solid #3a3a55; border-radius:4px;">
                        <option value="png">PNG (raster — print quality)</option>
                        <option value="svg">SVG (vector — editable in Inkscape)</option>
                    </select>
                </div>
                <div id="export-page-dpi-row" style="margin-bottom:16px;">
                    <label style="font-size:12px; display:block; margin-bottom:4px;">Resolution (DPI)</label>
                    <select id="export-page-dpi" style="width:100%; padding:6px; background:#2a2a40; color:#ccc; border:1px solid #3a3a55; border-radius:4px;">
                        <option value="150">150 DPI (screen quality)</option>
                        <option value="300" selected>300 DPI (print quality)</option>
                        <option value="600">600 DPI (high detail)</option>
                    </select>
                </div>
                <div style="display:flex; gap:8px; justify-content:flex-end;">
                    <button id="export-page-cancel" class="toolbar-btn" style="padding:6px 16px;">Cancel</button>
                    <button id="export-page-ok" class="toolbar-btn modal-btn-primary" style="padding:6px 16px;">Export</button>
                </div>
            `;

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            // Hide DPI row when SVG is selected (SVG is resolution-independent)
            const formatSelect = box.querySelector('#export-page-format');
            const dpiRow = box.querySelector('#export-page-dpi-row');
            formatSelect.addEventListener('change', () => {
                dpiRow.style.display = formatSelect.value === 'svg' ? 'none' : '';
            });

            const cleanup = () => { overlay.remove(); };

            box.querySelector('#export-page-cancel').addEventListener('click', () => {
                cleanup();
                resolve(null);
            });

            box.querySelector('#export-page-ok').addEventListener('click', () => {
                const format = formatSelect.value;
                const dpi = parseInt(box.querySelector('#export-page-dpi').value, 10);
                cleanup();
                resolve({ format, dpi });
            });

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) { cleanup(); resolve(null); }
            });

            document.addEventListener('keydown', function onEsc(e) {
                if (e.key === 'Escape') {
                    document.removeEventListener('keydown', onEsc);
                    cleanup();
                    resolve(null);
                }
            });
        });
    }

    // =========================================================================
    // HELP MENU HANDLERS
    // =========================================================================

    /**
     * Show keyboard shortcuts reference.
     *
     * Builds a quick-reference overlay from the shortcut registry.
     */
    _showKeyboardShortcuts() {
        const overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.style.cssText = 'display:flex; align-items:center; justify-content:center; position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5);';

        const box = document.createElement('div');
        box.className = 'modal-box';
        box.style.cssText = 'background:#1e1e2e; border:1px solid #3a3a55; border-radius:8px; padding:20px; min-width:320px; max-width:480px; max-height:80vh; overflow-y:auto; color:#ccc;';

        // Common shortcuts — kept simple and readable
        box.innerHTML = `
            <h3 style="margin:0 0 16px; color:#eee; font-size:14px;">Keyboard Shortcuts</h3>
            <table style="width:100%; font-size:12px; border-collapse:collapse;">
                <tr><td style="padding:4px 8px; color:#7788aa;">V</td><td>Select (pointer)</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">H</td><td>Pan (hand tool)</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">R</td><td>Rectangle</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">E</td><td>Ellipse</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">L</td><td>Line</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">P</td><td>Pen / freehand</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">T</td><td>Text</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">C</td><td>Cloud</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">O</td><td>Callout</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">W</td><td>Polyline</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">Shift+A</td><td>Arrow</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">S</td><td>Sticky Note</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">I</td><td>Image Overlay</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">U</td><td>Distance measure</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">A</td><td>Area measure</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">N</td><td>Count markers</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">K</td><td>Calibrate scale</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">M</td><td>Equipment Marker</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">1-5</td><td>Switch intent (Note/Issue/Question/Approval/Change)</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">Delete</td><td>Delete selected</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">Ctrl+Z</td><td>Undo</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">Ctrl+Y</td><td>Redo</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">Ctrl+G</td><td>Group selected</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">Ctrl+Shift+G</td><td>Ungroup</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">+/−</td><td>Zoom in/out</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">0</td><td>Fit to width</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">PgUp/PgDn</td><td>Previous/next page</td></tr>
                <tr><td style="padding:4px 8px; color:#7788aa;">Esc</td><td>Cancel / close</td></tr>
            </table>
            <div style="margin-top:16px; text-align:right;">
                <button id="shortcuts-close" class="toolbar-btn modal-btn-primary" style="padding:6px 16px;">Close</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => overlay.remove();
        box.querySelector('#shortcuts-close').addEventListener('click', cleanup);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
        document.addEventListener('keydown', function onEsc(e) {
            if (e.key === 'Escape') { document.removeEventListener('keydown', onEsc); cleanup(); }
        });
    }

    /**
     * Show About dialog with version and project info.
     */
    _showAbout() {
        const overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.style.cssText = 'display:flex; align-items:center; justify-content:center; position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5);';

        const box = document.createElement('div');
        box.className = 'modal-box';
        box.style.cssText = 'background:#1e1e2e; border:1px solid #3a3a55; border-radius:8px; padding:20px; min-width:280px; color:#ccc; text-align:center;';

        box.innerHTML = `
            <h3 style="margin:0 0 8px; color:#eee; font-size:16px;">PortolanCAST</h3>
            <p style="font-size:12px; color:#7788aa; margin:0 0 8px;">Building Automation Document Markup Tool</p>
            <p style="font-size:11px; color:#667788; margin:0 0 16px;">
                Open source &middot; FastAPI + Fabric.js + PyMuPDF
            </p>
            <div style="text-align:right;">
                <button id="about-close" class="toolbar-btn modal-btn-primary" style="padding:6px 16px;">Close</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => overlay.remove();
        box.querySelector('#about-close').addEventListener('click', cleanup);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
        document.addEventListener('keydown', function onEsc(e) {
            if (e.key === 'Escape') { document.removeEventListener('keydown', onEsc); cleanup(); }
        });
    }

    // =========================================================================
    // EXPORT PDF (annotated)
    // =========================================================================

    /**
     * Export the current PDF with annotations baked in.
     *
     * Saves current markups to the server first (ensures latest state),
     * then triggers a download of the annotated PDF via fetch + blob URL.
     * Uses blob download pattern for better UX (no page navigation).
     */
    async _handleExport() {
        if (!this.viewer || !this.viewer.docId) {
            alert('No document open to export.');
            return;
        }

        const statusMsg = document.getElementById('status-message');
        statusMsg.textContent = 'Exporting...';

        try {
            // Save latest markups first so the export has current data
            if (this.canvas && this.canvas.onContentChange) {
                // Save current page state to the in-memory map
                this.canvas.onPageChanging(this.viewer.currentPage);
            }

            // Trigger save and wait for it to complete
            const pages = this.canvas ? this.canvas.getAllPageMarkups() : {};
            const saveResp = await fetch(
                `/api/documents/${this.viewer.docId}/markups`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pages }),
                }
            );
            if (!saveResp.ok) {
                throw new Error('Failed to save markups before export');
            }

            // Fetch the exported PDF as a blob
            const exportResp = await fetch(
                `/api/documents/${this.viewer.docId}/export`
            );
            if (!exportResp.ok) {
                const err = await exportResp.json();
                throw new Error(err.detail || 'Export failed');
            }

            const blob = await exportResp.blob();

            // Create a temporary download link and click it
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // Extract filename from Content-Disposition or use a default
            const cd = exportResp.headers.get('Content-Disposition');
            const match = cd && cd.match(/filename="?([^"]+)"?/);
            a.download = match ? match[1] : 'export_annotated.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            statusMsg.textContent = 'Export complete';
        } catch (err) {
            statusMsg.textContent = `Export error: ${err.message}`;
            console.error('[Toolbar] Export failed:', err);
        }
    }

    // =========================================================================
    // NEW DOCUMENT (blank)
    // =========================================================================

    /**
     * Show the "New Document" modal and focus the name field.
     */
    _showNewDocModal() {
        const modal = document.getElementById('modal-new-doc');
        if (!modal) return;
        modal.style.display = 'flex';
        // Pre-select the name field for immediate typing
        const nameInput = document.getElementById('new-doc-name');
        if (nameInput) {
            nameInput.select();
            nameInput.focus();
        }
    }

    /**
     * Hide the "New Document" modal.
     */
    _hideNewDocModal() {
        const modal = document.getElementById('modal-new-doc');
        if (modal) modal.style.display = 'none';
    }

    /**
     * Read the modal form, call POST /api/documents/blank, and open the result.
     *
     * Same pattern as _handleFileUpload: API call → loadDocument.
     * The modal provides name, page count, and page size preset.
     */
    async _handleNewDocument() {
        const name = (document.getElementById('new-doc-name')?.value || 'Untitled').trim() || 'Untitled';
        const pages = parseInt(document.getElementById('new-doc-pages')?.value || '1', 10);
        const size = document.getElementById('new-doc-size')?.value || 'letter';

        this._hideNewDocModal();

        const statusMsg = document.getElementById('status-message');
        statusMsg.textContent = 'Creating document...';

        try {
            const resp = await fetch('/api/documents/blank', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, page_count: pages, page_size: size }),
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Create failed');
            }

            const result = await resp.json();
            statusMsg.textContent = `Created: ${result.filename}`;

            // Update URL, load into viewer (same as file upload flow)
            window.history.pushState({}, '', `/edit/${result.id}`);
            await this.viewer.loadDocument(result.id);

        } catch (err) {
            statusMsg.textContent = `Error: ${err.message}`;
            console.error('[Toolbar] New document failed:', err);
        }
    }

    // =========================================================================
    // FILE UPLOAD
    // =========================================================================

    /**
     * Upload a PDF file to the server and open it in the viewer.
     *
     * Args:
     *   file: File object from the file input.
     */
    async _handleFileUpload(file) {
        // Dispatch .portolan bundles to their own handler (import-bundle endpoint)
        if (file.name.toLowerCase().endsWith('.portolan')) {
            return this._handleBundleImport(file);
        }

        // SECURITY: Client-side extension check (server validates too)
        if (!file.name.toLowerCase().endsWith('.pdf')) {
            alert('Please select a PDF or .portolan bundle file.');
            return;
        }

        const statusMsg = document.getElementById('status-message');
        statusMsg.textContent = `Uploading ${file.name}...`;

        const formData = new FormData();
        formData.append('file', file);

        try {
            const resp = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Upload failed');
            }

            const result = await resp.json();
            statusMsg.textContent = `Loaded: ${result.filename}`;

            // Update URL without full page reload
            window.history.pushState({}, '', `/edit/${result.id}`);

            // Load the document in the viewer
            await this.viewer.loadDocument(result.id);

        } catch (err) {
            statusMsg.textContent = `Error: ${err.message}`;
            console.error('Upload failed:', err);
        }
    }

    // =========================================================================
    // BUNDLE SAVE/IMPORT (.portolan)
    // =========================================================================

    /**
     * Show the "Save Bundle" naming dialog and wait for user input.
     *
     * Displays the modal with a text input pre-filled with the suggested name.
     * Returns a Promise that resolves to the chosen filename string (without
     * the .portolan extension) or null if the user cancels.
     *
     * Uses a promise-based modal approach: the modal's confirm/cancel actions
     * resolve the promise, allowing the caller to simply await this method.
     * All listeners are registered inside the promise callback and removed
     * by the cleanup() function on both confirm and cancel paths — no leaks.
     *
     * Args:
     *   defaultName: Suggested filename to pre-fill (without .portolan suffix).
     *
     * Returns:
     *   Promise<string|null> — trimmed name or null if cancelled.
     */
    _showBundleNameModal(defaultName) {
        return new Promise((resolve) => {
            const modal   = document.getElementById('modal-save-bundle');
            const input   = document.getElementById('bundle-name-input');
            const btnSave = document.getElementById('bundle-name-save');
            const btnCancel = document.getElementById('bundle-name-cancel');
            const overlay = document.getElementById('modal-save-bundle-overlay');

            // Pre-fill with the suggested name
            input.value = defaultName;

            // Show modal (flex keeps it centered)
            modal.style.display = 'flex';

            // Focus and select all so the user can type to replace immediately
            setTimeout(() => { input.focus(); input.select(); }, 50);

            // Cleanup: hide modal and remove all event listeners
            const cleanup = (result) => {
                modal.style.display = 'none';
                btnSave.removeEventListener('click', onSave);
                btnCancel.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onCancel);
                input.removeEventListener('keydown', onKey);
                resolve(result);
            };

            const onSave = () => {
                const name = input.value.trim();
                // Fall back to defaultName if the user cleared the field
                cleanup(name || defaultName);
            };
            const onCancel = () => cleanup(null);

            const onKey = (e) => {
                if (e.key === 'Enter')  { e.preventDefault(); onSave(); }
                if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            };

            btnSave.addEventListener('click', onSave);
            btnCancel.addEventListener('click', onCancel);
            overlay.addEventListener('click', onCancel);
            input.addEventListener('keydown', onKey);
        });
    }

    /**
     * Save a .portolan bundle for the current document.
     *
     * Flow:
     *   1. Show naming dialog — user picks filename (or cancels).
     *   2. Save current markups to server (flush in-memory state).
     *   3. Fetch bundle blob from GET /api/documents/{id}/export-bundle.
     *   4. Trigger browser download with the user-chosen filename.
     *
     * The bundle preserves the original PDF + all markups, layers, and scale
     * settings so the document can be fully re-edited on any PortolanCAST
     * installation.
     */
    async _handleBundleSave() {
        if (!this.viewer || !this.viewer.docId) {
            alert('No document open to save as bundle.');
            return;
        }

        // Derive suggested name from the original PDF filename:
        //   "site-plan.pdf"  →  "site-plan"
        //   "document"       →  "document"
        const rawName = this.viewer.docInfo?.filename || 'document';
        const defaultName = rawName.replace(/\.pdf$/i, '');

        // Show naming dialog — cancel returns null, which aborts the save
        const chosenName = await this._showBundleNameModal(defaultName);
        if (chosenName === null) return;  // user cancelled

        const statusMsg = document.getElementById('status-message');
        statusMsg.textContent = 'Saving bundle...';

        try {
            // Save current page state to in-memory map before bundling
            if (this.canvas && this.canvas.onContentChange) {
                this.canvas.onPageChanging(this.viewer.currentPage);
            }

            // Flush all markups to the server so the bundle has current data
            const pages = this.canvas ? this.canvas.getAllPageMarkups() : {};
            const saveResp = await fetch(
                `/api/documents/${this.viewer.docId}/markups`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pages }),
                }
            );
            if (!saveResp.ok) {
                throw new Error('Failed to save markups before bundling');
            }

            // Fetch the bundle as a binary blob
            const bundleResp = await fetch(
                `/api/documents/${this.viewer.docId}/export-bundle`
            );
            if (!bundleResp.ok) {
                const err = await bundleResp.json();
                throw new Error(err.detail || 'Bundle export failed');
            }

            const blob = await bundleResp.blob();

            // Build final filename — ensure .portolan extension even if the user
            // accidentally typed it in the input (avoid "name.portolan.portolan")
            let filename = chosenName.trim();
            if (!filename.toLowerCase().endsWith('.portolan')) {
                filename += '.portolan';
            }

            // Trigger browser download using the user-chosen filename
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            statusMsg.textContent = `Bundle saved: ${filename}`;
        } catch (err) {
            statusMsg.textContent = `Bundle save error: ${err.message}`;
            console.error('[Toolbar] Bundle save failed:', err);
        }
    }

    /**
     * Export all markup annotations as an Obsidian-compatible ZIP of Markdown files.
     *
     * Flow:
     *   1. Flush current page to the pageMarkups map.
     *   2. Collect all pages via getAllPageMarkups().
     *   3. POST pages JSON to /api/documents/{id}/export-obsidian.
     *   4. Trigger browser download of the returned ZIP.
     *
     * The export sends the live canvas state so unsaved markup changes are
     * included in the download without requiring a manual save first.
     *
     * ZIP structure (generated server-side):
     *   {document-stem}/page-{N}/{type}-{uuid}.md
     *
     * Each .md file has YAML frontmatter (markupId, type, status, tags, source URL)
     * + the markup note text + Obsidian [[wikilinks]] for tags.
     *
     * The source URL deep-links back to PortolanCAST so the user can navigate
     * from Obsidian → correct page → selected markup with one click.
     */
    async _handleObsidianExport() {
        if (!this.viewer || !this.viewer.docId) {
            alert('No document open to export.');
            return;
        }

        const statusMsg = document.getElementById('status-message');
        statusMsg.textContent = 'Generating Obsidian export...';

        try {
            // Flush current page into the pageMarkups map before reading all pages
            if (this.canvas) {
                this.canvas.onPageChanging(this.viewer.currentPage);
            }

            // Collect all pages (serialized Fabric JSON, integer keys)
            const pages = this.canvas ? this.canvas.getAllPageMarkups() : {};

            // POST the live canvas state to the server for export generation
            const resp = await fetch(
                `/api/documents/${this.viewer.docId}/export-obsidian`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pages }),
                }
            );

            if (!resp.ok) {
                // Server returns JSON errors; ZIP returns binary — only parse JSON on error
                const err = await resp.json().catch(() => ({ detail: 'Export failed' }));
                throw new Error(err.detail || 'Obsidian export failed');
            }

            const blob = await resp.blob();

            // Extract filename from Content-Disposition header (fallback to generic name)
            const cd = resp.headers.get('Content-Disposition') || '';
            const match = cd.match(/filename="([^"]+)"/);
            const filename = match ? match[1] : 'obsidian_export.zip';

            // Trigger browser download — auto-revoke object URL after click
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);

            statusMsg.textContent = `Obsidian export ready: ${filename}`;
        } catch (err) {
            statusMsg.textContent = `Obsidian export error: ${err.message}`;
            console.error('[Toolbar] Obsidian export failed:', err);
        }
    }

    /**
     * Import a .portolan bundle and open the restored document.
     *
     * POSTs the bundle file to /api/documents/import-bundle, which creates
     * a new document record and restores all markup/layer/scale state.
     * On success, navigates to the new document's editor page.
     *
     * Args:
     *   file: File object from the file input (must end with .portolan).
     */
    async _handleBundleImport(file) {
        const statusMsg = document.getElementById('status-message');
        statusMsg.textContent = `Importing ${file.name}...`;

        const formData = new FormData();
        formData.append('file', file);

        try {
            const resp = await fetch('/api/documents/import-bundle', {
                method: 'POST',
                body: formData,
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Import failed');
            }

            const result = await resp.json();
            statusMsg.textContent = `Imported: ${result.filename}`;

            // Navigate to the newly created document
            window.history.pushState({}, '', `/edit/${result.id}`);
            await this.viewer.loadDocument(result.id);

        } catch (err) {
            statusMsg.textContent = `Import error: ${err.message}`;
            console.error('[Toolbar] Bundle import failed:', err);
        }
    }

    // =========================================================================
    // CALLOUT DOUBLE-CLICK EDITING
    // =========================================================================

    /**
     * Bind a double-click handler that lets users re-edit callout labels.
     *
     * Called once per document load from app.js._onDocumentLoaded() after
     * canvas.init() creates a fresh Fabric canvas instance.
     *
     * How it works:
     *   - On mouse:dblclick, find the clicked object.
     *   - If it is a callout Group (marked with _isCallout or contains a Line
     *     + IText), ungroup, enter editing on the IText, regroup on exit.
     *   - Non-callout objects are ignored so NodeEditor dblclick still works.
     *
     * The method stores the handler reference on the instance so that
     * initForCanvas() calls (new document loads) can cleanly rebind.
     *
     * Args:
     *   fc: Fabric canvas instance (fabric.Canvas) for the loaded document.
     */
    _initCalloutEditing(fc) {
        // Remove previous handler if this is a re-init (new document loaded)
        if (this._calloutDblClickHandler) {
            fc.off('mouse:dblclick', this._calloutDblClickHandler);
        }

        this._calloutDblClickHandler = (opt) => {
            const target = opt.target;
            if (!target) return;

            // Identify callout groups: explicit flag OR Group containing Line + IText
            const isCallout = target._isCallout ||
                (target.type === 'group' && target._objects &&
                 target._objects.some(o => o.type === 'line' || o.type === 'Line') &&
                 target._objects.some(o => o.type === 'i-text' || o.type === 'IText'));

            if (!isCallout) return;

            // Prevent NodeEditor or other handlers from firing
            opt.e.stopPropagation();

            this._enterCalloutEdit(target, fc);
        };

        fc.on('mouse:dblclick', this._calloutDblClickHandler);
    }

    /**
     * Ungroup a callout Group, enter IText editing, then regroup on exit.
     *
     * Coordinate recovery:
     *   Fabric Group items have left/top relative to the group's centre.
     *   calcTransformMatrix() gives the absolute transform; qrDecompose()
     *   extracts translate/scale/angle so we can reconstruct canvas positions.
     *
     * Metadata preservation:
     *   markupId, markupType, markupStatus, markupNote, layerId are copied
     *   from the old group to the new group so no audit trail is lost.
     *
     * Args:
     *   group: fabric.Group that represents the callout.
     *   fc:    Fabric canvas instance.
     */
    _enterCalloutEdit(group, fc) {
        // Collect custom metadata before we destroy the group
        const CUSTOM_KEYS = [
            'markupId', 'markupType', 'markupStatus', 'markupNote',
            'layerId', '_isCallout',
        ];
        const meta = {};
        CUSTOM_KEYS.forEach(k => { meta[k] = group[k]; });

        // Recover absolute canvas positions for each child item.
        // Item.left/top inside a group are relative to the group origin;
        // multiplying by the group's transform gives absolute canvas coords.
        const absItems = group._objects.map(item => {
            const mtx = item.calcTransformMatrix();
            const decomp = fabric.util.qrDecompose(mtx);
            return { item, absLeft: decomp.translateX, absTop: decomp.translateY };
        });

        // Deactivate and remove the group from the canvas
        fc.discardActiveObject();
        fc.remove(group);

        let lineItem = null;
        let textItem = null;

        // Re-add each child at its absolute canvas position
        absItems.forEach(({ item, absLeft, absTop }) => {
            item.set({
                left: absLeft,
                top: absTop,
                // Items were stored relative to group — reset origin to TL
                originX: 'center',
                originY: 'center',
            });

            const t = item.type ? item.type.toLowerCase() : '';
            if (t === 'line') {
                item.set({ selectable: false, evented: false });
                lineItem = item;
            } else if (t === 'i-text' || t === 'itext') {
                item.set({ selectable: true, editable: true });
                textItem = item;
            }

            fc.add(item);
        });

        if (!textItem) {
            // Safety: if no IText found, abort and restore nothing (shouldn't happen)
            console.warn('[Toolbar] _enterCalloutEdit: no IText found in group');
            fc.renderAll();
            return;
        }

        fc.setActiveObject(textItem);
        fc.renderAll();

        // Enter editing mode on the text label
        textItem.enterEditing();
        textItem.selectAll();

        // Regroup everything back on editing exit
        const onEditingExited = () => {
            textItem.off('editing:exited', onEditingExited);

            if (!textItem.text.trim()) {
                textItem.set('text', 'Callout');
            }

            // Remove standalone items
            fc.remove(textItem);
            if (lineItem) fc.remove(lineItem);

            // Reset properties for grouping
            textItem.set({ originX: 'left', originY: 'top', selectable: true, editable: true });
            if (lineItem) lineItem.set({ originX: 'left', originY: 'top', selectable: false, evented: false });

            const children = lineItem ? [lineItem, textItem] : [textItem];
            const newGroup = new fabric.Group(children, { selectable: true });

            // Restore all metadata onto the new group
            CUSTOM_KEYS.forEach(k => { if (meta[k] !== undefined) newGroup[k] = meta[k]; });

            fc.add(newGroup);
            fc.setActiveObject(newGroup);
            fc.renderAll();
            this.canvas.onContentChange();
        };

        textItem.on('editing:exited', onEditingExited);
    }

    // =========================================================================
    // EQUIPMENT MARKER PLACEMENT (click-to-place pin + open link panel)
    // =========================================================================

    /**
     * Set up a one-shot click handler for placing an equipment marker pin.
     *
     * Builds a fabric.Group with a colored circle and "..." placeholder label,
     * stamps it with markupType 'equipment-marker', then opens the Equipment
     * Marker panel for entity search/linking. Reverts to select after placement.
     *
     * Visual design follows the Count marker pattern (_buildCountMarker):
     * circle with white stroke + centered text label below.
     */
    _initEquipmentMarkerPlacement() {
        const fc = this.canvas.fabricCanvas;
        const MARKER_COLOR = MARKUP_COLORS['equipment-marker'] || '#c678dd';
        const RADIUS = 10;       // Pin head radius in natural coords
        const LABEL_OFFSET = 4;  // Gap between circle bottom and label top

        const onMouseDown = (opt) => {
            // Ignore clicks on existing objects — don't place a marker over a markup
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);

            // Pin head circle
            const circle = new fabric.Circle({
                left: pointer.x - RADIUS,
                top: pointer.y - RADIUS,
                radius: RADIUS,
                fill: MARKER_COLOR,
                stroke: '#ffffff',
                strokeWidth: 1.5,
                selectable: false,
                evented: false,
            });

            // Placeholder label — will be updated to entity tag_number by the panel
            const label = new fabric.IText('...', {
                left: pointer.x,
                top: pointer.y + RADIUS + LABEL_OFFSET,
                fontFamily: 'Arial, sans-serif',
                fontSize: 10,
                fontWeight: 'bold',
                fill: '#ffffff',
                stroke: null,
                strokeWidth: 0,
                selectable: false,
                editable: false,
                originX: 'center',
                originY: 'top',
                backgroundColor: 'rgba(30, 30, 46, 0.8)',
                padding: 2,
            });

            const group = new fabric.Group([circle, label], {
                selectable: true,
                subTargetCheck: false,
            });

            fc.add(group);

            // Stamp semantic metadata — preserveColor keeps our purple fill
            this.canvas.stampDefaults(group, {
                markupType: 'equipment-marker',
                preserveColor: true,
            });

            fc.renderAll();

            // Open the Equipment Marker panel for entity linking
            if (window.app && window.app.equipmentMarkerPanel) {
                window.app.equipmentMarkerPanel.open(group);
            }

            // One-shot: clean up handler and revert to select tool
            this._cleanupShapeDrawing();
            this.activeTool = 'select';
            document.querySelectorAll('.tool-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tool === 'select');
            });
        };

        fc.on('mouse:down', onMouseDown);

        // Store for cleanup (same _shapeHandlers mechanism as all other tools)
        this._shapeHandlers = {
            'mouse:down': onMouseDown,
        };
    }

    // =========================================================================
    // CONNECTION DRAWING (Haystack Phase 2 — two-click entity wiring)
    // =========================================================================

    /**
     * Two-click connection tool: click source equipment marker → rubber-band
     * preview line → click target equipment marker → draw directed connection
     * line and save to DB.
     *
     * Design decisions:
     *   - Both clicks MUST land on equipment markers with entityId set.
     *     Clicking empty canvas or non-entity objects is ignored (with status hint).
     *   - Connection line is a Fabric Group (shaft + arrowhead), same as Arrow tool,
     *     but with connection metadata (connectionId, sourceEntityId, targetEntityId).
     *   - Line is dashed cyan for signal connections (distinguishes from regular arrows).
     *   - DB POST happens after canvas placement — if POST fails, the line is removed.
     *   - One-shot: reverts to select after placing one connection.
     */
    _initConnectionDrawing() {
        const fc = this.canvas.fabricCanvas;
        const CONNECTION_COLOR = '#56b6c2'; // Cyan — distinct from all markup colors
        const STROKE_WIDTH = 2;
        const ARROW_SIZE = 12;
        const WING_ANGLE = Math.PI / 6;
        const DASH_PATTERN = [8, 4]; // Signal connection visual signature

        /** @type {fabric.Object|null} Source equipment marker Group */
        let sourceMarker = null;
        /** @type {string|null} Source entity UUID */
        let sourceEntityId = null;
        /** @type {fabric.Line|null} Rubber-band preview line during second click */
        let previewLine = null;

        // Status hint element — reuse the mode bar if available
        const showHint = (msg) => {
            const modeEl = document.getElementById('sb-mode');
            if (modeEl) modeEl.textContent = msg;
        };

        showHint('Connect: click source marker');

        // ── Find the equipment marker Group that owns a clicked object ──────
        // Equipment markers are Groups with entityId. The user might click the
        // circle child or the label child — we need the parent Group.
        const findMarkerGroup = (target) => {
            if (!target) return null;

            // Direct hit on the marker Group itself
            if (target.entityId) return target;

            // Hit on a child inside a Group — walk up to parent
            if (target.group && target.group.entityId) return target.group;

            // Check if target is a Group containing objects with entityId
            // (Fabric sometimes returns the Group directly)
            if (target._objects && target.entityId) return target;

            return null;
        };

        // ── Compute center of a marker Group in canvas coordinates ──────────
        const getMarkerCenter = (marker) => {
            const center = marker.getCenterPoint();
            return { x: center.x, y: center.y };
        };

        // ── Event handlers ──────────────────────────────────────────────────

        const onMouseDown = (opt) => {
            const target = opt.target;
            const marker = findMarkerGroup(target);

            if (!sourceMarker) {
                // --- First click: select source marker ---
                if (!marker) {
                    showHint('Connect: click an equipment marker (with entity)');
                    return;
                }
                if (!marker.entityId) {
                    showHint('Connect: marker has no entity — link it first');
                    return;
                }

                sourceMarker = marker;
                sourceEntityId = marker.entityId;

                // Highlight source with temporary border
                marker.set({ borderColor: CONNECTION_COLOR, borderScaleFactor: 2 });
                fc.renderAll();

                // Start rubber-band preview from source center
                const src = getMarkerCenter(marker);
                previewLine = new fabric.Line(
                    [src.x, src.y, src.x, src.y],
                    {
                        stroke: CONNECTION_COLOR,
                        strokeWidth: STROKE_WIDTH,
                        strokeDashArray: DASH_PATTERN,
                        strokeUniform: true,
                        selectable: false,
                        evented: false,
                    }
                );
                fc.add(previewLine);
                fc.renderAll();

                showHint('Connect: click target marker');

            } else {
                // --- Second click: select target marker and create connection ---
                if (!marker) {
                    showHint('Connect: click a target equipment marker');
                    return;
                }
                if (!marker.entityId) {
                    showHint('Connect: target marker has no entity — link it first');
                    return;
                }
                if (marker.entityId === sourceEntityId) {
                    showHint('Connect: cannot connect entity to itself');
                    return;
                }

                const targetEntityId = marker.entityId;
                const src = getMarkerCenter(sourceMarker);
                const tgt = getMarkerCenter(marker);

                // Remove preview line
                if (previewLine) {
                    fc.remove(previewLine);
                    previewLine = null;
                }

                // Reset source highlight
                sourceMarker.set({ borderColor: '', borderScaleFactor: 1 });

                // ── Build the connection line (shaft + arrowhead) ────────────
                const dx = tgt.x - src.x;
                const dy = tgt.y - src.y;
                const angle = Math.atan2(dy, dx);

                // Arrowhead wing tips
                const wing1x = tgt.x - ARROW_SIZE * Math.cos(angle - WING_ANGLE);
                const wing1y = tgt.y - ARROW_SIZE * Math.sin(angle - WING_ANGLE);
                const wing2x = tgt.x - ARROW_SIZE * Math.cos(angle + WING_ANGLE);
                const wing2y = tgt.y - ARROW_SIZE * Math.sin(angle + WING_ANGLE);

                // Shorten shaft so it doesn't poke through the arrowhead fill
                const shaftEndX = tgt.x - ARROW_SIZE * 0.6 * Math.cos(angle);
                const shaftEndY = tgt.y - ARROW_SIZE * 0.6 * Math.sin(angle);

                const shaft = new fabric.Line(
                    [src.x, src.y, shaftEndX, shaftEndY],
                    {
                        stroke: CONNECTION_COLOR,
                        strokeWidth: STROKE_WIDTH,
                        strokeDashArray: DASH_PATTERN,
                        strokeUniform: true,
                        selectable: false,
                        evented: false,
                    }
                );

                const headPath = `M ${tgt.x},${tgt.y} L ${wing1x},${wing1y} L ${wing2x},${wing2y} Z`;
                const head = new fabric.Path(headPath, {
                    fill: CONNECTION_COLOR,
                    stroke: CONNECTION_COLOR,
                    strokeWidth: 1,
                    strokeLineJoin: 'round',
                    strokeUniform: true,
                    selectable: false,
                    evented: false,
                });

                const connectionGroup = new fabric.Group([shaft, head], {
                    selectable: true,
                    // Connection metadata — survives serialization via CUSTOM_PROPERTIES
                    sourceEntityId: sourceEntityId,
                    targetEntityId: targetEntityId,
                });

                // Generate a connection UUID before adding to canvas
                const connectionId = crypto.randomUUID();
                connectionGroup.connectionId = connectionId;

                fc.add(connectionGroup);

                // Stamp markup metadata — markupType 'connection' for identification
                this.canvas.stampDefaults(connectionGroup, {
                    markupType: 'note',
                    preserveColor: true,
                });

                connectionGroup.setCoords();
                fc.renderAll();

                // ── Save connection to DB ────────────────────────────────────
                const docId = this.viewer ? this.viewer.docId : null;
                const pageNum = this.viewer ? this.viewer.currentPage : null;

                fetch('/api/connections', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source_id: sourceEntityId,
                        target_id: targetEntityId,
                        connection_type: 'signal',
                        doc_id: docId ? parseInt(docId, 10) : null,
                        page_number: pageNum,
                        fabric_data: JSON.stringify(connectionGroup.toObject()),
                    }),
                })
                .then(resp => {
                    if (!resp.ok) {
                        return resp.json().then(data => {
                            throw new Error(data.detail || 'Failed to save connection');
                        });
                    }
                    return resp.json();
                })
                .then(data => {
                    // Update the canvas object with the server-assigned connection ID
                    // (we used crypto.randomUUID client-side, but the server generates its own)
                    connectionGroup.connectionId = data.connection.id;
                    showHint('Connection saved');
                })
                .catch(err => {
                    console.error('[Connect] Failed to save connection:', err);
                    // Remove the visual line if DB save failed — no orphan canvas objects
                    fc.remove(connectionGroup);
                    fc.renderAll();
                    showHint('Connection failed: ' + err.message);
                });

                // One-shot: clean up and revert to select
                this._cleanupShapeDrawing();
                this.activeTool = 'select';
                document.querySelectorAll('.tool-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tool === 'select');
                });
            }
        };

        const onMouseMove = (opt) => {
            if (!previewLine) return;
            const pointer = fc.getPointer(opt.e);
            previewLine.set({ x2: pointer.x, y2: pointer.y });
            fc.renderAll();
        };

        // ── Handler registration ────────────────────────────────────────────

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);

        this._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
        };

        // ── Cleanup override ────────────────────────────────────────────────
        // Remove preview line and reset source state when tool is deactivated
        this._cleanupShapeDrawing = () => {
            if (previewLine) {
                fc.remove(previewLine);
                previewLine = null;
            }
            if (sourceMarker) {
                sourceMarker.set({ borderColor: '', borderScaleFactor: 1 });
                sourceMarker = null;
            }
            sourceEntityId = null;

            // Restore status bar mode display
            showHint('');

            const fc2 = this.canvas && this.canvas.fabricCanvas;
            if (fc2 && this._shapeHandlers) {
                for (const [ev, fn] of Object.entries(this._shapeHandlers)) {
                    fc2.off(ev, fn);
                }
                this._shapeHandlers = null;
            }

            // Restore prototype method for future tool activations
            delete this._cleanupShapeDrawing;
        };
    }
}
