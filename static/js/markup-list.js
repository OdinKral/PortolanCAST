/**
 * PortolanCAST — Markup List Module
 *
 * Purpose:
 *   Renders a filterable, clickable list of all markups across all pages.
 *   This narrows Norman's evaluation gulf — the semantic model becomes
 *   visible at scale. Users can see all issues, filter by type/status,
 *   click to navigate to a markup, and understand the state of the document.
 *
 * Architecture:
 *   Scans canvas.pageMarkups (in-memory Map) plus the current page's live
 *   objects. Builds a flat list of markup entries with page/index/metadata.
 *   Renders rows in the #markup-list container. Responds to filter dropdowns.
 *   Click a row → navigate to page + select the object on the canvas.
 *
 * Design principle (Norman — evaluation gulf):
 *   "Show me all open issues" requires aggregation across pages.
 *   The properties panel shows one object. The markup list shows them all.
 *   Together they make the semantic model visible at every scale.
 *
 * Security:
 *   - Note text is rendered via textContent (not innerHTML) — XSS safe
 *   - Filter values validated against known option sets
 *   - No external data ingestion
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-16
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Human-readable labels for Fabric.js type names.
 * Must handle both lowercase (live objects) and PascalCase (serialized JSON).
 */
const SHAPE_LABELS = {
    'rect': 'Rect', 'Rect': 'Rect',
    'ellipse': 'Ellipse', 'Ellipse': 'Ellipse',
    'line': 'Line', 'Line': 'Line',
    'path': 'Pen', 'Path': 'Pen',
    'circle': 'Circle', 'Circle': 'Circle',
    'polygon': 'Polygon', 'Polygon': 'Polygon',
    'polyline': 'Polyline', 'Polyline': 'Polyline',
    'i-text': 'Text', 'IText': 'Text',
    'textbox': 'Text', 'Textbox': 'Text',
    // Groups — disambiguate by measurementType when building row
    'group': 'Group', 'Group': 'Group',
};

/**
 * Type badge labels — short names for the markup type badges.
 * Includes both markup intent types and Phase 2 measurement types.
 */
const TYPE_LABELS = {
    'note': 'Note',
    'issue': 'Issue',
    'question': 'Qstn',
    'approval': 'Appr',
    'change': 'Chng',
    // Phase 2: measurement types
    'distance': 'Dist',
    'polylength': 'PLen',
    'area': 'Area',
    'perimeter': 'Peri',
    'angle': 'Angl',
    'count': 'Count',
    // Phase 3: image overlay — photo placed as a canvas markup object
    'image-overlay': 'Image',
    'component-stamp': 'Stamp',
};

// =============================================================================
// TAG PARSING
// =============================================================================

/**
 * Extract hashtags from a markup note string.
 *
 * Tags are #word patterns: alphanumeric + dash/underscore, no spaces.
 * Returns a deduplicated, lowercase array in order of first appearance.
 *
 * Mirrors the same function in properties.js — both files use their own copy
 * to avoid a shared-utilities dependency for one small function.
 *
 * Args:
 *   note: Raw markupNote string.
 *
 * Returns:
 *   string[] — deduplicated lowercase tag names (without # prefix).
 */
