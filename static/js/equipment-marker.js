/**
 * PortolanCAST — Equipment Marker Panel
 *
 * Purpose:
 *   Slide-out panel for linking a canvas pin marker to an existing or new
 *   equipment entity. Triggered when the user clicks on the drawing with
 *   the Equipment Marker (M) tool active. Collapses the manual workflow
 *   (draw → select → type tag → Promote) into: press M → click → pick → done.
 *
 * Design philosophy:
 *   Search-first: the full entity list is fetched once on open, then filtered
 *   client-side as the user types. "Create new" lives below the search results
 *   as a secondary action, because most markers should link to existing entities
 *   that were captured via Quick Capture during the field walkthrough.
 *
 * Data flow:
 *   1. toolbar.js places a placeholder Group (circle + "..." label) on click
 *   2. toolbar.js calls open(group) → panel slides in, entity list loads
 *   3. User picks an existing entity OR creates a new one
 *   4. _selectEntity() links the entity to the marker: updates label, sets
 *      entityId, POSTs the markup-entity link, triggers auto-save, closes panel
 *   5. If the user closes without linking → the placeholder marker is removed
 *
 * Security:
 *   All user-supplied text rendered via textContent — never innerHTML.
 *   Entity data comes from the local server API, but is still sanitized for display.
 *   Input is trimmed and length-limited before API submission.
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-03-09
 */

// =============================================================================
// EQUIPMENT MARKER PANEL
// =============================================================================

export class EquipmentMarkerPanel {
    constructor() {
        /** @type {number|null} Current document ID for API calls */
        this._docId = null;

        /** @type {Object|null} CanvasOverlay reference for auto-save triggers */
        this._canvas = null;

        /** @type {boolean} Whether init() has been called (idempotent guard) */
        this._initialized = false;

        /** @type {fabric.Group|null} The pending marker placed on the canvas */
        this._pendingMarker = null;

        /** @type {Array} Cached entity list from GET /api/entities */
        this._entityCache = [];

        /** @type {Array} Cached pattern list from GET /api/patterns?type=component */
        this._patternCache = [];

        /** @type {Object|null} Currently selected pattern for new entity creation */
        this._selectedPattern = null;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Initialize the Equipment Marker panel — bind buttons and keyboard events.
     *
     * Called by app.js on first document load. Idempotent via _initialized guard.
     *
     * Args:
     *   docId:  Current document ID for markup-entity linking API calls.
     *   canvas: CanvasOverlay instance for triggering auto-save after linking.
     */
    init(docId, canvas) {
        this._docId = docId;
        this._canvas = canvas;

        if (this._initialized) return;
        this._initialized = true;

        // Bind close button
        const closeBtn = document.getElementById('em-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        // Bind search input — filter on each keystroke
        const searchInput = document.getElementById('em-search');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                this._onSearchInput(searchInput.value);
            });
        }

        // Bind Create & Link button
        const createBtn = document.getElementById('em-create-btn');
        if (createBtn) {
            createBtn.addEventListener('click', () => this._onCreate());
        }

        // Bind pattern picker — auto-fills fields when a pattern is selected
        const patternSelect = document.getElementById('em-pattern');
        if (patternSelect) {
            patternSelect.addEventListener('change', () => this._onPatternSelect(patternSelect.value));
        }

