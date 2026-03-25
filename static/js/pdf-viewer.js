/**
 * PortolanCAST — PDF Viewer Module
 *
 * Purpose:
 *   Handles PDF page rendering via the server-side PyMuPDF engine.
 *   Manages page navigation, zoom levels, and viewport panning.
 *   Pages are rendered server-side as PNG images (not client-side PDF.js)
 *   because server-side rendering gives consistent results on all browsers
 *   and keeps the door open for PyMuPDF annotation embedding later.
 *
 * Architecture note:
 *   We use server-side rendering (PyMuPDF → PNG → <img>) instead of
 *   client-side PDF.js rendering. This is simpler, more reliable for
 *   large-format engineering drawings, and means PyMuPDF handles all
 *   PDF complexity in one place. PDF.js library files are kept for
 *   potential future use (text layer, client-side search).
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-15
 */

// =============================================================================
// ZOOM CONFIGURATION
// =============================================================================

// Zoom is expressed as a percentage (100 = actual rendered size)
const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
const ZOOM_STEP = 25;       // Step for button clicks
const ZOOM_SCROLL_STEP = 10; // Step for scroll wheel
const ZOOM_DEFAULT = 100;

// DPI to request from server at 100% zoom
// Higher = sharper but slower initial load
const BASE_DPI = 150;

// =============================================================================
// SCROLL-BOUNDARY PAGE NAVIGATION
// =============================================================================

/**
 * Return the over-scroll threshold (px) from the user's sensitivity preference.
 *
 * Level 1 (Low)    = 150px — hard to trigger accidentally
 * Level 2 (Medium) = 80px  — default
 * Level 3 (High)   = 30px  — light touch, fast page-flipping
 *
 * Read on every wheel event so changes in the settings modal apply instantly.
 */
function getOverscrollThreshold() {
    const level = localStorage.getItem('portolancast-scroll-sensitivity');
    if (level === '1') return 150;
    if (level === '3') return 30;
    return 80;
}

// =============================================================================
// PDF VIEWER CLASS
// =============================================================================

/**
 * Manages PDF display, navigation, zoom, and pan.
 *
 * Communicates with the FastAPI backend to load page images.
 * Each page is a PNG rendered server-side at the requested DPI.
 *
 * Usage:
 *   const viewer = new PDFViewer();
 *   await viewer.loadDocument(docId);
 *   viewer.goToPage(0);
 */
export class PDFViewer {
    constructor() {
        // DOM elements
        this.viewport = document.getElementById('viewport');
        this.container = document.getElementById('canvas-container');
        this.pdfImage = document.getElementById('pdf-image');
        this.welcomeScreen = document.getElementById('welcome-screen');

        // Document state
        this.docId = null;
        this.docInfo = null;
        this.currentPage = 0;
        this.pageCount = 0;

        // Zoom state
        this.zoom = ZOOM_DEFAULT;

        // Rotation state — per-page clockwise degrees, one of: 0, 90, 180, 270.
        // Applied server-side via the ?rotate= query param so the rendered PNG
        // already has the correct orientation and swapped dimensions.
        // The Fabric canvas overlay resizes automatically via the existing
        // imageNaturalWidth/Height tracking in canvas.js.
        this.rotation = 0;

        /**
         * OCG layers currently hidden for this document.
         * Set of layer name strings (e.g., 'BORDER', 'Text PS').
         * When non-empty, appended as ?hidden_layers=... on page render requests.
         * @type {Set<string>}
         */
        this.pdfHiddenLayers = new Set();

        /**
         * Per-page rotation map — persisted to document_settings via API.
         * Key: page number (int as string), Value: degrees (0/90/180/270).
         * Pages not in the map default to 0°.
         * @type {Object<string, number>}
         */
        this._pageRotations = {};

        // Pan state — tracks mouse drag for panning
        this.isPanning = false;
        this.panStartX = 0;
        this.panStartY = 0;
        this.scrollStartX = 0;
        this.scrollStartY = 0;

        /**
         * Scroll-boundary page navigation state.
         * Accumulates wheel delta past the viewport edge; flips the page when
         * the total reaches getOverscrollThreshold().
         *
         * amount:    accumulated over-scroll pixels in the current direction
         * direction: 'next' | 'prev' | null
         * lastFlip:  Date.now() of the last page flip — used to enforce a
         *            cooldown so rapid wheel events don't skip multiple pages
         */
        this._overscroll = { amount: 0, direction: null, lastFlip: 0 };

        // Rendered image natural dimensions (at BASE_DPI)
        this.imageNaturalWidth = 0;
        this.imageNaturalHeight = 0;

        // Callbacks for external components
        this.onPageChange = null;   // (pageNumber, pageCount) => {}
        this.onZoomChange = null;   // (zoomPercent) => {}
        this.onDocumentLoad = null; // (docInfo) => {}

        this._bindEvents();
    }

