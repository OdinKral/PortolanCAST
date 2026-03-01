/**
 * PortolanCAST — RFI Generator Panel Module
 *
 * Purpose:
 *   Generates a formal, numbered RFI (Request for Information) document from
 *   selected markups in the current document. The RFI is the standard construction
 *   industry mechanism for querying the design team about conflicts, omissions, or
 *   items requiring clarification found during review.
 *
 *   Unlike the Review Brief (which groups all markups by type for internal review),
 *   the RFI Generator produces a submission-ready document: numbered items,
 *   formal header block (RFI No, Project, Drawing, To, From), and configurable
 *   filters to include only the markups relevant to the specific query.
 *
 * Architecture:
 *   Calls POST /api/documents/{id}/generate-rfi with:
 *     - pages:   live canvas state (same getAllPageMarkups() payload as Review Brief)
 *     - filters: {types, tags, statuses} from panel controls
 *     - header:  {rfi_no, project, drawing, to, from} from text fields
 *   Renders Markdown to DOM using the same XSS-safe converter as ReviewBrief.
 *   Copy to Clipboard exports raw Markdown for pasting into email or RFI systems.
 *
 * Design principle (Don Norman — Gulf of Evaluation):
 *   The filter controls let users see immediately which markups will be included
 *   before generating — reducing surprises and rework cycles.
 *
 * Security:
 *   - All rendered text uses DOM textContent (never innerHTML) — XSS safe
 *   - Header field values sent as JSON strings; server treats them as text, not HTML
 *   - Raw Markdown written to clipboard only on explicit user action
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-25
 */

// =============================================================================
// RFI GENERATOR PANEL
// =============================================================================

/**
 * Manages the RFI Generator left panel tab.
 *
 * Usage:
 *   const rfi = new RFIGenerator();
 *   rfi.init(canvas);
 *   rfi.docId = 42;       // set by app.js on document load
 *   rfi.generate();       // called by MarkupList when user switches to RFI tab (auto)
 *                         // or by user clicking Generate button
 */
export class RFIGenerator {
    constructor() {
        /**
         * CanvasOverlay instance — needed to gather live page markup data.
         * getAllPageMarkups() serializes the in-memory canvas state.
         * Set by init().
         * @type {import('./canvas.js').CanvasOverlay|null}
         */
        this.canvas = null;

        /**
         * Document ID for the API call.
         * Set by app.js: this.rfiGenerator.docId = info.id in _onDocumentLoaded().
         * @type {number|null}
         */
        this.docId = null;

        /** @type {string} Raw Markdown from last successful generate — used by Copy */
        this._lastMarkdown = '';

        /** @type {boolean} True while a request is in flight (prevents double-generate) */
        this._loading = false;

        // Cached DOM element references — set in init()
        this._els = {};
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the RFI generator panel.
     *
     * Caches DOM references and binds Generate + Copy button handlers.
     * Safe to call once at app startup — panel content changes per document
     * but the DOM structure is static.
     *
     * Args:
     *   canvas: CanvasOverlay instance (must be initialized).
     */
    init(canvas) {
        this.canvas = canvas;

        this._els = {
            content:     document.getElementById('rfi-content'),
            generateBtn: document.getElementById('btn-rfi-generate'),
            copyBtn:     document.getElementById('btn-rfi-copy'),
            // Header input fields
            rfiNo:       document.getElementById('rfi-no'),
            project:     document.getElementById('rfi-project'),
            drawing:     document.getElementById('rfi-drawing'),
            toParty:     document.getElementById('rfi-to'),
            fromParty:   document.getElementById('rfi-from'),
            // Filter controls
            typeFilter:   document.getElementById('rfi-filter-type'),
            tagFilter:    document.getElementById('rfi-filter-tag'),
            statusFilter: document.getElementById('rfi-filter-status'),
        };

        if (!this._els.content) {
            console.warn('[RFIGenerator] #rfi-content not found — panel not initialized');
            return;
        }

        this._els.generateBtn?.addEventListener('click', () => this.generate());
        this._els.copyBtn?.addEventListener('click',     () => this._copyToClipboard());

        this._showPlaceholder('Fill in the header and click Generate.');
        console.log('[RFIGenerator] Panel initialized');
    }

    // =========================================================================
    // GENERATE
    // =========================================================================

    /**
     * Fetch a fresh RFI document from the server and render it.
     *
     * Sends the live canvas state (all pages, including unsaved changes) plus
     * header field values and filter selections to the server. The server
     * generates the RFI Markdown and returns it for rendering.
     *
     * Guarded by _loading flag — concurrent clicks while a request is in flight
     * are silently ignored to avoid duplicate server calls.
     */
    async generate() {
        if (!this.canvas || !this.docId) {
            this._showPlaceholder('No document loaded.');
            return;
        }
        if (this._loading) return;
        this._loading = true;

        // Show loading state immediately — Norman: instant feedback for slow operations
        this._showPlaceholder('Generating RFI…');

        // Snapshot all page markups — serializes the in-memory Fabric canvas state.
        // Same payload format used by auto-save and the Review Brief endpoint.
        const pages = this.canvas.getAllPageMarkups();

        // Build filter object from panel controls
        const filters = this._readFilters();

        // Build header object from text fields
        const header = this._readHeader();

        try {
            const resp = await fetch(`/api/documents/${this.docId}/generate-rfi`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ pages, filters, header }),
            });

