/**
 * PortolanCAST — Main Application Controller
 *
 * Purpose:
 *   Entry point for the frontend application. Initializes all modules
 *   (viewer, toolbar, canvas, plugins) and connects them together.
 *   Manages application-level state and UI updates.
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-15
 */

import { PDFViewer } from './pdf-viewer.js';
import { Toolbar } from './toolbar.js';
import { CanvasOverlay, MARKUP_COLORS } from './canvas.js';
import { PropertiesPanel } from './properties.js';
import { MarkupList } from './markup-list.js';
import { ScaleManager } from './scale.js';
import { MeasureTools } from './measure.js';
import { NodeEditor } from './node-editor.js';
import { PluginLoader } from './plugins.js';
import { MeasureSummary } from './measure-summary.js';
import { ExtendedCognitionPlugin } from './plugins/extended-cognition.js';
import { NodeCastPlugin } from './plugins/nodecast.js';
import { HealthMonitorPlugin } from './plugins/health-monitor.js';
import { LayerManager } from './layers.js';
import { PDFLayerPanel } from './pdf-layers.js';
import { SearchPanel } from './search.js';
import { ReviewBrief } from './review-brief.js';
import { RFIGenerator } from './rfi-generator.js';
import { StampManager, ToolPresetsPanel, SequenceManager } from './tools-panel.js';
import { EntityManager } from './entity-manager.js';
import { EntityModal } from './entity-modal.js';
import { QuickCapture } from './quick-capture.js';
import { EquipmentMarkerPanel } from './equipment-marker.js';
// PageTextPanel is loaded as a plain script (page-text.js) — no import needed.
// It attaches PageTextPanel to the global scope so app.js can instantiate it.

// =============================================================================
// APPLICATION INITIALIZATION
// =============================================================================

class App {
    constructor() {
        this.viewer = new PDFViewer();
        this.canvas = new CanvasOverlay();
        this.toolbar = new Toolbar(this.viewer, this.canvas);
        this.properties = new PropertiesPanel();
        this.markupList = new MarkupList();
        this.scale = new ScaleManager();
        this.measureTools = new MeasureTools();
        this.nodeEditor = new NodeEditor();
        this.measureSummary = new MeasureSummary();
        this.plugins = new PluginLoader();
        this.layerManager = new LayerManager();
        this.pdfLayerPanel = new PDFLayerPanel();
        this.search = new SearchPanel();
        this.reviewBrief = new ReviewBrief();
        this.rfiGenerator = new RFIGenerator();
        // Tool Chest — stamp placement, saved tool presets, sequence counters.
        // These init() lazily on first document load (canvas must exist first).
        this.stampManager    = new StampManager();
        this.toolPresets     = new ToolPresetsPanel();
        this.sequenceManager = new SequenceManager();
        // PageTextPanel is a plain script (page-text.js); class is on globalThis
        this.pageText = new PageTextPanel();
        // Stage 3B: Equipment tab list + entity detail modal
        this.entityManager = new EntityManager();
        this.entityModal = new EntityModal();
        // Sprint 1: Quick Capture panel for rapid field equipment entry
        this.quickCapture = new QuickCapture();
        // Equipment Marker: click-to-place entity pin on drawings
        this.equipmentMarkerPanel = new EquipmentMarkerPanel();

        // Give PluginLoader access to the App instance for plugin init() calls.
        // Set here (not in PluginLoader constructor) to avoid circular dependency.
        this.plugins._app = this;

        // Wire measurement tools and scale into the toolbar so setTool() can call them.
        // These are set here (after construction) to avoid circular constructor dependencies.
        this.toolbar.measureTools = this.measureTools;
        this.toolbar.scale = this.scale;

        // Give ToolPresetsPanel access to MARKUP_COLORS so saved presets can fall back
        // to the semantic color of the current markup type when _lastStrokeColor is unset.
        this.toolbar._MARKUP_COLORS_REF = MARKUP_COLORS;

        // Wire nodeEditor to measureTools so endLineEdit can rebuild Groups
        this.nodeEditor.measureTools = this.measureTools;

        // Track last page for canvas save-on-navigate (Option B from plan)
        this.lastPage = 0;

        // Document ID for persistence API calls
        this.docId = null;

        // Dirty flag — true when markups have changed since last save
        this._dirty = false;

        // Auto-save debounce timer
        this._saveTimer = null;

        // Markup list refresh debounce timer
        this._listRefreshTimer = null;

        // Status bar counts debounce timer
        this._countsTimer = null;

        // Pending object selection after page navigation (from markup list click)
        this._pendingSelect = null;

        this._connectCallbacks();
        this._bindPersistence();
        this._bindPanelCollapse();
        this._loadThumbnails = null; // debounced thumbnail loader

        // Wire intent mode indicator in toolbar
        this.toolbar.onMarkupTypeChange = (type) => this._updateIntentIndicator(type);
        this._updateIntentIndicator(this.toolbar.activeMarkupType);
    }

