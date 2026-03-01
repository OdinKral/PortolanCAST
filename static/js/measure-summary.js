/**
 * PortolanCAST — Measurement Summary Module
 *
 * Purpose:
 *   Aggregates all measurement objects (distance, area, count) across every page
 *   into a dedicated "Measures" left-panel tab.  Provides:
 *     - Three stat cards: total count + summed value per type
 *     - Filterable, scrollable row list with page labels
 *     - Click-to-navigate rows (same _navigateToMarkup path as markup-list.js)
 *     - CSV export (client-side Blob download — no server involved)
 *
 * Architecture:
 *   Mirrors markup-list.js multi-page aggregation exactly:
 *     - Live page: canvas.fabricCanvas.getObjects()
 *     - Other pages: canvas.pageMarkups Map (Fabric serialized JSON)
 *
 *   Area deduplication: each area measurement produces TWO Fabric objects —
 *   a Polygon (the primary) and a companion IText centroid label (pairedId match).
 *   Both carry measurementType === 'area'.  We skip the IText to avoid
 *   double-counting (detected by Fabric type: 'IText' / 'i-text').
 *
 * Security:
 *   - All user-visible text written via textContent (not innerHTML) — XSS safe
 *   - CSV download uses Blob URL + auto-revoke — no server upload
 *   - Type filter values validated against a known allowlist before use
 *   - No eval(), no dynamic code execution
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-23
 */

// =============================================================================
// VALID MEASUREMENT TYPES — allowlist for filter validation
// =============================================================================

const VALID_TYPES = new Set(['all', 'distance', 'area', 'count']);

// =============================================================================
// MEASURE SUMMARY
// =============================================================================

/**
 * Aggregates measurement objects from all pages and renders a summary panel.
 *
 * Usage:
 *   const summary = new MeasureSummary();
 *   summary.init(canvas, scale);
 *   summary.onNavigate = (page, objIndex) => { ... };
 *   // summary.refresh() is called automatically on Measures tab switch
 */
