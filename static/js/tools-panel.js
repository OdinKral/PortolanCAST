/**
 * PortolanCAST — Tool Chest Panel
 *
 * Purpose:
 *   Three manager classes backing the left-panel "Tools" tab:
 *
 *   StampManager      — predefined + custom text stamps placed with a single
 *                       click (APPROVED, REJECTED, FOR CONSTRUCTION, …)
 *
 *   ToolPresetsPanel  — saved tool configurations (tool type + markup type +
 *                       stroke color/width) accessible via right-click on any
 *                       toolbar button or as clickable cards in the panel.
 *
 *   SequenceManager   — named counters that place auto-incrementing circle+
 *                       number badges on the drawing. Each click advances the
 *                       counter. State persists across page reloads.
 *
 * All state is persisted in localStorage — no server round-trips needed.
 *
 * Security:
 *   - localStorage values are parsed with try/catch and validated before use.
 *   - User-supplied text (stamp label, preset name, sequence name) is inserted
 *     via textContent / textNode — never innerHTML — to prevent XSS.
 *   - Stamp IText objects use editable:false so placed stamps cannot be edited
 *     to inject unexpected canvas content.
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-03-01
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Built-in stamp definitions.
 * color: the fill color of the placed IText stamp.
 * These are read-only — users cannot delete or modify them.
 */
const BUILTIN_STAMPS = [
    { id: 'approved',         label: 'APPROVED',         color: '#44cc66' },
    { id: 'rejected',         label: 'REJECTED',         color: '#ff4444' },
    { id: 'reviewed',         label: 'REVIEWED',         color: '#4a9eff' },
    { id: 'for-construction', label: 'FOR CONSTRUCTION', color: '#ffaa00' },
    { id: 'draft',            label: 'DRAFT',            color: '#8888a0' },
    { id: 'hold',             label: 'HOLD',             color: '#ff6600' },
    { id: 'void',             label: 'VOID',             color: '#cc0000' },
];

/** Diagonal angle (degrees) applied to all stamps — matches Bluebeam convention. */
const STAMP_ANGLE = 30;

/** Circle radius (canvas px) for sequence badge backgrounds. */
const SEQ_BADGE_RADIUS = 14;

// =============================================================================
// StampManager
// =============================================================================

/**
 * Manages the Stamps section of the Tools panel.
 *
 * Workflow:
 *   1. _render() populates #stamps-list with buttons for each built-in and
 *      custom stamp.
 *   2. Clicking a stamp button calls _activatePlacement(stamp), which sets up
 *      a one-shot mouse:down listener on the Fabric canvas.
 *   3. When the user clicks on empty canvas area, an IText object is placed
 *      at that point and the placement mode exits automatically.
 *
 * Custom stamps are stored in localStorage key 'portolancast-stamps'.
 */
export class StampManager {
    constructor() {
        /** @type {import('./toolbar.js').Toolbar|null} */
        this._toolbar = null;
        /** @type {import('./canvas.js').CanvasOverlay|null} */
        this._canvas = null;
        /** @type {Array<{id:string,label:string,color:string}>} */
        this._customStamps = [];
    }