    /**
     * Wire up callbacks between modules.
     * Viewer fires events → App updates UI (status bar, thumbnails, properties).
     */
    _connectCallbacks() {
        // When a page changes, update status bar, thumbnails, and canvas
        this.viewer.onPageChange = (page, total) => {
            // Save markups from the previous page before loading the new one
            if (page !== this.lastPage) {
                this.canvas.onPageChanging(this.lastPage);
            }

            this._updatePageStatus(page, total);
            this._highlightThumbnail(page);

            // Forward page navigation to plugins so they can update their UI
            this.plugins.emit('page-changed', page, total);

            // Load markups for the new page and update tracking
            if (page !== this.lastPage) {
                // Await async page load, then handle pending selections
                const hasPending = this._pendingSelect && this._pendingSelect.page === page;
                const pendingIdx = hasPending ? this._pendingSelect.objIndex : -1;
                if (hasPending) {
                    this._pendingSelect = null;
                }
                this.canvas.onPageChanged(page).then(() => {
                    if (hasPending && pendingIdx >= 0) {
                        this._selectObjectByIndex(pendingIdx);
                    }
                });
                // Refresh text panel for the new page (no-op if tab is hidden)
                this.pageText.refresh(page);
                this.lastPage = page;

                // Auto-save when navigating away from a page with changes
                if (this._dirty) {
                    this._scheduleSave();
                }
            }
        };

        // When page rotation changes, transform markup coordinates so
        // objects stay at the same physical location on the drawing.
        // Fired BEFORE the image reloads, while old dimensions are current.
        this.viewer.onRotationChange = (newRotation, oldRotation, oldWidth, oldHeight) => {
            const delta = (newRotation - oldRotation + 360) % 360;
            this.canvas.transformObjectsForRotation(delta, oldWidth, oldHeight);
            // Mark dirty so transformed coordinates are auto-saved
            this.markDirty();
        };

        // When zoom changes, update status bar, sync canvas overlay, and redraw
        // the thumbnail viewport indicator so the red rect scales correctly.
        this.viewer.onZoomChange = (zoom) => {
            this._updateZoomDisplay(zoom);
            this.canvas.syncToViewer();
            this._updateThumbnailViewport();
        };

        // When a page image finishes loading, redraw the indicator against the
        // new page's dimensions (natural width/height may have changed).
        this.viewer.onPageLoad = () => {
            this._updateThumbnailViewport();
        };

        // When a document loads, update UI, load thumbnails, show properties
        this.viewer.onDocumentLoad = (info) => {
            this._onDocumentLoaded(info);
        };

        // Scroll → redraw thumbnail viewport indicator in real time
        // Uses passive:true because we never call preventDefault here
        this.viewer.viewport.addEventListener('scroll', () => {
            this._updateThumbnailViewport();
        }, { passive: true });
    }

    // =========================================================================
    // UI UPDATE METHODS
    // =========================================================================

    /**
     * Intent mode label map — short capitalized labels for the toolbar indicator.
     */
    static INTENT_LABELS = {
        note: 'Note', issue: 'Issue', question: 'Question',
        approval: 'Approval', change: 'Change',
    };

    /**
     * Update the intent mode indicator in the toolbar.
     * Shows the active markup type with its semantic color dot.
     *
     * Args:
     *   type: Active markupType string.
     */
    _updateIntentIndicator(type) {
        const dot = document.getElementById('intent-dot');
        const label = document.getElementById('intent-label');
        if (dot) dot.style.background = MARKUP_COLORS[type] || MARKUP_COLORS.note;
        if (label) label.textContent = App.INTENT_LABELS[type] || type;
    }

    /**
     * Update page indicator in status bar and toolbar area.
     */
    _updatePageStatus(page, total) {
        const statusPage = document.getElementById('status-page');
        statusPage.textContent = `Page: ${page + 1} / ${total}`;
    }

    /**
     * Update zoom display in toolbar and status bar.
     */
    _updateZoomDisplay(zoom) {
        document.getElementById('zoom-display').textContent = `${zoom}%`;
        document.getElementById('status-zoom').textContent = `Zoom: ${zoom}%`;
    }

