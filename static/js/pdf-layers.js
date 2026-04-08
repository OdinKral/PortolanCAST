/**
 * PortolanCAST — PDF OCG Layer Panel
 *
 * Purpose:
 *   Displays the Optional Content Groups (OCG layers) embedded in the PDF
 *   and lets the user toggle their visibility. OCGs are the PDF equivalent
 *   of CAD layers — engineering drawings from AutoCAD/Bluebeam carry named
 *   layers for each discipline (walls, piping, text, annotations, etc.).
 *
 * Architecture:
 *   - Reads available layers via GET /api/documents/{id}/pdf-layers
 *   - Tracks hidden layer names in a local Set
 *   - On toggle: calls viewer.setHiddenLayers([...hidden]) to re-render
 *   - Panel is shown only when the document has OCG layers
 *
 * Security:
 *   - Layer names set via textContent (never innerHTML) — XSS safe
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-03-24
 */

// =============================================================================
// PDF LAYER PANEL
// =============================================================================

/**
 * Manages the PDF OCG layer visibility panel inside the Layers tab.
 *
 * The panel renders a "PDF Layers" section above the annotation layers.
 * Each OCG layer gets an eye-button toggle. Toggling re-renders the current
 * page via the viewer's setHiddenLayers() method.
 *
 * Usage:
 *   const pdfLayers = new PDFLayerPanel();
 *   await pdfLayers.load(docId, viewer);   // fetch layers, populate panel
 *   pdfLayers.clear();                     // called on new document load
 */
export class PDFLayerPanel {
    constructor() {
        /** @type {Array<{name: string, on: boolean}>} Available OCG layers */
        this._layers = [];

        /** @type {Set<string>} Layer names currently hidden */
        this._hidden = new Set();

        /** @type {import('./pdf-viewer.js').PDFViewer|null} */
        this._viewer = null;

        /** @type {number|null} Current document ID */
        this._docId = null;

        /** @type {boolean} Whether the layer list is expanded (default collapsed) */
        this._expanded = false;
    }

    // =========================================================================
    // LOAD / CLEAR
    // =========================================================================