    // =========================================================================
    // EVENT BINDING
    // =========================================================================

    /**
     * Wire up mouse/wheel events for zoom and pan.
     * Keyboard shortcuts are handled by app.js.
     */
    _bindEvents() {
        // Scroll wheel → zoom
        this.viewport.addEventListener('wheel', (e) => {
            // Only zoom when Ctrl is held (standard convention)
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -ZOOM_SCROLL_STEP : ZOOM_SCROLL_STEP;
                // Capture cursor position relative to viewport so zoom anchors
                // to the point under the mouse rather than jumping to top-left.
                const rect = this.viewport.getBoundingClientRect();
                const focalPoint = {
                    viewportX: e.clientX - rect.left,
                    viewportY: e.clientY - rect.top,
                };
                this.setZoom(this.zoom + delta, focalPoint);
            }
        }, { passive: false });

        // Mouse drag → pan
        this.viewport.addEventListener('mousedown', (e) => {
            // Only pan with left mouse button when not over a UI element
            if (e.button !== 0) return;
            // Also block pan when a drawing/select tool is active (.drawing-active).
            // Without this, dragging Fabric objects also pans the viewport because
            // Fabric captures the event but it still bubbles to #viewport.
            if (e.target.closest('.side-panel, #toolbar, #status-bar, .canvas-container.drawing-active')) return;

            this.isPanning = true;
            this.panStartX = e.clientX;
            this.panStartY = e.clientY;
            this.scrollStartX = this.viewport.scrollLeft;
            this.scrollStartY = this.viewport.scrollTop;
            this.container.classList.add('panning');
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isPanning) return;
            const dx = e.clientX - this.panStartX;
            const dy = e.clientY - this.panStartY;
            this.viewport.scrollLeft = this.scrollStartX - dx;
            this.viewport.scrollTop = this.scrollStartY - dy;
        });

        window.addEventListener('mouseup', () => {
            if (this.isPanning) {
                this.isPanning = false;
                this.container.classList.remove('panning');
            }
        });

        // Track natural image size when loaded
        this.pdfImage.addEventListener('load', () => {
            this.imageNaturalWidth = this.pdfImage.naturalWidth;
            this.imageNaturalHeight = this.pdfImage.naturalHeight;
            this._applyZoom();
            // Notify minimap and other listeners that a fresh page image is ready
            if (this.onPageLoad) this.onPageLoad(this.pdfImage);
        });

        // --- Scroll-boundary page navigation ---
        // Capture phase on #viewport fires BEFORE any child handler (including the
        // Fabric canvas wrapper's capture listener in canvas.js). This guarantees we
        // see every wheel event regardless of where in the viewport the mouse is,
        // and regardless of Fabric's pointer-events state.
        //
        // When the threshold is reached we call e.stopPropagation() so canvas.js's
        // _bindScrollForwarding does NOT apply the remaining delta to the fresh page.
        this.viewport.addEventListener('wheel', (e) => {
            if (e.ctrlKey) return; // ctrl+scroll = zoom, handled by the bubble listener

            let dy = e.deltaY;
            if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 24;
            else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= this.viewport.clientHeight;
            if (dy === 0) return;

            const maxScrollTop = this.viewport.scrollHeight - this.viewport.clientHeight;
            // Only active when the page is taller than the viewport.
            // Pages that fit fully have maxScrollTop ≈ 0 and no meaningful edge.
            if (maxScrollTop <= 5) return;

            // Use <= 1 tolerance: fractional scrollTop (0.3px etc.) on high-DPI
            // displays would break a strict === 0 check.
            const isTopEdge    = dy < 0 && this.viewport.scrollTop <= 1;
            const isBottomEdge = dy > 0 && this.viewport.scrollTop >= maxScrollTop - 1;

            if (isTopEdge || isBottomEdge) {
                const direction = isBottomEdge ? 'next' : 'prev';

                // Cooldown: after a flip, ignore edge events for 1200ms so rapid
                // trackpad momentum doesn't skip multiple pages in one gesture.
                if (Date.now() - this._overscroll.lastFlip < 1200) return;

                // Reset accumulator when direction reverses
                if (direction !== this._overscroll.direction) {
                    this._overscroll.amount    = 0;
                    this._overscroll.direction = direction;
                }

                this._overscroll.amount += Math.abs(dy);
                const threshold = getOverscrollThreshold();
                const progress  = Math.min(100, (this._overscroll.amount / threshold) * 100);
                this._updateOverscrollIndicator(progress, direction);

                if (this._overscroll.amount >= threshold) {
                    // Record flip time BEFORE navigating so the cooldown starts
                    // immediately — goToPage() is async and takes time to resolve.
                    this._overscroll = { amount: 0, direction: null, lastFlip: Date.now() };
                    this._updateOverscrollIndicator(0, null);
                    e.stopPropagation();
                    if (direction === 'next') this.nextPage();
                    else this.prevPage();
                }
            } else {
                // Scrolled away from edge — discard partial accumulation
                // (preserve lastFlip so the cooldown remains active)
                if (this._overscroll.amount > 0) {
                    this._overscroll.amount    = 0;
                    this._overscroll.direction = null;
                    this._updateOverscrollIndicator(0, null);
                }
            }
        }, { passive: false, capture: true });
    }

    /**
     * Update the over-scroll progress indicator on #viewport.
     *
     * Grows an inset box-shadow at the top or bottom edge as the threshold
     * is approached. No DOM injection — avoids z-index conflicts with Fabric.
     *
     * Args:
     *   progress:  0–100 (% of threshold reached)
     *   direction: 'next' (bottom glow) | 'prev' (top glow) | null (clear)
     */
    _updateOverscrollIndicator(progress, direction) {
        if (progress <= 0 || !direction) {
            this.viewport.style.boxShadow = '';
            return;
        }
        const alpha  = 0.25 + (progress / 100) * 0.5;          // 0.25 → 0.75
        const height = Math.round(2 + (progress / 100) * 6);    // 2px → 8px
        const color  = `rgba(74, 144, 226, ${alpha.toFixed(2)})`;
        this.viewport.style.boxShadow = direction === 'next'
            ? `inset 0 -${height}px 0 0 ${color}`
            : `inset 0  ${height}px 0 0 ${color}`;
    }

    // =========================================================================
    // DOCUMENT LOADING
    // =========================================================================

    /**
     * Load a document from the server and display the first page.
     *
     * Args:
     *   docId: Database document ID from the upload response.
     */
    async loadDocument(docId) {
        this.docId = docId;

        // Fetch document metadata
        const resp = await fetch(`/api/documents/${docId}/info`);
        if (!resp.ok) {
            throw new Error(`Failed to load document: ${resp.statusText}`);
        }

        this.docInfo = await resp.json();
        this.pageCount = this.docInfo.page_count;
        this.currentPage = 0;

        // Reset OCG layer state — new document starts with all layers visible
        this.pdfHiddenLayers = new Set();

        // Load per-page rotation preferences before first render
        // so the first page displays in its saved orientation.
        await this.loadRotations();

        // Switch from welcome screen to canvas
        this.welcomeScreen.style.display = 'none';
        this.container.style.display = 'block';

        // Notify app of document load
        if (this.onDocumentLoad) {
            this.onDocumentLoad(this.docInfo);
        }

        // Render first page (uses saved rotation if any)
        await this.goToPage(0);
    }

    // =========================================================================
    // PAGE NAVIGATION
    // =========================================================================

    /**
     * Navigate to a specific page and render it.
     *
     * Args:
     *   pageNumber: Zero-indexed page number.
     */
    async goToPage(pageNumber) {
        if (!this.docId) return;

        // Clamp to valid range
        pageNumber = Math.max(0, Math.min(pageNumber, this.pageCount - 1));
        this.currentPage = pageNumber;

        // Restore per-page rotation — each page remembers its orientation
        this.rotation = this.getPageRotation(pageNumber);

        // Show loading state
        this.pdfImage.style.opacity = '0.5';

        // Request page image from server.
        // DPI is fixed at BASE_DPI — zoom is handled client-side via CSS.
        // rotate instructs the server to bake the rotation into the PNG so
        // the Fabric canvas overlay coord-space matches the displayed image.
        // hidden_layers lists OCG layer names to suppress (empty = show all).
        let url = `/api/documents/${this.docId}/page/${pageNumber}?dpi=${BASE_DPI}&rotate=${this.rotation}`;
        if (this.pdfHiddenLayers.size > 0) {
            url += `&hidden_layers=${encodeURIComponent([...this.pdfHiddenLayers].join(','))}`;
        }

        try {
            this.pdfImage.src = url;
            // Wait for image to load
            await new Promise((resolve, reject) => {
                this.pdfImage.onload = resolve;
                this.pdfImage.onerror = () => reject(new Error('Failed to load page image'));
            });
            this.pdfImage.style.opacity = '1';
        } catch (err) {
            this.pdfImage.style.opacity = '1';
            console.error('Page render failed:', err);
        }

        // Notify listeners
        if (this.onPageChange) {
            this.onPageChange(this.currentPage, this.pageCount);
        }

        // Reset scroll to top-left when changing pages
        this.viewport.scrollLeft = 0;
        this.viewport.scrollTop = 0;
    }

    /** Go to next page if available. */
    nextPage() {
        if (this.currentPage < this.pageCount - 1) {
            this.goToPage(this.currentPage + 1);
        }
    }

    /** Go to previous page if available. */
    prevPage() {
        if (this.currentPage > 0) {
            this.goToPage(this.currentPage - 1);
        }
    }

    // =========================================================================
    // OCG LAYER VISIBILITY
    // =========================================================================

    /**
     * Update the set of hidden OCG layers and re-render the current page.
     *
     * Called by the PDF layer panel when the user toggles a layer.
     * The hidden set is passed as ?hidden_layers= to the server render endpoint.
     *
     * Args:
     *   hiddenLayerNames: Array of layer name strings to hide.
     */
    setHiddenLayers(hiddenLayerNames) {
        this.pdfHiddenLayers = new Set(hiddenLayerNames);
        // Re-render current page with new layer state
        this.goToPage(this.currentPage);
    }

    /**
     * Clear all layer filters and re-render the current page with all layers visible.
     */
    resetHiddenLayers() {
        if (this.pdfHiddenLayers.size > 0) {
            this.pdfHiddenLayers = new Set();
            this.goToPage(this.currentPage);
        }
    }

    // =========================================================================
    // ZOOM
    // =========================================================================

    /**
     * Set zoom level and re-render the image at the new size.
     *
     * Zoom is CSS-based (scaling the <img> element) rather than
     * re-requesting at a different DPI. This gives instant zoom
     * response. The server renders at BASE_DPI which is sharp enough
     * for most zoom levels.
     *
     * Args:
     *   zoomPercent: Zoom level as percentage (25-400).
     */
    /**
     * Set zoom and optionally anchor to a focal point so the content under
     * that point stays stationary after zooming.
     *
     * Args:
     *   zoomPercent: Target zoom level (25-400).
     *   focalPoint: Optional {viewportX, viewportY} — pixel offset from the
     *               top-left corner of the viewport element. If omitted, no
     *               scroll adjustment is made (content jumps to top-left).
     */
    setZoom(zoomPercent, focalPoint = null) {
        const oldZoom = this.zoom;
        this.zoom = Math.max(ZOOM_MIN, Math.min(zoomPercent, ZOOM_MAX));
        this._applyZoom();

        // Anchor zoom to focal point: keep the content coordinate under the
        // focal pixel stationary. Formula:
        //   newScroll = (oldScroll + focalOffset) * (newZoom / oldZoom) - focalOffset
        // This works because the focal point's content coordinate scales by the
        // zoom ratio, while its position within the viewport stays constant.
        if (focalPoint && oldZoom !== this.zoom) {
            const ratio = this.zoom / oldZoom;
            this.viewport.scrollLeft =
                (this.viewport.scrollLeft + focalPoint.viewportX) * ratio - focalPoint.viewportX;
            this.viewport.scrollTop =
                (this.viewport.scrollTop + focalPoint.viewportY) * ratio - focalPoint.viewportY;
        }

        if (this.onZoomChange) {
            this.onZoomChange(this.zoom);
        }
    }

    /** Apply current zoom level to the image element. */
    _applyZoom() {
        if (!this.imageNaturalWidth) return;

        const scale = this.zoom / 100;
        const w = Math.round(this.imageNaturalWidth * scale);
        const h = Math.round(this.imageNaturalHeight * scale);

        this.pdfImage.style.width = `${w}px`;
        this.pdfImage.style.height = `${h}px`;
    }

    /** Zoom in by one step, anchored to the center of the visible viewport. */
    zoomIn() {
        this.setZoom(this.zoom + ZOOM_STEP, this._viewportCenter());
    }

    /** Zoom out by one step, anchored to the center of the visible viewport. */
    zoomOut() {
        this.setZoom(this.zoom - ZOOM_STEP, this._viewportCenter());
    }

    /**
     * Return the center of the visible viewport as a focal point.
     * Used by zoom buttons so they don't jump to the top-left corner.
     */
    _viewportCenter() {
        return {
            viewportX: this.viewport.clientWidth  / 2,
            viewportY: this.viewport.clientHeight / 2,
        };
    }

    /**
     * Fit the page to the viewport width.
     * Calculates zoom so the page width matches the viewport width.
     * Uses the currently loaded image's natural width (which is already
     * the post-rotation width when rotation is 90°/270°).
     */
    fitToWidth() {
        if (!this.imageNaturalWidth) return;

        const viewportWidth = this.viewport.clientWidth - 20; // 20px padding
        const fitZoom = Math.round((viewportWidth / this.imageNaturalWidth) * 100);
        this.setZoom(fitZoom);
    }

    // =========================================================================
    // ROTATION
    // =========================================================================

    /**
     * Cycle clockwise through 0 → 90 → 180 → 270 → 0.
     *
     * Rotation is per-page and persisted to document_settings so each page
     * remembers its orientation across sessions. After rotating, the viewer
     * auto-fits to width so the rotated page fills the viewport (prevents
     * the "cut off image" problem reported in the 2026-03-10 field test).
     *
     * Coordinate handling: When rotation changes, onRotationChange fires
     * BEFORE the image reloads. App.js uses this to transform all markup
     * coordinates through the rotation matrix so objects maintain their
     * physical position on the drawing. See canvas.js
     * transformObjectsForRotation() for the affine math.
     */
    rotate() {
        this.setRotation((this.rotation + 90) % 360);
    }

    /**
     * Set an explicit rotation for the current page and re-render.
     *
     * Persists the rotation to the per-page map and saves to the server.
     * Auto-fits to width after the rotated image loads so the page
     * doesn't extend beyond the viewport.
     *
     * Args:
     *   degrees: One of 0, 90, 180, 270. Invalid values snap to 0.
     */
    setRotation(degrees) {
        const valid = [0, 90, 180, 270];
        const oldRotation = this.rotation;
        this.rotation = valid.includes(degrees) ? degrees : 0;

        // No change — skip re-render and callbacks
        if (this.rotation === oldRotation) return;

        // Store in per-page map
        const pageKey = String(this.currentPage);
        if (this.rotation === 0) {
            delete this._pageRotations[pageKey];
        } else {
            this._pageRotations[pageKey] = this.rotation;
        }

        // Persist to server (fire-and-forget — rotation is best-effort)
        this._saveRotations();

        // Fire rotation change BEFORE re-rendering so listeners can transform
        // markup coordinates while imageNaturalWidth/Height still hold the
        // pre-rotation values. This is critical: goToPage() triggers an image
        // load that will swap dimensions, but markups need the OLD dimensions
        // to compute the correct coordinate transformation.
        if (this.onRotationChange) {
            this.onRotationChange(
                this.rotation, oldRotation,
                this.imageNaturalWidth, this.imageNaturalHeight
            );
        }

        // Re-render the current page with the new rotation baked in.
        // goToPage() resets scroll to top-left, which is appropriate
        // since the page dimensions may have changed.
        if (this.docId) {
            // After rotation, auto-fit to width so the page isn't "cut off".
            // We need to wait for the image to load before fitting because
            // imageNaturalWidth changes when dimensions swap (portrait↔landscape).
            const fitAfterLoad = () => {
                this.fitToWidth();
                this.pdfImage.removeEventListener('load', fitAfterLoad);
            };
            this.pdfImage.addEventListener('load', fitAfterLoad);

            this.goToPage(this.currentPage);
        }
    }

    /**
     * Load per-page rotations from the server for the current document.
     *
     * Called once when a document loads. Populates _pageRotations so that
     * goToPage() can restore each page's saved orientation.
     */
    async loadRotations() {
        if (!this.docId) return;

        try {
            const resp = await fetch(`/api/documents/${this.docId}/rotations`);
            if (resp.ok) {
                this._pageRotations = await resp.json();
            }
        } catch (err) {
            console.error('[Viewer] Failed to load rotations:', err);
        }
    }

    /**
     * Save per-page rotations to the server.
     * Fire-and-forget — rotation persistence is best-effort.
     */
    async _saveRotations() {
        if (!this.docId) return;

        try {
            await fetch(`/api/documents/${this.docId}/rotations`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this._pageRotations),
            });
        } catch (err) {
            console.error('[Viewer] Failed to save rotations:', err);
        }
    }

    /**
     * Get the saved rotation for a specific page.
     *
     * Args:
     *   pageNumber: Zero-indexed page number.
     *
     * Returns:
     *   Degrees (0, 90, 180, or 270). Defaults to 0 if not set.
     */
    getPageRotation(pageNumber) {
        return this._pageRotations[String(pageNumber)] || 0;
    }
}