function parseTags(note) {
    if (!note) return [];
    const matches = [...note.matchAll(/#([a-zA-Z0-9_-]+)/g)];
    const seen = new Set();
    return matches
        .map(m => m[1].toLowerCase())
        .filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
}

// =============================================================================
// MARKUP LIST
// =============================================================================

/**
 * Manages the markup list panel — aggregates markups across all pages
 * into a filterable, clickable table.
 *
 * Usage:
 *   const list = new MarkupList();
 *   list.init(canvas);
 *   list.onNavigate = (page, objectIndex) => { ... };
 */
export class MarkupList {
    constructor() {
        /** @type {import('./canvas.js').CanvasOverlay|null} */
        this.canvas = null;

        /**
         * Callback when user clicks a markup row.
         * Args: (pageNumber, objectIndex) — app.js uses these to navigate + select.
         * @type {Function|null}
         */
        this.onNavigate = null;

        /**
         * MeasureSummary instance — set by app.js after init.
         * When the user switches to the Measures panel tab, _bindTabSwitching()
         * calls measureSummary.refresh() so the aggregated data is always fresh.
         * @type {import('./measure-summary.js').MeasureSummary|null}
         */
        this.measureSummary = null;

        /**
         * LayerManager instance — set by app.js after init.
         * When the user switches to the Layers panel tab, _bindTabSwitching()
         * calls layerManager.refresh() so the layer list is always current.
         * @type {import('./layers.js').LayerManager|null}
         */
        this.layerManager = null;

        /**
         * ReviewBrief instance — set by app.js after init.
         * When the user switches to the Brief panel tab, _bindTabSwitching()
         * calls reviewBrief.refresh() so the brief reflects the live canvas state.
         * @type {import('./review-brief.js').ReviewBrief|null}
         */
        this.reviewBrief = null;

        /**
         * EntityManager instance — set by app.js after init.
         * When the user switches to the Equipment panel tab, _bindTabSwitching()
         * calls entityManager.refresh() so the entity list is always current.
         * @type {import('./entity-manager.js').EntityManager|null}
         */
        this.entityManager = null;

        /**
         * RFIGenerator instance — set by app.js after init.
         * The RFI tab does NOT auto-generate on switch (header fields may be empty).
         * The user clicks Generate explicitly — this ref is kept for future hooks.
         * @type {import('./rfi-generator.js').RFIGenerator|null}
         */
        this.rfiGenerator = null;

        /** @type {Array<object>} Flat list of all markup entries across pages */
        this._entries = [];

        /** @type {string} Current type filter value: 'all' or a markupType */
        this._typeFilter = 'all';

        /** @type {string} Current status filter value: 'all' | 'open' | 'resolved' */
        this._statusFilter = 'all';

        /** @type {string|null} ID of the currently highlighted row */
        this._activeRowId = null;

        /**
         * Active tag filter — null means no tag filter applied.
         * Set by _setTagFilter(), read by _renderList().
         * Cleared automatically when a new document is loaded (canvas.pageMarkups changes).
         * @type {string|null}
         */
        this._tagFilter = null;

        // DOM element cache — set in init()
        this._els = {};
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the markup list panel.
     *
     * Caches DOM references, binds filter change handlers, and sets up
     * tab switching behavior for the left panel.
     *
     * Args:
     *   canvas: CanvasOverlay instance (must be initialized).
     */
    init(canvas) {
        this.canvas = canvas;

        this._els = {
            list: document.getElementById('markup-list'),
            count: document.getElementById('markup-count'),
            typeFilter: document.getElementById('markup-filter'),
            statusFilter: document.getElementById('markup-status-filter'),
            emptyMsg: document.getElementById('markup-list-empty'),
            // Tag cloud — chip strip above the scrollable markup rows
            tagCloud: document.getElementById('markup-tag-cloud'),
        };

        this._bindTabSwitching();
        this._bindFilters();

        console.log('[MarkupList] Panel initialized');
    }

    // =========================================================================
    // TAB SWITCHING
    // =========================================================================

    /**
     * Bind click handlers for the Pages/Markups tab buttons.
     */
    _bindTabSwitching() {
        const tabs = document.querySelectorAll('.panel-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // Deactivate all tabs and content
                tabs.forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => {
                    c.classList.remove('active');
                });

                // Activate clicked tab and its content
                tab.classList.add('active');
                const panelId = `tab-${tab.dataset.panel}`;
                const panel = document.getElementById(panelId);
                if (panel) panel.classList.add('active');

                // Refresh list when switching to Markups tab
                if (tab.dataset.panel === 'markups') {
                    this.refresh();
                }

                // Refresh measurement summary when switching to Measures tab
                if (tab.dataset.panel === 'measures' && this.measureSummary) {
                    this.measureSummary.refresh();
                }

                // Refresh layer panel when switching to Layers tab
                if (tab.dataset.panel === 'layers' && this.layerManager) {
                    this.layerManager.refresh();
                }

                // Refresh review brief when switching to Brief tab
                if (tab.dataset.panel === 'brief' && this.reviewBrief) {
                    this.reviewBrief.refresh();
                }

                // RFI tab: no auto-generate — user fills header fields first, then clicks Generate
                // (nothing to do here; the button handler in rfi-generator.js handles generation)

                // Refresh Equipment tab when switching to it
                if (tab.dataset.panel === 'equipment' && this.entityManager) {
                    this.entityManager.refresh();
                }
            });
        });
    }

    // =========================================================================
    // FILTER HANDLERS
    // =========================================================================

    /**
     * Bind change handlers for the type and status filter dropdowns.
     */
    _bindFilters() {
        if (this._els.typeFilter) {
            this._els.typeFilter.addEventListener('change', (e) => {
                this._typeFilter = e.target.value;
                this._renderList();
            });
        }

        if (this._els.statusFilter) {
            this._els.statusFilter.addEventListener('change', (e) => {
                this._statusFilter = e.target.value;
                this._renderList();
            });
        }
    }

    // =========================================================================
    // REFRESH — Scan all pages and rebuild the list
    // =========================================================================

    /**
     * Scan all page markups and rebuild the list.
     *
     * Collects markup objects from:
     *   1. The current page's live Fabric canvas objects
     *   2. Serialized JSON for all other pages in canvas.pageMarkups
     *
     * Each entry includes: page number, object index, type, status, note,
     * shape type, and stroke color (for visual identification).
     */
    refresh() {
        if (!this.canvas) return;

        this._entries = [];

        // Determine which page is live on canvas — use app's lastPage to
        // avoid race with viewer.currentPage which updates before image loads
        const livePage = this.canvas.viewer ? this.canvas.viewer.currentPage : 0;

        // Scan stored pages (all except the live page — counted separately)
        for (const [pageNum, fabricJson] of this.canvas.pageMarkups) {
            if (pageNum === livePage) continue;
            if (!fabricJson || !fabricJson.objects) continue;

            fabricJson.objects.forEach((obj, idx) => {
                this._entries.push(this._buildEntry(obj, pageNum, idx));
            });
        }

        // Count live canvas objects for the current page (avoids saving side-effect)
        if (this.canvas.fabricCanvas) {
            const liveObjs = this.canvas.fabricCanvas.getObjects();
            liveObjs.forEach((obj, idx) => {
                this._entries.push(this._buildEntry(obj, livePage, idx));
            });
        }

        // Sort by page number, then by index within page
        this._entries.sort((a, b) => a.page - b.page || a.index - b.index);

        this._renderList();
    }

    // =========================================================================
    // ENTRY BUILDER — normalize obj into a flat entry record
    // =========================================================================

    /**
     * Build a normalized entry record from a Fabric object.
     *
     * Handles both markup objects (markupType) and measurement objects
     * (measurementType) into a common structure for rendering.
     *
     * Args:
     *   obj: Fabric.js object (live or from serialized JSON).
     *   page: Page number (zero-indexed).
     *   index: Object index within the page.
     *
     * Returns:
     *   Object — normalized entry with type, status, note, etc.
     */
    _buildEntry(obj, page, index) {
        const isMeasurement = !!obj.measurementType;

        // Compute display note for measurement entries using live scale
        let note = '';
        if (isMeasurement) {
            const scale = this.scale;
            switch (obj.measurementType) {
                case 'distance':
                    note = (scale && obj.pixelLength != null)
                        ? scale.formatDistance(obj.pixelLength)
                        : (obj.labelText || '');
                    break;
                case 'area':
                    note = (scale && obj.pixelArea != null)
                        ? scale.formatArea(obj.pixelArea)
                        : (obj.labelText || '');
                    break;
                case 'polylength':
                    note = (scale && obj.pixelLength != null)
                        ? `Σ ${scale.formatDistance(obj.pixelLength)}`
                        : (obj.labelText || '');
                    break;
                case 'perimeter':
                    note = (scale && obj.pixelLength != null)
                        ? `⊡ ${scale.formatDistance(obj.pixelLength)}`
                        : (obj.labelText || '');
                    break;
                case 'angle':
                    note = obj.angleDegrees != null
                        ? `${obj.angleDegrees.toFixed(1)}°`
                        : (obj.labelText || '');
                    break;
                case 'count':
                    note = obj.countIndex != null ? `#${obj.countIndex}` : '';
                    break;
                default:
                    note = obj.labelText || '';
            }
        } else {
            note = obj.markupNote || '';
        }

        return {
            page,
            index,
            // type drives badge color class and filter matching
            type: isMeasurement ? obj.measurementType : (obj.markupType || 'note'),
            // status only applies to markup objects
            status: isMeasurement ? 'measurement' : (obj.markupStatus || 'open'),
            note,
            shape: obj.type || '?',
            stroke: obj.stroke || '#ff0000',
            isMeasurement,
            // tags parsed from markupNote — empty array for measurements and area companions
            // (measurement notes are formatted values, not user text, so no tags expected)
            tags: isMeasurement ? [] : parseTags(obj.markupNote || ''),
        };
    }

    // =========================================================================
    // RENDER — Build DOM rows from entries
    // =========================================================================

    /**
     * Render the markup list rows into the DOM.
     * Applies current type and status filters.
     * Measurement objects always pass the status filter (no open/resolved concept).
     */
    _renderList() {
        if (!this._els.list) return;

        // Apply filters — type, status, and optional tag
        const filtered = this._entries.filter(e => {
            if (this._typeFilter !== 'all' && e.type !== this._typeFilter) return false;
            // Measurements skip the status filter — they have no open/resolved status
            if (!e.isMeasurement && this._statusFilter !== 'all' && e.status !== this._statusFilter) return false;
            // Tag filter: skip if active tag is not in this entry's tag list
            if (this._tagFilter !== null && !e.tags.includes(this._tagFilter)) return false;
            return true;
        });

        // Collect all unique tags from annotation markup entries (not measurements)
        // for the tag cloud. Computed from all entries (not filtered) so the cloud
        // always shows the full tag vocabulary regardless of other active filters.
        const allTags = [...new Set(
            this._entries
                .filter(e => !e.isMeasurement)
                .flatMap(e => e.tags)
        )].sort();

        this._renderTagCloud(allTags);

        // Update count summary
        const totalCount = this._entries.length;
        const shownCount = filtered.length;
        if (this._els.count) {
            const isFiltered = this._typeFilter !== 'all' || this._statusFilter !== 'all' || this._tagFilter !== null;
            if (!isFiltered) {
                this._els.count.textContent = `${totalCount} markup${totalCount !== 1 ? 's' : ''}`;
            } else {
                this._els.count.textContent = `${shownCount}/${totalCount} markups`;
            }
        }

        // Show/hide empty message
        if (this._els.emptyMsg) {
            this._els.emptyMsg.style.display = filtered.length === 0 ? 'block' : 'none';
        }

        // Clear existing rows (but keep the empty message element)
        const existingRows = this._els.list.querySelectorAll('.markup-row');
        existingRows.forEach(row => row.remove());

        // Build rows
        filtered.forEach(entry => {
            const row = this._createRow(entry);
            this._els.list.appendChild(row);
        });
    }

    /**
     * Create a single markup row DOM element.
     *
     * Layout:
     *   [status dot] [type badge] [shape + note preview] [page #]
     *
     * Args:
     *   entry: Markup entry object from _entries.
     *
     * Returns:
     *   HTMLElement — the row div.
     */
    _createRow(entry) {
        const row = document.createElement('div');
        row.className = 'markup-row';
        row.dataset.page = entry.page;
        row.dataset.index = entry.index;

        // Unique ID for active highlighting
        const rowId = `${entry.page}-${entry.index}`;
        row.dataset.rowId = rowId;
        if (rowId === this._activeRowId) {
            row.classList.add('active');
        }

        // Status indicator dot — neutral for measurements (no open/resolved concept)
        const statusDot = document.createElement('span');
        const dotStatus = entry.isMeasurement ? 'measurement' : entry.status;
        statusDot.className = `markup-status-dot status-${dotStatus}`;
        statusDot.title = entry.isMeasurement ? 'Measurement' : entry.status;
        row.appendChild(statusDot);

        // Type badge
        const typeBadge = document.createElement('span');
        typeBadge.className = `markup-type-badge type-${entry.type}`;
        // SECURITY: textContent, not innerHTML
        typeBadge.textContent = TYPE_LABELS[entry.type] || entry.type;
        row.appendChild(typeBadge);

        // Content area: shape label + note preview
        const content = document.createElement('div');
        content.className = 'markup-row-content';

        const shapeLine = document.createElement('div');
        shapeLine.className = 'markup-row-shape';
        // For measurement objects, show a descriptive shape label based on measurementType
        let shapeLabel;
        if (entry.isMeasurement) {
            shapeLabel = {
                distance: 'Ruler', polylength: 'Path', area: 'Polygon',
                perimeter: 'Perimeter', angle: 'Angle', count: 'Marker',
            }[entry.type] || SHAPE_LABELS[entry.shape] || entry.shape;
        } else if (entry.shape === 'group' || entry.shape === 'Group') {
            shapeLabel = 'Callout';
        } else {
            shapeLabel = SHAPE_LABELS[entry.shape] || entry.shape;
        }
        shapeLine.textContent = shapeLabel;
        content.appendChild(shapeLine);

        if (entry.note) {
            const noteLine = document.createElement('div');
            noteLine.className = 'markup-row-note';
            // SECURITY: textContent, not innerHTML — XSS safe
            noteLine.textContent = entry.note;
            row.title = entry.note;
            content.appendChild(noteLine);
        }

        row.appendChild(content);

        // Page number label
        const pageLabel = document.createElement('span');
        pageLabel.className = 'markup-row-page';
        pageLabel.textContent = `p.${entry.page + 1}`;
        row.appendChild(pageLabel);

        // Click handler — navigate to page and select object
        row.addEventListener('click', () => {
            this._setActiveRow(rowId);
            if (this.onNavigate) {
                this.onNavigate(entry.page, entry.index);
            }
        });

        return row;
    }

    // =========================================================================
    // TAG CLOUD + FILTER
    // =========================================================================

    /**
     * Render the tag cloud strip above the markup rows.
     *
     * Shows one chip per unique tag found across all annotation markups.
     * The cloud is hidden when no tags exist. The active tag filter chip
     * is highlighted with a different class. An "All" chip always appears
     * first and clears the active tag filter.
     *
     * Design principle (Norman — affordance):
     *   Tags are clickable because they look like interactive chips (cursor:pointer,
     *   hover highlight). Toggle behavior (click active tag to clear) prevents
     *   the user from getting "stuck" in a filter they can't clear.
     *
     * Args:
     *   allTags: Sorted array of unique tag strings across all annotation entries.
     *
     * Security: tag text is set via textContent — never innerHTML.
     */
    _renderTagCloud(allTags) {
        const container = this._els.tagCloud;
        if (!container) return;

        // Clear existing chips
        while (container.firstChild) container.removeChild(container.firstChild);

        if (allTags.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = '';

        // "All" chip — clears the tag filter; highlighted when no tag is active
        const clearChip = document.createElement('span');
        clearChip.className = 'markup-tag' + (this._tagFilter === null ? ' markup-tag-all-active' : '');
        clearChip.textContent = 'All';
        clearChip.title = 'Show all markups';
        clearChip.addEventListener('click', () => this._setTagFilter(null));
        container.appendChild(clearChip);

        for (const tag of allTags) {
            const chip = document.createElement('span');
            const isActive = this._tagFilter === tag;
            chip.className = 'markup-tag' + (isActive ? ' markup-tag-active' : '');
            chip.textContent = '#' + tag;  // SECURITY: textContent
            chip.title = isActive ? `Showing #${tag} — click to clear` : `Filter by #${tag}`;
            // Toggle: click active tag clears the filter (exit without getting stuck)
            chip.addEventListener('click', () => this._setTagFilter(isActive ? null : tag));
            container.appendChild(chip);
        }
    }

    /**
     * Set the active tag filter and re-render the list.
     *
     * Args:
     *   tag: Tag string to filter by, or null to clear the filter.
     */
    _setTagFilter(tag) {
        this._tagFilter = tag;
        this._renderList();
    }

    /**
     * Highlight a row as active (selected).
     *
     * Args:
     *   rowId: String ID "page-index" of the row to highlight.
     */
    _setActiveRow(rowId) {
        this._activeRowId = rowId;
        const rows = this._els.list.querySelectorAll('.markup-row');
        rows.forEach(row => {
            row.classList.toggle('active', row.dataset.rowId === rowId);
        });
    }

    /**
     * Clear the active row highlight (e.g. when selection is cleared on canvas).
     */
    clearActive() {
        this._activeRowId = null;
        const rows = this._els.list.querySelectorAll('.markup-row');
        rows.forEach(row => row.classList.remove('active'));
    }
}
