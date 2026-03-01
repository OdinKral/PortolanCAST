/**
 * PortolanCAST — Page Text Panel
 *
 * Purpose:
 *   Extracts and displays text content from the currently viewed PDF page.
 *   Two-tier strategy mirrors the backend:
 *     1. Native text layer (fast, no deps) — works for born-digital PDFs.
 *     2. Tesseract OCR fallback — shown when native text is empty and the
 *        user explicitly requests it. Gracefully disabled if Tesseract is
 *        not installed on the server.
 *
 * Usage:
 *   const pageText = new PageTextPanel();
 *   pageText.initForDocument(docId);   // call on each document load
 *   pageText.refresh(pageNumber);      // call on each page change
 *
 * Security:
 *   - All AI-generated/OCR text is inserted via textContent (never innerHTML)
 *     to prevent XSS from malformed PDF content.
 *   - Requests are gated behind the active tab check to avoid wasteful fetches.
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-02-28
 */

'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

// Install hint shown when OCR is requested but Tesseract is absent
const OCR_INSTALL_MSG = [
    'Tesseract is not installed on the server.',
    'To enable OCR for scanned PDFs, run:',
    '',
    '  sudo apt-get install tesseract-ocr',
    '  venv/bin/pip install pytesseract pillow',
    '',
    'Then restart the PortolanCAST server.',
].join('\n');

// =============================================================================
// PAGE TEXT PANEL
// =============================================================================

