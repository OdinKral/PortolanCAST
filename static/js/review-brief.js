/**
 * PortolanCAST — Review Brief Panel Module
 *
 * Purpose:
 *   Generates and displays a structured Markdown review brief for the current
 *   document. The brief groups annotation markups by type (issue > question >
 *   change > note > approval), open before resolved, sorted by page number.
 *
 *   This is the "structured output" half of the knowledge loop:
 *     Mark up (structured input) → Review Brief (structured output)
 *   The brief becomes the source document for RFIs, review letters, punch lists.
 *
 * Architecture:
 *   Calls POST /api/documents/{id}/review-brief with the live canvas pages data.
 *   Renders Markdown to DOM using a minimal, XSS-safe converter (no innerHTML).
 *   Copy to Clipboard exports raw Markdown for pasting into external tools.
 *
 * Design principle (Cal Newport — minimalism + Don Norman — feedback):
 *   One button, one output. Refresh on demand. Copy when needed.
 *   No automatic refresh — users control when the brief is generated so active
 *   markup work is not interrupted by background computation.
 *   The Copy button gives immediate tactile feedback ("Copied!") before resetting.
 *
 * Security:
 *   - All rendered text uses DOM textContent (never innerHTML) — XSS safe
 *   - Raw Markdown written to clipboard only on explicit user action
 *   - No external scripts or libraries required
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-25
 */

// =============================================================================
// REVIEW BRIEF PANEL
// =============================================================================

/**
 * Manages the Review Brief left panel tab.
 *
 * Usage:
 *   const brief = new ReviewBrief();
 *   brief.init(canvas);
 *   brief.docId = 42;         // set by app.js on document load
 *   brief.refresh();          // called by MarkupList when user switches to Brief tab
 */
export class ReviewBrief {
    constructor() {
        /**
         * CanvasOverlay instance — needed to gather live page markup data
         * (getAllPagesData() serializes the in-memory canvas state).
         * Set by init().
         * @type {import('./canvas.js').CanvasOverlay|null}
         */
        this.canvas = null;

        /**
         * Document ID for the API call.
         * Set by app.js: this.reviewBrief.docId = info.id in _onDocumentLoaded().
         * @type {number|null}
         */
        this.docId = null;

        /** @type {string} Raw Markdown from last successful refresh — used by Copy */
        this._lastMarkdown = '';

        /** @type {boolean} True while a request is in flight (prevents double-refresh) */
        this._loading = false;

        // Cached DOM element references — set in init()
        this._els = {};
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the review brief panel.
     *
     * Caches DOM references and binds Refresh + Copy button handlers.
     * Safe to call once at app startup — panel content changes per document
     * but the DOM structure is static.
     *
     * Args:
     *   canvas: CanvasOverlay instance (must be initialized).
     */
    init(canvas) {
        this.canvas = canvas;

        this._els = {
            content:    document.getElementById('brief-content'),
            timestamp:  document.getElementById('brief-timestamp'),
            refreshBtn: document.getElementById('btn-brief-refresh'),
            copyBtn:    document.getElementById('btn-brief-copy'),
            openCount:  document.getElementById('brief-open-count'),
        };

        if (!this._els.content) {
            console.warn('[ReviewBrief] #brief-content not found — panel not initialized');
            return;
        }

        this._els.refreshBtn?.addEventListener('click', () => this.refresh());
        this._els.copyBtn?.addEventListener('click',   () => this._copyToClipboard());

        this._showPlaceholder('Click Refresh to generate the review brief.');
        console.log('[ReviewBrief] Panel initialized');
    }

    // =========================================================================
    // REFRESH
    // =========================================================================

    /**
     * Fetch a fresh review brief from the server and render it.
     *
     * Sends the live canvas state (all pages, including unsaved changes) to the
     * server so the brief reflects the current working session — not just what
     * was last auto-saved to the database.
     *
     * Guarded by _loading flag — concurrent clicks while a request is in flight
     * are silently ignored to avoid duplicate server calls.
     */
    async refresh() {
        if (!this.canvas || !this.docId) {
            this._showPlaceholder('No document loaded.');
            return;
        }
        if (this._loading) return;
        this._loading = true;

        // Show loading state immediately — Norman: instant feedback for slow operations
        this._showPlaceholder('Generating brief…');

        // Snapshot all page markups — serializes the in-memory Fabric canvas state.
        // Same payload format used by auto-save and the AI summary (EC) endpoints.
        const pages = this.canvas.getAllPageMarkups();

        try {
            const resp = await fetch(`/api/documents/${this.docId}/review-brief`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ pages }),
            });

            if (!resp.ok) throw new Error(`Server error: ${resp.statusText}`);

            const data = await resp.json();
            this._lastMarkdown = data.markdown || '';
            this._renderMarkdown(this._lastMarkdown);

            // Update header: timestamp + open-item badge
            const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            if (this._els.timestamp) {
                this._els.timestamp.textContent = `Updated ${now}`;
            }
            if (this._els.openCount) {
                const open = data.open ?? 0;
                this._els.openCount.textContent = open > 0 ? `${open} open` : '';
                this._els.openCount.style.display = open > 0 ? '' : 'none';
            }

        } catch (err) {
            console.error('[ReviewBrief] Refresh failed:', err);
            this._showPlaceholder('Brief generation failed — see console.');
        } finally {
            this._loading = false;
        }
    }

    // =========================================================================
    // MARKDOWN RENDERING
    // =========================================================================

    /**
     * Render a Markdown string to the brief content area.
     *
     * Implements a minimal, XSS-safe Markdown-to-DOM converter covering the
     * exact subset produced by _generate_review_brief() on the server:
     *   # H1 / ## H2 / ### H3     — headings
     *   --- (exactly three dashes) — horizontal rule
     *   - item                     — unordered list item
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
                // Unordered list item — create <ul> container on first item
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
                // Blank line — end any open list; no DOM node emitted
                inList    = false;
                currentUl = null;

            } else {
                // Regular paragraph
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
     * Splits the text on ** boundaries first, then * within non-bold segments.
     * All text is inserted via createTextNode — never innerHTML. This is the
     * critical XSS guard since the Markdown contains user-authored note text.
     *
     * Args:
     *   parent: DOM element to append into (h1/h2/h3/p/li).
     *   text:   Raw text string that may contain ** and * delimiters.
     */
    _appendInlineText(parent, text) {
        // Split on **...** — odd-indexed parts are inside bold delimiters
        const boldParts = text.split('**');
        boldParts.forEach((part, i) => {
            if (i % 2 === 1) {
                // Inside **bold**
                const strong = document.createElement('strong');
                strong.appendChild(document.createTextNode(part));
                parent.appendChild(strong);
            } else {
                // Outside bold — scan for *italic*
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
     * Used for loading state, empty state, and error state. Clears any
     * previously rendered Markdown.
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
     * Falls back gracefully if the Clipboard API is unavailable (non-HTTPS or
     * browser permission denied). Briefly changes the button text to "Copied!"
     * as Norman-style confirmation feedback before resetting.
     */
    async _copyToClipboard() {
        if (!this._lastMarkdown) return;

        try {
            await navigator.clipboard.writeText(this._lastMarkdown);

            // Brief tactile feedback — Norman: visibility of system status
            if (this._els.copyBtn) {
                const orig = this._els.copyBtn.textContent;
                this._els.copyBtn.textContent = 'Copied!';
                setTimeout(() => { this._els.copyBtn.textContent = orig; }, 1800);
            }
        } catch (err) {
            console.warn('[ReviewBrief] Clipboard write failed:', err);
        }
    }
}
