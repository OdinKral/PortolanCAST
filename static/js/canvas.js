/**
 * PortolanCAST — Canvas Overlay Module
 *
 * Purpose:
 *   Fabric.js canvas overlay that sits on top of the PDF image for markup.
 *   Handles zoom synchronization, page-change save/restore, and coordinate
 *   mapping between natural (BASE_DPI) pixels and display pixels.
 *
 * Architecture:
 *   - Fabric objects use NATURAL coordinates (the image's actual pixel dims)
 *   - Display size = natural * (zoom / 100), applied via CSS + Fabric setZoom
 *   - Pan sync is free — canvas is a child of #canvas-container which scrolls
 *     inside #viewport, so scroll-based panning moves both image and canvas
 *   - Page markups are stored in an in-memory Map (pageNumber → Fabric JSON)
 *   - pointer-events toggle via .drawing-active CSS class
 *
 * Coordinate strategy:
 *   Natural coords = pixel coordinates at BASE_DPI (150).
 *   Display coords = natural * (zoom / 100).
 *   On zoom: set canvas CSS to display dims, Fabric.setZoom(zoom/100),
 *            internal dims stay at natural. toJSON() always returns natural coords.
 *
 * Security:
 *   - No external data ingestion in this module
 *   - JSON serialization is Fabric.js internal format only
 *   - No eval or dynamic code execution
 *
 * Author: PortolanCAST
 * Version: 0.2.0
 * Date: 2026-02-15
 */

// =============================================================================
// CUSTOM PROPERTIES — Semantic metadata preserved through serialization
// =============================================================================

/**
 * Custom properties added to Fabric objects for semantic markup.
 * These are included in toJSON() so they survive save/load cycles.
 *
 * markupType:      'note' | 'issue' | 'question' | 'approval' | 'change'
 * markupStatus:    'open' | 'resolved'
 * markupNote:      Free-text annotation
 * markupAuthor:    Who created the markup (defaults to 'User', Phase 4 → real identity)
 * markupTimestamp: ISO 8601 creation time — set once at creation, never overwritten
 *
 * Phase 2 — measurement properties (on Group or Polygon objects created by MeasureTools):
 * measurementType: 'distance' | 'area' | 'count'
 * pixelLength:     Pixel distance in natural Fabric coords (distance tool + calibration)
 * pixelArea:       Square pixels via Shoelace formula (area tool)
 * countIndex:      Integer 1-N auto-incremented per canvas page (count tool)
 * countGroup:      String group name for organizing count markers (default 'default')
 * labelText:       Display string baked at creation time ("10.5 ft", "150.3 sq ft", "#3")
 */
const CUSTOM_PROPERTIES = [
    'markupType', 'markupStatus', 'markupNote',
    'markupAuthor', 'markupTimestamp',
    // Photo attachment: stable UUID per markup object.
    // Set once at creation in stampDefaults(), never overwritten.
    // Used as the lookup key for markup_photos in the server DB.
    'markupId',
    // Phase 2: measurement tool properties
    'measurementType', 'pixelLength', 'pixelArea',
    'countIndex', 'countGroup', 'labelText',
    // Phase 3A: node editing support
    // pairedId links a polygon/label pair so NodeEditor can find the companion label
    // lineEndpoints stores line endpoints relative to group.left/top for endpoint editing
    'pairedId', 'lineEndpoints',
    // Phase 5: layer assignment — which layer this markup belongs to
    'layerId',
    // Q2: callout group identification — survives save/load so double-click
    // editing is always available without relying on child object inspection.
    '_isCallout',
    // Equipment marker: links a visual pin on the drawing to a DB entity ID.
    // Set when the user picks/creates an entity in the Equipment Marker panel.
    'entityId',
];

/**
 * Semantic color mapping — markupType → stroke color.
 *
 * Color is information, not decoration. Each markup type has a distinct
 * color so users can identify intent at a glance without reading labels.
 * This closes a critical feedback loop for Csikszentmihalyi's flow state:
 * the visual confirms the intent immediately.
 *
 * Exported so toolbar.js, properties.js, and markup-list.js can share
 * the same mapping.
 */
