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

        // Section header
        const header = document.createElement('div');
        header.className = 'pdf-layers-header';

        const title = document.createElement('span');
        title.className = 'pdf-layers-title';
        title.textContent = 'PDF Layers';

        const showAllBtn = document.createElement('button');
        showAllBtn.className = 'pdf-layers-showall-btn';
        showAllBtn.title = 'Show all PDF layers';
        showAllBtn.textContent = 'Show all';
        showAllBtn.addEventListener('click', () => this.showAll());

        header.appendChild(title);
        header.appendChild(showAllBtn);
        section.appendChild(header);

        // One row per OCG layer
        for (const layer of this._layers) {
            section.appendChild(this._buildRow(layer.name));
        }

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

        const isHidden = this._hidden.has(layerName);
        if (isHidden) row.classList.add('layer-hidden');

        // Visibility toggle button
        const visBtn = document.createElement('button');
        visBtn.className = 'layer-vis-btn';
        visBtn.title = 'Toggle visibility';
        visBtn.textContent = '👁';
        visBtn.style.opacity = isHidden ? '0.3' : '1';
        visBtn.addEventListener('click', () => this.toggle(layerName));

        // Layer name — read-only (OCG names come from the PDF, cannot be changed)
        const nameSpan = document.createElement('span');
        nameSpan.className = 'layer-name';
        nameSpan.textContent = layerName;  // textContent: XSS safe

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
    }
}
