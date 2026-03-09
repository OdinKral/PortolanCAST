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

        // Fetch entity list (cached per open — cheap enough for small entity counts)
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
            return tag.includes(q) || type.includes(q);
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
            tagSpan.textContent = entity.tag_number || '(no tag)';

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

            // 2. Update marker label to entity tag_number
            const label = this._getMarkerLabel(marker);
            if (label) {
                label.set('text', entity.tag_number || '?');
            }

            // 3. Set entityId on the Group for serialization persistence
            marker.set('entityId', entity.id);

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
        const equipType = document.getElementById('em-new-type')?.value || '';
        const statusEl = document.getElementById('em-status');

        // SECURITY: validate required field
        if (!tag) {
            if (statusEl) {
                statusEl.textContent = 'Tag number is required';
                statusEl.style.color = '#ff6b6b';
            }
            return;
        }

        const createBtn = document.getElementById('em-create-btn');
        if (createBtn) createBtn.disabled = true;

        try {
            const resp = await fetch('/api/entities', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tag_number: tag,
                    equip_type: equipType,
                }),
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

        const newTag = document.getElementById('em-new-tag');
        if (newTag) newTag.value = '';

        const newType = document.getElementById('em-new-type');
        if (newType) newType.selectedIndex = 0;

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