            if (!resp.ok) throw new Error(`Server error: ${resp.statusText}`);

            const data = await resp.json();
            this._lastMarkdown = data.markdown || '';
            this._renderMarkdown(this._lastMarkdown);

        } catch (err) {
            console.error('[RFIGenerator] Generate failed:', err);
            this._showPlaceholder('RFI generation failed — see console.');
        } finally {
            this._loading = false;
        }
    }

    /**
     * Read the current filter selections from the panel controls.
     *
     * Returns an object with arrays of selected values. Empty arrays mean
     * "include all" (no restriction) — the server interprets them this way.
     *
     * Returns:
     *   { types: string[], tags: string[], statuses: string[] }
     */
    _readFilters() {
        const typeVal   = this._els.typeFilter?.value   || 'all';
        const statusVal = this._els.statusFilter?.value || 'all';
        const tagRaw    = (this._els.tagFilter?.value   || '').trim().toLowerCase();

        // 'all' means no restriction — pass empty array to server
        const types    = typeVal   !== 'all' ? [typeVal]   : [];
        const statuses = statusVal !== 'all' ? [statusVal] : [];

        // Tag filter: support space/comma-separated list like "structural, urgent"
        const tags = tagRaw
            ? tagRaw.split(/[\s,]+/).map(t => t.replace(/^#/, '')).filter(Boolean)
            : [];

        return { types, tags, statuses };
    }

    /**
     * Read the current header field values from the panel inputs.
     *
     * All fields are optional — empty strings cause the server to
     * substitute em-dash placeholders in the RFI header block.
     *
     * Returns:
     *   { rfi_no, project, drawing, to, from }
     */
    _readHeader() {
        return {
            rfi_no:  (this._els.rfiNo?.value    || '').trim(),
            project: (this._els.project?.value  || '').trim(),
            drawing: (this._els.drawing?.value  || '').trim(),
            to:      (this._els.toParty?.value  || '').trim(),
            from:    (this._els.fromParty?.value || '').trim(),
        };
    }

    // =========================================================================
    // MARKDOWN RENDERING
    // =========================================================================

    /**
     * Render a Markdown string to the RFI content area.
     *
     * Reuses the same minimal, XSS-safe Markdown-to-DOM converter as ReviewBrief.
     * Covers the exact subset produced by _generate_rfi_document() on the server:
     *   # H1 / ## H2 / ### H3     — headings
     *   --- (exactly three dashes) — horizontal rule
     *   - item                     — unordered list item (not used by RFI but supported)
     *   **bold** and *italic*      — parsed by _appendInlineText
     *   blank lines                — end any open list; no element emitted
     *   all other lines            — plain paragraph
     *
     * SECURITY: All text content uses createTextNode (never innerHTML).
     *
     * Args:
     *   md: Markdown string from the server.
     */
    _renderMarkdown(md) {
        const container = this._els.content;
        if (!container) return;

        // Safe DOM clear — avoids the innerHTML = '' shortcut
        while (container.firstChild) container.removeChild(container.firstChild);

        const lines = md.split('\n');
        let inList    = false;
        let currentUl = null;

        for (const line of lines) {

            // Whenever we see a non-blank, non-list line, close the open <ul>
            if (inList && line.trim() && !line.startsWith('- ')) {
                inList    = false;
                currentUl = null;
            }

            if (line.startsWith('### ')) {
                const el = document.createElement('h3');
                el.className = 'brief-h3';
                this._appendInlineText(el, line.slice(4));
                container.appendChild(el);

            } else if (line.startsWith('## ')) {
                const el = document.createElement('h2');
                el.className = 'brief-h2';
                this._appendInlineText(el, line.slice(3));
                container.appendChild(el);

            } else if (line.startsWith('# ')) {
                const el = document.createElement('h1');
                el.className = 'brief-h1';
                this._appendInlineText(el, line.slice(2));
                container.appendChild(el);

            } else if (line.trim() === '---') {
                container.appendChild(document.createElement('hr'));

            } else if (line.startsWith('- ')) {
                if (!inList) {
                    currentUl = document.createElement('ul');
                    currentUl.className = 'brief-list';
                    container.appendChild(currentUl);
                    inList = true;
                }
                const li = document.createElement('li');
                li.className = 'brief-li';
                this._appendInlineText(li, line.slice(2));
                currentUl.appendChild(li);

            } else if (line.trim() === '') {
                inList    = false;
                currentUl = null;

            } else {
                const p = document.createElement('p');
                p.className = 'brief-p';
                this._appendInlineText(p, line);
                container.appendChild(p);
            }
        }
    }

    /**
     * Append inline text with **bold** and *italic* support to a parent element.
     *
     * All text is inserted via createTextNode — never innerHTML.
     * This is the critical XSS guard since the Markdown contains user-authored note text.
     *
     * Args:
     *   parent: DOM element to append into (h1/h2/h3/p/li).
     *   text:   Raw text string that may contain ** and * delimiters.
     */
    _appendInlineText(parent, text) {
        const boldParts = text.split('**');
        boldParts.forEach((part, i) => {
            if (i % 2 === 1) {
                const strong = document.createElement('strong');
                strong.appendChild(document.createTextNode(part));
                parent.appendChild(strong);
            } else {
                const italicParts = part.split('*');
                italicParts.forEach((ipart, j) => {
                    if (j % 2 === 1) {
                        const em = document.createElement('em');
                        em.appendChild(document.createTextNode(ipart));
                        parent.appendChild(em);
                    } else {
                        parent.appendChild(document.createTextNode(ipart));
                    }
                });
            }
        });
    }

    // =========================================================================
    // PLACEHOLDER
    // =========================================================================

    /**
     * Replace the content area with a single muted status message.
     *
     * Args:
     *   message: Status text to display.
     */
    _showPlaceholder(message) {
        const container = this._els.content;
        if (!container) return;
        while (container.firstChild) container.removeChild(container.firstChild);
        const p = document.createElement('p');
        p.className = 'muted-text';
        p.textContent = message;
        container.appendChild(p);
    }

    // =========================================================================
    // CLIPBOARD
    // =========================================================================

    /**
     * Copy the raw Markdown to the system clipboard.
     *
     * The raw Markdown (not the rendered DOM) is what gets copied — making it
     * directly pasteable into RFI systems, email clients, or documentation tools.
     *
     * Falls back gracefully if the Clipboard API is unavailable.
     * Briefly changes the button text to "Copied!" as feedback before resetting.
     */
    async _copyToClipboard() {
        if (!this._lastMarkdown) return;

        try {
            await navigator.clipboard.writeText(this._lastMarkdown);

            if (this._els.copyBtn) {
                const orig = this._els.copyBtn.textContent;
                this._els.copyBtn.textContent = 'Copied!';
                setTimeout(() => { this._els.copyBtn.textContent = orig; }, 1800);
            }
        } catch (err) {
            console.warn('[RFIGenerator] Clipboard write failed:', err);
        }
    }
}
