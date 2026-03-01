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

        // Rotation state — clockwise degrees, one of: 0, 90, 180, 270.
        // Applied server-side via the ?rotate= query param so the rendered PNG
        // already has the correct orientation and swapped dimensions.
        // The Fabric canvas overlay resizes automatically via the existing
        // imageNaturalWidth/Height tracking in canvas.js.
        this.rotation = 0;

        // Pan state — tracks mouse drag for panning
        this.isPanning = false;
        this.panStartX = 0;
        this.panStartY = 0;
        this.scrollStartX = 0;
        this.scrollStartY = 0;

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
                this.setZoom(this.zoom + delta);
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
        });
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

        // Switch from welcome screen to canvas
        this.welcomeScreen.style.display = 'none';
        this.container.style.display = 'block';

        // Notify app of document load
        if (this.onDocumentLoad) {
            this.onDocumentLoad(this.docInfo);
        }

        // Render first page
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

        // Show loading state
        this.pdfImage.style.opacity = '0.5';

        // Request page image from server.
        // DPI is fixed at BASE_DPI — zoom is handled client-side via CSS.
        // rotate instructs the server to bake the rotation into the PNG so
        // the Fabric canvas overlay coord-space matches the displayed image.
        const url = `/api/documents/${this.docId}/page/${pageNumber}?dpi=${BASE_DPI}&rotate=${this.rotation}`;

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
    setZoom(zoomPercent) {
        this.zoom = Math.max(ZOOM_MIN, Math.min(zoomPercent, ZOOM_MAX));
        this._applyZoom();

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

    /** Zoom in by one step. */
    zoomIn() {
        this.setZoom(this.zoom + ZOOM_STEP);
    }

    /** Zoom out by one step. */
    zoomOut() {
        this.setZoom(this.zoom - ZOOM_STEP);
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
     * Rotation is applied server-side — the rendered PNG already has the
     * correct dimensions and orientation after this call. The Fabric canvas
     * overlay resizes automatically because the new PNG's naturalWidth/Height
     * differ from the previous load, triggering the 'load' listener in canvas.js.
     *
     * Note on existing markups: markups are stored in the coordinate space
     * of the rendered image. Rotating after placing markups will cause them
     * to appear in incorrect positions because the coordinate space changes
     * with the rotation. Best practice: set rotation before starting markup work.
     */
    rotate() {
        this.setRotation((this.rotation + 90) % 360);
    }

    /**
     * Set an explicit rotation and re-render the current page.
     *
     * Args:
     *   degrees: One of 0, 90, 180, 270. Invalid values snap to 0.
     */
    setRotation(degrees) {
        const valid = [0, 90, 180, 270];
        this.rotation = valid.includes(degrees) ? degrees : 0;

        // Re-render the current page with the new rotation baked in.
        // goToPage() resets scroll to top-left, which is appropriate
        // since the page dimensions may have changed.
        if (this.docId) {
            this.goToPage(this.currentPage);
        }

        if (this.onRotationChange) {
            this.onRotationChange(this.rotation);
        }
    }
}