    /**
     * Called when a new document is loaded.
     * Updates filename display, properties panel, and loads thumbnails.
     */
    _onDocumentLoaded(info) {
        // Update filename in toolbar
        const filenameEl = document.getElementById('filename-display');
        filenameEl.textContent = info.filename;
        filenameEl.title = info.filename;

        // Update properties panel
        document.getElementById('doc-info').style.display = 'block';
        document.getElementById('no-doc-msg').style.display = 'none';
        document.getElementById('prop-filename').textContent = info.filename;
        document.getElementById('prop-pages').textContent = info.page_count;
        document.getElementById('prop-size').textContent = this._formatFileSize(info.file_size);

        if (info.page_sizes && info.page_sizes.length > 0) {
            const ps = info.page_sizes[0];
            document.getElementById('prop-dims').textContent =
                `${ps.width_inches}" × ${ps.height_inches}"`;
        }

        // Load page thumbnails
        this._loadAllThumbnails(info.id, info.page_count);

        // Store document ID for persistence API calls
        this.docId = info.id;

        // Initialize Fabric.js canvas overlay with viewer reference
        // Needs viewer to read imageNaturalWidth/Height and zoom
        this.canvas.init(this.viewer);
        this.lastPage = 0;
        this._dirty = false;

        // Layers: bind UI (idempotent) and rebind object:added on the fresh canvas.
        // Fire layerManager.load() immediately so it races the 200ms setTimeout below.
        // The load result is awaited INSIDE the setTimeout before _loadMarkups fires,
        // guaranteeing layer state is applied before any objects hit the canvas.
        // Keeping _onDocumentLoaded synchronous avoids delaying nodeEditor/measureTools.
        this.layerManager.init(this.canvas);
        this.layerManager.initForCanvas(this.canvas.fabricCanvas);
        const _layerLoadPromise = this.layerManager.load(info.id); // fire immediately

        // Load PDF OCG layers — shows the PDF Layers section if the document
        // has embedded CAD layers (e.g., AutoCAD/Bluebeam engineering drawings).
        this.pdfLayerPanel.load(info.id, this.viewer);

        // Initialize NodeEditor — attaches dblclick/selection:cleared listeners
        // to the newly created Fabric canvas. Must run after canvas.init() since
        // that creates a fresh Fabric canvas instance for each loaded document.
        this.nodeEditor.initForCanvas(this.canvas, this.toolbar, this.scale);
        // Wire node-edit button → NodeEditor.enterEditModeOnSelection()
        // (done here rather than in initForCanvas so toolbar is already set up)
        this.toolbar.onNodeEditRequest = () => this.nodeEditor.enterEditModeOnSelection();

        // Bind callout double-click editing handler — allows re-editing the IText
        // label inside an existing callout Group by double-clicking on it.
        // Registered per document load (each load creates a fresh Fabric canvas).
        this.toolbar._initCalloutEditing(this.canvas.fabricCanvas);

        // Wire MeasureTools global recalc listener — keeps measurement labels
        // accurate after the user moves or scales objects in select mode.
        // Must run after canvas.init() creates a fresh Fabric canvas instance.
        this.measureTools.initForCanvas(this.canvas.fabricCanvas, this.scale);

        // Initialize or rebind MeasureSummary — aggregates all measurements across
        // pages for the Measures tab in the left panel.
        // Guard with canvas check: init() only runs once (first document load);
        // subsequent loads just update the scale reference for fresh formatting.
        if (!this.measureSummary.canvas) {
            this.measureSummary.init(this.canvas, this.scale);
            this.measureSummary.onNavigate = (page, objIndex) => {
                this._navigateToMarkup(page, objIndex);
            };
            // Cross-wire: MarkupList owns the tab-switching code, so it triggers
            // measureSummary.refresh() when the user clicks the Measures tab.
            this.markupList.measureSummary = this.measureSummary;
            // Cross-wire: MarkupList tab-switching code triggers
            // layerManager.refresh() when the user clicks the Layers tab.
            this.markupList.layerManager = this.layerManager;
            // Cross-wire: MarkupList tab-switching code triggers
            // reviewBrief.refresh() when the user clicks the Brief tab.
            this.markupList.reviewBrief = this.reviewBrief;
            // Cross-wire: MarkupList tab-switching code passes docId to
            // rfiGenerator when the user switches to the RFI tab.
            this.markupList.rfiGenerator = this.rfiGenerator;
        }
        // Always update scale ref in case user loaded a different document
        // (scale preset may have changed from the previous document's settings)
        this.measureSummary.scale = this.scale;

        // Initialize or rebind properties panel — listens for selection events
        // on the (possibly new) Fabric canvas instance.
        // Pass scale so _showMeasurementProps can call formatDistance/formatArea live.
        if (!this.properties.canvas) {
            this.properties.init(this.canvas);
            this.properties.onPropertyChange = () => this.markDirty();
        } else {
            this.properties.rebind();
        }
        this.properties.scale = this.scale;
        // Inject docId so properties panel can call the markup-photos API
        this.properties.docId = info.id;
        // Wire entity modal reference so properties panel View button can open it
        this.properties.entityModal = this.entityModal;

        // Initialize entity modal — once per app lifetime (binds Escape key + close button)
        if (!this.entityModal._escBound || !this.entityModal._canvas) {
            this.entityModal.init(this.canvas);
        }

        // Initialize entity manager for each document — stores docId for context
        this.entityManager.init(info.id);

        // Cross-wire: MarkupList tab-switching code triggers
        // entityManager.refresh() when the user clicks the Equipment tab.
        if (!this.markupList.entityManager) {
            this.markupList.entityManager = this.entityManager;
        }

        // Initialize Quick Capture panel — once per app lifetime (binds buttons + keyboard)
        if (!this.quickCapture._initialized) {
            this.quickCapture.init(this.entityManager);
        }

        // Initialize Equipment Marker panel — once per app lifetime (binds buttons + keyboard).
        // docId and canvas update on each document load for correct API targeting.
        if (!this.equipmentMarkerPanel._initialized) {
            this.equipmentMarkerPanel.init(info.id, this.canvas);
        } else {
            // Already initialized — just update docId and canvas for the new document
            this.equipmentMarkerPanel._docId = info.id;
            this.equipmentMarkerPanel._canvas = this.canvas;
        }

        // Initialize review brief panel — once per app lifetime; docId updated per document.
        if (!this.reviewBrief.canvas) {
            this.reviewBrief.init(this.canvas);
        }
        // Update docId so refresh() calls hit the correct document endpoint
        this.reviewBrief.docId = info.id;

        // Initialize RFI generator panel — once per app lifetime; docId updated per document.
        if (!this.rfiGenerator.canvas) {
            this.rfiGenerator.init(this.canvas);
        }
        // Update docId so generate() calls hit the correct document endpoint
        this.rfiGenerator.docId = info.id;

        // Initialize or rebind markup list — aggregates markups across pages.
        // Pass scale so measurement entries can show formatted values.
        // MUST happen before pageText.initForDocument() — markupList.init() calls
        // _bindTabSwitching() which attaches listeners to .panel-tab buttons
        // (including the Text tab). pageText.initForDocument() adds a second
        // listener AFTER, ensuring _bindTabSwitching fires first and .active is
        // already on #tab-text when our refresh() guard runs.
        if (!this.markupList.canvas) {
            this.markupList.init(this.canvas);
            this.markupList.onNavigate = (page, objIndex) => {
                this._navigateToMarkup(page, objIndex);
            };
        }
        this.markupList.scale = this.scale;

        // Initialize page text panel — AFTER markupList.init() so that
        // _bindTabSwitching()'s listener on the Text tab button was added
        // first; our listener fires second and sees .active already set.
        this.pageText.initForDocument(info.id);

        // Initialize Tool Chest panels — runs once per app lifetime.
        // State is localStorage-backed so no per-document re-init is needed.
        // Canvas reference (this.canvas) is the stable CanvasOverlay; the
        // tool managers access fabricCanvas dynamically at placement time, so
        // they automatically use the current canvas after each document load.
        if (!this._toolsInited) {
            this._toolsInited = true;
            this.stampManager.init(this.toolbar, this.canvas);
            this.toolPresets.init(this.toolbar);
            this.sequenceManager.init(this.toolbar, this.canvas);
        }

        // Wire canvas content changes to auto-save, list refresh, and status counts
        this.canvas.onContentChange = () => {
            this.markDirty();
            this._scheduleListRefresh();
            this._scheduleCountsUpdate();
        };

        // Show ambient status counts now that a document is loaded
        const countsEl = document.getElementById('status-counts');
        if (countsEl) countsEl.style.display = '';

        // Show and load drawing scale selector
        const scaleEl = document.getElementById('status-scale');
        if (scaleEl) scaleEl.style.display = '';

        // L3: Reveal the persistent mode bar and seed it with the current tool
        const sbMode = document.getElementById('sb-mode');
        if (sbMode) sbMode.style.display = '';
        this.toolbar._updateModeBar(this.toolbar.activeTool);
        this.scale.load(info.id);

        // Wire scale dropdown — only bind once
        if (!this._scaleBound) {
            this._scaleBound = true;
            const scaleSelect = document.getElementById('scale-select');
            if (scaleSelect) {
                scaleSelect.addEventListener('change', (e) => {
                    this.scale.setPreset(e.target.value);
                });
            }
        }

        // Show "Add Page" button in the pages panel footer
        const pagesPanelFooter = document.getElementById('pages-panel-footer');
        if (pagesPanelFooter) pagesPanelFooter.style.display = '';

        // Wire "Add Page" button — only bind once (idempotent guard via _addPageBound)
        if (!this._addPageBound) {
            this._addPageBound = true;
            const btnAddPage = document.getElementById('btn-add-page');
            if (btnAddPage) {
                btnAddPage.addEventListener('click', () => this._addBlankPage());
            }
        }

        // Load saved markups from server after canvas is initialized.
        // Await the layer load first so layer state (visibility/lock) is
        // applied before loadFromJSON adds objects via object:added events.
        // On localhost the layer API resolves in <50ms, so the await is instant.
        setTimeout(async () => {
            await _layerLoadPromise;
            this._loadMarkups(info.id);
        }, 200);

        // Fit to width on initial load for best viewing experience
        // Use setTimeout to let the image load first
        setTimeout(() => this.viewer.fitToWidth(), 100);

        // Forward document load to plugins — let them initialize against this document
        this.plugins.emit('document-loaded', info);

        // Wire canvas selection events → plugin hooks.
        // Must re-bind on every document load because canvas is recreated per document.
        // Emitting object-selected/deselected allows plugins to react to user selections
        // (e.g. an AI plugin showing analysis for the selected annotation).
        const fc = this.canvas.fabricCanvas;
        fc.on('selection:created', (e) => this.plugins.emit('object-selected', e.selected?.[0]));
        fc.on('selection:updated', (e) => this.plugins.emit('object-selected', e.selected?.[0]));
        fc.on('selection:cleared',  ()  => this.plugins.emit('object-deselected'));
    }