class PageTextPanel {
    /**
     * Creates a PageTextPanel but does not bind to any document yet.
     * Call initForDocument() after constructing.
     */
    constructor() {
        /** @type {number|null} Current document ID */
        this._docId = null;

        /** @type {number} Last rendered page number */
        this._lastPage = -1;

        /** @type {boolean} Whether the Text tab is currently visible */
        this._tabActive = false;

        /** @type {AbortController|null} In-flight fetch controller for cancellation */
        this._abortCtrl = null;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Bind this panel to a newly-loaded document.
     * Wires the tab switch, OCR button, and copy button once — safe to call
     * repeatedly on re-load (uses click-listener replacement pattern).
     *
     * Args:
     *   docId (number): The document ID for API calls.
     */
    initForDocument(docId) {
        this._docId   = docId;
        this._lastPage = -1;

        // Wire tab switch: refresh immediately when the Text tab becomes active.
        //
        // IMPORTANT: do NOT clone-replace this button. markup-list.js._bindTabSwitching()
        // already attached a listener to it that adds .active to #tab-text. Cloning
        // removes that listener and breaks the tab switch. Use a named reference instead
        // so we can cleanly remove the old listener on re-init without losing the
        // _bindTabSwitching listener.
        const tabBtn = document.querySelector('.panel-tab[data-panel="text"]');
        if (tabBtn) {
            if (this._tabClickHandler) {
                tabBtn.removeEventListener('click', this._tabClickHandler);
            }
            // _bindTabSwitching fires first (added before us) — so when our handler
            // runs, .active is already on #tab-text and the refresh() guard passes.
            this._tabClickHandler = () => {
                this.refresh(this._lastPage >= 0 ? this._lastPage : 0);
            };
            tabBtn.addEventListener('click', this._tabClickHandler);
        }

        // Wire "Extract with OCR" button
        const ocrBtn = document.getElementById('text-ocr-btn');
        if (ocrBtn) {
            const newOcr = ocrBtn.cloneNode(true);
            ocrBtn.parentNode.replaceChild(newOcr, ocrBtn);
            newOcr.addEventListener('click', () => this._fetchAndRender(
                this._lastPage, /* useOcr= */ true
            ));
        }

        // Wire "Copy" button — copies current text to clipboard
        const copyBtn = document.getElementById('text-copy-btn');
        if (copyBtn) {
            const newCopy = copyBtn.cloneNode(true);
            copyBtn.parentNode.replaceChild(newCopy, copyBtn);
            newCopy.addEventListener('click', () => this._copyText());
        }

        // Clear the panel for the new document
        this._setEmpty('Load a page to extract its text.');
    }

    /**
     * Refresh the panel for the given page.
     * Skips the fetch if the Text tab is not visible (avoids wasteful
     * background requests on every page turn).
     *
     * Checks the actual DOM state of the tab rather than tracking
     * an internal flag — more reliable because it's always in sync with
     * whatever panel-tab switching logic is active.
     *
     * Args:
     *   pageNumber (number): Zero-indexed page number.
     */
    refresh(pageNumber) {
        this._lastPage = pageNumber;
        if (!this._docId) return;

        // Only fetch when #tab-text is the currently visible panel.
        // Checking the DOM is more reliable than tracking _tabActive state
        // because it doesn't require hooking into every panel-tab click.
        const tabContent = document.getElementById('tab-text');
        if (!tabContent || !tabContent.classList.contains('active')) return;

        this._fetchAndRender(pageNumber, /* useOcr= */ false);
    }

    // =========================================================================
    // FETCH + RENDER
    // =========================================================================

    /**
     * Fetch text extraction result from the server and render it.
     * Cancels any in-flight request for the same panel (e.g. rapid page turns).
     *
     * Args:
     *   pageNumber (number): Zero-indexed page number.
     *   useOcr     (boolean): Whether to request OCR fallback.
     */
    async _fetchAndRender(pageNumber, useOcr) {
        if (!this._docId) return;

        // Cancel previous in-flight request if still pending
        if (this._abortCtrl) this._abortCtrl.abort();
        this._abortCtrl = new AbortController();

        this._setLoading(pageNumber);

        try {
            const url = `/api/documents/${this._docId}/text/${pageNumber}`
                      + (useOcr ? '?ocr=true' : '');
            const resp = await fetch(url, { signal: this._abortCtrl.signal });

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: resp.statusText }));
                this._setError(err.detail || 'Server error');
                return;
            }

            const data = await resp.json();
            this._render(data);
        } catch (err) {
            if (err.name === 'AbortError') return;  // cancelled — ignore
            this._setError('Network error: ' + err.message);
        }
    }

    /**
     * Render the API response into the panel DOM.
     * Uses textContent throughout to prevent XSS from PDF/OCR content.
     *
     * Args:
     *   data: Response object from /api/documents/{id}/text/{page}
     */
    _render(data) {
        const bodyEl   = document.getElementById('text-body');
        const statsEl  = document.getElementById('text-stats');
        const ocrWrap  = document.getElementById('text-ocr-wrap');
        const badgeEl  = document.getElementById('text-method-badge');
        const copyBtn  = document.getElementById('text-copy-btn');
        if (!bodyEl) return;

        const { text, word_count, char_count, has_native_text,
                method, ocr_available, page } = data;

        // ── Method badge ─────────────────────────────────────────────────────
        if (badgeEl) {
            badgeEl.dataset.method = method;
            badgeEl.textContent = method === 'native' ? 'Native'
                                : method === 'ocr'    ? 'OCR'
                                :                       'No text';
        }

        // ── Stats line ───────────────────────────────────────────────────────
        if (statsEl) {
            if (method !== 'none') {
                statsEl.textContent = `${word_count} words · ${char_count} chars`;
            } else {
                statsEl.textContent = '';
            }
        }

        // ── Main text area ───────────────────────────────────────────────────
        // SECURITY: always textContent — OCR/PDF text may contain '<>' chars
        if (method !== 'none' && text) {
            bodyEl.textContent = text;
            if (copyBtn) copyBtn.disabled = false;
        } else {
            // No text at all — show contextual help
            if (method === 'none' && !has_native_text) {
                bodyEl.textContent = '(No text layer detected on this page)';
            } else {
                bodyEl.textContent = '(Page is empty)';
            }
            if (copyBtn) copyBtn.disabled = true;
        }

        // ── OCR call-to-action ────────────────────────────────────────────────
        // Show the OCR section when native text is absent.
        if (ocrWrap) {
            const showOcrSection = !has_native_text && method !== 'ocr';
            ocrWrap.style.display = showOcrSection ? '' : 'none';

            if (showOcrSection) {
                const ocrBtn     = document.getElementById('text-ocr-btn');
                const ocrHintEl  = document.getElementById('text-ocr-hint');

                if (ocrBtn) {
                    ocrBtn.disabled = !ocr_available;
                    ocrBtn.title    = ocr_available
                        ? 'Extract text from this page image using Tesseract'
                        : 'Tesseract is not installed — see hint below';
                }
                if (ocrHintEl) {
                    // Show install instructions when Tesseract is absent
                    if (!ocr_available) {
                        ocrHintEl.style.display = '';
                        // SECURITY: plain text (OCR_INSTALL_MSG is a constant, not user input)
                        ocrHintEl.textContent = OCR_INSTALL_MSG;
                    } else {
                        ocrHintEl.style.display = 'none';
                    }
                }
            }
        }
    }

    // =========================================================================
    // STATE HELPERS
    // =========================================================================

    /** Show a loading indicator while fetch is in-flight. */
    _setLoading(page) {
        const bodyEl  = document.getElementById('text-body');
        const statsEl = document.getElementById('text-stats');
        const ocrWrap = document.getElementById('text-ocr-wrap');
        const badgeEl = document.getElementById('text-method-badge');
        if (bodyEl)  { bodyEl.textContent  = `Extracting text for page ${page + 1}…`; }
        if (statsEl) { statsEl.textContent = ''; }
        if (ocrWrap) { ocrWrap.style.display = 'none'; }
        if (badgeEl) { badgeEl.dataset.method = ''; badgeEl.textContent = '…'; }
    }

    /** Show an error message. */
    _setError(msg) {
        const bodyEl  = document.getElementById('text-body');
        const statsEl = document.getElementById('text-stats');
        if (bodyEl)  { bodyEl.textContent  = `Error: ${msg}`; }
        if (statsEl) { statsEl.textContent = ''; }
    }

    /** Show a neutral empty-state message. */
    _setEmpty(msg) {
        const bodyEl  = document.getElementById('text-body');
        const statsEl = document.getElementById('text-stats');
        const ocrWrap = document.getElementById('text-ocr-wrap');
        const badgeEl = document.getElementById('text-method-badge');
        if (bodyEl)  { bodyEl.textContent  = msg; }
        if (statsEl) { statsEl.textContent = ''; }
        if (ocrWrap) { ocrWrap.style.display = 'none'; }
        if (badgeEl) { badgeEl.dataset.method = ''; badgeEl.textContent = ''; }
    }

    /** Copy current text content to clipboard. */
    _copyText() {
        const bodyEl = document.getElementById('text-body');
        if (!bodyEl || !bodyEl.textContent) return;

        const text = bodyEl.textContent;
        if (text.startsWith('(') || text.startsWith('Error:')) return;

        navigator.clipboard.writeText(text).then(() => {
            const copyBtn = document.getElementById('text-copy-btn');
            if (copyBtn) {
                const original = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = original; }, 1500);
            }
        }).catch(() => {
            // Fallback: select text for manual copy
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(bodyEl);
            sel.removeAllRanges();
            sel.addRange(range);
        });
    }

    /**
     * Called by the panel-tab switch system when the tab is hidden.
     * We track this so refresh() skips background fetches.
     */
    deactivate() {
        this._tabActive = false;
    }
}