    /**
     * Initialize the stamp manager.
     *
     * Args:
     *   toolbar: Toolbar instance (for setTool cleanup and activeTool tracking).
     *   canvas:  CanvasOverlay instance (for Fabric canvas + stampDefaults).
     */
    init(toolbar, canvas) {
        this._toolbar = toolbar;
        this._canvas  = canvas;

        // Load custom stamps — invalid data silently becomes empty array
        try {
            const raw = localStorage.getItem('portolancast-stamps');
            const parsed = raw ? JSON.parse(raw) : [];
            this._customStamps = Array.isArray(parsed) ? parsed : [];
        } catch {
            this._customStamps = [];
        }

        this._render();
        this._bindModal();
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    /**
     * Rebuild the #stamps-list DOM from the current built-in + custom stamps.
     * Called on init and after any custom stamp is added or removed.
     */
    _render() {
        const list = document.getElementById('stamps-list');
        if (!list) return;
        // Clear previous content
        while (list.firstChild) list.removeChild(list.firstChild);

        const allStamps = [...BUILTIN_STAMPS, ...this._customStamps];
        allStamps.forEach(stamp => {
            const row = document.createElement('div');
            row.className = 'stamp-row';

            const btn = document.createElement('button');
            btn.className = 'stamp-btn';
            btn.title = `Click to activate stamp, then click on drawing to place`;

            // Use textContent (not innerHTML) — stamp labels are user-supplied
            const preview = document.createElement('span');
            preview.className = 'stamp-preview';
            preview.style.color = stamp.color;
            preview.textContent = stamp.label;
            btn.appendChild(preview);
            btn.addEventListener('click', () => this._activatePlacement(stamp));

            row.appendChild(btn);

            // Custom stamps get a delete button; built-ins are permanent
            const isBuiltin = BUILTIN_STAMPS.some(s => s.id === stamp.id);
            if (!isBuiltin) {
                const del = document.createElement('button');
                del.className = 'stamp-delete-btn';
                del.title = 'Remove this custom stamp';
                del.textContent = '×';
                del.addEventListener('click', () => this._deleteCustom(stamp.id));
                row.appendChild(del);
            }

            list.appendChild(row);
        });
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _save() {
        localStorage.setItem('portolancast-stamps', JSON.stringify(this._customStamps));
    }

    _deleteCustom(id) {
        this._customStamps = this._customStamps.filter(s => s.id !== id);
        this._save();
        this._render();
    }

    // ── Modal (custom stamp creation) ─────────────────────────────────────────

    _bindModal() {
        const btnNew   = document.getElementById('btn-new-stamp');
        const overlay  = document.getElementById('modal-stamp-overlay');
        const cancelBtn = document.getElementById('stamp-cancel');
        const createBtn = document.getElementById('stamp-create');
        const modal    = document.getElementById('modal-new-stamp');

        if (btnNew)    btnNew.addEventListener('click',    () => this._showModal());
        if (overlay)   overlay.addEventListener('click',   () => this._hideModal());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this._hideModal());
        if (createBtn) createBtn.addEventListener('click', () => this._createStamp());

        if (modal) {
            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this._hideModal();
                if (e.key === 'Enter')  this._createStamp();
            });
        }
    }

    _showModal() {
        const modal = document.getElementById('modal-new-stamp');
        if (!modal) return;
        modal.style.display = 'flex';
        const input = document.getElementById('stamp-label');
        if (input) { input.value = ''; setTimeout(() => input.focus(), 0); }
    }

    _hideModal() {
        const modal = document.getElementById('modal-new-stamp');
        if (modal) modal.style.display = 'none';
    }

    _createStamp() {
        const labelEl = document.getElementById('stamp-label');
        const colorEl = document.getElementById('stamp-color');
        const label   = (labelEl?.value || '').trim().toUpperCase();
        if (!label) { labelEl?.focus(); return; }

        this._customStamps.push({
            id:    crypto.randomUUID(),
            label,
            color: colorEl?.value || '#cc44cc',
        });
        this._save();
        this._render();
        this._hideModal();
    }

    // ── Canvas placement ──────────────────────────────────────────────────────

    /**
     * Activate one-shot stamp placement mode.
     * The next click on empty canvas area places the stamp as an IText object.
     *
     * Args:
     *   stamp: Stamp definition object { id, label, color }.
     */
    _activatePlacement(stamp) {
        const fc = this._canvas?.fabricCanvas;
        if (!fc) return;

        // Clean up any active shape drawing first
        if (this._toolbar) {
            this._toolbar._cleanupShapeDrawing();
            this._toolbar.activeTool = 'stamp';
        }

        const onMouseDown = (opt) => {
            // Don't place on top of an existing object
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);

            // Stamp = bold angled IText.  editable:false keeps it immutable.
            const textObj = new fabric.IText(stamp.label, {
                left:       pointer.x,
                top:        pointer.y,
                fontFamily: 'Arial Black, Arial, sans-serif',
                fontSize:   28,
                fontWeight: 'bold',
                fill:       stamp.color,
                stroke:     null,
                strokeWidth: 0,
                angle:      STAMP_ANGLE,
                opacity:    0.85,
                selectable: true,
                editable:   false,   // Stamps are immutable once placed
                originX:    'center',
                originY:    'center',
            });

            fc.add(textObj);
            // Attach semantic metadata (markupId, type, author, etc.)
            this._canvas.stampDefaults(textObj, {
                markupType: 'note',
                preserveColor: true,
            });
            fc.setActiveObject(textObj);
            fc.renderAll();

            // One-shot: remove listener and return to select
            fc.off('mouse:down', onMouseDown);
            if (this._toolbar) {
                this._toolbar.activeTool = 'select';
                document.querySelectorAll('.tool-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tool === 'select');
                });
            }
        };

        fc.on('mouse:down', onMouseDown);
        // Register in _shapeHandlers so Escape key cleans up via _cleanupShapeDrawing()
        if (this._toolbar) {
            this._toolbar._shapeHandlers = { 'mouse:down': onMouseDown };
        }
    }
}

