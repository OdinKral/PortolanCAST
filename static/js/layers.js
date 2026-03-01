/**
 * PortolanCAST — Layer Manager Module (Phase 5)
 *
 * Purpose:
 *   Document-wide layer system for organizing markups into named, togglable
 *   layers (e.g. "Structural", "Electrical", "Comments"). Provides create,
 *   rename, delete, visibility toggle, and lock operations. Layer definitions
 *   persist to the server via document_settings. Each Fabric object is
 *   auto-assigned to the active layer when drawn.
 *
 * Architecture:
 *   - Layer defs stored in memory as _layers[] and persisted as JSON in the
 *     document_settings table (key "layers") — same store as scale settings.
 *   - Fabric objects get layerId stamped via object:added hook in initForCanvas().
 *   - Visibility/lock state applied by iterating all canvas objects whenever
 *     a layer state changes. This is O(n) in objects but document markups are
 *     small enough that it's imperceptible.
 *   - initForCanvas() is idempotent: removes old handler before rebinding
 *     so document reload doesn't accumulate duplicate handlers.
 *
 * Security:
 *   - Layer names rendered via textContent (never innerHTML) — XSS safe
 *   - Layer IDs generated with crypto.randomUUID() — not user-controlled
 *   - Server validates and clamps all layer fields on PUT
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-02-23
 */

// =============================================================================
// LAYER MANAGER
// =============================================================================

/**
 * Manages the layer panel and layer state for a document.
 *
 * Usage:
 *   const lm = new LayerManager();
 *   lm.init(canvas);                           // bind UI, idempotent
 *   lm.initForCanvas(canvas.fabricCanvas);     // rebind object:added per doc
 *   await lm.load(docId);                      // fetch from server, apply state
 *
 * Layer object shape:
 *   { id: string, name: string, visible: boolean, locked: boolean }
 */