export const MARKUP_COLORS = {
    note:     '#aaaaaa',  // Gray — neutral annotation
    issue:    '#ff4444',  // Red — problem, needs attention
    question: '#ffaa00',  // Amber — uncertainty, needs answer
    approval: '#44cc66',  // Green — accepted, good to go
    change:   '#4a9eff',  // Blue — modification, scope change
    // Image overlays carry no stroke — transparent keeps stampDefaults() safe
    // if preserveColor is ever omitted by a future caller.
    'image-overlay': 'transparent',
    // Equipment marker pin — purple distinguishes entity pins from markup annotations
    'equipment-marker': '#c678dd',
};

/**
 * Patch Fabric.js Object.prototype.toObject to always include our custom
 * semantic properties in serialization output.
 *
 * WHY: Fabric.js 6.x's canvas.toJSON(propertiesToInclude) doesn't reliably
 * pass propertiesToInclude through to each object's toObject() in all
 * serialization paths (page change, undo/redo, loadFromJSON callbacks).
 * Patching the prototype guarantees custom properties survive every path.
 *
 * SECURITY: Only adds properties from a hardcoded allowlist (CUSTOM_PROPERTIES).
 */
if (typeof fabric !== 'undefined') {
    const _originalToObject = fabric.Object.prototype.toObject;
    fabric.Object.prototype.toObject = function (propertiesToInclude = []) {
        return _originalToObject.call(
            this,
            [...new Set([...propertiesToInclude, ...CUSTOM_PROPERTIES])]
        );
    };
}

// =============================================================================
// CANVAS OVERLAY
// =============================================================================

/**
 * Fabric.js canvas overlay for PDF markup.
 *
 * Manages a Fabric.Canvas instance positioned over the PDF image.
 * Synchronizes with the PDFViewer's zoom and page navigation.
 *
 * Usage:
 *   const canvas = new CanvasOverlay();
 *   canvas.init(viewer);             // after document loads
 *   canvas.syncToViewer();           // on zoom change
 *   canvas.onPageChanging(oldPage);  // before page switch
 *   canvas.onPageChanged(newPage);   // after page switch
 */