// =============================================================================
// ToolPresetsPanel
// =============================================================================

/**
 * Manages the "My Tools" presets section of the Tools panel.
 *
 * Workflow:
 *   1. User right-clicks any .tool-btn → save-preset context menu appears.
 *   2. User names the preset and clicks Save — preset is stored in localStorage.
 *   3. Clicking a preset card calls _apply(preset) which activates the tool
 *      with the saved color/width via _pendingPresetOverride on the Toolbar.
 *
 * Presets are stored in localStorage key 'portolancast-presets'.
 */
export class ToolPresetsPanel {
    constructor() {
        /** @type {import('./toolbar.js').Toolbar|null} */
        this._toolbar = null;
        /** @type {Array<{id,name,toolType,markupType,strokeColor,strokeWidth}>} */
        this._presets = [];
        /** @type {HTMLElement|null} Active context menu DOM node */
        this._contextMenu = null;
        /** @type {Function|null} Bound dismiss handler for click-outside */
        this._boundDismiss = null;
    }

    /**
     * Initialize the presets panel.
     *
     * Args:
     *   toolbar: Toolbar instance — needed to call setTool() and apply overrides.
     */
    init(toolbar) {
        this._toolbar = toolbar;

        try {
            const raw = localStorage.getItem('portolancast-presets');
            const parsed = raw ? JSON.parse(raw) : [];
            this._presets = Array.isArray(parsed) ? parsed : [];
        } catch {
            this._presets = [];
        }

        this._render();
        this._bindToolBtnRightClick();
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _save() {
        localStorage.setItem('portolancast-presets', JSON.stringify(this._presets));
    }

    _delete(id) {
        this._presets = this._presets.filter(p => p.id !== id);
        this._save();
        this._render();
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    /**
     * Rebuild the #presets-list DOM.
     * Called on init and after any preset is saved or deleted.
     */
    _render() {
        const list = document.getElementById('presets-list');
        if (!list) return;
        while (list.firstChild) list.removeChild(list.firstChild);

        if (this._presets.length === 0) {
            const empty = document.createElement('p');
            empty.id = 'presets-empty';
            empty.className = 'muted-text';
            empty.textContent = 'Right-click any tool button to save a preset';
            list.appendChild(empty);
            return;
        }

        this._presets.forEach(preset => {
            const card = document.createElement('div');
            card.className = 'preset-card';
            card.title = `${preset.toolType} · ${preset.markupType}`;

            const swatch = document.createElement('span');
            swatch.className = 'preset-swatch';
            swatch.style.background = preset.strokeColor || '#cccccc';

            const name = document.createElement('span');
            name.className = 'preset-name';
            name.textContent = preset.name;  // textContent prevents XSS

            const del = document.createElement('button');
            del.className = 'preset-delete';
            del.title = 'Remove preset';
            del.textContent = '×';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                this._delete(preset.id);
            });

            card.appendChild(swatch);
            card.appendChild(name);
            card.appendChild(del);
            card.addEventListener('click', () => this._apply(preset));
            list.appendChild(card);
        });
    }

    // ── Apply preset ──────────────────────────────────────────────────────────

    /**
     * Activate a saved preset: set the markup type and store a color/width
     * override that _initShapeDrawing() will pick up on the next placement.
     *
     * Args:
     *   preset: Preset object from this._presets.
     */
    _apply(preset) {
        if (!this._toolbar) return;
        // Set markup type so intent indicator updates
        this._toolbar.activeMarkupType = preset.markupType;
        // Store override — consumed by _initShapeDrawing on next shape creation
        this._toolbar._pendingPresetOverride = {
            strokeColor: preset.strokeColor,
            strokeWidth: preset.strokeWidth,
        };
        this._toolbar.setTool(preset.toolType);
    }

