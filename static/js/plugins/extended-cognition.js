/**
 * PortolanCAST — ExtendedCognition Plugin (EC Brief)
 *
 * Purpose:
 *   First real plugin in PortolanCAST's plugin framework. Synthesizes a plain-English
 *   status briefing of all markups in a document using a local Ollama LLM when
 *   available, or computed statistics as a fallback.
 *
 *   Answers the project-manager question: "Where does this drawing stand?"
 *   without requiring the user to count rows in the Markups tab.
 *
 * Architecture:
 *   1. init(container, app) — renders the shell HTML into the right-panel tab
 *   2. onDocumentLoaded(info) — triggers a summary fetch from the server
 *   3. _fetchSummary() — flushes live canvas page, POSTs to /api/documents/{id}/ai-summary
 *   4. _renderSummary(data) — displays narrative text + per-type stat rows
 *
 * Lifecycle:
 *   - Panel shows "Open a document..." placeholder before a doc is loaded
 *   - After doc load: spinner → AI brief (or computed fallback) + stat rows
 *   - Refresh button: re-runs the fetch (picks up newly-added markups)
 *
 * Security assumptions:
 *   - Ollama runs on localhost only (no external network call from browser)
 *   - All LLM calls are server-side; this file only talks to the local FastAPI
 *   - No user-provided content is eval'd or injected as HTML (textContent only)
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-02-23
 */

// =============================================================================
// TYPE METADATA — icons and display labels for each markup type
// Must stay in sync with MARKUP_COLORS in canvas.js
// =============================================================================

const TYPE_META = {
    issue:    { icon: '●', label: 'Issues',    cls: 'ec-type-issue'    },
    question: { icon: '?', label: 'Questions', cls: 'ec-type-question' },
    approval: { icon: '✓', label: 'Approvals', cls: 'ec-type-approval' },
    change:   { icon: '↔', label: 'Changes',   cls: 'ec-type-change'   },
    note:     { icon: '·', label: 'Notes',     cls: 'ec-type-note'     },
};

// =============================================================================
// PLUGIN MANIFEST
// =============================================================================

/**
 * ExtendedCognitionPlugin — plain object manifest (not a class).
 * The PluginLoader registers this singleton; state lives directly on the object.
 * init() is called once; onDocumentLoaded() is called on every document load.
 */
