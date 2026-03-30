/**
 * PortolanCAST — Find & Replace
 *
 * Purpose:
 *   Search and replace text across all markup objects on the current page.
 *   Matches against both visible text content (IText/Textbox .text) and
 *   markup note metadata (.markupNote). Highlights matched objects and
 *   provides prev/next navigation.
 *
 * Architecture:
 *   Modal-based UI. Ctrl+H opens. Searches fabric canvas objects on the
 *   current page only (cross-page search would require deserializing saved
 *   markup JSON from all pages — deferred to a future version).
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-03-30
 */

// =============================================================================
// FIND & REPLACE CLASS
// =============================================================================

/**
 * Find and replace text in canvas markup objects.
 *
 * Usage:
 *   const fr = new FindReplace();
 *   fr.init(canvasOverlay);
 *   fr.open();
 */
export class FindReplace {
    constructor() {
        /** @type {import('./canvas.js').CanvasOverlay|null} */
        this.canvas = null;
        /** @type {boolean} */
        this._initialized = false;
        /** @type {Array<{obj: fabric.Object, prop: string}>} Current match list */
        this._matches = [];
        /** @type {number} Index of currently highlighted match */
        this._currentIndex = -1;
        /** @type {string|null} Original stroke color of the highlighted object */
        this._highlightOriginalStroke = null;
    }

    /**
     * Initialize Find & Replace. Call once after canvas is ready.
     *
     * Args:
     *   canvas: CanvasOverlay instance
     */
    init(canvas) {
        if (this._initialized) return;
        this._initialized = true;
        this.canvas = canvas;
        this._bindControls();
        console.log('[FindReplace] Initialized');
    }

    // =========================================================================
    // MODAL OPEN / CLOSE
    // =========================================================================

    /** Open the Find & Replace modal and focus the find input. */
    open() {
        const modal = document.getElementById('modal-find-replace');
        const overlay = document.getElementById('modal-find-replace-overlay');
        if (!modal) return;

        modal.style.display = 'block';
        if (overlay) overlay.style.display = 'block';

        // Focus find input and select existing text for quick re-search
        const findInput = document.getElementById('find-input');
        if (findInput) {
            findInput.focus();
            findInput.select();
        }

        // Clear previous results
        this._matches = [];
        this._currentIndex = -1;
        this._updateMatchCount();
    }

    /** Close the modal and clear highlights. */
    close() {
        const modal = document.getElementById('modal-find-replace');
        const overlay = document.getElementById('modal-find-replace-overlay');
        if (modal) modal.style.display = 'none';
        if (overlay) overlay.style.display = 'none';

        this._clearHighlight();
        this._matches = [];
        this._currentIndex = -1;
    }

    // =========================================================================
    // SEARCH
    // =========================================================================

    /**
     * Search all text-bearing objects on the current canvas for the query string.
     * Populates this._matches with {obj, prop} entries.
     *
     * Args:
     *   query: Search string (empty = clear results)
     *   caseSensitive: If true, match case exactly
     */
    _search(query, caseSensitive = false) {
        this._clearHighlight();
        this._matches = [];
        this._currentIndex = -1;

        if (!query || !this.canvas?.fabricCanvas) {
            this._updateMatchCount();
            return;
        }

        const fc = this.canvas.fabricCanvas;
        const normalize = caseSensitive ? (s) => s : (s) => s.toLowerCase();
        const needle = normalize(query);

        for (const obj of fc.getObjects()) {
            // Check visible text (IText, Textbox)
            if (typeof obj.text === 'string' && normalize(obj.text).includes(needle)) {
                this._matches.push({ obj, prop: 'text' });
                continue;  // Don't double-match same object
            }
            // Check markup note metadata
            if (typeof obj.markupNote === 'string' && normalize(obj.markupNote).includes(needle)) {
                this._matches.push({ obj, prop: 'markupNote' });
            }
        }

        this._updateMatchCount();

        // Auto-navigate to first match
        if (this._matches.length > 0) {
            this._navigateTo(0);
        }
    }

    // =========================================================================
    // NAVIGATION
    // =========================================================================

    /** Navigate to the next match (wraps around). */
    _next() {
        if (this._matches.length === 0) return;
        const nextIdx = (this._currentIndex + 1) % this._matches.length;
        this._navigateTo(nextIdx);
    }

    /** Navigate to the previous match (wraps around). */
    _prev() {
        if (this._matches.length === 0) return;
        const prevIdx = (this._currentIndex - 1 + this._matches.length) % this._matches.length;
        this._navigateTo(prevIdx);
    }

    /**
     * Highlight and select a specific match by index.
     *
     * Args:
     *   idx: Index into this._matches
     */
    _navigateTo(idx) {
        this._clearHighlight();
        if (idx < 0 || idx >= this._matches.length) return;

        this._currentIndex = idx;
        const { obj } = this._matches[idx];

        // Highlight with a bright border
        this._highlightOriginalStroke = obj.stroke;
        obj.set('stroke', '#00ffff');
        obj.set('strokeWidth', (obj.strokeWidth || 1) + 1);

        // Select the object on the canvas
        this.canvas.fabricCanvas.setActiveObject(obj);
        this.canvas.fabricCanvas.renderAll();

        this._updateMatchCount();
    }