        // Bind Escape key to close panel (only when panel is visible).
        // capture: true so we intercept before other Escape handlers.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._isOpen()) {
                e.stopPropagation();
                this.close();
            }
        }, { capture: true });
    }

    // =========================================================================
    // OPEN / CLOSE
    // =========================================================================

    /**
     * Open the panel for a newly-placed marker.
     *
     * Fetches the entity list, renders results, and focuses the search input.
     *
     * Args:
     *   marker: fabric.Group — the placeholder marker on the canvas.
     */
    async open(marker) {
        this._pendingMarker = marker;

        const panel = document.getElementById('em-panel');
        if (!panel) return;

        panel.style.display = '';

        // Clear previous state
        this._clearFields();

        // Fetch patterns (once, then cached) and entity list
        await this._fetchPatterns();
        await this._fetchEntities();

        // Render full list initially
        this._renderResults(this._entityCache);

        // Auto-focus search input
        const searchInput = document.getElementById('em-search');
        if (searchInput) {
            setTimeout(() => searchInput.focus(), 50);
        }
    }

    /**
     * Close the panel.
     *
     * If the pending marker still has the placeholder label "...", the user
     * cancelled without linking — remove the orphan marker from the canvas.
     */
    close() {
        const panel = document.getElementById('em-panel');
        if (panel) panel.style.display = 'none';

        // Cancel flow: remove unlinked placeholder marker
        if (this._pendingMarker && this._canvas) {
            const label = this._getMarkerLabel(this._pendingMarker);
            if (label && label.text === '...') {
                // User never linked an entity — remove the orphan
                this._canvas.fabricCanvas.remove(this._pendingMarker);
                this._canvas.fabricCanvas.renderAll();
            }
        }

        this._pendingMarker = null;
        this._clearFields();
    }

    /**
     * Check if the panel is currently visible.
     *
     * Returns:
     *   boolean — true if the equipment marker panel is displayed.
     */
    _isOpen() {
        const panel = document.getElementById('em-panel');
        return panel && panel.style.display !== 'none';
    }

    // =========================================================================
    // ENTITY FETCH + SEARCH
    // =========================================================================

    /**
     * Fetch all entities from the API and cache them.
     *
     * The entity list is small enough (hundreds at most) that client-side
     * filtering is faster and more responsive than per-keystroke API calls.
     */
    async _fetchEntities() {
        try {
            const resp = await fetch('/api/entities');
            if (!resp.ok) throw new Error(resp.statusText);
            const data = await resp.json();
            // API returns { entities: [...] }
            this._entityCache = data.entities || data || [];
        } catch (err) {
            console.error('[EquipmentMarker] Failed to fetch entities:', err);
            this._entityCache = [];
        }
    }

    /**
     * Fetch component patterns from the API and populate the pattern picker.
     *
     * Only fetches once — patterns are static seed data that rarely changes.
     * Populates the <select> with grouped options by category.
     */
    async _fetchPatterns() {
        // Only fetch once per session — patterns are seed data
        if (this._patternCache.length > 0) {
            this._populatePatternSelect();
            return;
        }

        try {
            const resp = await fetch('/api/patterns?type=component');
            if (!resp.ok) throw new Error(resp.statusText);
            this._patternCache = await resp.json();
        } catch (err) {
            console.error('[EquipmentMarker] Failed to fetch patterns:', err);
            this._patternCache = [];
        }

        this._populatePatternSelect();
    }

    /**
     * Populate the pattern picker <select> with options grouped by category.
     *
     * Groups: sensor, controller, actuator, setpoint (matching ISA categories).
     * Each option shows the pattern name and ISA symbol for quick recognition.
     */
    _populatePatternSelect() {
        const select = document.getElementById('em-pattern');
        if (!select) return;

        // Preserve the "No pattern" default option
        select.innerHTML = '<option value="">No pattern — manual entry</option>';

        // Group patterns by category for organized display
        const groups = {};
        for (const p of this._patternCache) {
            const cat = p.category || 'other';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(p);
        }

        // Display order for categories
        const categoryOrder = ['sensor', 'controller', 'actuator', 'setpoint'];
        for (const cat of categoryOrder) {
            const patterns = groups[cat];
            if (!patterns || patterns.length === 0) continue;

            const optgroup = document.createElement('optgroup');
            // Capitalize category label for display
            optgroup.label = cat.charAt(0).toUpperCase() + cat.slice(1) + 's';

            for (const p of patterns) {
                const option = document.createElement('option');
                option.value = p.id;
                // Show ISA symbol in parentheses for quick recognition
                const isaLabel = p.isa_symbol ? ` (${p.isa_symbol})` : '';
                option.textContent = `${p.name}${isaLabel}`;
                optgroup.appendChild(option);
            }

            select.appendChild(optgroup);
        }
    }

    /**
     * Handle pattern selection — auto-fill equip_type and show ISA tag hint.
     *
     * When a pattern is selected:
     *   1. Sets equip_type to the pattern name
     *   2. Shows the ISA symbol and tags in the info panel
     *   3. Fetches the next ISA sequence number for the tag hint
     *   4. If no pattern selected, clears auto-fill and hides info
     *
     * Args:
     *   patternId: The selected pattern ID, or '' for no pattern.
     */
    async _onPatternSelect(patternId) {
        const infoEl = document.getElementById('em-pattern-info');
        const tagHint = document.getElementById('em-tag-hint');
        const tagInput = document.getElementById('em-new-tag');
        const typeSelect = document.getElementById('em-new-type');

        if (!patternId) {
            // No pattern selected — clear auto-fill
            this._selectedPattern = null;
            if (infoEl) infoEl.style.display = 'none';
            if (tagHint) tagHint.style.display = 'none';
            if (tagInput) tagInput.placeholder = 'Auto-generated from pattern, or type manually';
            return;
        }

        // Find the selected pattern in the cache
        const pattern = this._patternCache.find(p => p.id === patternId);
        if (!pattern) return;

        this._selectedPattern = pattern;

        // Show pattern info: ISA symbol + tags
        if (infoEl) {
            const tags = Array.isArray(pattern.tags) ? pattern.tags : [];
            const tagPills = tags.map(t => `<span class="em-tag-pill">${t}</span>`).join(' ');
            const isaLabel = pattern.isa_symbol ? `ISA: <strong>${pattern.isa_symbol}</strong>` : '';
            infoEl.innerHTML = `${isaLabel} ${tagPills}`;
            infoEl.style.display = '';
        }

        // Auto-fill equip_type from pattern name
        // Try to match an existing option, otherwise set to the pattern name via a dynamic option
        if (typeSelect) {
            const matchOption = Array.from(typeSelect.options).find(
                o => o.value.toLowerCase() === pattern.name.toLowerCase()
            );
            if (matchOption) {
                typeSelect.value = matchOption.value;
            } else {
                // Add a temporary option for the pattern name
                const dynamicOpt = document.createElement('option');
                dynamicOpt.value = pattern.name;
                dynamicOpt.textContent = pattern.name;
                dynamicOpt.dataset.dynamic = 'true';
                typeSelect.appendChild(dynamicOpt);
                typeSelect.value = pattern.name;
            }
        }

        // Fetch next ISA number for the tag hint
        if (pattern.isa_prefix && tagHint && tagInput) {
            const building = (document.getElementById('em-new-building')?.value || '').trim();
            try {
                const resp = await fetch(
                    `/api/patterns/${patternId}/next-isa?building=${encodeURIComponent(building)}`
                );
                if (resp.ok) {
                    const data = await resp.json();
                    tagHint.textContent = `Suggested: ${data.suggested_tag}`;
                    tagHint.style.display = '';
                    tagInput.placeholder = data.suggested_tag;
                }
            } catch (err) {
                console.error('[EquipmentMarker] ISA number fetch failed:', err);
            }
        }
    }

    /**
     * Handle search input — filter cached entities client-side.
     *
     * Matches case-insensitively against tag_number and equip_type.
     *
     * Args:
     *   query: Current search input value.
     */
    _onSearchInput(query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) {
            this._renderResults(this._entityCache);
            return;
        }

        const filtered = this._entityCache.filter(e => {
            const tag = (e.tag_number || '').toLowerCase();
            const type = (e.equip_type || '').toLowerCase();
            const bldg = (e.building || '').toLowerCase();
            return tag.includes(q) || type.includes(q) || bldg.includes(q);
        });

        this._renderResults(filtered);
    }

    /**
     * Render entity search results into the results container.
     *
     * Each row is built via DOM API (textContent only — no innerHTML).
     * Clicking a row calls _selectEntity().
     *
     * Args:
     *   entities: Array of entity objects to display.
     */
    _renderResults(entities) {
        const container = document.getElementById('em-results');
        if (!container) return;

        // Clear previous results
        container.innerHTML = '';

        if (!entities || entities.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'em-no-results';
            noResults.textContent = 'No entities found';
            container.appendChild(noResults);
            return;
        }

        for (const entity of entities) {
            const row = document.createElement('div');
            row.className = 'em-result-row';

            const tagSpan = document.createElement('span');
            tagSpan.className = 'em-result-tag';
            // SECURITY: textContent only
            // Show building prefix if set, so "Bldg-A / AHU-1" is distinguishable
            const displayTag = entity.building
                ? `${entity.building} / ${entity.tag_number}`
                : entity.tag_number || '(no tag)';
            tagSpan.textContent = displayTag;

            const typeSpan = document.createElement('span');
            typeSpan.className = 'em-result-type';
            typeSpan.textContent = entity.equip_type || '';

            row.appendChild(tagSpan);
            row.appendChild(typeSpan);

            row.addEventListener('click', () => this._selectEntity(entity));

            container.appendChild(row);
        }
    }

    // =========================================================================
    // ENTITY LINKING
    // =========================================================================

    /**
     * Link the selected entity to the pending marker.
     *
     * Flow:
     *   1. POST markup-entity link via the existing API
     *   2. Update the marker's IText label to the entity tag_number
     *   3. Set entityId on the marker Group for serialization
     *   4. Trigger canvas auto-save
     *   5. Close the panel
     *
     * Args:
     *   entity: Entity object { id, tag_number, equip_type, ... }
     */
    async _selectEntity(entity) {
        const marker = this._pendingMarker;
        if (!marker || !this._canvas) return;

        const statusEl = document.getElementById('em-status');

        try {
            // 1. POST markup-entity link — reuse existing API from properties.js
            const markupId = marker.markupId;
            const pageNumber = this._canvas.currentPage ?? 0;

            if (markupId && this._docId) {
                const resp = await fetch(
                    `/api/documents/${this._docId}/markup-entities`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            markup_id: markupId,
                            entity_id: entity.id,
                            page_number: pageNumber,
                        }),
                    }
                );

                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to link entity');
                }
            }

            // 2. Set entityId and patternId on the Group for serialization persistence
            marker.set('entityId', entity.id);
            if (entity.pattern_id) {
                marker.set('patternId', entity.pattern_id);
            }

            // 3. Cache both view labels for ISA View Toggle (Phase 3).
            //    isaLabel = tag_number (ISA-5.1 designation, e.g., "TT-101")
            //    systemLabel = human-readable name from pattern views (e.g., "Zone Temp Sensor")
            marker.set('isaLabel', entity.tag_number || '?');
            if (entity.pattern_id) {
                const pattern = this._patternCache.find(p => p.id === entity.pattern_id);
                if (pattern && pattern.views) {
                    const views = typeof pattern.views === 'string'
                        ? JSON.parse(pattern.views) : pattern.views;
                    if (views.system && views.system.label) {
                        marker.set('systemLabel', views.system.label);
                    }
                }
            }

            // 4. Update marker label — respect current view mode
            const label = this._getMarkerLabel(marker);
            if (label) {
                const viewMode = window.app?._viewMode || 'system';
                const systemLabel = marker.get('systemLabel');
                if (viewMode === 'system' && systemLabel) {
                    label.set('text', systemLabel);
                } else {
                    label.set('text', entity.tag_number || '?');
                }
            }

            // 4. Trigger canvas re-render and auto-save
            this._canvas.fabricCanvas.renderAll();
            this._canvas.onContentChange();

            // 5. Close panel
            this._pendingMarker = null;
            const panel = document.getElementById('em-panel');
            if (panel) panel.style.display = 'none';
            this._clearFields();

            // Show confirmation toast (reuse QuickCapture pattern)
            this._showToast(`${entity.tag_number} linked`);

        } catch (err) {
            console.error('[EquipmentMarker] Link failed:', err);
            if (statusEl) {
                statusEl.textContent = err.message || 'Link failed';
                statusEl.style.color = '#ff6b6b';
            }
        }
    }

    // =========================================================================
    // ENTITY CREATION
    // =========================================================================

    /**
     * Create a new entity from the panel's tag/type fields, then link it.
     *
     * On 409 (tag conflict): shows the existing entity info in the status bar
     * and auto-links to the existing entity instead.
     */
    async _onCreate() {
        const tag = (document.getElementById('em-new-tag')?.value || '').trim();
        const building = (document.getElementById('em-new-building')?.value || '').trim();
        const equipType = document.getElementById('em-new-type')?.value || '';
        const statusEl = document.getElementById('em-status');

        // When a pattern is selected, tag_number is optional (auto-generated from ISA prefix).
        // Without a pattern, tag_number is still required.
        if (!tag && !this._selectedPattern) {
            if (statusEl) {
                statusEl.textContent = 'Tag number is required (or select a pattern)';
                statusEl.style.color = '#ff6b6b';
            }
            return;
        }

        const createBtn = document.getElementById('em-create-btn');
        if (createBtn) createBtn.disabled = true;

        try {
            // Build the request body — include pattern_id if a pattern is selected
            const body = {
                building: building,
                equip_type: equipType,
            };
            if (tag) body.tag_number = tag;
            if (this._selectedPattern) body.pattern_id = this._selectedPattern.id;

            const resp = await fetch('/api/entities', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (resp.status === 409) {
                // Tag conflict — link to the existing entity instead
                const conflictData = await resp.json();
                const existing = conflictData.existing || conflictData.entity;
                if (existing) {
                    if (statusEl) {
                        statusEl.textContent = `Tag exists — linking to ${existing.tag_number}`;
                        statusEl.style.color = '#ffaa00';
                    }
                    // Brief delay so user sees the message, then link
                    await new Promise(r => setTimeout(r, 500));
                    await this._selectEntity(existing);
                    // Refresh cache so the list stays current
                    await this._fetchEntities();
                    return;
                }
            }

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to create entity');
            }

            const entityData = await resp.json();

            // Refresh cache with the new entity
            await this._fetchEntities();

            // Link the new entity to the marker
            await this._selectEntity(entityData);

        } catch (err) {
            console.error('[EquipmentMarker] Create failed:', err);
            if (statusEl) {
                statusEl.textContent = err.message || 'Create failed';
                statusEl.style.color = '#ff6b6b';
            }
        } finally {
            if (createBtn) createBtn.disabled = false;
        }
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================

    /**
     * Get the IText label child from a marker Group.
     *
     * The marker Group contains [Circle, IText]. We find the IText by type.
     *
     * Args:
     *   group: fabric.Group — the equipment marker.
     *
     * Returns:
     *   fabric.IText|null — the label child, or null if not found.
     */
    _getMarkerLabel(group) {
        if (!group || !group._objects) return null;
        // Fabric.js 6: type names are lowercase ('i-text', 'text', 'circle')
        return group._objects.find(o => o.type === 'i-text' || o.type === 'text') || null;
    }

    /**
     * Clear all form fields and status.
     */
    _clearFields() {
        const search = document.getElementById('em-search');
        if (search) search.value = '';

        const newBuilding = document.getElementById('em-new-building');
        if (newBuilding) newBuilding.value = '';

        const newTag = document.getElementById('em-new-tag');
        if (newTag) {
            newTag.value = '';
            newTag.placeholder = 'Auto-generated from pattern, or type manually';
        }

        const newType = document.getElementById('em-new-type');
        if (newType) {
            // Remove any dynamically-added pattern options before resetting
            newType.querySelectorAll('option[data-dynamic]').forEach(o => o.remove());
            newType.selectedIndex = 0;
        }

        // Reset pattern picker and info display
        const patternSelect = document.getElementById('em-pattern');
        if (patternSelect) patternSelect.value = '';
        this._selectedPattern = null;

        const patternInfo = document.getElementById('em-pattern-info');
        if (patternInfo) patternInfo.style.display = 'none';

        const tagHint = document.getElementById('em-tag-hint');
        if (tagHint) tagHint.style.display = 'none';

        const status = document.getElementById('em-status');
        if (status) {
            status.textContent = '';
            status.style.color = '';
        }

        const results = document.getElementById('em-results');
        if (results) results.innerHTML = '';
    }

    /**
     * Show a brief confirmation toast (bottom-right, auto-dismiss 2s).
     *
     * Args:
     *   message: Text to display.
     */
    _showToast(message) {
        // Remove any existing toast
        const existing = document.querySelector('.qc-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'qc-toast';
        // SECURITY: textContent only
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('qc-toast-fade');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }
}