    /**
     * Load thumbnail images for all pages into the side panel.
     */
    _loadAllThumbnails(docId, pageCount) {
        const list = document.getElementById('thumbnail-list');
        list.innerHTML = '';

        for (let i = 0; i < pageCount; i++) {
            const item = document.createElement('div');
            item.className = 'thumbnail-item' + (i === 0 ? ' active' : '');
            item.dataset.page = i;

            const img = document.createElement('img');
            img.src = `/api/documents/${docId}/thumbnail/${i}`;
            img.alt = `Page ${i + 1}`;
            img.loading = 'lazy'; // Lazy-load thumbnails for large documents

            const label = document.createElement('div');
            label.className = 'thumbnail-label';
            label.textContent = `${i + 1}`;

            // Viewport indicator canvas — red rectangle drawn over the thumbnail
            // showing which portion of the page is currently visible. Updated on
            // scroll and zoom via _updateThumbnailViewport(). pointer-events: none
            // so the canvas never intercepts thumbnail click events.
            const vpCanvas = document.createElement('canvas');
            vpCanvas.className = 'thumbnail-viewport-canvas';

            item.appendChild(img);
            item.appendChild(label);
            item.appendChild(vpCanvas);

            // Click thumbnail → navigate to that page
            item.addEventListener('click', () => {
                this.viewer.goToPage(i);
            });

            list.appendChild(item);
        }
    }