    // ── Right-click context menu ───────────────────────────────────────────────

    /**
     * Bind contextmenu events on all .tool-btn elements so right-clicking
     * a tool button opens the "Save as preset" menu.
     * Called once on init — buttons are static (no dynamic injection of .tool-btn).
     */
    _bindToolBtnRightClick() {
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._showSaveMenu(e, btn.dataset.tool);
            });
        });
    }

    /**
     * Show the save-preset context menu near the right-click position.
     *
     * Args:
     *   e:        MouseEvent from contextmenu listener.
     *   toolName: The data-tool value of the clicked button.
     */
    _showSaveMenu(e, toolName) {
        this._hideMenu();

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top  = `${e.clientY}px`;

        const header = document.createElement('div');
        header.className = 'context-menu-header';
        header.textContent = `Save "${toolName}" preset`;

        const input = document.createElement('input');
        input.type        = 'text';
        input.className   = 'context-menu-input';
        input.value       = toolName;
        input.maxLength   = 40;
        input.placeholder = 'Preset name';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'context-menu-item context-menu-action';
        saveBtn.textContent = 'Save Preset';

        const doSave = () => {
            const name = input.value.trim() || toolName;
            const activeType = this._toolbar?.activeMarkupType || 'note';

            // Use _lastStrokeColor set by _initShapeDrawing, or fall back to
            // a sensible default derived from the current markup type.
            const strokeColor = this._toolbar?._lastStrokeColor
                || this._toolbar?._MARKUP_COLORS_REF?.[activeType]
                || '#4a9eff';

            this._presets.push({
                id:          crypto.randomUUID(),
                name,
                toolType:    toolName,
                markupType:  activeType,
                strokeColor,
                strokeWidth: this._toolbar?._lastStrokeWidth ?? 2,
            });
            this._save();
            this._render();
            this._hideMenu();
        };

        saveBtn.addEventListener('click', doSave);
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter')  doSave();
            if (ev.key === 'Escape') this._hideMenu();
        });

        menu.appendChild(header);
        menu.appendChild(input);
        menu.appendChild(saveBtn);
        document.body.appendChild(menu);
        this._contextMenu = menu;

        // Auto-focus and select text for immediate rename
        setTimeout(() => {
            input.focus();
            input.select();
            // Dismiss when clicking anywhere outside the menu
            document.addEventListener('click', this._boundDismiss = () => this._hideMenu(), { once: true });
        }, 0);
    }

    _hideMenu() {
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
        if (this._boundDismiss) {
            document.removeEventListener('click', this._boundDismiss);
            this._boundDismiss = null;
        }
    }
}

// =============================================================================
// SequenceManager
// =============================================================================

/**
 * Manages the Sequences section of the Tools panel.
 *
 * A sequence is a named counter (name, start number, format string, badge color).
 * Clicking "Place" activates continuous placement mode: each click on the canvas
 * places a circle+number Group and increments the counter.  Press Escape or switch
 * tool to stop.
 *
 * Sequences are stored in localStorage key 'portolancast-sequences'.
 */
export class SequenceManager {
    constructor() {
        /** @type {import('./toolbar.js').Toolbar|null} */
        this._toolbar = null;
        /** @type {import('./canvas.js').CanvasOverlay|null} */
        this._canvas = null;
        /** @type {Array<{id,name,next,start,format,color}>} */
        this._sequences = [];
        /**
         * Currently active placement — stored so Escape cleanup can remove the handler.
         * @type {{seq: object, handler: Function}|null}
         */
        this._activePlacement = null;
    }