export const ExtendedCognitionPlugin = {
    name: 'extended-cognition',
    label: 'EC Brief',
    version: '1.0.0',

    // State injected by PluginLoader.register()
    _container: null,
    _app: null,
    _docInfo: null,

    // =========================================================================
    // LIFECYCLE HOOKS (called by PluginLoader)
    // =========================================================================

    /**
     * Called once when the plugin is registered.
     * Renders the panel shell into the container div provided by PluginLoader.
     *
     * Args:
     *   container: The #tab-plugin-extended-cognition div in the right panel.
     *   app:       The App instance (window.app).
     */
    init(container, app) {
        this._container = container;
        this._app = app;
        this._renderShell();
    },

    /**
     * Called by PluginLoader when a new document finishes loading.
     * Stores doc info and triggers a fresh summary fetch.
     *
     * Args:
     *   info: Document info object from the server
     *         { id, filename, page_count, file_size, page_sizes }
     */
    onDocumentLoaded(info) {
        this._docInfo = info;
        this._fetchSummary();
    },

    // =========================================================================
    // PRIVATE — SHELL RENDERING
    // =========================================================================

    /**
     * Render the static panel shell with placeholder state.
     * Called once in init(); subsequent updates replace inner element contents only.
     *
     * HTML structure injected into container:
     *   #ec-narrative  — narrative text area (briefing or placeholder)
     *   #ec-stats      — per-type stat rows (hidden until doc loads)
     *   #ec-footer     — Refresh button + mode badge (hidden until doc loads)
     */
    _renderShell() {
        if (!this._container) return;

        // SECURITY: use textContent (never innerHTML with user data) for dynamic content.
        // The shell itself uses a safe literal template.
        this._container.innerHTML = `
            <div id="ec-narrative" class="ec-narrative ec-empty">
                Open a document to generate a brief.
            </div>
            <div id="ec-stats" class="ec-stats" style="display:none"></div>
            <div id="ec-footer" class="ec-footer" style="display:none">
                <button id="ec-refresh" class="toolbar-btn ec-refresh-btn">↺ Refresh</button>
                <span id="ec-mode-badge" class="ec-mode-badge"></span>
            </div>
        `;

        // Bind Refresh button — re-fetches summary with latest markups
        const refreshBtn = this._container.querySelector('#ec-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this._fetchSummary());
        }
    },

    // =========================================================================
    // PRIVATE — SUMMARY FETCH
    // =========================================================================

    /**
     * Fetch a summary from the server for the current document.
     *
     * Flow:
     *   1. Flush live canvas page to in-memory store (avoid losing unsaved markups)
     *   2. Collect all page markups
     *   3. Show spinner
     *   4. POST to /api/documents/{id}/ai-summary
     *   5. Render result or error
     *
     * The server returns:
     *   { summary, stats, mode: 'ai'|'computed', model: 'mistral:7b'|null }
     */
    async _fetchSummary() {
        if (!this._docInfo || !this._app) return;

        // Flush the live page so freshly-drawn markups are included in the payload.
        // Without this flush, the current page's objects stay in Fabric's in-memory
        // canvas and aren't captured in canvas.pageMarkups yet.
        this._app.canvas.onPageChanging(this._app.lastPage);
        const pages = this._app.canvas.getAllPageMarkups();

        this._showSpinner();

        try {
            const resp = await fetch(`/api/documents/${this._docInfo.id}/ai-summary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });

            if (!resp.ok) {
                throw new Error(`Server error: ${resp.status} ${resp.statusText}`);
            }

            const data = await resp.json();
            this._renderSummary(data);
        } catch (err) {
            this._renderError(err.message || 'Failed to load summary');
        }
    },

    // =========================================================================
    // PRIVATE — UI STATE HELPERS
    // =========================================================================

    /**
     * Show a loading spinner text in the narrative area while fetching.
     */
    _showSpinner() {
        const narrative = this._container?.querySelector('#ec-narrative');
        if (narrative) {
            narrative.className = 'ec-narrative ec-loading';
            narrative.textContent = 'Generating brief…';
        }

        // Hide stats and footer while loading
        const stats = this._container?.querySelector('#ec-stats');
        const footer = this._container?.querySelector('#ec-footer');
        if (stats) stats.style.display = 'none';
        if (footer) footer.style.display = 'none';
    },

    /**
     * Render an error state in the narrative area.
     *
     * Args:
     *   message: Human-readable error string.
     */
    _renderError(message) {
        const narrative = this._container?.querySelector('#ec-narrative');
        if (narrative) {
            narrative.className = 'ec-narrative ec-error';
            // SECURITY: textContent prevents XSS — error messages come from
            // our own server or fetch API, but we still use safe assignment
            narrative.textContent = `Error: ${message}`;
        }
    },

    // =========================================================================
    // PRIVATE — SUMMARY RENDERING
    // =========================================================================

    /**
     * Render the full summary panel: narrative text + stat rows + footer badge.
     *
     * Args:
     *   data: Response object from /api/documents/{id}/ai-summary
     *         { summary, stats, mode: 'ai'|'computed', model }
     */
    _renderSummary(data) {
        if (!this._container) return;

        // ── Narrative text ──────────────────────────────────────────────────
        const narrative = this._container.querySelector('#ec-narrative');
        if (narrative) {
            narrative.className = 'ec-narrative';
            // SECURITY: textContent — never innerHTML — for AI-generated content
            narrative.textContent = data.summary || 'No summary available.';
        }

        // ── Per-type stat rows ───────────────────────────────────────────────
        const statsEl = this._container.querySelector('#ec-stats');
        if (statsEl) {
            statsEl.style.display = '';
            this._renderStats(data.stats || {}, statsEl);
        }

        // ── Footer: Refresh + mode badge ────────────────────────────────────
        const footer = this._container.querySelector('#ec-footer');
        if (footer) {
            footer.style.display = '';
        }

        const badge = this._container.querySelector('#ec-mode-badge');
        if (badge) {
            if (data.mode === 'ai' && data.model) {
                badge.className = 'ec-mode-badge ec-mode-ai';
                // ⚡ signals AI-generated text (fast and smart)
                badge.textContent = `⚡ ${data.model}`;
            } else {
                badge.className = 'ec-mode-badge';
                // ≈ signals computed/estimated (not AI)
                badge.textContent = '≈ Computed';
            }
        }
    },

    /**
     * Render per-type markup count rows into the stats container.
     *
     * Only renders types with count > 0. Shows "No markups yet" if all zero.
     * Each row: [icon] [label] [count]
     *
     * Args:
     *   stats:     The stats object from the server { byType, byStatus, total, ... }
     *   container: The #ec-stats DOM element to render into.
     */
    _renderStats(stats, container) {
        container.innerHTML = '';

        const byType = stats.byType || {};
        const types = Object.keys(TYPE_META);
        const hasAny = types.some(t => (byType[t] || 0) > 0);

        if (!hasAny) {
            // Empty state — show muted "no markups" row
            const emptyRow = document.createElement('div');
            emptyRow.className = 'ec-stat-row ec-muted';
            emptyRow.textContent = 'No markups yet';
            container.appendChild(emptyRow);
            return;
        }

        for (const type of types) {
            const count = byType[type] || 0;
            if (count === 0) continue; // skip zero-count types

            const meta = TYPE_META[type];

            const row = document.createElement('div');
            row.className = 'ec-stat-row';
            row.dataset.type = type; // allow tests to find rows by type

            const iconEl = document.createElement('span');
            iconEl.className = `ec-stat-icon ${meta.cls}`;
            iconEl.textContent = meta.icon;

            const labelEl = document.createElement('span');
            labelEl.className = 'ec-stat-label';
            labelEl.textContent = meta.label;

            const countEl = document.createElement('span');
            countEl.className = 'ec-stat-count';
            countEl.textContent = count;

            row.appendChild(iconEl);
            row.appendChild(labelEl);
            row.appendChild(countEl);
            container.appendChild(row);
        }
    },
};