export class LayerManager {
    constructor() {
        /** @type {Array<{id:string, name:string, visible:boolean, locked:boolean}>} */
        this._layers = [];

        /** @type {string} ID of the currently active layer */
        this._activeLayerId = 'default';

        /** @type {import('./canvas.js').CanvasOverlay|null} */
        this._canvas = null;

        /** @type {fabric.Canvas|null} Active Fabric canvas instance */
        this._fabricCanvas = null;

        /** @type {number|null} Current document ID */
        this._docId = null;

        /**
         * Stored reference to the object:added handler so initForCanvas()
         * can remove it before rebinding on document reload.
         * Fabric.js off() requires the exact same function reference used in on().
         * @type {Function|null}
         */
        this._objectAddedHandler = null;

        /** Guard: prevent double-binding the #btn-new-layer click */
        this._initBound = false;

        // ── Context menu state ────────────────────────────────────────────────
        /** @type {HTMLElement|null} The currently visible context menu element */
        this._contextMenu = null;

        /** @type {Function|null} The contextmenu event handler (stored for removal on rebind) */
        this._contextMenuHandler = null;

        /** @type {HTMLElement|null} The wrapper element the contextmenu listener is on */
        this._contextMenuWrapper = null;

        /** @type {Function|null} Global mousedown dismiss handler */
        this._ctxDismissClick = null;

        /** @type {Function|null} Global keydown dismiss handler */
        this._ctxDismissKey = null;
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Bind UI elements that don't change between document loads.
     * Safe to call multiple times — idempotent guard via _initBound.
     *
     * Args:
     *   canvas: CanvasOverlay instance (used for fabricCanvas access).
     */
    init(canvas) {
        this._canvas = canvas;

        if (this._initBound) return;
        this._initBound = true;

        const btnNew = document.getElementById('btn-new-layer');
        if (btnNew) {
            btnNew.addEventListener('click', () => this.addLayer());
        }

        console.log('[LayerManager] UI bound');
    }

    /**
     * Rebind the object:added handler to a fresh Fabric canvas instance.
     *
     * Called each time a new document is loaded because canvas.init()
     * creates a new fabric.Canvas object. Removes the previous handler
     * first to prevent accumulation across document loads.
     *
     * The handler does two things:
     *   1. Assigns layerId to newly drawn objects (if not already set)
     *   2. Applies visibility/lock state to all objects (including loaded ones)
     *
     * Args:
     *   fc: fabric.Canvas — the newly created Fabric canvas instance.
     */
    initForCanvas(fc) {
        // Remove old handler before rebinding (Fabric off() needs exact ref)
        if (this._fabricCanvas && this._objectAddedHandler) {
            this._fabricCanvas.off('object:added', this._objectAddedHandler);
        }

        this._fabricCanvas = fc;

        // Build and store handler so we can remove it on next rebind.
        this._objectAddedHandler = (e) => {
            const obj = e.target;
            if (!obj) return;

            // CRITICAL: Only assign layerId to "real" markup/measurement objects.
            //
            // Temp preview objects (area rubber-band, snap indicators, distance preview
            // line) have no markupType or measurementType. They are added with
            // evented=false + selectable=false intentionally so mouse clicks pass
            // through to the canvas — the area tool's onMouseDown guard does:
            //   if (opt.target) return;  // skip if click hit an existing object
            //
            // If we assigned layerId and called _applyLayerState on a temp object,
            // _applyLayerState would override evented → true (default layer is
            // unlocked), causing subsequent vertex clicks to hit the preview line
            // instead of the empty canvas, breaking area/distance polygon drawing.
            const isRealObject = !!(obj.markupType || obj.measurementType);
            if (!obj.layerId && isRealObject) {
                obj.layerId = this._activeLayerId;
            }

            // Apply layer state only to objects that belong to a layer.
            // This means real objects (just stamped above) AND loaded objects
            // (already have layerId from JSON serialization). Temp objects are
            // skipped here because they have no layerId.
            if (obj.layerId) {
                this._applyLayerState(obj);
            }
        };

        fc.on('object:added', this._objectAddedHandler);

        // Wire right-click layer assignment context menu.
        // Must rebind per document load since the Fabric canvas (and its
        // wrapperEl) is a new object each time.
        const wrapper = fc.wrapperEl;
        if (wrapper) {
            this.bindContextMenu(wrapper, fc);
        }

        console.log('[LayerManager] object:added bound to new Fabric canvas');
    }

    // =========================================================================
    // LOAD / SAVE
    // =========================================================================

    /**
     * Load layer definitions from the server for a document.
     *
     * Fetches the layer config, populates _layers and _activeLayerId,
     * then renders the panel and applies state to any objects already on
     * the canvas. Called with await in app.js _onDocumentLoaded() so layers
     * are ready before _loadMarkups() fires.
     *
     * Args:
     *   docId: Document database ID.
     */
    async load(docId) {
        this._docId = docId;
        try {
            const resp = await fetch(`/api/documents/${docId}/layers`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            this._layers = Array.isArray(data.layers) ? data.layers : [];
            this._activeLayerId = data.activeId || 'default';

            // Ensure there's always at least a Default layer (defensive)
            if (this._layers.length === 0) {
                this._layers = [{ id: 'default', name: 'Default', visible: true, locked: false }];
                this._activeLayerId = 'default';
            }

            this.refresh();

            // Apply layer state to any objects already on the canvas
            // (e.g., if layers were loaded after markups in a timing edge case)
            this._applyAllLayerStates();

            console.log(`[LayerManager] Loaded ${this._layers.length} layers for doc ${docId}`);
        } catch (err) {
            console.error('[LayerManager] Failed to load layers:', err);
            // Fallback to default single layer
            this._layers = [{ id: 'default', name: 'Default', visible: true, locked: false }];
            this._activeLayerId = 'default';
            this.refresh();
        }
    }

    /**
     * Persist current layer definitions to the server.
     *
     * Uses PUT /api/documents/{id}/layers with the full layer array and
     * current activeId. Called after any state-changing operation
     * (add, delete, rename, toggle visible/locked).
     *
     * Failures are logged but do not throw — layer operations feel instant
     * to the user even if the network lags. The next save will retry the
     * full current state.
     */
    async _save() {
        if (!this._docId) return;
        try {
            await fetch(`/api/documents/${this._docId}/layers`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    layers: this._layers,
                    activeId: this._activeLayerId,
                }),
            });
        } catch (err) {
            console.error('[LayerManager] Failed to save layers:', err);
        }
    }

    // =========================================================================
    // LAYER CRUD
    // =========================================================================

    /**
     * Set a layer as the active drawing target.
     *
     * Updates the visual highlight in the panel. All subsequent objects
     * drawn on the canvas will be assigned to this layer.
     *
     * Args:
     *   id: Layer ID string.
     */
    setActive(id) {
        this._activeLayerId = id;
        // Update DOM — highlight active row
        const rows = document.querySelectorAll('#layers-list .layer-row');
        rows.forEach(row => {
            row.classList.toggle('active', row.dataset.layerId === id);
        });
    }

    /**
     * Toggle a layer's visibility.
     *
     * When hidden: objects on this layer become invisible (obj.visible = false).
     * When shown: objects become visible again.
     * State is saved to the server after every toggle.
     *
     * Args:
     *   id: Layer ID string.
     */
    toggleVisible(id) {
        const layer = this._layers.find(l => l.id === id);
        if (!layer) return;
        layer.visible = !layer.visible;
        this._applyAllLayerStates();
        this._save();
        this.refresh();
    }

    /**
     * Toggle a layer's lock state.
     *
     * When locked: objects are not selectable or evented (can't be moved).
     * When unlocked: objects become interactive again.
     * Visibility is not affected by lock state.
     *
     * Args:
     *   id: Layer ID string.
     */
    toggleLocked(id) {
        const layer = this._layers.find(l => l.id === id);
        if (!layer) return;
        layer.locked = !layer.locked;
        this._applyAllLayerStates();
        this._save();
        this.refresh();
    }

    /**
     * Add a new layer to the document.
     *
     * Creates a layer with a UUID, auto-generated name "Layer N",
     * visible=true, locked=false. Saves and refreshes the panel.
     */
    addLayer() {
        const n = this._layers.length + 1;
        const newLayer = {
            id: crypto.randomUUID(),
            name: `Layer ${n}`,
            visible: true,
            locked: false,
        };
        this._layers.push(newLayer);
        this._save();
        this.refresh();
        console.log(`[LayerManager] Added layer: ${newLayer.name} (${newLayer.id})`);
    }

    /**
     * Rename a layer.
     *
     * Updates the layer name in memory and saves. The panel is not
     * fully re-rendered — the caller manages DOM inline-edit cleanup.
     *
     * Args:
     *   id:   Layer ID string.
     *   name: New name string (will be trimmed).
     */
    renameLayer(id, name) {
        const layer = this._layers.find(l => l.id === id);
        if (!layer) return;
        const trimmed = name.trim();
        if (!trimmed) return; // Reject empty names
        layer.name = trimmed;
        this._save();
        console.log(`[LayerManager] Renamed layer ${id} → "${trimmed}"`);
    }

    /**
     * Delete a layer.
     *
     * Guard: cannot delete the last remaining layer. Orphaned objects
     * (those whose layerId was the deleted layer) are re-assigned to
     * 'default' BEFORE splicing the array so _applyAllLayerStates()
     * can find the default layer.
     *
     * Args:
     *   id: Layer ID string.
     */
    deleteLayer(id) {
        if (this._layers.length <= 1) {
            console.warn('[LayerManager] Cannot delete last layer');
            return;
        }

        // Re-assign orphaned objects to 'default' BEFORE removing the layer
        // so _applyAllLayerStates() can resolve the default layer state
        if (this._fabricCanvas) {
            for (const obj of this._fabricCanvas.getObjects()) {
                if (obj.layerId === id) {
                    obj.layerId = 'default';
                }
            }
        }
        // Also re-assign orphans in serialized pages
        if (this._canvas) {
            for (const [, fabricJson] of this._canvas.pageMarkups) {
                if (!fabricJson || !fabricJson.objects) continue;
                for (const obj of fabricJson.objects) {
                    if (obj.layerId === id) obj.layerId = 'default';
                }
            }
        }

        this._layers = this._layers.filter(l => l.id !== id);

        // If the active layer was deleted, fall back to first remaining layer
        if (this._activeLayerId === id) {
            this._activeLayerId = this._layers[0].id;
        }

        this._applyAllLayerStates();
        this._save();
        this.refresh();
        console.log(`[LayerManager] Deleted layer ${id}`);
    }

    // =========================================================================
    // CANVAS STATE APPLICATION
    // =========================================================================

    /**
     * Apply a single layer's visibility and lock state to one Fabric object.
     *
     * Visibility and lock are orthogonal:
     *   - Hidden: obj.visible = false (invisible, unselectable, unevented)
     *   - Locked: obj.selectable = false, obj.evented = false (but still visible)
     *   - Hidden + Locked: all three flags false (intersection of both rules)
     *
     * Args:
     *   obj: Fabric.js object with a layerId property.
     */
    _applyLayerState(obj) {
        if (!obj.layerId) return;
        const layer = this._layers.find(l => l.id === obj.layerId);
        if (!layer) return; // Orphaned object — leave as-is

        const hidden = !layer.visible;
        const locked = layer.locked;

        obj.visible = !hidden;
        obj.selectable = !hidden && !locked;
        obj.evented = !hidden && !locked;
    }

    /**
     * Apply all layer states to every object on the current Fabric canvas.
     *
     * Called after any layer state change (toggle visible/locked, delete).
     * O(n) in canvas objects — fast enough for typical document markups.
     */
    _applyAllLayerStates() {
        if (!this._fabricCanvas) return;
        for (const obj of this._fabricCanvas.getObjects()) {
            this._applyLayerState(obj);
        }
        this._fabricCanvas.renderAll();
    }

    // =========================================================================
    // LAYER ASSIGNMENT API
    // =========================================================================

    /**
     * Re-assign one or more Fabric objects to a different layer.
     *
     * Updates layerId on each object, applies the new layer's visibility and
     * lock state, re-renders the canvas, and triggers auto-save. Used by the
     * right-click context menu and future programmatic assignment.
     *
     * Args:
     *   objects: Array of Fabric.js objects to re-assign.
     *   layerId: ID of the destination layer.
     */
    assignLayer(objects, layerId) {
        const layer = this._layers.find(l => l.id === layerId);
        if (!layer) return;
        if (!Array.isArray(objects) || objects.length === 0) return;

        for (const obj of objects) {
            obj.layerId = layerId;
            this._applyLayerState(obj);
        }

        if (this._fabricCanvas) {
            this._fabricCanvas.renderAll();
        }

        // Trigger auto-save — markup content has changed (layerId is serialized)
        if (this._canvas && typeof this._canvas.onContentChange === 'function') {
            this._canvas.onContentChange();
        }

        console.log(
            `[LayerManager] Assigned ${objects.length} object(s) to layer "${layer.name}" (${layerId})`
        );
    }

    // =========================================================================
    // CONTEXT MENU
    // =========================================================================

    /**
     * Wire the right-click context menu for layer assignment to the Fabric canvas.
     *
     * Called from initForCanvas() each time a new document is loaded. Removes
     * any previous contextmenu binding before adding the new one so document
     * reloads don't accumulate duplicate handlers.
     *
     * When the user right-clicks on a markup/measurement object:
     *   - If the object is part of the active selection → assign the whole selection.
     *   - Otherwise → assign just the right-clicked object.
     *
     * Right-clicking on empty canvas area shows nothing.
     *
     * Args:
     *   wrapper: The Fabric .canvas-container wrapperEl div.
     *   fc:      The fabric.Canvas instance.
     */
    bindContextMenu(wrapper, fc) {
        // Remove previous binding if present (document reload case)
        if (this._contextMenuHandler && this._contextMenuWrapper) {
            this._contextMenuWrapper.removeEventListener(
                'contextmenu', this._contextMenuHandler
            );
        }

        this._contextMenuWrapper = wrapper;
        this._contextMenuHandler = (e) => {
            e.preventDefault();

            // Convert browser event coordinates to Fabric internal canvas coords.
            // getPointer() divides by zoom so returned coords match object left/top.
            const pointer = fc.getPointer(e);

            // Find the topmost real markup/measurement object at the cursor.
            // Reverse so the last-added (visually topmost) object is checked first.
            const objects = fc.getObjects()
                .filter(obj => obj.markupType || obj.measurementType)
                .reverse();

            const clicked = objects.find(obj => obj.containsPoint(pointer));
            if (!clicked) return;  // Empty canvas area — no menu

            // Prefer operating on the whole selection if the clicked object is
            // part of it, otherwise operate on just the clicked object.
            const activeObjects = fc.getActiveObjects();
            const targets = activeObjects.includes(clicked) ? activeObjects : [clicked];

            this._showContextMenu(e, targets);
        };

        wrapper.addEventListener('contextmenu', this._contextMenuHandler);
    }

    /**
     * Show the layer assignment context menu near the cursor.
     *
     * Creates the menu element dynamically and appends to <body> (to avoid
     * overflow:hidden clipping from parent panels). Positions it so it stays
     * within the viewport. Dismisses on item click, Escape, or click outside.
     *
     * SECURITY: All user-supplied text (layer names) set via textContent — no XSS.
     *
     * Args:
     *   e:       Original contextmenu MouseEvent (for cursor position).
     *   targets: Array of Fabric.js objects to re-assign.
     */
    _showContextMenu(e, targets) {
        this._hideContextMenu();

        const menu = document.createElement('div');
        menu.id = 'layer-context-menu';
        menu.setAttribute('role', 'menu');

        // Header ── "Assign N object(s) to layer"
        const header = document.createElement('div');
        header.className = 'ctx-menu-header';
        const countLabel = targets.length > 1 ? `${targets.length} objects` : '1 object';
        header.textContent = `Assign ${countLabel} to layer`;
        menu.appendChild(header);

        // Horizontal separator
        const sep = document.createElement('div');
        sep.className = 'ctx-menu-sep';
        menu.appendChild(sep);

        // Current layer of the first target — used to mark the active assignment
        const currentLayerId = targets[0]?.layerId;

        // One button per layer
        for (const layer of this._layers) {
            const item = document.createElement('button');
            item.className = 'ctx-menu-item';
            item.setAttribute('role', 'menuitem');
            item.dataset.layerId = layer.id;
            if (layer.id === currentLayerId) item.classList.add('current');

            // Filled dot = current, hollow dot = other
            const dot = document.createElement('span');
            dot.className = 'ctx-menu-dot';
            dot.textContent = layer.id === currentLayerId ? '●' : '○';
            dot.setAttribute('aria-hidden', 'true');

            // Layer name — textContent: XSS safe
            const nameSpan = document.createElement('span');
            nameSpan.textContent = layer.name;

            item.appendChild(dot);
            item.appendChild(nameSpan);

            item.addEventListener('click', () => {
                this.assignLayer(targets, layer.id);
                this._hideContextMenu();
            });

            menu.appendChild(item);
        }

        document.body.appendChild(menu);
        this._contextMenu = menu;

        // Position: fixed coords at cursor, clamped so menu stays in viewport.
        // Approximate dimensions — CSS sets min-width=200; height varies by layer count.
        const approxH = 32 + this._layers.length * 30 + 10;
        const x = Math.min(e.clientX, window.innerWidth  - 210);
        const y = Math.min(e.clientY, window.innerHeight - approxH);

        menu.style.left = `${Math.max(4, x)}px`;
        menu.style.top  = `${Math.max(4, y)}px`;

        // Dismiss on click outside — use setTimeout so THIS click event
        // (which opened the menu) doesn't immediately close it again.
        this._ctxDismissClick = (ev) => {
            if (!menu.contains(ev.target)) this._hideContextMenu();
        };
        this._ctxDismissKey = (ev) => {
            if (ev.key === 'Escape') this._hideContextMenu();
        };

        setTimeout(() => {
            document.addEventListener('mousedown', this._ctxDismissClick, true);
            document.addEventListener('keydown',   this._ctxDismissKey,   true);
        }, 0);
    }

    /**
     * Hide and remove the context menu from the DOM.
     *
     * Also removes the global dismiss listeners. Safe to call when no
     * menu is visible — all guard checks are null-safe.
     */
    _hideContextMenu() {
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
        if (this._ctxDismissClick) {
            document.removeEventListener('mousedown', this._ctxDismissClick, true);
            this._ctxDismissClick = null;
        }
        if (this._ctxDismissKey) {
            document.removeEventListener('keydown', this._ctxDismissKey, true);
            this._ctxDismissKey = null;
        }
    }

    // =========================================================================
    // PANEL RENDERING
    // =========================================================================

    /**
     * Rebuild the #layers-list DOM from _layers[].
     *
     * Called after any state change that affects the list.
     * Uses textContent for all user-supplied strings to prevent XSS.
     */
    refresh() {
        const list = document.getElementById('layers-list');
        const countEl = document.getElementById('layers-count');
        const emptyEl = document.getElementById('layers-empty');
        if (!list) return;

        // Update count label
        if (countEl) {
            countEl.textContent = `${this._layers.length} layer${this._layers.length !== 1 ? 's' : ''}`;
        }

        // Show empty message if no layers (shouldn't happen but defensive)
        if (emptyEl) {
            emptyEl.style.display = this._layers.length === 0 ? '' : 'none';
        }

        // Rebuild rows — clear only the rows, not the empty-msg placeholder
        const oldRows = list.querySelectorAll('.layer-row');
        oldRows.forEach(r => r.remove());

        for (const layer of this._layers) {
            list.appendChild(this._buildRow(layer));
        }
    }

    /**
     * Build a single layer row DOM element.
     *
     * Row layout:
     *   [eye btn] [lock btn] [name span] ... [delete btn]
     *
     * All text set via textContent (XSS safe).
     * Delete button only appears on hover via CSS opacity.
     * Double-click on name → inline rename input.
     *
     * Args:
     *   layer: Layer object { id, name, visible, locked }
     *
     * Returns:
     *   HTMLElement — the built row div.
     */
    _buildRow(layer) {
        const row = document.createElement('div');
        row.className = 'layer-row';
        row.dataset.layerId = layer.id;
        if (layer.id === this._activeLayerId) row.classList.add('active');
        if (!layer.visible) row.classList.add('layer-hidden');
        if (layer.locked) row.classList.add('layer-locked');

        // Visibility toggle button
        const visBtn = document.createElement('button');
        visBtn.className = 'layer-vis-btn';
        visBtn.title = 'Toggle visibility';
        visBtn.textContent = '👁';
        visBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Don't trigger row setActive
            this.toggleVisible(layer.id);
        });

        // Lock toggle button
        const lockBtn = document.createElement('button');
        lockBtn.className = 'layer-lock-btn';
        lockBtn.title = 'Toggle lock';
        lockBtn.textContent = layer.locked ? '🔒' : '🔓';
        lockBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleLocked(layer.id);
        });

        // Layer name span — double-click to rename
        const nameSpan = document.createElement('span');
        nameSpan.className = 'layer-name';
        nameSpan.title = 'Double-click to rename';
        nameSpan.textContent = layer.name; // textContent: XSS safe
        nameSpan.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this._startRename(layer.id, nameSpan);
        });

        // Delete button — only shown on hover via CSS
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'layer-delete-btn';
        deleteBtn.title = 'Delete layer';
        deleteBtn.textContent = '×';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteLayer(layer.id);
        });

        // Click row → set active (make this the drawing target layer)
        row.addEventListener('click', () => this.setActive(layer.id));

        row.appendChild(visBtn);
        row.appendChild(lockBtn);
        row.appendChild(nameSpan);
        row.appendChild(deleteBtn);

        return row;
    }

    /**
     * Start an inline rename edit on a layer name span.
     *
     * Replaces the <span> with an <input>. Commits on blur or Enter.
     * Cancels (restores original name) on Escape.
     *
     * Args:
     *   id:       Layer ID.
     *   nameSpan: The <span class="layer-name"> element to replace.
     */
    _startRename(id, nameSpan) {
        const layer = this._layers.find(l => l.id === id);
        if (!layer) return;

        const input = document.createElement('input');
        input.className = 'layer-name-input';
        input.type = 'text';
        input.value = layer.name;

        const commit = () => {
            const newName = input.value.trim();
            if (newName) {
                this.renameLayer(id, newName);
                nameSpan.textContent = newName; // Update span without full refresh
            }
            // Restore span (remove input)
            if (input.parentNode) {
                input.parentNode.replaceChild(nameSpan, input);
            }
        };

        const cancel = () => {
            if (input.parentNode) {
                input.parentNode.replaceChild(nameSpan, input);
            }
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });

        // Replace span with input, then focus
        nameSpan.parentNode.replaceChild(input, nameSpan);
        input.focus();
        input.select();
    }
}