export class CanvasOverlay {
    constructor() {
        /** @type {boolean} Whether init() has been called successfully */
        this.initialized = false;

        /** @type {fabric.Canvas|null} The Fabric.js canvas instance */
        this.fabricCanvas = null;

        /** @type {object|null} Reference to PDFViewer for reading zoom/dimensions */
        this.viewer = null;

        /**
         * In-memory storage for per-page markup objects.
         * Key: page number (int), Value: Fabric.js JSON object
         * Persisted across page changes within a session.
         * @type {Map<number, object>}
         */
        this.pageMarkups = new Map();

        // Undo/redo state — JSON snapshot stack approach
        /** @type {string[]} Undo stack of JSON snapshots */
        this._undoStack = [];
        /** @type {string[]} Redo stack of JSON snapshots */
        this._redoStack = [];
        /** @type {number} Maximum undo history depth */
        this._maxUndoSteps = 50;
        /** @type {boolean} Guard against saving snapshots during undo/redo operations */
        this._undoRedoInProgress = false;

        /**
         * Callback fired when canvas content changes (object add/modify/remove).
         * App.js wires this to markDirty() for auto-save.
         * @type {Function|null}
         */
        this.onContentChange = null;
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the Fabric.js canvas overlay.
     *
     * Creates the Fabric.Canvas from the <canvas id="fabric-canvas"> element,
     * sets initial dimensions to match the PDF image natural size, and applies
     * the current zoom level.
     *
     * Args:
     *   viewer: PDFViewer instance — used to read imageNaturalWidth/Height and zoom.
     *
     * Preconditions:
     *   - <canvas id="fabric-canvas"> must exist in the DOM
     *   - Fabric.js must be loaded (globalThis.fabric available)
     *   - viewer.imageNaturalWidth/Height should be set (image loaded)
     */
    init(viewer) {
        if (!viewer) {
            console.error('[Canvas] init() requires a viewer reference');
            return;
        }

        // SECURITY: Verify Fabric.js is loaded before proceeding
        if (typeof fabric === 'undefined') {
            console.error('[Canvas] Fabric.js not loaded — cannot initialize overlay');
            return;
        }

        this.viewer = viewer;

        // If re-initializing (e.g. loading a new document), clean up the old canvas
        if (this.fabricCanvas) {
            // Remove image load listener from previous init
            if (this._onImageLoad && this.viewer.pdfImage) {
                this.viewer.pdfImage.removeEventListener('load', this._onImageLoad);
                this._onImageLoad = null;
            }
            this.fabricCanvas.dispose();
            this.fabricCanvas = null;
            this.pageMarkups.clear();
        }

        // Create Fabric.Canvas from the HTML canvas element
        // Fabric wraps it in a .canvas-container div with upper/lower canvas layers
        this.fabricCanvas = new fabric.Canvas('fabric-canvas', {
            // Don't render a selection rectangle background
            selectionColor: 'rgba(74, 158, 255, 0.15)',
            selectionBorderColor: '#4a9eff',
            selectionLineWidth: 1,
            // Disable default controls styling — we'll customize in Phase 1
            preserveObjectStacking: true,
            // Don't intercept events when no tool is active
            skipTargetFind: false,
        });

        // Set internal canvas dimensions to natural image size
        // These are the coordinate-space dimensions, not display dimensions
        const natW = this.viewer.imageNaturalWidth || 1;
        const natH = this.viewer.imageNaturalHeight || 1;
        this.fabricCanvas.setDimensions({ width: natW, height: natH });

        // Apply current zoom so canvas display size matches the image
        this._applyZoom();

        // Listen for image load events to sync canvas when natural dims become available.
        // This handles the race condition where init() is called before the first
        // page image has loaded (imageNaturalWidth/Height are still 0).
        const pdfImage = this.viewer.pdfImage;
        if (pdfImage) {
            this._onImageLoad = () => this.syncToViewer();
            pdfImage.addEventListener('load', this._onImageLoad);
        }

        // Forward wheel scroll events from the canvas to #viewport.
        // Fabric.js intercepts wheel events on its canvas layers and calls
        // preventDefault(), which cancels browser-native scrolling before the
        // event reaches #viewport's scroll handler. We intercept in CAPTURE
        // phase (parent fires before child) — before Fabric's handlers fire —
        // and manually forward non-zoom scroll deltas to the viewport.
        const wrapper = this.fabricCanvas.wrapperEl;
        if (wrapper) {
            this._bindScrollForwarding(wrapper);
        }

        // Enable shift-click multi-select on the Fabric canvas
        this._bindShiftClickSelect();

        // Set up undo/redo event listeners and save initial baseline
        this._bindUndoEvents();
        this._saveBaselineSnapshot();

        this.initialized = true;
        console.log(`[Canvas] Fabric.js overlay initialized (${natW}×${natH} natural)`);
    }

    // =========================================================================
    // SCROLL FORWARDING
    // =========================================================================

    /**
     * Forward wheel events from the Fabric canvas wrapper to #viewport.
     *
     * WHY: Fabric.js registers internal listeners on its canvas layers that
     * call preventDefault() on wheel events, preventing the browser from
     * naturally scrolling #viewport when the user scrolls over the canvas.
     *
     * We register in CAPTURE phase so our handler fires BEFORE the event
     * descends to Fabric's canvas-element-level handlers. For non-Ctrl scroll:
     * we prevent default, stop propagation, and manually apply the delta to
     * the viewport. For Ctrl+scroll (zoom): we return early and let the event
     * propagate normally to #viewport's existing zoom handler.
     *
     * Cleanup: when fabricCanvas.dispose() is called (re-init), the wrapperEl
     * is removed from DOM and this listener is garbage-collected — no explicit
     * removeEventListener needed.
     *
     * Args:
     *   wrapper: The Fabric .canvas-container wrapper div element.
     */
    _bindScrollForwarding(wrapper) {
        wrapper.addEventListener('wheel', (e) => {
            // Ctrl+wheel = zoom — let #viewport's wheel handler manage it.
            // Return without intercepting; event propagates normally.
            if (e.ctrlKey) return;

            // Translate delta to pixels. Most desktop browsers report
            // DOM_DELTA_PIXEL; trackpads and some devices use line or page units.
            let dy = e.deltaY;
            let dx = e.deltaX;
            if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
                // Approximate 1 line = 24px (standard CSS line-height estimate)
                dy *= 24;
                dx *= 24;
            } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
                dy *= this.viewer.viewport.clientHeight;
                dx *= this.viewer.viewport.clientWidth;
            }

            // Stop here: Fabric must not handle this event, and we scroll manually.
            e.preventDefault();
            e.stopPropagation();

            // Scroll #viewport — identical effect to native browser scroll
            this.viewer.viewport.scrollLeft += dx;
            this.viewer.viewport.scrollTop += dy;
        }, { passive: false, capture: true });
    }

    // =========================================================================
    // ZOOM SYNCHRONIZATION
    // =========================================================================

    /**
     * Synchronize the canvas size and zoom to match the PDF viewer.
     *
     * Called when zoom changes. Sets:
     *   1. Fabric internal dimensions to natural image size (coordinate space)
     *   2. Fabric viewport zoom to viewer.zoom / 100
     *   3. Canvas CSS dimensions to displayed image size
     *
     * This keeps markup objects in natural coords while rendering at display scale.
     */
    syncToViewer() {
        if (!this.initialized || !this.fabricCanvas) return;
        this._applyZoom();
    }

    /**
     * Internal: apply current viewer zoom to the Fabric canvas.
     *
     * Uses Fabric's setZoom for the viewport transform (objects scale automatically)
     * and sets CSS dimensions so the canvas element matches the displayed image.
     */
    _applyZoom() {
        if (!this.viewer || !this.fabricCanvas) return;

        const natW = this.viewer.imageNaturalWidth || 1;
        const natH = this.viewer.imageNaturalHeight || 1;
        const scale = this.viewer.zoom / 100;

        // Display dimensions — MUST exactly match the PDF image's CSS width/height.
        // Use the same Math.round() as pdf-viewer.js._applyZoom() to prevent
        // sub-pixel drift between the image and canvas overlay.
        const displayW = Math.round(natW * scale);
        const displayH = Math.round(natH * scale);

        // CRITICAL: Set canvas element dimensions to DISPLAY size, not natural size.
        // Fabric's setZoom(scale) applies a viewport transform that scales objects
        // from natural coords to display coords. If we set canvas element size to
        // natural and then CSS-scale to display, objects get scaled TWICE:
        //   position * scale (Fabric zoom) * scale (CSS scaling) = scale^2
        // By setting element size = display size, there's no CSS scaling — Fabric's
        // setZoom alone handles the natural→display coordinate transform.
        this.fabricCanvas.setDimensions({ width: displayW, height: displayH });

        // Fabric viewport zoom — objects stored in natural coords render at display scale
        this.fabricCanvas.setZoom(scale);

        // Size the Fabric wrapper div (.canvas-container) to match the PDF image
        const wrapper = this.fabricCanvas.wrapperEl;
        if (wrapper) {
            wrapper.style.width = displayW + 'px';
            wrapper.style.height = displayH + 'px';
        }

        this.fabricCanvas.renderAll();
    }

    // =========================================================================
    // PAGE CHANGE HANDLING
    // =========================================================================

    /**
     * Save current page's markups before navigating away.
     *
     * Serializes all Fabric objects to JSON and stores them in the in-memory
     * page map. Must be called BEFORE the page image changes.
     *
     * Args:
     *   currentPage: The page number we're leaving (zero-indexed).
     */
    onPageChanging(currentPage) {
        if (!this.initialized || !this.fabricCanvas) return;

        // Only save if there are objects on the canvas
        const objects = this.fabricCanvas.getObjects();
        if (objects.length > 0) {
            this.pageMarkups.set(currentPage, this.fabricCanvas.toJSON(CUSTOM_PROPERTIES));
        } else {
            // Clear entry if page has no markups (don't store empty JSON)
            this.pageMarkups.delete(currentPage);
        }
    }

    /**
     * Load the new page's markups after navigating to it.
     *
     * Clears the canvas, loads any stored markups for the target page,
     * and re-applies the current zoom. Must be called AFTER the page changes.
     *
     * Args:
     *   newPage: The page number we've navigated to (zero-indexed).
     */
    async onPageChanged(newPage) {
        if (!this.initialized || !this.fabricCanvas) return;

        // Guard against undo snapshots during page load
        this._undoRedoInProgress = true;

        // Clear the canvas for the new page
        this.fabricCanvas.clear();

        // Restore saved markups if they exist for this page
        const saved = this.pageMarkups.get(newPage);
        if (saved) {
            await this.fabricCanvas.loadFromJSON(saved);
            // Re-apply zoom after loading — loadFromJSON may reset transform
            this._applyZoom();
            this.fabricCanvas.renderAll();
        } else {
            // No saved markups — just ensure zoom is correct
            this._applyZoom();
        }

        this._undoRedoInProgress = false;
        // Reset undo stack for the new page — loaded state is the baseline
        this._saveBaselineSnapshot();
    }

    // =========================================================================
    // DRAWING MODE TOGGLE
    // =========================================================================

    /**
     * Enable or disable drawing mode.
     *
     * When drawing is active:
     *   1. .drawing-active class is added to the Fabric wrapper element (CSS fallback)
     *   2. A bubble-phase mousedown listener is added to the wrapper that calls
     *      stopPropagation(), preventing events from ever reaching #viewport's pan handler.
     *
     * WHY stopPropagation instead of CSS alone:
     *   Fabric.js 6 dynamically sets pointer-events on its canvas layers via inline styles
     *   during rendering. These inline styles can override the CSS cascade, causing events
     *   to reach #viewport even when .drawing-active is present. The stopPropagation
     *   approach is immune to CSS specificity battles — it intercepts at the event level
     *   before #viewport's handler fires, regardless of computed styles.
     *
     * Args:
     *   enabled: boolean — true to enable drawing, false to disable.
     */
    setDrawingMode(enabled) {
        if (!this.fabricCanvas) return;

        // Fabric wraps our canvas in a .canvas-container div
        const wrapper = this.fabricCanvas.wrapperEl;
        if (!wrapper) return;

        wrapper.classList.toggle('drawing-active', enabled);

        if (enabled && !this._panBlockHandler) {
            // Bubble phase — fires AFTER Fabric processes the event.
            // Stops the event from propagating up to #viewport's pan handler.
            // This is the authoritative guard: CSS .drawing-active is a backup.
            this._panBlockHandler = (e) => e.stopPropagation();
            wrapper.addEventListener('mousedown', this._panBlockHandler);
        } else if (!enabled && this._panBlockHandler) {
            wrapper.removeEventListener('mousedown', this._panBlockHandler);
            this._panBlockHandler = null;
        }
    }

    // =========================================================================
    // SHIFT-CLICK MULTI-SELECT
    // =========================================================================

    /**
     * Enable shift-click to add/remove objects from the selection.
     *
     * Fabric.js 6 supports drag-to-lasso selection natively (via
     * `selection: true`), but does NOT handle shift-click to incrementally
     * build a selection set. This handler fills that gap.
     *
     * Behavior:
     *   - Shift+click on an unselected object → add it to the current selection
     *   - Shift+click on an already-selected object → remove it from selection
     *   - Click without Shift → normal single-select (Fabric default)
     *
     * Implementation uses Fabric's `mouse:down:before` event which fires
     * before Fabric's internal selection logic. We set `e.e.__shiftMultiSelect`
     * as a flag, then handle the actual selection in `mouse:down` after
     * Fabric has identified the target object.
     */
    _bindShiftClickSelect() {
        if (!this.fabricCanvas) return;

        this.fabricCanvas.on('mouse:down', (opt) => {
            // Only act on shift-click when selection is enabled (select tool active)
            if (!opt.e.shiftKey) return;
            if (!this.fabricCanvas.selection) return;

            const target = opt.target;
            if (!target) return;

            // Don't interfere with ActiveSelection internal objects
            // (clicking inside an existing multi-select group)
            if (target.type === 'activeselection') return;

            const activeObj = this.fabricCanvas.getActiveObject();

            if (!activeObj) {
                // Nothing selected yet — just let Fabric select normally
                return;
            }

            // Prevent Fabric's default selection behavior from replacing our work
            opt.e.preventDefault();

            if (activeObj.type === 'activeselection') {
                // Already multi-selected — add or remove the target
                const group = activeObj;
                const objects = group.getObjects();

                if (objects.includes(target)) {
                    // Target is already in the selection — remove it
                    group.removeWithUpdate(target);
                    if (group.getObjects().length === 1) {
                        // Only one left — collapse to single selection
                        const remaining = group.getObjects()[0];
                        this.fabricCanvas.discardActiveObject();
                        this.fabricCanvas.setActiveObject(remaining);
                    } else if (group.getObjects().length === 0) {
                        this.fabricCanvas.discardActiveObject();
                    }
                } else {
                    // Add target to existing selection
                    group.addWithUpdate(target);
                }
            } else {
                // Single object selected — create ActiveSelection with both
                if (activeObj === target) {
                    // Shift-clicked the same object — deselect
                    this.fabricCanvas.discardActiveObject();
                } else {
                    // Create a new ActiveSelection with both objects
                    this.fabricCanvas.discardActiveObject();
                    const sel = new fabric.ActiveSelection(
                        [activeObj, target],
                        { canvas: this.fabricCanvas }
                    );
                    this.fabricCanvas.setActiveObject(sel);
                }
            }

            this.fabricCanvas.requestRenderAll();
        });
    }

    // =========================================================================
    // UNDO / REDO
    // =========================================================================

    /**
     * Set up Fabric.js event listeners that snapshot canvas state for undo.
     * Called once during init() after the Fabric canvas is created.
     */
    _bindUndoEvents() {
        if (!this.fabricCanvas) return;

        // These events fire after user interactions that change canvas content
        const saveSnapshot = () => {
            if (this._undoRedoInProgress) return;
            this._pushUndoSnapshot();
            if (this.onContentChange) this.onContentChange();
        };

        this.fabricCanvas.on('object:added', saveSnapshot);
        this.fabricCanvas.on('object:modified', saveSnapshot);
        this.fabricCanvas.on('object:removed', saveSnapshot);

        // Stamp semantic metadata on pen strokes when they're created.
        // path:created fires for free-drawing (pen tool) — object:added
        // also fires for these, so undo snapshot is handled above.
        // Color is set by the pen brush config in toolbar.js (which reads
        // the active intent mode), so we use preserveColor to keep it.
        this.fabricCanvas.on('path:created', (opt) => {
            if (opt.path && !opt.path.markupType) {
                this.stampDefaults(opt.path, { preserveColor: true });
            }
        });

        // Text editing cleanup — remove empty text objects when user exits editing
        // (e.g. placed text then pressed Escape without typing)
        this.fabricCanvas.on('text:editing:exited', (opt) => {
            if (opt.target && (!opt.target.text || !opt.target.text.trim())) {
                this.fabricCanvas.remove(opt.target);
            }
            this.fabricCanvas.renderAll();
        });

        // Text content changes trigger auto-save (typing in IText)
        this.fabricCanvas.on('text:changed', () => {
            if (this._undoRedoInProgress) return;
            if (this.onContentChange) this.onContentChange();
        });
    }

    /**
     * Save the current canvas state to the undo stack.
     * Clears the redo stack (new action invalidates redo history).
     */
    _pushUndoSnapshot() {
        const snapshot = JSON.stringify(this.fabricCanvas.toJSON(CUSTOM_PROPERTIES));
        this._undoStack.push(snapshot);

        // Cap stack size to prevent memory bloat on long editing sessions
        if (this._undoStack.length > this._maxUndoSteps) {
            this._undoStack.shift();
        }

        // New action kills redo history — can't redo after new changes
        this._redoStack = [];
    }

    /**
     * Save a baseline snapshot (the initial state before any edits).
     * Called after init and after page change/load.
     */
    _saveBaselineSnapshot() {
        this._undoStack = [];
        this._redoStack = [];
        // Save initial state so first undo returns to "no markups" or "loaded markups"
        if (this.fabricCanvas) {
            this._undoStack.push(JSON.stringify(this.fabricCanvas.toJSON(CUSTOM_PROPERTIES)));
        }
    }

    /**
     * Undo the last canvas change.
     *
     * Pops the current state onto the redo stack and restores the previous
     * state from the undo stack. Uses Fabric.js 6 Promise API for loadFromJSON
     * (v6 changed 2nd arg from callback to reviver function).
     *
     * Returns:
     *   Promise<boolean> — true if undo was performed, false if nothing to undo.
     */
    async undo() {
        if (!this.fabricCanvas || this._undoStack.length <= 1) return false;

        this._undoRedoInProgress = true;

        // Current state goes to redo stack
        const current = this._undoStack.pop();
        this._redoStack.push(current);

        // Restore previous state
        const previous = this._undoStack[this._undoStack.length - 1];
        await this.fabricCanvas.loadFromJSON(JSON.parse(previous));
        this._applyZoom();
        this.fabricCanvas.renderAll();
        this._undoRedoInProgress = false;
        if (this.onContentChange) this.onContentChange();

        return true;
    }

    /**
     * Redo the last undone canvas change.
     *
     * Pops from the redo stack and pushes onto the undo stack.
     * Uses Fabric.js 6 Promise API for loadFromJSON.
     *
     * Returns:
     *   Promise<boolean> — true if redo was performed, false if nothing to redo.
     */
    async redo() {
        if (!this.fabricCanvas || this._redoStack.length === 0) return false;

        this._undoRedoInProgress = true;

        // Pop from redo and push to undo
        const next = this._redoStack.pop();
        this._undoStack.push(next);

        // Restore the redo state
        await this.fabricCanvas.loadFromJSON(JSON.parse(next));
        this._applyZoom();
        this.fabricCanvas.renderAll();
        this._undoRedoInProgress = false;
        if (this.onContentChange) this.onContentChange();

        return true;
    }

    /** @returns {boolean} Whether undo is available */
    get canUndo() { return this._undoStack.length > 1; }

    /** @returns {boolean} Whether redo is available */
    get canRedo() { return this._redoStack.length > 0; }

    // =========================================================================
    // SERIALIZATION
    // =========================================================================

    /**
     * Clear all markups on the current canvas page.
     * Does NOT clear the in-memory store for other pages.
     */
    clear() {
        if (!this.fabricCanvas) return;
        this.fabricCanvas.clear();
        this._applyZoom();
    }

    /**
     * Serialize current canvas markups to JSON for persistence.
     *
     * Returns Fabric.js JSON in natural coordinates (independent of zoom).
     * Suitable for saving to server/database.
     *
     * Returns:
     *   Object — Fabric.js canvas JSON (not a string).
     */
    toJSON() {
        if (!this.fabricCanvas) return { objects: [] };
        // Include semantic custom properties so they survive save/load
        return this.fabricCanvas.toJSON(CUSTOM_PROPERTIES);
    }

    /**
     * Load markups from JSON onto the canvas.
     *
     * Expects Fabric.js JSON format in natural coordinates.
     * Re-applies current zoom after loading.
     *
     * Args:
     *   json: Object — Fabric.js canvas JSON.
     */
    async fromJSON(json) {
        if (!this.fabricCanvas || !json) return;

        await this.fabricCanvas.loadFromJSON(json);
        this._applyZoom();
        this.fabricCanvas.renderAll();
    }

    /**
     * Get all in-memory page markups as a serializable object.
     *
     * Returns:
     *   Object — { pageNumber: fabricJSON, ... } for all pages with markups.
     */
    getAllPageMarkups() {
        // Save current page first so the map is up-to-date
        if (this.viewer && this.fabricCanvas) {
            this.onPageChanging(this.viewer.currentPage);
        }

        const result = {};
        for (const [page, json] of this.pageMarkups) {
            result[page] = json;
        }
        return result;
    }

    /**
     * Set default semantic metadata on a Fabric object.
     *
     * Every markup is a data point — this ensures objects carry semantic
     * properties from creation, even if the user hasn't set them via UI yet.
     *
     * Args:
     *   obj: Fabric.js object to stamp with defaults.
     *   overrides: Optional object to override defaults (e.g. { markupType: 'issue' }).
     */
    stampDefaults(obj, overrides = {}) {
        if (!obj) return;
        // Only set fields that aren't already set — this function is called both
        // at object creation (fresh object, all defaults apply) AND for legacy
        // migration (existing object may have valid user-set values we must not wipe).
        const type = overrides.markupType || obj.markupType || 'note';
        obj.markupType = type;
        if (!obj.markupStatus) obj.markupStatus = overrides.markupStatus || 'open';
        if (!obj.markupNote && obj.markupNote !== '') {
            obj.markupNote = overrides.markupNote || '';
        } else if (overrides.markupNote) {
            obj.markupNote = overrides.markupNote;
        }

        // Author and timestamp are creation-only — never overwritten on re-stamps.
        // This preserves the original creator and time even if the markup is edited
        // later. Phase 4 will replace 'User' with identity from user settings.
        if (!obj.markupTimestamp) {
            obj.markupTimestamp = new Date().toISOString();
        }
        if (!obj.markupAuthor) {
            obj.markupAuthor = overrides.markupAuthor || 'User';
        }

        // markupId: stable UUID used as the cross-reference key for photo
        // attachments in the server DB. Set once at creation — never overwritten
        // even when the user edits the markup. Legacy objects (saved before this
        // field existed) will receive a UUID lazily on their first stampDefaults()
        // call (e.g. when selected and shown in the properties panel).
        if (!obj.markupId) {
            obj.markupId = crypto.randomUUID();
        }

        // Color-as-meaning: set stroke to the semantic color for this type
        // unless an explicit color override was provided (e.g. pen tool, which
        // already set the brush color to match the active intent mode)
        if (!overrides.preserveColor) {
            obj.set('stroke', MARKUP_COLORS[type] || MARKUP_COLORS.note);
        }
    }

    /**
     * Load page markups from a server-provided data object.
     *
     * Populates the in-memory Map and loads the current page's markups
     * onto the canvas. Called after fetching from GET /api/documents/{id}/markups.
     *
     * Args:
     *   pages: Object — { "pageNumber": fabricJSON, ... } from server.
     *          Keys are strings (JSON transport), converted to ints internally.
     */
    loadAllPageMarkups(pages) {
        if (!pages || typeof pages !== 'object') return;

        this.pageMarkups.clear();

        for (const [pageStr, fabricJson] of Object.entries(pages)) {
            const pageNum = parseInt(pageStr, 10);
            if (isNaN(pageNum)) continue;
            this.pageMarkups.set(pageNum, fabricJson);
        }

        // If we have markups for the current page, load them onto the canvas
        if (this.initialized && this.viewer) {
            const currentPage = this.viewer.currentPage;
            const saved = this.pageMarkups.get(currentPage);
            if (saved && this.fabricCanvas) {
                this._undoRedoInProgress = true;
                this.fabricCanvas.loadFromJSON(saved).then(() => {
                    this._applyZoom();
                    this.fabricCanvas.renderAll();
                    this._undoRedoInProgress = false;
                    // Loaded state becomes the undo baseline
                    this._saveBaselineSnapshot();
                });
            }
        }

        const pageCount = this.pageMarkups.size;
        if (pageCount > 0) {
            console.log(`[Canvas] Loaded markups for ${pageCount} page(s) from server`);
        }
    }
}
