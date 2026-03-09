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
            polyline: 'markup', arrow: 'markup', 'sticky-note': 'markup', 'image-overlay': 'markup',
            distance: 'measure', area: 'measure', count: 'measure',
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
                // Re-populate the settings list to reflect the reset state
                this._populateSettingsLists();
            });
        }

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

                // Redo: Ctrl+Y (alternative)
                case 'y':
                    if (e.ctrlKey && this.canvas) {
                        e.preventDefault();
                        this.canvas.redo();
                    }
                    break;

                // Escape: deselect tool, return to select/pan mode
                case 'Escape':
                    this.setTool(null);
                    break;

                // V: Select tool
                case 'v':
                    if (!e.ctrlKey) {
                        this.setTool('select');
                    }
                    break;

                // P: Pen tool
                case 'p':
                    if (!e.ctrlKey) {
                        this.setTool('pen');
                    }
                    break;

                // R: Rectangle tool
                case 'r':
                    if (!e.ctrlKey) {
                        this.setTool('rect');
                    }
                    break;

                // E: Ellipse tool
                case 'e':
                    if (!e.ctrlKey) {
                        this.setTool('ellipse');
                    }
                    break;

                // L: Line tool
                case 'l':
                    if (!e.ctrlKey) {
                        this.setTool('line');
                    }
                    break;

                // H: Highlighter tool (H = Highlight — do not reassign to Hand)
                case 'h':
                    if (!e.ctrlKey) {
                        this.setTool('highlighter');
                    }
                    break;

                // G: Hand / Grab / Pan tool (G = Grab — H is taken by Highlighter)
                case 'g':
                    if (!e.ctrlKey) {
                        this.setTool('hand');
                    }
                    break;

                // T: Text tool
                case 't':
                    if (!e.ctrlKey) {
                        this.setTool('text');
                    }
                    break;

                // C: Cloud tool
                case 'c':
                    if (!e.ctrlKey) {
                        this.setTool('cloud');
                    }
                    break;

                // O: Callout tool
                case 'o':
                    if (!e.ctrlKey) {
                        this.setTool('callout');
                    }
                    break;

                // W: Polyline tool (multi-segment connected line)
                // Bluebeam uses SHIFT+N; we use capital 'N' (Shift+N in browser key events)
                // to avoid conflicting with lowercase 'n' (count tool).
                case 'W':
                case 'w':
                    if (!e.ctrlKey) {
                        this.setTool('polyline');
                    }
                    break;

                // Phase 2: Measurement tool shortcuts
                // U: Distance ruler (mnemonic: rUler)
                case 'u':
                    if (!e.ctrlKey) {
                        this.setTool('distance');
                    }
                    break;

                // a: Area tool (lowercase — no shift)
                case 'a':
                    if (!e.ctrlKey) {
                        this.setTool('area');
                    }
                    break;

                // A: Arrow markup (Shift+A — uppercase is produced by Shift+A in key events)
                // 'a' is taken by Area, so Shift+A = uppercase 'A' gives Arrow.
                case 'A':
                    if (!e.ctrlKey) {
                        this.setTool('arrow');
                    }
                    break;

                // S: Sticky Note — click-to-place editable note box with yellow background
                case 's':
                    if (!e.ctrlKey) {
                        this.setTool('sticky-note');
                    }
                    break;

                // I: Image Overlay — upload a photo and place it as a Fabric.Image markup
                case 'i':
                    if (!e.ctrlKey) {
                        this.setTool('image-overlay');
                    }
                    break;

                // N: Count tool (mnemonic: Number)
                case 'n':
                    if (!e.ctrlKey) {
                        this.setTool('count');
                    }
                    break;

                // K: Calibrate scale (mnemonic: calibrate with Known dimension)
                case 'k':
                    if (!e.ctrlKey) {
                        this.setTool('calibrate');
                    }
                    break;

                // Q: Quick Capture — opens entity capture panel (not a drawing tool)
                case 'q':
                    if (!e.ctrlKey && window.app && window.app.quickCapture) {
                        window.app.quickCapture.open();
                    }
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

            case 'area':
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                if (this.measureTools) {
                    this.measureTools.initArea(this.canvas, this, this.scale);
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
        const fontFamily = textPrefs.fontFamily || 'Arial, sans-serif';
        const fontSize   = Math.max(8, Math.min(200, Number(textPrefs.fontSize) || 16));
        const fontWeight = textPrefs.bold   ? 'bold'   : 'normal';
        const fontStyle  = textPrefs.italic ? 'italic' : 'normal';

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

            // One-shot: clean up this handler and switch to select tool
            // (without triggering toggle-off since activeTool is 'text' not 'select')
            this._cleanupShapeDrawing();
            this.activeTool = 'select';
            document.querySelectorAll('.tool-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tool === 'select');
            });
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

            // One-shot: clean up this mousedown handler and switch to select tool.
            // Done immediately after placement — the editing:exited handler above
            // is attached directly to the noteObj, not to the canvas handler.
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
}