    /**
     * Fetch OCG layers for a document and populate the panel.
     *
     * Called when a document finishes loading. If the PDF has no OCG layers
     * the section stays hidden.
     *
     * Args:
     *   docId:  Database document ID.
     *   viewer: PDFViewer instance (for setHiddenLayers calls).
     */
    async load(docId, viewer) {
        this._docId = docId;
        this._viewer = viewer;
        this._hidden = new Set();  // Reset state for new document

        try {
            const resp = await fetch(`/api/documents/${docId}/pdf-layers`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._layers = Array.isArray(data.layers) ? data.layers : [];
        } catch (err) {
            console.error('[PDFLayerPanel] Failed to load PDF layers:', err);
            this._layers = [];
        }

        this.refresh();
        console.log(`[PDFLayerPanel] Loaded ${this._layers.length} OCG layers for doc ${docId}`);
    }

    /**
     * Clear panel state (called when no document is open).
     */
    clear() {
        this._layers = [];
        this._hidden = new Set();
        this._docId = null;
        this.refresh();
    }

    // =========================================================================
    // TOGGLE
    // =========================================================================

    /**
     * Toggle a layer's visibility and re-render the current page.
     *
     * Args:
     *   layerName: The OCG layer name string.
     */
    toggle(layerName) {
        if (this._hidden.has(layerName)) {
            this._hidden.delete(layerName);
        } else {
            this._hidden.add(layerName);
        }

        // Push updated hidden set to the viewer — triggers page re-render
        if (this._viewer) {
            this._viewer.setHiddenLayers([...this._hidden]);
        }

        // Update the eye button appearance
        this._updateRowVisual(layerName);
    }

    /**
     * Make all OCG layers visible.
     */
    showAll() {
        this._hidden.clear();
        if (this._viewer) {
            this._viewer.resetHiddenLayers();
        }
        this.refresh();
    }

    /**
     * Toggle the expanded/collapsed state of the layer row list.
     *
     * Collapsing only hides the UI rows — it does NOT change which layers
     * are visible on the canvas. The header count badge keeps the user
     * informed of hidden-layer state even when collapsed.
     */
    toggleExpanded() {
        this._expanded = !this._expanded;
        const body = document.getElementById('pdf-layers-body');
        const chevron = document.getElementById('pdf-layers-chevron');
        if (body) body.style.display = this._expanded ? '' : 'none';
        if (chevron) chevron.textContent = this._expanded ? '▼' : '▶';
    }

    // =========================================================================
    // PANEL RENDERING
    // =========================================================================

    /**
     * Rebuild the PDF layers section DOM.
     *
     * The section is injected into #layers-list before the annotation layers.
     * It is shown only when the document has OCG layers.
     */
    refresh() {
        const list = document.getElementById('layers-list');
        if (!list) return;

        // Remove existing PDF layers section
        const existing = document.getElementById('pdf-layers-section');
        if (existing) existing.remove();

        // No OCG layers — nothing to show
        if (this._layers.length === 0) return;

        const section = document.createElement('div');
        section.id = 'pdf-layers-section';
        section.className = 'pdf-layers-section';

        // --- Section header (always visible) ---
        const header = document.createElement('div');
        header.className = 'pdf-layers-header';

        // Chevron — clickable disclosure triangle to expand/collapse rows
        const chevron = document.createElement('span');
        chevron.id = 'pdf-layers-chevron';
        chevron.className = 'pdf-layers-chevron';
        chevron.textContent = this._expanded ? '▼' : '▶';

        const title = document.createElement('span');
        title.className = 'pdf-layers-title';
        title.textContent = 'PDF Layers';

        // Hidden count badge — shows "3/8 hidden" so user knows state at a glance
        const hiddenCount = this._hidden.size;
        const totalCount = this._layers.length;
        const countBadge = document.createElement('span');
        countBadge.className = 'pdf-layers-count';
        if (hiddenCount > 0) {
            countBadge.textContent = `${hiddenCount}/${totalCount} hidden`;
            countBadge.classList.add('has-hidden');
        } else {
            countBadge.textContent = `${totalCount}`;
        }

        const showAllBtn = document.createElement('button');
        showAllBtn.className = 'pdf-layers-showall-btn';
        showAllBtn.title = 'Show all PDF layers';
        showAllBtn.textContent = 'Show all';
        showAllBtn.addEventListener('click', () => this.showAll());

        header.appendChild(chevron);
        header.appendChild(title);
        header.appendChild(countBadge);
        header.appendChild(showAllBtn);

        // Clicking header (chevron, title, or count) toggles expand/collapse
        const clickArea = document.createElement('div');
        clickArea.className = 'pdf-layers-header-click';
        clickArea.appendChild(chevron);
        clickArea.appendChild(title);
        clickArea.appendChild(countBadge);
        clickArea.addEventListener('click', () => this.toggleExpanded());

        header.textContent = '';  // clear previous appends
        header.appendChild(clickArea);
        header.appendChild(showAllBtn);
        section.appendChild(header);

        // --- Collapsible body (layer rows) ---
        const body = document.createElement('div');
        body.id = 'pdf-layers-body';
        body.style.display = this._expanded ? '' : 'none';

        for (const layer of this._layers) {
            body.appendChild(this._buildRow(layer.name));
        }

        section.appendChild(body);

        // Divider between PDF layers and annotation layers
        const divider = document.createElement('div');
        divider.className = 'pdf-layers-divider';

        const dividerLabel = document.createElement('span');
        dividerLabel.className = 'pdf-layers-divider-label';
        dividerLabel.textContent = 'Annotation Layers';
        divider.appendChild(dividerLabel);

        section.appendChild(divider);

        // Insert at top of #layers-list (before annotation layers)
        list.insertBefore(section, list.firstChild);
    }

    /**
     * Build a single PDF layer row.
     *
     * Args:
     *   layerName: OCG layer name string.
     *
     * Returns:
     *   HTMLElement — the built row div.
     */
    _buildRow(layerName) {
        const row = document.createElement('div');
        row.className = 'layer-row pdf-layer-row';
        row.dataset.pdfLayer = layerName;

        // Look up alias from the loaded layer data
        const layerData = this._layers.find(l => l.name === layerName);
        const alias = layerData?.alias || '';

        const isHidden = this._hidden.has(layerName);
        if (isHidden) row.classList.add('layer-hidden');

        // Visibility toggle button
        const visBtn = document.createElement('button');
        visBtn.className = 'layer-vis-btn';
        visBtn.title = 'Toggle visibility';
        visBtn.textContent = '👁';
        visBtn.style.opacity = isHidden ? '0.3' : '1';
        visBtn.addEventListener('click', () => this.toggle(layerName));

        // Layer name — shows alias if set, original name as tooltip
        const nameSpan = document.createElement('span');
        nameSpan.className = 'layer-name';
        if (alias) {
            nameSpan.textContent = alias;
            nameSpan.title = layerName;  // Original OCG name on hover
        } else {
            nameSpan.textContent = layerName;
            nameSpan.title = 'Right-click to rename';
        }

        // Right-click to rename
        nameSpan.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._startRename(row, layerName, alias);
        });