    /**
     * Initialize the sequence manager.
     *
     * Args:
     *   toolbar: Toolbar instance.
     *   canvas:  CanvasOverlay instance.
     */
    init(toolbar, canvas) {
        this._toolbar = toolbar;
        this._canvas  = canvas;

        try {
            const raw = localStorage.getItem('portolancast-sequences');
            const parsed = raw ? JSON.parse(raw) : [];
            this._sequences = Array.isArray(parsed) ? parsed : [];
        } catch {
            this._sequences = [];
        }

        this._render();
        this._bindModal();
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _save() {
        localStorage.setItem('portolancast-sequences', JSON.stringify(this._sequences));
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    /**
     * Rebuild the #sequences-list DOM.
     * Each row: colored badge showing next number | sequence name | action buttons.
     */
    _render() {
        const list = document.getElementById('sequences-list');
        if (!list) return;
        while (list.firstChild) list.removeChild(list.firstChild);

        if (this._sequences.length === 0) {
            const empty = document.createElement('p');
            empty.id = 'sequences-empty';
            empty.className = 'muted-text';
            empty.textContent = 'No sequences yet — click + to create one';
            list.appendChild(empty);
            return;
        }

        this._sequences.forEach(seq => {
            const row = document.createElement('div');
            row.className = 'seq-row';

            // Mini badge showing the next number to be placed
            const badge = document.createElement('span');
            badge.className = 'seq-badge';
            badge.style.background = seq.color;
            badge.textContent = this._format(seq, seq.next);

            const nameEl = document.createElement('span');
            nameEl.className = 'seq-name';
            nameEl.textContent = seq.name;

            const actions = document.createElement('div');
            actions.className = 'seq-actions';

            // Place: activates continuous placement on the canvas
            const placeBtn = document.createElement('button');
            placeBtn.className = 'seq-place-btn toolbar-btn';
            placeBtn.title = 'Click on drawing to place next number';
            placeBtn.textContent = 'Place';
            placeBtn.addEventListener('click', () => this._activatePlacement(seq));

            // Reset: return counter to start value
            const resetBtn = document.createElement('button');
            resetBtn.className = 'seq-reset-btn toolbar-btn';
            resetBtn.title = `Reset counter to ${seq.start}`;
            resetBtn.textContent = '↺';
            resetBtn.addEventListener('click', () => {
                seq.next = seq.start;
                this._save();
                this._render();
            });

            // Delete: remove the sequence definition
            const delBtn = document.createElement('button');
            delBtn.className = 'seq-delete-btn toolbar-btn';
            delBtn.title = 'Delete this sequence';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', () => {
                this._stopPlacement();
                this._sequences = this._sequences.filter(s => s.id !== seq.id);
                this._save();
                this._render();
            });

            actions.appendChild(placeBtn);
            actions.appendChild(resetBtn);
            actions.appendChild(delBtn);

            row.appendChild(badge);
            row.appendChild(nameEl);
            row.appendChild(actions);
            list.appendChild(row);
        });
    }

    /**
     * Format a number according to the sequence's format string.
     * {n} in the format string is replaced with the number.
     *
     * Args:
     *   seq: Sequence definition.
     *   n:   The number to format.
     *
     * Returns:
     *   Formatted string (e.g. "FS-3" for format "FS-{n}", n=3).
     */
    _format(seq, n) {
        return (seq.format || '{n}').replace('{n}', String(n));
    }

    // ── Modal ─────────────────────────────────────────────────────────────────

    _bindModal() {
        const btnNew    = document.getElementById('btn-new-sequence');
        const overlay   = document.getElementById('modal-seq-overlay');
        const cancelBtn = document.getElementById('seq-cancel');
        const createBtn = document.getElementById('seq-create');
        const modal     = document.getElementById('modal-new-sequence');

        if (btnNew)    btnNew.addEventListener('click',    () => this._showModal());
        if (overlay)   overlay.addEventListener('click',   () => this._hideModal());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this._hideModal());
        if (createBtn) createBtn.addEventListener('click', () => this._createSequence());

