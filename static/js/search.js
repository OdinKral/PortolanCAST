/**
 * PortolanCAST — Global Search Panel Module
 *
 * Purpose:
 *   Provides full-text search across all documents (by filename) and markup
 *   content (by markupNote, markupType, markupAuthor). Results are clickable
 *   — document hits navigate to /edit/{id}, markup hits navigate to the
 *   correct page within the current or a different document.
 *
 * Architecture:
 *   Calls GET /api/search?q= (300ms debounce) and renders result rows in
 *   the #search-results container. Navigation callbacks are wired by app.js
 *   so this module has no direct dependency on the viewer or canvas.
 *
 * Design principle (Norman — feedback):
 *   Search must feel instant. The 300ms debounce balances server load against
 *   perceived responsiveness. Results render incrementally as the user types.
 *
 * Security:
 *   - Query is encoded via encodeURIComponent before insertion into the URL
 *   - All result text is rendered via textContent (never innerHTML) — XSS safe
 *   - Server enforces a 200-char query length cap
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-25
 */

// =============================================================================
// SEARCH PANEL
// =============================================================================

/**
 * Manages the global search tab in the left panel.
 *
 * Usage:
 *   const search = new SearchPanel();
 *   search.init();
 *   search.onNavigate = (docId, pageNumber) => { ... };
 */
export class SearchPanel {
    constructor() {
        /**
         * Called when the user clicks a markup hit on a different document
         * or a same-document markup hit. Args: (docId: int, pageNumber: int).
         * @type {Function|null}
         */
        this.onNavigate = null;

        /** @type {number|null} Debounce timer for input */
        this._searchTimer = null;

        /** @type {string} Last query sent to avoid duplicate requests */
        this._lastQuery = '';

        // Cached DOM element references — set in init()
        this._els = {};
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the search panel.
     *
     * Caches DOM references and binds input event handlers. Safe to call
     * once at app startup — the search panel is document-independent and
     * does not need rebinding when documents are loaded.
     */
    init() {
        this._els = {
            input:   document.getElementById('search-input'),
            results: document.getElementById('search-results'),
            count:   document.getElementById('search-count'),
        };

        if (!this._els.input) {
            console.warn('[Search] #search-input not found — panel not initialized');
            return;
        }

        // Debounce: wait 300ms after last keystroke before searching.
        // Avoids hammering the server on rapid typing.
        this._els.input.addEventListener('input', () => {
            if (this._searchTimer) clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => this._doSearch(), 300);
        });

        // Enter key: search immediately (cancels pending debounce)
        this._els.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (this._searchTimer) clearTimeout(this._searchTimer);
                this._doSearch();
            }
        });

        console.log('[Search] Panel initialized');
    }

    // =========================================================================
    // SEARCH EXECUTION
    // =========================================================================

    /**
     * Execute the search against the server and render results.
     *
     * No-ops if the query is identical to the last sent query (prevents
     * duplicate requests when the user types and then Enters without change).
     */
    async _doSearch() {
        const q = (this._els.input?.value || '').trim();

        // Avoid duplicate requests for the same query
        if (q === this._lastQuery) return;
        this._lastQuery = q;

        if (!q) {
            this._renderResults([]);
            return;
        }

        try {
            const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
            if (!resp.ok) throw new Error(`Search request failed: ${resp.statusText}`);
            const data = await resp.json();
            this._renderResults(data.results || []);
        } catch (err) {
            console.error('[Search] Request failed:', err);
            if (this._els.results) {
                this._els.results.textContent = 'Search unavailable — see console';
            }
        }
    }

    // =========================================================================
    // RESULT RENDERING
    // =========================================================================

    /**
     * Render a list of search result rows into the results container.
     *
     * Each result is a clickable row showing a type badge, document name,
     * optional page reference, and a context excerpt.
     *
     * Args:
     *   results: Array of result objects from GET /api/search.
     */
    _renderResults(results) {
        const container = this._els.results;
        if (!container) return;

        // Update result count label
        if (this._els.count) {
            this._els.count.textContent = results.length > 0
                ? `${results.length} result${results.length !== 1 ? 's' : ''}`
                : '';
        }

        // Clear previous results using DOM — avoids trusting innerHTML
        while (container.firstChild) container.removeChild(container.firstChild);

        if (results.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'muted-text';
            // Show different hint depending on whether a query is active
            empty.textContent = this._lastQuery
                ? 'No results found'
                : 'Type to search across documents and markups';
            container.appendChild(empty);
            return;
        }

        for (const r of results) {
            container.appendChild(this._buildResultRow(r));
        }
    }

    /**
     * Build a single result row DOM element.
     *
     * Args:
     *   r: Result object { entity_type, doc_id, doc_name, page_number,
     *                       match_field, match_text, context }
     *
     * Returns:
     *   HTMLDivElement — the clickable result row.
     */
    _buildResultRow(r) {
        const row = document.createElement('div');
        row.className = 'search-result-row';

        // Type badge — "Doc" or "Markup"
        const badge = document.createElement('span');
        badge.className = `search-result-badge search-badge-${r.entity_type}`;
        badge.textContent = r.entity_type === 'document' ? 'Doc' : 'Markup';
        row.appendChild(badge);

        // Document name
        const docName = document.createElement('span');
        docName.className = 'search-result-docname';
        docName.textContent = r.doc_name;
        row.appendChild(docName);

        // Page number for markup hits (1-indexed display)
        if (r.page_number != null) {
            const pageSpan = document.createElement('span');
            pageSpan.className = 'search-result-page';
            pageSpan.textContent = `p.${r.page_number + 1}`;
            row.appendChild(pageSpan);
        }

        // Context excerpt — note text or field:value summary
        if (r.context) {
            const ctx = document.createElement('div');
            ctx.className = 'search-result-context';
            ctx.textContent = r.context;  // SECURITY: textContent, never innerHTML
            row.appendChild(ctx);
        }

        row.addEventListener('click', () => this._onResultClick(r));
        return row;
    }

    // =========================================================================
    // NAVIGATION
    // =========================================================================

    /**
     * Handle a result row click — navigate to the matching document or page.
     *
     * Document hits: full navigation to /edit/{doc_id}.
     * Markup hits on the current document: delegate to onNavigate callback
     *   (app.js wires this to viewer.goToPage for same-doc navigation).
     * Markup hits on a different document: full navigation to /edit/{doc_id}.
     *
     * Note: Markup hits navigate to the PAGE only — object-level selection
     * (highlighting the specific object on canvas) is a Phase 2 enhancement
     * that requires matching markupId after page load.
     *
     * Args:
     *   r: Result object from the server.
     */
    _onResultClick(r) {
        if (r.entity_type === 'document') {
            window.location.href = `/edit/${r.doc_id}`;
        } else if (this.onNavigate) {
            // Delegate to app.js — it knows the current docId and can
            // distinguish same-doc vs cross-doc navigation
            this.onNavigate(r.doc_id, r.page_number);
        }
    }
}