        // PDF badge to distinguish from annotation layers
        const badge = document.createElement('span');
        badge.className = 'pdf-layer-badge';
        badge.title = 'PDF layer (from the original drawing)';
        badge.textContent = 'PDF';

        row.appendChild(visBtn);
        row.appendChild(nameSpan);
        row.appendChild(badge);

        return row;
    }

    /**
     * Enter inline rename mode for a PDF layer.
     *
     * Replaces the name span with a text input. Enter or blur commits,
     * Escape cancels. Empty input clears the alias (reverts to OCG name).
     *
     * Args:
     *   row:       The row HTMLElement.
     *   layerName: Original OCG layer name (canonical key).
     *   currentAlias: Current alias string (may be empty).
     */
    _startRename(row, layerName, currentAlias) {
        const nameSpan = row.querySelector('.layer-name');
        if (!nameSpan || row.querySelector('.layer-rename-input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'layer-rename-input';
        input.value = currentAlias || layerName;
        input.placeholder = layerName;
        input.maxLength = 128;

        // Select all text for easy replacement
        const commit = () => {
            const newAlias = input.value.trim();
            // If they typed the original name back, treat as "clear alias"
            const aliasToSave = (newAlias === layerName) ? '' : newAlias;
            this._saveAlias(layerName, aliasToSave);
        };

        const cancel = () => {
            input.replaceWith(nameSpan);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });

        input.addEventListener('blur', () => commit());

        nameSpan.replaceWith(input);
        input.focus();
        input.select();
    }

    /**
     * Save a layer alias to the server and update the UI.
     *
     * Args:
     *   layerName: Original OCG layer name.
     *   alias:     New alias (empty string clears it).
     */
    async _saveAlias(layerName, alias) {
        if (!this._docId) return;

        try {
            const resp = await fetch(`/api/documents/${this._docId}/pdf-layers/rename`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ layer: layerName, alias }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            // Update local layer data
            const layerData = this._layers.find(l => l.name === layerName);
            if (layerData) layerData.alias = alias;

            // Re-render just this row's name span
            const row = document.querySelector(`[data-pdf-layer="${CSS.escape(layerName)}"]`);
            if (row) {
                const input = row.querySelector('.layer-rename-input');
                const nameSpan = document.createElement('span');
                nameSpan.className = 'layer-name';

                if (alias) {
                    nameSpan.textContent = alias;
                    nameSpan.title = layerName;
                } else {
                    nameSpan.textContent = layerName;
                    nameSpan.title = 'Right-click to rename';
                }

                nameSpan.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this._startRename(row, layerName, alias);
                });

                if (input) input.replaceWith(nameSpan);
            }
        } catch (err) {
            console.error('[PDFLayerPanel] Failed to save alias:', err);
            // On error, revert UI by refreshing
            this.refresh();
        }
    }

    /**
     * Update the visual state of a single row without full re-render.
     *
     * Called after toggle() for instant visual feedback.
     *
     * Args:
     *   layerName: OCG layer name string.
     */
    _updateRowVisual(layerName) {
        const row = document.querySelector(`[data-pdf-layer="${CSS.escape(layerName)}"]`);
        if (!row) return;

        const isHidden = this._hidden.has(layerName);
        row.classList.toggle('layer-hidden', isHidden);

        const visBtn = row.querySelector('.layer-vis-btn');
        if (visBtn) visBtn.style.opacity = isHidden ? '0.3' : '1';

        // Keep the count badge in sync after individual toggles
        this._updateCountBadge();
    }

    /**
     * Update the header count badge without a full DOM rebuild.
     *
     * Shows "N/total hidden" when layers are hidden, or just the total
     * count when all layers are visible. Provides at-a-glance state even
     * when the section is collapsed.
     */
    _updateCountBadge() {
        const badge = document.querySelector('.pdf-layers-count');
        if (!badge) return;

        const hiddenCount = this._hidden.size;
        const totalCount = this._layers.length;

        if (hiddenCount > 0) {
            badge.textContent = `${hiddenCount}/${totalCount} hidden`;
            badge.classList.add('has-hidden');
        } else {
            badge.textContent = `${totalCount}`;
            badge.classList.remove('has-hidden');
        }
    }
}