    /** Remove highlight from the currently navigated match. */
    _clearHighlight() {
        if (this._currentIndex >= 0 && this._currentIndex < this._matches.length) {
            const { obj } = this._matches[this._currentIndex];
            if (this._highlightOriginalStroke !== null) {
                obj.set('stroke', this._highlightOriginalStroke);
                // Restore original stroke width (we added 1)
                if (obj.strokeWidth > 1) {
                    obj.set('strokeWidth', obj.strokeWidth - 1);
                }
            }
            this._highlightOriginalStroke = null;
        }
        this.canvas?.fabricCanvas?.renderAll();
    }

    // =========================================================================
    // REPLACE
    // =========================================================================

    /**
     * Replace text in the current match.
     *
     * Args:
     *   findStr: Original search string
     *   replaceStr: Replacement string
     *   caseSensitive: Match case flag
     */
    _replaceOne(findStr, replaceStr, caseSensitive) {
        if (this._currentIndex < 0 || this._currentIndex >= this._matches.length) return;
        if (!findStr) return;

        const { obj, prop } = this._matches[this._currentIndex];
        const original = obj[prop] || '';
        const flags = caseSensitive ? 'g' : 'gi';
        const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, flags);

        // Replace first occurrence only
        const replaced = original.replace(regex, replaceStr);
        obj.set(prop, replaced);

        this.canvas.fabricCanvas.renderAll();
        this.canvas.onContentChange?.();

        // Re-search to update match list (the replaced object might no longer match)
        this._search(findStr, caseSensitive);
    }

    /**
     * Replace all occurrences across all matching objects.
     *
     * Args:
     *   findStr: Original search string
     *   replaceStr: Replacement string
     *   caseSensitive: Match case flag
     *
     * Returns:
     *   Number of replacements made
     */
    _replaceAll(findStr, replaceStr, caseSensitive) {
        if (!findStr || this._matches.length === 0) return 0;

        const flags = caseSensitive ? 'g' : 'gi';
        const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, flags);
        let count = 0;

        for (const { obj, prop } of this._matches) {
            const original = obj[prop] || '';
            const replaced = original.replace(regex, replaceStr);
            if (replaced !== original) {
                obj.set(prop, replaced);
                count++;
            }
        }

        this.canvas.fabricCanvas.renderAll();
        this.canvas.onContentChange?.();

        // Re-search to clear matches
        this._search(findStr, caseSensitive);
        return count;
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================

    /** Update the match count display in the modal. */
    _updateMatchCount() {
        const el = document.getElementById('find-match-count');
        if (!el) return;
        const total = this._matches.length;
        if (total === 0) {
            el.textContent = '0 matches';
        } else {
            el.textContent = `${this._currentIndex + 1} of ${total}`;
        }
    }

    // =========================================================================
    // CONTROL BINDINGS
    // =========================================================================

    _bindControls() {
        const findInput = document.getElementById('find-input');
        const replaceInput = document.getElementById('replace-input');
        const caseCb = document.getElementById('find-case-sensitive');
        const closeBtn = document.getElementById('find-replace-close');
        const overlay = document.getElementById('modal-find-replace-overlay');
        const prevBtn = document.getElementById('find-prev');
        const nextBtn = document.getElementById('find-next');
        const replaceOneBtn = document.getElementById('find-replace-one');
        const replaceAllBtn = document.getElementById('find-replace-all');

        // Live search on typing (debounced 200ms)
        let searchTimer = 0;
        const doSearch = () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                this._search(findInput?.value || '', caseCb?.checked);
            }, 200);
        };

        findInput?.addEventListener('input', doSearch);
        caseCb?.addEventListener('change', doSearch);

        // Enter key in find input → next match
        findInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) {
                    this._prev();
                } else {
                    this._next();
                }
            }
        });

        // Navigation
        prevBtn?.addEventListener('click', () => this._prev());
        nextBtn?.addEventListener('click', () => this._next());

        // Replace
        replaceOneBtn?.addEventListener('click', () => {
            this._replaceOne(
                findInput?.value || '',
                replaceInput?.value || '',
                caseCb?.checked
            );
        });

        replaceAllBtn?.addEventListener('click', () => {
            const count = this._replaceAll(
                findInput?.value || '',
                replaceInput?.value || '',
                caseCb?.checked
            );
            if (count > 0) {
                console.log(`[FindReplace] Replaced ${count} occurrences`);
            }
        });

        // Close
        closeBtn?.addEventListener('click', () => this.close());
        overlay?.addEventListener('click', () => this.close());

        // Escape closes the modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modal = document.getElementById('modal-find-replace');
                if (modal && modal.style.display !== 'none') {
                    e.stopPropagation();
                    this.close();
                }
            }
        }, { capture: true });
    }
}