        if (modal) {
            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this._hideModal();
                if (e.key === 'Enter')  this._createSequence();
            });
        }
    }

    _showModal() {
        const modal = document.getElementById('modal-new-sequence');
        if (!modal) return;
        modal.style.display = 'flex';
        // Reset fields for a fresh sequence
        const nameEl  = document.getElementById('seq-name');
        const fmtEl   = document.getElementById('seq-format');
        const startEl = document.getElementById('seq-start');
        if (nameEl)  { nameEl.value  = ''; }
        if (fmtEl)   { fmtEl.value   = '{n}'; }
        if (startEl) { startEl.value = '1'; }
        // Auto-focus name input
        setTimeout(() => nameEl?.focus(), 0);
    }

    _hideModal() {
        const modal = document.getElementById('modal-new-sequence');
        if (modal) modal.style.display = 'none';
    }

    _createSequence() {
        const nameEl  = document.getElementById('seq-name');
        const startEl = document.getElementById('seq-start');
        const fmtEl   = document.getElementById('seq-format');
        const colorEl = document.getElementById('seq-color');

        const name   = (nameEl?.value || '').trim();
        if (!name) { nameEl?.focus(); return; }

        const start  = Math.max(1, parseInt(startEl?.value  || '1',  10));
        const format = (fmtEl?.value  || '{n}').trim() || '{n}';
        const color  = colorEl?.value || '#4a9eff';

        this._sequences.push({
            id:     crypto.randomUUID(),
            name,
            next:   start,
            start,
            format,
            color,
        });
        this._save();
        this._render();
        this._hideModal();
    }

    // ── Placement ─────────────────────────────────────────────────────────────

    /**
     * Stop active sequence placement and return to select mode.
     * Safe to call even when no placement is active.
     */
    _stopPlacement() {
        if (this._activePlacement) {
            this._canvas?.fabricCanvas?.off('mouse:down', this._activePlacement.handler);
            this._activePlacement = null;
        }
        if (this._toolbar) {
            this._toolbar.activeTool = 'select';
            document.querySelectorAll('.tool-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tool === 'select');
            });
        }
    }

    /**
     * Activate continuous placement mode for a sequence.
     * Each click on empty canvas places a circle+number badge and increments
     * the counter.  Pressing Escape exits via _cleanupShapeDrawing() on Toolbar.
     *
     * The badge is a fabric.Group containing:
     *   - A filled circle (radius=SEQ_BADGE_RADIUS) centered at (0,0)
     *   - A centered IText with the formatted number
     * The Group is positioned with originX/Y='center' so clicking places the
     * badge's center at the cursor position (not top-left corner).
     *
     * Args:
     *   seq: Sequence definition from this._sequences.
     */
    _activatePlacement(seq) {
        const fc = this._canvas?.fabricCanvas;
        if (!fc) return;

        // Cancel any previously active placement
        this._stopPlacement();

        if (this._toolbar) {
            this._toolbar._cleanupShapeDrawing();
            this._toolbar.activeTool = 'sequence';
        }

        const onMouseDown = (opt) => {
            // Don't place on top of existing objects
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);
            const label   = this._format(seq, seq.next);

            // Circle background — centered at Group origin
            const circle = new fabric.Circle({
                radius:      SEQ_BADGE_RADIUS,
                fill:        seq.color,
                stroke:      null,
                strokeWidth: 0,
                originX:     'center',
                originY:     'center',
            });

            // Number label — centered inside the circle
            // fontSize scaled to fit: SEQ_BADGE_RADIUS * 1.1 is a reliable ratio
            const text = new fabric.IText(label, {
                fontFamily:  'Arial, sans-serif',
                fontSize:    Math.round(SEQ_BADGE_RADIUS * 1.1),
                fontWeight:  'bold',
                fill:        '#ffffff',
                stroke:      null,
                strokeWidth: 0,
                textAlign:   'center',
                originX:     'center',
                originY:     'center',
            });

            // Group centered at the click point
            const group = new fabric.Group([circle, text], {
                left:      pointer.x,
                top:       pointer.y,
                originX:   'center',
                originY:   'center',
                selectable: true,
            });

            fc.add(group);
            // Attach semantic metadata — preserveColor keeps the circle's fill
            this._canvas.stampDefaults(group, {
                markupType:    'note',
                preserveColor: true,
            });
            // Tag with sequence metadata for search and review brief
            group.sequenceId   = seq.id;
            group.sequenceName = seq.name;

            fc.setActiveObject(group);
            fc.renderAll();

            // Advance counter and persist
            seq.next += 1;
            this._save();
            // Refresh panel to show the new next-number badge
            this._render();
        };

        fc.on('mouse:down', onMouseDown);
        this._activePlacement = { seq, handler: onMouseDown };

        // Register in _shapeHandlers so Escape key path in Toolbar cleans up
        if (this._toolbar) {
            this._toolbar._shapeHandlers = { 'mouse:down': onMouseDown };
        }
    }
}
