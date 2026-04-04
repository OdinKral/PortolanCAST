/**
 * PortolanCAST — Text Selection Layer
 *
 * Purpose:
 *   Renders transparent text spans over the PDF image so users can
 *   click-drag to select, copy, and search PDF text — matching the
 *   core Bluebeam Revu text selection behavior.
 *
 * Architecture:
 *   - Fetches word bounding boxes from /api/documents/{id}/text-words/{page}
 *   - Creates positioned <span> elements inside #text-layer
 *   - Spans are transparent but selectable — browser handles selection natively
 *   - Text layer is only interactive when no drawing tool is active
 *     (controlled via CSS class .text-select-active)
 *   - Coordinates are in natural pixels (BASE_DPI = 150), scaled by zoom
 *
 * Security:
 *   - Word text is inserted via textContent (never innerHTML)
 *   - API response is validated before rendering
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-04-03
 */

// =============================================================================
// TEXT LAYER CLASS
// =============================================================================

export class TextLayer {
    constructor() {
        /** @type {HTMLDivElement|null} */
        this._el = null;

        /** @type {number|null} Current document ID */
        this._docId = null;

        /** @type {number} Current page number */
        this._page = -1;

        /** @type {number} Current page rotation */
        this._rotation = 0;

        /** @type {number} Current zoom level (percentage) */
        this._zoom = 100;

        /** @type {boolean} Whether a drawing tool is active */
        this._drawingActive = false;

        /** @type {Map<number, Array>} Cache: page → word data */
        this._cache = new Map();
    }

    /**
     * Initialize the text layer.
     *
     * Call once after DOM is ready. Finds the #text-layer div and sets up
     * the layer for rendering.
     */
    init() {
        this._el = document.getElementById('text-layer');
    }

    /**
     * Load and render text words for a given page.
     *
     * Called by the viewer on page change. Fetches word positions from the
     * server (cached per page) and renders transparent spans.
     *
     * @param {number} docId - Document ID
     * @param {number} page - Zero-indexed page number
     * @param {number} rotation - Page rotation in degrees
     */
    async loadPage(docId, page, rotation = 0) {
        if (!this._el) return;

        this._docId = docId;
        this._page = page;
        this._rotation = rotation;

        // Clear existing spans
        this._el.innerHTML = '';

        // Check cache first
        const cacheKey = `${docId}-${page}-${rotation}`;
        let words = this._cache.get(cacheKey);

        if (!words) {
            try {
                const resp = await fetch(
                    `/api/documents/${docId}/text-words/${page}?rotate=${rotation}`
                );
                if (!resp.ok) return;
                const data = await resp.json();
                if (!Array.isArray(data.words)) return;
                words = data.words;
                this._cache.set(cacheKey, words);
            } catch {
                return;  // Silently fail — text selection is non-critical
            }
        }

        this._renderWords(words);
    }

    /**
     * Render word spans into the text layer div.
     *
     * Each word gets an absolutely-positioned <span> with transparent text.
     * Font size is set to match the bounding box height so the invisible
     * text aligns with the visible PDF text in the image below.
     *
     * @param {Array<{x:number, y:number, w:number, h:number, text:string}>} words
     */
    _renderWords(words) {
        if (!this._el || !words.length) return;

        // Build all spans in a document fragment for performance
        const frag = document.createDocumentFragment();

        for (const word of words) {
            const span = document.createElement('span');
            span.textContent = word.text;

            // Position at natural coordinates (zoom applied via CSS transform on parent)
            span.style.left = `${word.x}px`;
            span.style.top = `${word.y}px`;
            span.style.width = `${word.w}px`;
            span.style.height = `${word.h}px`;
            span.style.fontSize = `${word.h * 0.85}px`;

            frag.appendChild(span);
        }

        this._el.appendChild(frag);
    }

    /**
     * Update the text layer dimensions and scale to match the current zoom.
     *
     * Called by the viewer/canvas whenever zoom changes. The text layer is
     * sized to match the natural image dimensions, then CSS-scaled to the
     * display size — same strategy as the Fabric canvas overlay.
     *
     * @param {number} naturalWidth - Image width at BASE_DPI
     * @param {number} naturalHeight - Image height at BASE_DPI
     * @param {number} zoom - Zoom percentage (100 = 1:1)
     */
    applyZoom(naturalWidth, naturalHeight, zoom) {
        if (!this._el) return;

        this._zoom = zoom;
        const scale = zoom / 100;
        const displayW = Math.round(naturalWidth * scale);
        const displayH = Math.round(naturalHeight * scale);

        this._el.style.width = `${displayW}px`;
        this._el.style.height = `${displayH}px`;

        // Scale the content (spans are positioned in natural coords)
        this._el.style.transformOrigin = '0 0';
        this._el.style.transform = `scale(${scale})`;
    }

    /**
     * Enable or disable text selection based on whether a drawing tool is active.
     *
     * When a drawing tool is active, the Fabric canvas captures pointer events.
     * When in select/hand mode, the text layer becomes interactive so the user
     * can select PDF text.
     *
     * @param {boolean} drawingActive - True if a drawing/measure tool is active
     */
    setDrawingActive(drawingActive) {
        if (!this._el) return;
        this._drawingActive = drawingActive;

        if (drawingActive) {
            this._el.classList.remove('text-select-active');
        } else {
            this._el.classList.add('text-select-active');
        }
    }

    /**
     * Clear the cache (e.g., when a new document is loaded).
     */
    clearCache() {
        this._cache.clear();
        if (this._el) this._el.innerHTML = '';
    }
}
