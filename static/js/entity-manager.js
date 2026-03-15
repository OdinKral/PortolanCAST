/**
 * PortolanCAST — Equipment Tab (Entity Manager)
 *
 * Purpose:
 *   Renders and manages the Equipment tab in the left panel. Displays a
 *   filterable list of all equipment entities, with each row showing
 *   tag_number, equip_type, location, and linked markup count. Clicking
 *   a row opens the Entity Detail Modal for full inspection.
 *
 * Security:
 *   All user-supplied text rendered via textContent — never innerHTML.
 *   Input fields trimmed before submission. Entity IDs validated as non-empty.
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-03-07
 */

// =============================================================================
// ENTITY MANAGER — EQUIPMENT TAB
// =============================================================================

export class EntityManager {
    constructor() {
        /** @type {string|null} Current document ID — not used for entity list (global) but stored for context */
        this.docId = null;

        /** @type {Array} Cached entity list from last refresh() */
        this._entities = [];

        /** @type {boolean} Whether init() has been called */
        this._initialized = false;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Initialize the Equipment tab for a document.
     *
     * Called by app.js on each document load. Stores docId and binds filter
     * handlers (idempotent — only binds once). Does NOT auto-refresh; the
     * tab-switching handler in markup-list.js calls refresh() when the user
     * clicks the Equipment tab.
     *
     * Args:
     *   docId: Current document ID (integer).
     */
    init(docId) {
        this.docId = docId;

        if (!this._initialized) {
            this._initialized = true;
            this._bindFilters();
        }
    }

    // =========================================================================
    // DATA FETCHING
    // =========================================================================

    /**
     * Fetch all entities from the API and render the list.
     *
     * Called when the user switches to the Equipment tab, or after mutations
     * (entity create/delete/unlink) that change the list content.
     */
    async refresh() {
        try {
            const resp = await fetch('/api/entities');
            if (!resp.ok) {
                console.error('[EntityManager] Failed to fetch entities:', resp.status);
                return;
            }
            const data = await resp.json();
            this._entities = data.entities || [];
            this._renderList();
        } catch (err) {
            console.error('[EntityManager] Error refreshing entities:', err);
        }
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    /**
     * Render the entity list into #equip-list, applying active filters.
     *
     * Filters are client-side substring matches on the cached entity array —
     * fast enough for <1000 entities. The equip_type filter dropdown is
     * populated with unique types from the full entity list.
     */
    _renderList() {
        const listEl = document.getElementById('equip-list');
        const emptyEl = document.getElementById('equip-empty');
        if (!listEl) return;

        // Apply active filters (case-insensitive substring match)
        const searchVal = (document.getElementById('equip-search')?.value || '').trim().toLowerCase();
        const buildingVal = document.getElementById('equip-filter-building')?.value || '';
        const typeVal = document.getElementById('equip-filter-type')?.value || '';
        const locVal = (document.getElementById('equip-filter-loc')?.value || '').trim().toLowerCase();

        let filtered = this._entities;

        if (searchVal) {
            filtered = filtered.filter(e =>
                (e.tag_number || '').toLowerCase().includes(searchVal)
            );
        }
        if (buildingVal) {
            filtered = filtered.filter(e => e.building === buildingVal);
        }
        if (typeVal) {
            filtered = filtered.filter(e => e.equip_type === typeVal);
        }
        if (locVal) {
            filtered = filtered.filter(e =>
                (e.location || '').toLowerCase().includes(locVal)
            );
        }

        // Populate filter dropdowns with unique values from full list
        this._populateBuildingDropdown();
        this._populateTypeDropdown();

        // Clear existing rows
        listEl.innerHTML = '';

        // Show/hide empty state
        if (this._entities.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        if (filtered.length === 0) {
            // Filters active but no matches — show inline "no results" message
            const noMatch = document.createElement('div');
            noMatch.className = 'muted-text';
            noMatch.style.padding = '12px 8px';
            noMatch.textContent = 'No entities match the current filters.';
            listEl.appendChild(noMatch);
            return;
        }

        // Build rows
        for (const entity of filtered) {
            const row = document.createElement('div');
            row.className = 'equip-row';
            row.dataset.entityId = entity.id;

            // Tag number — prefixed with building if set
            const tag = document.createElement('span');
            tag.className = 'equip-tag';
            // SECURITY: textContent only
            const displayTag = entity.building
                ? `${entity.building} / ${entity.tag_number}`
                : entity.tag_number || '—';
            tag.textContent = displayTag;
            row.appendChild(tag);

            // Equipment type
            const type = document.createElement('span');
            type.className = 'equip-type';
            type.textContent = entity.equip_type || '';
            row.appendChild(type);

            // Location (truncated in CSS)
            if (entity.location) {
                const loc = document.createElement('span');
                loc.className = 'equip-location';
                loc.textContent = entity.location;
                row.appendChild(loc);
            }

            // Markup count badge
            const count = document.createElement('span');
            count.className = 'equip-count';
            const mc = entity.markup_count || 0;
            count.textContent = mc > 0 ? `${mc}` : '';
            count.title = mc > 0 ? `${mc} linked markup${mc !== 1 ? 's' : ''}` : 'No linked markups';
            row.appendChild(count);

            // Click → open entity modal
            row.addEventListener('click', () => {
                // EntityModal is cross-wired via window.app.entityModal
                if (window.app && window.app.entityModal) {
                    window.app.entityModal.open(entity.id);
                }
            });

            listEl.appendChild(row);
        }
    }

    /**
     * Populate the building filter dropdown with unique values from all entities.
     *
     * Same pattern as _populateTypeDropdown — deduplication via Set,
     * preserves current selection, avoids unnecessary DOM rebuilds.
     */
    _populateBuildingDropdown() {
        const select = document.getElementById('equip-filter-building');
        if (!select) return;

        const currentVal = select.value;
        const buildings = [...new Set(
            this._entities
                .map(e => e.building)
                .filter(b => b) // skip null/empty
        )].sort();

        const existing = Array.from(select.options).slice(1).map(o => o.value);
        if (JSON.stringify(existing) === JSON.stringify(buildings)) return;

        while (select.options.length > 1) {
            select.remove(1);
        }

        for (const b of buildings) {
            const opt = document.createElement('option');
            opt.value = b;
            opt.textContent = b;
            select.appendChild(opt);
        }

        if (buildings.includes(currentVal)) {
            select.value = currentVal;
        }
    }

    /**
     * Populate the equip_type filter dropdown with unique values from all entities.
     *
     * Preserves the current selection if it still exists in the data. Uses a Set
     * for deduplication and sorts alphabetically for consistent ordering.
     */
    _populateTypeDropdown() {
        const select = document.getElementById('equip-filter-type');
        if (!select) return;

        const currentVal = select.value;
        const types = [...new Set(
            this._entities
                .map(e => e.equip_type)
                .filter(t => t) // skip null/empty
        )].sort();

        // Rebuild only if types changed — avoid unnecessary DOM thrash
        const existing = Array.from(select.options).slice(1).map(o => o.value);
        if (JSON.stringify(existing) === JSON.stringify(types)) return;

        // Clear all except "All types" option
        while (select.options.length > 1) {
            select.remove(1);
        }

        for (const t of types) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            select.appendChild(opt);
        }

        // Restore previous selection if still valid
        if (types.includes(currentVal)) {
            select.value = currentVal;
        }
    }

    // =========================================================================
    // FILTER BINDING
    // =========================================================================

    /**
     * Bind input/change handlers for the Equipment tab filter controls.
     *
     * Uses 'input' event on text fields for live filtering as the user types,
     * and 'change' event on the select dropdown. All handlers just re-render
     * from the cached _entities array — no new API calls.
     */
    _bindFilters() {
        const searchInput = document.getElementById('equip-search');
        const buildingSelect = document.getElementById('equip-filter-building');
        const typeSelect = document.getElementById('equip-filter-type');
        const locInput = document.getElementById('equip-filter-loc');

        if (searchInput) {
            searchInput.addEventListener('input', () => this._renderList());
        }
        if (buildingSelect) {
            buildingSelect.addEventListener('change', () => this._renderList());
        }
        if (typeSelect) {
            typeSelect.addEventListener('change', () => this._renderList());
        }
        if (locInput) {
            locInput.addEventListener('input', () => this._renderList());
        }
    }
}