export class MeasureSummary {
    constructor() {
        /** @type {import('./canvas.js').CanvasOverlay|null} */
        this.canvas = null;

        /**
         * ScaleManager reference — used for live unit formatting.
         * Updated by app.js on each document load (scale preset may change).
         * @type {import('./scale.js').ScaleManager|null}
         */
        this.scale = null;

        /**
         * Callback fired when the user clicks a row.
         * Args: (pageNumber: number, objectIndex: number)
         * → app.js._navigateToMarkup() handles page nav + object selection.
         * @type {Function|null}
         */
        this.onNavigate = null;

        /** @type {Array<object>} All measurement entries across all pages (unfiltered) */
        this._entries = [];

        /**
         * Active type filter for row display.
         * One of: 'all' | 'distance' | 'area' | 'count'
         * @type {string}
         */
        this._typeFilter = 'all';

        // DOM element cache — set in init()
        this._els = {};
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the Measures panel.
     *
     * Caches DOM element references, binds the type-filter dropdown and the
     * CSV export button.  Safe to call only once — app.js guards with
     * `if (!this.measureSummary.canvas)`.
     *
     * Args:
     *   canvas: CanvasOverlay instance (must already be initialized).
     *   scale:  ScaleManager instance for unit conversion.
     */
    init(canvas, scale) {
        this.canvas = canvas;
        this.scale = scale;

        this._els = {
            statDistCount:  document.getElementById('stat-distance-count'),
            statDistTotal:  document.getElementById('stat-distance-total'),
            statAreaCount:  document.getElementById('stat-area-count'),
            statAreaTotal:  document.getElementById('stat-area-total'),
            statCntCount:   document.getElementById('stat-count-count'),
            statCntTotal:   document.getElementById('stat-count-total'),
            typeFilter:     document.getElementById('measure-type-filter'),
            exportBtn:      document.getElementById('btn-export-csv'),
            list:           document.getElementById('measure-list'),
            emptyMsg:       document.getElementById('measure-list-empty'),
        };

        this._bindHandlers();

        console.log('[MeasureSummary] Panel initialized');
    }

    // =========================================================================
    // EVENT BINDING
    // =========================================================================

    /**
     * Bind the type-filter select and Export CSV button.
     * Both are idempotent — only called once from init().
     */
    _bindHandlers() {
        if (this._els.typeFilter) {
            this._els.typeFilter.addEventListener('change', (e) => {
                // Validate against allowlist — defense-in-depth even for local UI
                const val = e.target.value;
                this._typeFilter = VALID_TYPES.has(val) ? val : 'all';
                this._renderRows();
            });
        }

        if (this._els.exportBtn) {
            this._els.exportBtn.addEventListener('click', () => {
                this._exportCSV();
            });
        }
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Aggregate all measurements and re-render the panel.
     *
     * Called by markup-list.js when the user switches to the Measures tab,
     * and may be called by app.js after content changes if needed.
     */
    refresh() {
        if (!this.canvas) return;

        this._aggregate();
        this._renderStats();
        this._renderRows();
    }

    // =========================================================================
    // AGGREGATION — scan live canvas + stored pageMarkups
    // =========================================================================

    /**
     * Collect all measurement entries from every page.
     *
     * Multi-page strategy mirrors markup-list.js:208-239:
     *   - All pages *except* the live page come from canvas.pageMarkups (JSON).
     *   - The live page is scanned from canvas.fabricCanvas.getObjects().
     *   This avoids calling onPageChanging() as a side-effect.
     *
     * Area companion IText labels are skipped here (see _isAreaCompanionLabel).
     */
    _aggregate() {
        this._entries = [];

        // Use canvas.viewer.currentPage as the live page reference —
        // same approach as markup-list.js (safe here because we are called
        // on tab switch, not during page navigation debounce)
        const livePage = this.canvas.viewer ? this.canvas.viewer.currentPage : 0;

        // ---- Stored pages (serialized JSON in pageMarkups Map) ----
        for (const [pageNum, fabricJson] of this.canvas.pageMarkups) {
            if (pageNum === livePage) continue;  // handled below via live canvas
            if (!fabricJson || !fabricJson.objects) continue;

            fabricJson.objects.forEach((obj, idx) => {
                if (!obj.measurementType) return;            // skip non-measurement objects
                if (this._isAreaCompanionLabel(obj)) return; // skip area IText duplicates
                this._entries.push(this._buildEntry(obj, pageNum, idx));
            });
        }

        // ---- Live canvas (current page) ----
        if (this.canvas.fabricCanvas) {
            const liveObjs = this.canvas.fabricCanvas.getObjects();
            liveObjs.forEach((obj, idx) => {
                if (!obj.measurementType) return;
                if (this._isAreaCompanionLabel(obj)) return;
                this._entries.push(this._buildEntry(obj, livePage, idx));
            });
        }

        // Sort by page number, then by object index within page
        this._entries.sort((a, b) => a.page - b.page || a.objIndex - b.objIndex);
    }

    /**
     * Determine if this Fabric object is the companion IText label of an area
     * measurement polygon.
     *
     * Each area measurement has TWO objects: the Polygon (primary, used for
     * stats and navigation) and an IText label placed at the centroid.  Both
     * carry measurementType === 'area' and a shared pairedId.  We skip the IText
     * to prevent double-counting in the summary panel.
     *
     * Fabric 6 serialized objects use the lowercase type strings ('i-text'),
     * while live canvas objects use PascalCase ('IText').
     *
     * Args:
     *   obj: Fabric object or serialized JSON representation.
     *
     * Returns:
     *   boolean — true if this object should be skipped.
     */
    _isAreaCompanionLabel(obj) {
        if (obj.measurementType !== 'area') return false;
        const t = obj.type;
        return t === 'IText' || t === 'i-text' || t === 'Textbox' || t === 'textbox';
    }

    /**
     * Build a normalized summary entry from a Fabric measurement object.
     *
     * Handles both live canvas objects (have method bindings) and serialized
     * JSON objects (plain property bags) — both expose the same custom
     * measurement properties (measurementType, pixelLength, pixelArea, etc.).
     *
     * Args:
     *   obj:      Fabric object (live) or plain object (from serialized JSON).
     *   page:     Page number, zero-indexed.
     *   objIndex: Object's position in the page objects array (for navigation).
     *
     * Returns:
     *   Entry object: { type, rawValue, formattedValue, page, pageLabel,
     *                   timestamp, author, objIndex }
     */
    _buildEntry(obj, page, objIndex) {
        const type = obj.measurementType;
        let rawValue = 0;
        let formattedValue = '';

        switch (type) {
            case 'distance':
                rawValue = obj.pixelLength || 0;
                // Prefer live scale for current formatting; fall back to baked labelText
                formattedValue = (this.scale && rawValue > 0)
                    ? this.scale.formatDistance(rawValue)
                    : (obj.labelText || `${rawValue.toFixed(1)} px`);
                break;

            case 'area':
                rawValue = obj.pixelArea || 0;
                formattedValue = (this.scale && rawValue > 0)
                    ? this.scale.formatArea(rawValue)
                    : (obj.labelText || `${rawValue.toFixed(0)} sq px`);
                break;

            case 'count':
                // Count items: rawValue = the counter index; no summed total
                rawValue = obj.countIndex || 0;
                formattedValue = obj.labelText || `#${rawValue}`;
                break;

            default:
                rawValue = 0;
                formattedValue = obj.labelText || '';
        }

        return {
            type,
            rawValue,
            formattedValue,
            page,
            pageLabel: `p.${page + 1}`,
            timestamp: obj.markupTimestamp || '',
            author: obj.markupAuthor || '',
            objIndex,
        };
    }

    // =========================================================================
    // STATS — totals for stat cards
    // =========================================================================

    /**
     * Compute per-type counts and pixel totals across all entries.
     *
     * Returns an object:
     *   { distance: { count, totalPx }, area: { count, totalPx }, count: { count } }
     */
    _getSummaryStats() {
        const stats = {
            distance: { count: 0, totalPx: 0 },
            area:     { count: 0, totalPx: 0 },
            count:    { count: 0 },
        };

        for (const e of this._entries) {
            if (e.type === 'distance') {
                stats.distance.count++;
                stats.distance.totalPx += e.rawValue;
            } else if (e.type === 'area') {
                stats.area.count++;
                stats.area.totalPx += e.rawValue;
            } else if (e.type === 'count') {
                stats.count.count++;
            }
        }

        return stats;
    }

    // =========================================================================
    // RENDER — stat cards
    // =========================================================================

    /**
     * Update the three stat cards (Distances / Areas / Count Items) with
     * current totals from _entries.
     */
    _renderStats() {
        const s = this._getSummaryStats();
        const els = this._els;

        // Distance stat card
        if (els.statDistCount) els.statDistCount.textContent = s.distance.count;
        if (els.statDistTotal) {
            if (s.distance.count === 0) {
                els.statDistTotal.textContent = '—';
            } else if (this.scale && s.distance.totalPx > 0) {
                els.statDistTotal.textContent = this.scale.formatDistance(s.distance.totalPx);
            } else {
                els.statDistTotal.textContent = `${s.distance.totalPx.toFixed(1)} px`;
            }
        }

        // Area stat card
        if (els.statAreaCount) els.statAreaCount.textContent = s.area.count;
        if (els.statAreaTotal) {
            if (s.area.count === 0) {
                els.statAreaTotal.textContent = '—';
            } else if (this.scale && s.area.totalPx > 0) {
                els.statAreaTotal.textContent = this.scale.formatArea(s.area.totalPx);
            } else {
                els.statAreaTotal.textContent = `${s.area.totalPx.toFixed(0)} sq px`;
            }
        }

        // Count stat card
        if (els.statCntCount) els.statCntCount.textContent = s.count.count;
        if (els.statCntTotal) {
            // "Count items" have no meaningful sum — show placed count or dash
            els.statCntTotal.textContent = s.count.count > 0
                ? `${s.count.count} placed`
                : '—';
        }
    }

    // =========================================================================
    // RENDER — row list
    // =========================================================================

    /**
     * Render filtered measurement rows into #measure-list.
     * Applies the current type filter (_typeFilter).
     * Reuses .markup-row and .markup-type-badge CSS for visual consistency.
     */
    _renderRows() {
        if (!this._els.list) return;

        const filtered = this._typeFilter === 'all'
            ? this._entries
            : this._entries.filter(e => e.type === this._typeFilter);

        // Show/hide empty state message
        if (this._els.emptyMsg) {
            this._els.emptyMsg.style.display = filtered.length === 0 ? 'block' : 'none';
        }

        // Clear existing rows (preserve the empty message element)
        this._els.list.querySelectorAll('.markup-row').forEach(r => r.remove());

        // Build and append rows
        filtered.forEach(entry => {
            const row = this._createRow(entry);
            this._els.list.appendChild(row);
        });
    }

    /**
     * Create a single measurement row element.
     *
     * Layout: [type badge] [formatted value] [page label]
     * Reuses .markup-row + .markup-type-badge CSS for visual consistency
     * with the Markups tab — same dark-theme row height and colors.
     *
     * Args:
     *   entry: Measurement entry from _entries.
     *
     * Returns:
     *   HTMLElement — the row div.
     */
    _createRow(entry) {
        const row = document.createElement('div');
        row.className = 'markup-row';
        row.dataset.page = entry.page;
        row.dataset.index = entry.objIndex;

        // ---- Type badge ----
        const badge = document.createElement('span');
        badge.className = `markup-type-badge type-${entry.type}`;
        // SECURITY: textContent, not innerHTML — avoids XSS from labelText values
        badge.textContent = { distance: 'Dist', area: 'Area', count: 'Count' }[entry.type]
            || entry.type;
        row.appendChild(badge);

        // ---- Content: formatted value ----
        const content = document.createElement('div');
        content.className = 'markup-row-content';

        const valueLine = document.createElement('div');
        valueLine.className = 'markup-row-shape';
        // SECURITY: textContent, not innerHTML
        valueLine.textContent = entry.formattedValue;
        content.appendChild(valueLine);

        row.appendChild(content);

        // ---- Page label ----
        const pageEl = document.createElement('span');
        pageEl.className = 'markup-row-page';
        pageEl.textContent = entry.pageLabel;
        row.appendChild(pageEl);

        // ---- Click → navigate ----
        row.addEventListener('click', () => {
            if (this.onNavigate) {
                this.onNavigate(entry.page, entry.objIndex);
            }
        });

        return row;
    }

    // =========================================================================
    // CSV EXPORT
    // =========================================================================

    /**
     * Build a CSV string from all entries (unfiltered) and trigger a download.
     *
     * Headers: Type, Value, Raw (px), Page, Author, Timestamp
     * Uses all _entries regardless of current type filter — the export should
     * always be complete.
     *
     * Client-side only — creates a Blob URL, clicks a hidden <a>, then revokes
     * the URL to free memory.  No server upload.
     */
    _exportCSV() {
        const headers = ['Type', 'Value', 'Raw (px)', 'Page', 'Author', 'Timestamp'];

        const rows = this._entries.map(e => [
            e.type,
            // Wrap in double-quotes and escape internal double-quotes (RFC 4180)
            `"${e.formattedValue.replace(/"/g, '""')}"`,
            e.rawValue.toFixed(2),
            e.pageLabel,
            e.author || '',
            e.timestamp || '',
        ]);

        const csvLines = [
            headers.join(','),
            ...rows.map(r => r.join(',')),
        ];

        const csv = csvLines.join('\r\n');  // RFC 4180 line ending

        // Build a Blob and trigger a synthetic download link click
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'measurements.csv';
        // Must be in the DOM for Firefox compatibility
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Revoke the object URL to free the Blob memory
        URL.revokeObjectURL(url);
    }
}
