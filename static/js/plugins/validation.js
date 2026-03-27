/**
 * PortolanCAST — Validation Plugin (Haystack Phase 4)
 *
 * Purpose:
 *   Right-panel plugin that scans the entity graph for a document and
 *   reports incomplete control loops, orphan sensors, and missing
 *   connections. Pattern constraints define the rules — the backend
 *   enforces them, this plugin displays the results.
 *
 * Architecture:
 *   1. init(container, app) — renders panel shell (summary bar + button + list)
 *   2. onDocumentLoaded(info) — stores doc info, resets findings
 *   3. _runValidation() — POSTs to /api/documents/{docId}/validate
 *   4. _renderFindings(data) — populates finding cards from response
 *   5. Click handler — navigates to finding's page + selects entity marker
 *
 * Security assumptions:
 *   - doc_id comes from the app's current document (trusted internal state)
 *   - API response is JSON from our own server (no XSS risk in textContent)
 *
 * Author: PortolanCAST
 * Date: 2026-03-26
 */

export const ValidationPlugin = {
    name: 'validation',
    label: 'Validate',
    version: '1.0.0',

    // State set in init()
    _container: null,
    _app: null,
    _docId: null,

    // =========================================================================
    // LIFECYCLE HOOKS (called by PluginLoader)
    // =========================================================================

    /**
     * Called once when the plugin is registered.
     * Renders the panel shell: summary bar, Validate button, findings list.
     *
     * Args:
     *   container: The #tab-plugin-validation div in the right panel.
     *   app:       The App instance (window.app).
     */
    init(container, app) {
        this._container = container;
        this._app = app;
        this._renderShell();
    },

    /**
     * Called when a document is loaded or switched.
     * Stores the document ID and resets the findings display.
     *
     * Args:
     *   info: Document info object { id, filename, page_count, ... }
     */
    onDocumentLoaded(info) {
        this._docId = info?.id || null;
        this._resetFindings();
    },

    // =========================================================================
    // SHELL RENDERING
    // =========================================================================

    /**
     * Build the static panel HTML: summary bar + validate button + scrollable
     * findings container. Wires the button click handler.
     */
    _renderShell() {
        this._container.innerHTML = `
            <div class="validation-header">
                <span class="validation-status-text" id="validation-status">
                    Ready to validate
                </span>
            </div>
            <button class="btn btn-sm validation-run-btn" id="validation-run-btn">
                ▶ Validate
            </button>
            <div class="validation-summary" id="validation-summary" style="display:none;"></div>
            <div class="validation-findings" id="validation-findings"></div>
        `;

        // Wire the Validate button
        const btn = this._container.querySelector('#validation-run-btn');
        btn.addEventListener('click', () => this._runValidation());
    },

    // =========================================================================
    // VALIDATION EXECUTION
    // =========================================================================

    /**
     * POST to the validation endpoint, then render findings.
     * Disables the button during the request to prevent double-fire.
     */
    async _runValidation() {
        if (!this._docId) return;

        const btn = this._container.querySelector('#validation-run-btn');
        const status = this._container.querySelector('#validation-status');
        btn.disabled = true;
        btn.textContent = '⏳ Validating…';
        status.textContent = 'Scanning entity graph…';

        try {
            const resp = await fetch(`/api/documents/${this._docId}/validate`, {
                method: 'POST',
            });
            if (!resp.ok) {
                throw new Error(`Server returned ${resp.status}`);
            }
            const data = await resp.json();
            this._renderFindings(data);
        } catch (err) {
            status.textContent = `Validation failed: ${err.message}`;
            status.className = 'validation-status-text validation-status-error';
        } finally {
            btn.disabled = false;
            btn.textContent = '▶ Validate';
        }
    },

    // =========================================================================
    // FINDINGS DISPLAY
    // =========================================================================

    /**
     * Render the summary bar and individual finding cards.
     *
     * Summary shows entity count + colored counts (errors/warnings/info/pass).
     * Each finding is a clickable card with severity icon, message, and tag.
     *
     * Args:
     *   data: { findings: [...], summary: { entities_checked, errors, warnings, info, pass } }
     */
    _renderFindings(data) {
        const { findings, summary } = data;
        const statusEl = this._container.querySelector('#validation-status');
        const summaryEl = this._container.querySelector('#validation-summary');
        const listEl = this._container.querySelector('#validation-findings');

        // Summary bar
        if (summary.errors === 0 && summary.warnings === 0) {
            statusEl.textContent = 'All checks passed';
            statusEl.className = 'validation-status-text validation-status-pass';
        } else if (summary.errors > 0) {
            statusEl.textContent = `${summary.errors} error${summary.errors > 1 ? 's' : ''} found`;
            statusEl.className = 'validation-status-text validation-status-error';
        } else {
            statusEl.textContent = `${summary.warnings} warning${summary.warnings > 1 ? 's' : ''}`;
            statusEl.className = 'validation-status-text validation-status-warn';
        }

        // Counts breakdown
        summaryEl.style.display = '';
        summaryEl.innerHTML = `
            <span class="validation-count">${summary.entities_checked} entities</span>
            <span class="validation-count vc-error">${summary.errors} errors</span>
            <span class="validation-count vc-warn">${summary.warnings} warnings</span>
            <span class="validation-count vc-info">${summary.info} info</span>
            <span class="validation-count vc-pass">${summary.pass} pass</span>
        `;

        // Finding cards
        listEl.innerHTML = '';
        if (findings.length === 0) {
            listEl.innerHTML = '<div class="validation-empty">No findings — all entities valid.</div>';
            return;
        }

        for (const f of findings) {
            const card = document.createElement('div');
            card.className = `validation-finding-card validation-finding-${f.severity}`;
            card.dataset.entityId = f.entity_id;
            card.dataset.pageNumber = f.page_number;
            card.dataset.docId = f.doc_id;

            // Severity icons: ✖ error, ⚠ warning, ℹ info
            const icon = f.severity === 'error' ? '✖'
                : f.severity === 'warning' ? '⚠' : 'ℹ';

            card.innerHTML = `
                <span class="validation-finding-icon">${icon}</span>
                <span class="validation-finding-msg">${this._escapeHtml(f.message)}</span>
                <span class="validation-finding-tag">${this._escapeHtml(f.entity_tag)}</span>
            `;

            // Click to navigate: go to page, then select the entity's marker
            card.addEventListener('click', () => this._navigateToFinding(f));
            listEl.appendChild(card);
        }
    },

    /**
     * Reset the findings panel to its initial state.
     * Called on document load/switch so stale findings don't persist.
     */
    _resetFindings() {
        const status = this._container.querySelector('#validation-status');
        const summary = this._container.querySelector('#validation-summary');
        const list = this._container.querySelector('#validation-findings');
        if (status) {
            status.textContent = 'Ready to validate';
            status.className = 'validation-status-text';
        }
        if (summary) {
            summary.style.display = 'none';
            summary.innerHTML = '';
        }
        if (list) list.innerHTML = '';
    },

    // =========================================================================
    // NAVIGATION
    // =========================================================================

    /**
     * Navigate to a finding's page and select its equipment marker.
     *
     * Uses the same pattern as nodeCAST: viewer.goToPage() triggers canvas
     * reload, then setTimeout waits for markups to load before selecting.
     *
     * Args:
     *   finding: Finding dict with entity_id, page_number, doc_id.
     */
    _navigateToFinding(finding) {
        const viewer = this._app?.viewer;
        if (!viewer) return;

        const currentPage = viewer.getCurrentPage?.() || 1;
        const targetPage = finding.page_number || 1;

        // Navigate to the target page (if needed)
        if (currentPage !== targetPage) {
            viewer.goToPage(targetPage);
        }

        // After page navigation + canvas load, find and select the entity's marker.
        // We search by entityId on the equipment marker, not markupId.
        setTimeout(() => {
            const fc = this._app?.canvas?.fabricCanvas;
            if (!fc) return;

            const marker = fc.getObjects().find(obj =>
                obj.markupType === 'equipment-marker' &&
                obj.entityId === finding.entity_id
            );

            if (marker) {
                fc.setActiveObject(marker);
                fc.renderAll();
            }
        }, 500);
    },

    // =========================================================================
    // UTILITIES
    // =========================================================================

    /**
     * Escape HTML entities to prevent XSS when inserting server text.
     * Defense-in-depth: server data is trusted, but belt-and-suspenders.
     */
    _escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;');
    },
};