    /**
     * Draw a red viewport indicator on the active thumbnail.
     *
     * The indicator shows which portion of the full page is currently visible
     * in the main viewport. Redraws on every scroll and zoom change.
     */
    _updateThumbnailViewport() {
        const vp = this.viewer.viewport;
        if (!vp || !this.viewer.imageNaturalWidth) return;

        // Find the active thumbnail item and its overlay canvas
        const activeItem = document.querySelector('.thumbnail-item.active');
        if (!activeItem) return;
        const canvas = activeItem.querySelector('.thumbnail-viewport-canvas');
        if (!canvas) return;

        // Thumbnail image element — drives the displayed dimensions
        const thumbImg = activeItem.querySelector('img');
        const thumbW = thumbImg ? thumbImg.offsetWidth  : activeItem.offsetWidth;
        const thumbH = thumbImg ? thumbImg.offsetHeight : activeItem.offsetHeight;
        if (!thumbW || !thumbH) return;

        // Match canvas pixel size to thumbnail display size so 1 canvas px = 1 CSS px
        canvas.width  = thumbW;
        canvas.height = thumbH;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, thumbW, thumbH);

        // Scale factors: thumbnail px per natural image px, and zoom ratio
        const natW      = this.viewer.imageNaturalWidth;
        const natH      = this.viewer.imageNaturalHeight;
        const thumbScaleX = thumbW / natW;
        const thumbScaleY = thumbH / natH;
        const zoomScale   = this.viewer.zoom / 100;

        // Convert display-pixel scroll offsets → natural px → thumbnail px
        const rx = (vp.scrollLeft / zoomScale) * thumbScaleX;
        const ry = (vp.scrollTop  / zoomScale) * thumbScaleY;
        const rw = (vp.clientWidth  / zoomScale) * thumbScaleX;
        const rh = (vp.clientHeight / zoomScale) * thumbScaleY;

        // Clamp rect to canvas bounds so it doesn't overflow when near edges
        const x1 = Math.max(0, rx);
        const y1 = Math.max(0, ry);
        const x2 = Math.min(thumbW, rx + rw);
        const y2 = Math.min(thumbH, ry + rh);

        // Fill with semi-transparent red then stroke the border
        ctx.fillStyle   = 'rgba(220, 50, 50, 0.15)';
        ctx.strokeStyle = '#e03030';
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
        ctx.fill();
        ctx.stroke();
    }

    /**
     * Highlight the active thumbnail in the page panel.
     * Before switching the .active class, clear the viewport-indicator canvas
     * on the previously active thumbnail so the red box doesn't linger on old pages.
     */
    _highlightThumbnail(page) {
        const items = document.querySelectorAll('.thumbnail-item');

        // Clear red viewport box from whichever thumbnail is currently active
        items.forEach(item => {
            if (item.classList.contains('active')) {
                const oldCanvas = item.querySelector('.thumbnail-viewport-canvas');
                if (oldCanvas) {
                    const ctx = oldCanvas.getContext('2d');
                    ctx.clearRect(0, 0, oldCanvas.width, oldCanvas.height);
                }
            }
        });

        items.forEach((item, idx) => {
            item.classList.toggle('active', idx === page);
        });

        // Scroll the active thumbnail into view
        const active = document.querySelector('.thumbnail-item.active');
        if (active) {
            active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    // =========================================================================
    // PANEL COLLAPSE
    // =========================================================================

    /**
     * Wire the collapse/expand toggle buttons on the left and right side panels.
     *
     * Each panel gets a narrow 28px strip when collapsed. The active tab content
     * and tab bar are hidden via CSS (.panel-collapsed). Clicking the button
     * in the strip expands the panel back to its full 200px width.
     */
    _bindPanelCollapse() {
        const leftPanel  = document.getElementById('panel-left');
        const rightPanel = document.getElementById('panel-properties');
        const btnLeft    = document.getElementById('btn-collapse-left');
        const btnRight   = document.getElementById('btn-collapse-right');

        if (btnLeft) {
            btnLeft.addEventListener('click', () => {
                leftPanel.classList.toggle('panel-collapsed');
                // ◀ when expanded (collapse it), ▶ when collapsed (expand it)
                btnLeft.innerHTML = leftPanel.classList.contains('panel-collapsed')
                    ? '&#9654;'   // ▶ expand
                    : '&#9664;';  // ◀ collapse
                // Redraw thumbnail indicator — panel resize changes viewport geometry
                this._updateThumbnailViewport();
            });
        }

        if (btnRight) {
            btnRight.addEventListener('click', () => {
                rightPanel.classList.toggle('panel-collapsed');
                // ▶ when expanded (collapse it), ◀ when collapsed (expand it)
                btnRight.innerHTML = rightPanel.classList.contains('panel-collapsed')
                    ? '&#9664;'   // ◀ expand
                    : '&#9654;';  // ▶ collapse
                this._updateThumbnailViewport();
            });
        }
    }

    // =========================================================================
    // MARKUP PERSISTENCE
    // =========================================================================

    /**
     * Set up save-on-unload to prevent data loss.
     */
    _bindPersistence() {
        // Save markups before the tab closes or navigates away
        window.addEventListener('beforeunload', () => {
            if (this._dirty && this.docId) {
                this._saveMarkupsSync();
            }
        });
    }

    /**
     * Mark that canvas content has changed and schedule auto-save.
     * Called when objects are added, modified, or removed.
     */
    markDirty() {
        this._dirty = true;
        this._updateSaveStatus('unsaved');
        this._scheduleSave();
    }

    /**
     * Schedule a debounced auto-save (3 seconds after last change).
     * Prevents hammering the server on rapid edits.
     */
    _scheduleSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._saveMarkups(), 3000);
    }

    /**
     * Save all page markups to the server.
     *
     * Collects markups from canvas.getAllPageMarkups() and PUTs them
     * to the persistence API.
     */
    async _saveMarkups() {
        if (!this.docId) return;

        const pages = this.canvas.getAllPageMarkups();

        try {
            this._updateSaveStatus('saving');
            const resp = await fetch(`/api/documents/${this.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });

            if (!resp.ok) {
                throw new Error(`Save failed: ${resp.statusText}`);
            }

            this._dirty = false;
            this._updateSaveStatus('saved');
            console.log('[App] Markups saved');
        } catch (err) {
            console.error('[App] Failed to save markups:', err);
            this._updateSaveStatus('error');
        }
    }

    /**
     * Synchronous save for beforeunload — uses sendBeacon for reliability.
     * sendBeacon survives page unload better than fetch.
     */
    _saveMarkupsSync() {
        if (!this.docId) return;

        const pages = this.canvas.getAllPageMarkups();
        const blob = new Blob(
            [JSON.stringify({ pages })],
            { type: 'application/json' }
        );
        navigator.sendBeacon(`/api/documents/${this.docId}/markups`, blob);
    }

    /**
     * Load markups from server for the current document.
     *
     * Args:
     *   docId: Document database ID.
     */
    async _loadMarkups(docId) {
        try {
            const resp = await fetch(`/api/documents/${docId}/markups`);
            if (!resp.ok) {
                throw new Error(`Load failed: ${resp.statusText}`);
            }

            const data = await resp.json();
            if (data.pages) {
                this.canvas.loadAllPageMarkups(data.pages);
            }

            this._dirty = false;
            this._updateSaveStatus('saved');
        } catch (err) {
            console.error('[App] Failed to load markups:', err);
        }
    }

    /**
     * Update the save status indicator in the status bar.
     *
     * Args:
     *   status: 'saved' | 'unsaved' | 'saving' | 'error'
     */
    _updateSaveStatus(status) {
        const el = document.getElementById('status-message');
        if (!el) return;

        const labels = {
            saved: '',
            unsaved: 'Unsaved changes',
            saving: 'Saving...',
            error: 'Save failed',
        };
        el.textContent = labels[status] || '';
    }

    // =========================================================================
    // MARKUP LIST INTEGRATION
    // =========================================================================

    /**
     * Navigate to a specific markup: go to page, then select the object.
     *
     * Called when the user clicks a row in the markup list panel.
     * If already on the correct page, just selects the object.
     *
     * Args:
     *   page: Page number (zero-indexed).
     *   objIndex: Index of the object in the Fabric objects array.
     */
    _navigateToMarkup(page, objIndex) {
        const currentPage = this.viewer.currentPage;

        if (page !== currentPage) {
            // Navigate to the page, then select after it loads
            // Store target for post-navigation selection
            this._pendingSelect = { page, objIndex };
            this.viewer.goToPage(page);
        } else {
            // Already on the right page — select directly
            this._selectObjectByIndex(objIndex);
        }
    }

    /**
     * Select a Fabric object by its index in the objects array.
     *
     * Args:
     *   objIndex: Index of the object to select.
     */
    _selectObjectByIndex(objIndex) {
        if (!this.canvas || !this.canvas.fabricCanvas) return;

        const objects = this.canvas.fabricCanvas.getObjects();
        if (objIndex >= 0 && objIndex < objects.length) {
            // Ensure we're in select mode first (without toggle-off behavior)
            if (this.toolbar.activeTool !== 'select') {
                this.toolbar.setTool('select');
            }
            const obj = objects[objIndex];
            this.canvas.fabricCanvas.setActiveObject(obj);
            this.canvas.fabricCanvas.renderAll();
        }
    }

    /**
     * Debounced refresh of the markup list.
     * Prevents rapid rebuilds during bulk operations (undo, page load).
     */
    _scheduleListRefresh() {
        if (this._listRefreshTimer) clearTimeout(this._listRefreshTimer);
        this._listRefreshTimer = setTimeout(() => {
            this.markupList.refresh();
        }, 300);
    }

    // =========================================================================
    // AMBIENT STATUS COUNTS — Deep work dashboard
    // =========================================================================

    /**
     * Debounced update of the status bar markup counts.
     * Prevents rapid DOM updates during bulk operations.
     */
    _scheduleCountsUpdate() {
        if (this._countsTimer) clearTimeout(this._countsTimer);
        this._countsTimer = setTimeout(() => this._updateMarkupCounts(), 200);
    }

    /**
     * Update the ambient markup count indicators in the status bar.
     *
     * Scans all pages for markup type and status totals. Always visible —
     * peripheral awareness of progress without breaking flow to check a tab.
     * Newport's "Drain the Shallows" principle: the bar does the shallow
     * counting so the professional can stay in deep work.
     */
    _updateMarkupCounts() {
        if (!this.canvas) return;

        const counts = { issue: 0, question: 0, approval: 0, change: 0, open: 0, total: 0 };

        // Count objects from saved pages (all pages except the live one)
        const livePage = this.lastPage;
        for (const [page, fabricJson] of this.canvas.pageMarkups) {
            if (page === livePage) continue; // skip — we'll count live objects below
            if (!fabricJson || !fabricJson.objects) continue;
            for (const obj of fabricJson.objects) {
                counts.total++;
                const type = obj.markupType || 'note';
                if (counts[type] !== undefined) counts[type]++;
                if ((obj.markupStatus || 'open') === 'open') counts.open++;
            }
        }

        // Count live canvas objects for the current page (avoids saving side-effect)
        if (this.canvas.fabricCanvas) {
            for (const obj of this.canvas.fabricCanvas.getObjects()) {
                counts.total++;
                const type = obj.markupType || 'note';
                if (counts[type] !== undefined) counts[type]++;
                if ((obj.markupStatus || 'open') === 'open') counts.open++;
            }
        }

        // Update DOM — only show non-zero counts for types
        const setCount = (cls, val, suffix = '') => {
            const el = document.querySelector(`.${cls}`);
            if (el) {
                el.textContent = val > 0 ? `${val}${suffix}` : '';
                el.style.display = val > 0 ? '' : 'none';
            }
        };

        setCount('count-issue', counts.issue, ' issue' + (counts.issue !== 1 ? 's' : ''));
        setCount('count-question', counts.question, ' qstn' + (counts.question !== 1 ? 's' : ''));
        setCount('count-approval', counts.approval, ' appr');
        setCount('count-change', counts.change, ' chng' + (counts.change !== 1 ? 's' : ''));

        const openEl = document.querySelector('.count-open');
        if (openEl) {
            openEl.textContent = counts.total > 0 ? `${counts.open} open` : '';
            openEl.style.display = counts.total > 0 ? '' : 'none';
        }

        // Hide separator if no typed counts visible
        const sep = document.querySelector('.status-count-sep');
        if (sep) {
            const hasTypeCounts = counts.issue + counts.question + counts.approval + counts.change > 0;
            sep.style.display = hasTypeCounts ? '' : 'none';
        }
    }

    // =========================================================================
    // BLANK PAGE APPEND
    // =========================================================================

    /**
     * Append a blank page at the end of the current document.
     *
     * Saves current markups first (so they survive the viewer reload),
     * then POSTs to the API, then reloads the document and navigates to
     * the new last page.
     *
     * Only appends at end — middle insertion would shift page indices
     * and break saved markup references in the database.
     */
    async _addBlankPage() {
        if (!this.docId) return;

        const btnAddPage = document.getElementById('btn-add-page');
        const statusMsg = document.getElementById('status-message');

        // Disable button to prevent double-clicks during the async operation
        if (btnAddPage) btnAddPage.disabled = true;
        statusMsg.textContent = 'Adding page...';

        try {
            // 1. Save current markups before reloading the viewer
            await this._saveMarkups();

            // 2. Tell server to append a blank page (matches last page's dimensions)
            const resp = await fetch(`/api/documents/${this.docId}/pages/blank`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),  // empty = match last page size
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Add page failed');
            }

            const result = await resp.json();
            const newPageIndex = result.new_page_index;

            // 3. Reload the document (triggers onDocumentLoad → loadMarkups)
            await this.viewer.loadDocument(this.docId);

            // 4. Navigate to the new blank page
            this.viewer.goToPage(newPageIndex);

            statusMsg.textContent = `Page ${newPageIndex + 1} added`;

        } catch (err) {
            statusMsg.textContent = `Error: ${err.message}`;
            console.error('[App] Add blank page failed:', err);
        } finally {
            if (btnAddPage) btnAddPage.disabled = false;
        }
    }

    // =========================================================================
    // UTILITY
    // =========================================================================

    /**
     * Format bytes to human-readable file size.
     */
    _formatFileSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // =========================================================================
    // STARTUP
    // =========================================================================

    /**
     * Initialize the application.
     * If the URL contains a document ID, load it automatically.
     */
    async init() {
        console.log('[PortolanCAST] Application starting...');

        // Initialize global search panel — document-independent, so init once here.
        // Wire onNavigate: same-doc → go to page; cross-doc → full page load.
        this.search.init();
        this.search.onNavigate = (docId, pageNumber) => {
            if (docId === this.docId) {
                // Same document — navigate to the page directly
                this.viewer.goToPage(pageNumber);
            } else {
                // Different document — full navigation (reloads app with that doc)
                window.location.href = `/edit/${docId}`;
            }
        };

        // Load plugins (stub in Phase 0)
        await this.plugins.loadPlugins();

        // Register ExtendedCognition — first real plugin, proof-of-concept for framework.
        // Provides a plain-English status briefing using local Ollama when available,
        // or computed markup statistics as a fallback.
        this.plugins.register(ExtendedCognitionPlugin);

        // Register nodeCAST — Phase 1 experiment: renders markups connected by shared
        // #tags as a force-directed SVG graph in the "Graph" right-panel tab.
        // This is the origin of the nodeCAST knowledge-graph vision.
        this.plugins.register(NodeCastPlugin);

        // Register HealthMonitor — status-bar dot + right-panel Health tab.
        // Provides fast (<500 ms) self-diagnostic checks (DB, PDF engine, disk, AI)
        // and a streaming dev test runner button for the full Playwright suite.
        this.plugins.register(HealthMonitorPlugin);

        // Check if we're on an edit page (URL: /edit/{id})
        const match = window.location.pathname.match(/^\/edit\/(\d+)$/);
        if (match) {
            const docId = parseInt(match[1], 10);
            try {
                await this.viewer.loadDocument(docId);
            } catch (err) {
                console.error('[PortolanCAST] Failed to load document:', err);
                document.getElementById('status-message').textContent =
                    `Error loading document: ${err.message}`;
            }
        }

        console.log('[PortolanCAST] Ready.');
    }
}

// =============================================================================
// BOOTSTRAP
// =============================================================================

// Initialize when DOM is ready
const app = new App();
app.init();

// Expose app on window for DevTools console testing
// e.g.: app.canvas.fabricCanvas.add(new fabric.Rect({...}))
// e.g.: app.scale.formatDistance(375)  → "10.00 ft" at 1/4"=1' scale
window.app = app;
