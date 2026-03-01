/**
 * PortolanCAST — Properties Panel Module
 *
 * Purpose:
 *   Manages the right-side properties panel. Shows editable semantic metadata
 *   (markupType, markupStatus, markupNote) and visual properties (stroke color,
 *   width) when a canvas object is selected. Shows document info otherwise.
 *
 * Architecture:
 *   Listens for Fabric.js selection events on the canvas. When an object is
 *   selected, populates the panel form controls from the object's properties.
 *   When the user changes a value, updates the object immediately. Changes
 *   fire onPropertyChange so app.js can trigger dirty tracking and auto-save.
 *
 * Design principle (Norman — visibility):
 *   "State is visible" — the panel answers "what is this markup?" at a glance.
 *   One click to change type or status. Every markup carries semantic meaning.
 *
 * Security:
 *   - User input to markupNote is stored as a plain string on the Fabric object
 *   - No HTML rendering of note content (XSS safe)
 *   - Values are validated against known option sets before applying
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-16
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Human-readable labels for Fabric.js 6 PascalCase type names.
 * Shown in the "Object" row so users see "Rectangle" not "Rect".
 */
const TYPE_LABELS = {
    // Fabric.js 6 live objects use lowercase type, serialized JSON uses PascalCase
    'rect': 'Rectangle',   'Rect': 'Rectangle',
    'ellipse': 'Ellipse',  'Ellipse': 'Ellipse',
    'line': 'Line',        'Line': 'Line',
    'path': 'Pen Stroke',  'Path': 'Pen Stroke',
    'circle': 'Circle',    'Circle': 'Circle',
    'polygon': 'Polygon',  'Polygon': 'Polygon',
    'polyline': 'Polyline', 'Polyline': 'Polyline',
    'group': 'Callout',    'Group': 'Callout',
    'i-text': 'Text',      'IText': 'Text',
    'textbox': 'Text',     'Textbox': 'Text',
};

import { MARKUP_COLORS } from './canvas.js';

// =============================================================================
// TAG PARSING
// =============================================================================

/**
 * Extract hashtags from a markup note string.
 *
 * Tags are #word patterns: alphanumeric + dash/underscore, no spaces.
 * Returns a deduplicated, lowercase array in order of first appearance.
 *
 * Examples:
 *   parseTags('Beam clash at grid C-4 #structural #urgent') → ['structural', 'urgent']
 *   parseTags('see #RFI-042 and #rfi-042') → ['rfi-042']  (deduped, lowercased)
 *   parseTags('') → []
 *
 * Args:
 *   note: Raw markupNote string from a Fabric object.
 *
 * Returns:
 *   string[] — deduplicated lowercase tag names (without the # prefix).
 */
function parseTags(note) {
    if (!note) return [];
    const matches = [...note.matchAll(/#([a-zA-Z0-9_-]+)/g)];
    const seen = new Set();
    return matches
        .map(m => m[1].toLowerCase())
        .filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
}

/** Valid markupType values — matches the <select> options in editor.html */
const VALID_MARKUP_TYPES = ['note', 'issue', 'question', 'approval', 'change'];

/** Valid markupStatus values */
const VALID_MARKUP_STATUSES = ['open', 'resolved'];

// =============================================================================
// PROPERTIES PANEL
// =============================================================================

/**
 * Manages the properties panel UI and syncs it with the selected canvas object.
 *
 * Usage:
 *   const props = new PropertiesPanel();
 *   props.init(canvas);  // after canvas is initialized
 */
export class PropertiesPanel {
    constructor() {
        /** @type {import('./canvas.js').CanvasOverlay|null} */
        this.canvas = null;

        /** @type {fabric.Object|null} Currently selected Fabric object */
        this._selectedObject = null;

        /**
         * Callback fired when a property is changed via the panel.
         * App.js wires this to markDirty() for auto-save.
         * @type {Function|null}
         */
        this.onPropertyChange = null;

        /**
         * Current document ID — injected by app.js after init() so photo
         * API calls can be scoped to the correct document.
         * @type {number|null}
         */
        this.docId = null;

        // Cache DOM references — set in init()
        this._els = {};
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the properties panel.
     *
     * Caches DOM element references, binds input change handlers, and
     * registers Fabric.js selection event listeners on the canvas.
     *
     * Args:
     *   canvas: CanvasOverlay instance (must have fabricCanvas initialized).
     */
    init(canvas) {
        this.canvas = canvas;

        // Cache DOM element references for fast access
        this._els = {
            markupProps: document.getElementById('markup-props'),
            markupSemanticProps: document.getElementById('markup-semantic-props'),
            measurementProps: document.getElementById('measurement-props'),
            docInfo: document.getElementById('doc-info'),
            objType: document.getElementById('prop-obj-type'),
            markupType: document.getElementById('prop-markup-type'),
            markupStatus: document.getElementById('prop-markup-status'),
            markupNote: document.getElementById('prop-markup-note'),
            markupAuthor: document.getElementById('prop-markup-author'),
            markupTimestamp: document.getElementById('prop-markup-timestamp'),
            strokeColor: document.getElementById('prop-stroke-color'),
            strokeWidth: document.getElementById('prop-stroke-width'),
            strokeWidthVal: document.getElementById('prop-stroke-width-val'),
            // Measurement-specific display elements
            measureLabel: document.getElementById('measure-label'),
            measureValue: document.getElementById('measure-value'),
            measureSecondaryRow: document.getElementById('measure-secondary-row'),
            measureSecondaryLabel: document.getElementById('measure-secondary-label'),
            measureSecondaryValue: document.getElementById('measure-secondary-value'),
            measureScaleLabel: document.getElementById('measure-scale-label'),
            // Photo attachment elements
            photoSection:   document.getElementById('markup-photos-section'),
            photoGrid:      document.getElementById('markup-photos-grid'),
            photoAttachBtn: document.getElementById('btn-attach-photo'),
            photoFileInput: document.getElementById('photo-file-input'),
            // Tag display — shows parsed #tags from the note field as chips
            tagDisplay: document.getElementById('prop-markup-tags'),
        };

        this._bindInputHandlers();
        this._bindCanvasEvents();

        console.log('[Properties] Panel initialized');
    }

    // =========================================================================
    // INPUT HANDLERS — User changes a property value
    // =========================================================================

    /**
     * Bind change/input event handlers on the property form controls.
     * When the user changes a value, update the selected Fabric object.
     */
    _bindInputHandlers() {
        // Markup type dropdown — changing type also updates stroke color
        // Color-as-meaning: type change = color change (visual confirms intent)
        this._els.markupType.addEventListener('change', (e) => {
            if (!this._selectedObject) return;
            const val = e.target.value;
            if (!VALID_MARKUP_TYPES.includes(val)) return;
            this._selectedObject.markupType = val;
            // Update stroke color to match the new type
            const newColor = MARKUP_COLORS[val] || MARKUP_COLORS.note;
            this._selectedObject.set('stroke', newColor);
            // Highlighter stores color in fill (not stroke) — keep both in sync
            // so changing the type visually changes the highlight color.
            // Only non-transparent fills qualify — rects/ellipses use 'transparent'.
            if (this._selectedObject.fill && this._selectedObject.fill !== 'transparent') {
                this._selectedObject.set('fill', newColor);
            }
            this._els.strokeColor.value = newColor;
            this.canvas.fabricCanvas.renderAll();
            this._fireChange();
        });

        // Markup status dropdown
        this._els.markupStatus.addEventListener('change', (e) => {
            if (!this._selectedObject) return;
            const val = e.target.value;
            if (!VALID_MARKUP_STATUSES.includes(val)) return;
            this._selectedObject.markupStatus = val;
            this._fireChange();
        });

        // Markup note textarea — update on input (live) for responsiveness.
        // Also live-updates tag chips so the user sees tags appear as they type #word.
        this._els.markupNote.addEventListener('input', (e) => {
            if (!this._selectedObject) return;
            this._selectedObject.markupNote = e.target.value;
            this._renderTagChips(parseTags(e.target.value));
            this._fireChange();
        });

        // Stroke color picker
        this._els.strokeColor.addEventListener('input', (e) => {
            if (!this._selectedObject) return;
            const color = e.target.value;
            this._selectedObject.set('stroke', color);
            // Highlighter stores color in fill — update fill so the picker works on it
            if (this._selectedObject.fill && this._selectedObject.fill !== 'transparent') {
                this._selectedObject.set('fill', color);
            }
            this.canvas.fabricCanvas.renderAll();
            this._fireChange();
        });

        // Stroke width slider
        this._els.strokeWidth.addEventListener('input', (e) => {
            if (!this._selectedObject) return;
            const width = parseInt(e.target.value, 10);
            this._els.strokeWidthVal.textContent = width;
            this._selectedObject.set('strokeWidth', width);
            this.canvas.fabricCanvas.renderAll();
            this._fireChange();
        });
    }

    // =========================================================================
    // CANVAS SELECTION EVENTS
    // =========================================================================

    /**
     * Register Fabric.js selection event listeners.
     *
     * selection:created — user selects an object (click or marquee)
     * selection:updated — user changes selection to a different object
     * selection:cleared — user clicks away, deselecting
     */
    _bindCanvasEvents() {
        if (!this.canvas || !this.canvas.fabricCanvas) return;

        const fc = this.canvas.fabricCanvas;

        fc.on('selection:created', (e) => {
            this._onSelect(e.selected ? e.selected[0] : null);
        });

        fc.on('selection:updated', (e) => {
            this._onSelect(e.selected ? e.selected[0] : null);
        });

        fc.on('selection:cleared', () => {
            this._onDeselect();
        });
    }

    // =========================================================================
    // PANEL STATE MANAGEMENT
    // =========================================================================

    /**
     * Handle object selection — populate the panel with the object's properties.
     *
     * Routes to _showMeasurementProps() for measurement objects (those with
     * obj.measurementType set) or to the markup properties form for standard
     * annotation objects.
     *
     * Args:
     *   obj: Fabric.js object that was selected, or null.
     */
    _onSelect(obj) {
        if (!obj) {
            this._onDeselect();
            return;
        }

        this._selectedObject = obj;

        // Route based on object category
        if (obj.measurementType) {
            this._showMeasurementProps(obj);
        } else {
            this._showMarkupProps(obj);
        }
    }

    /**
     * Populate the panel for measurement objects (distance, area, count).
     *
     * Shows the #measurement-props section with live-computed values using
     * the current scale. Hides the semantic markup fields (type/status/note)
     * but keeps the appearance section (color/width) visible.
     *
     * Values are always computed live from stored pixelLength/pixelArea so
     * changing the drawing scale updates the panel display immediately.
     *
     * Args:
     *   obj: Fabric measurement object with obj.measurementType set.
     */
    _showMeasurementProps(obj) {
        // Show markup-props for the Appearance section (color/width)
        this._els.markupProps.style.display = 'block';
        this._els.docInfo.style.display = 'none';

        // Hide semantic fields — type/status/note don't apply to measurements
        if (this._els.markupSemanticProps) {
            this._els.markupSemanticProps.style.display = 'none';
        }

        // Show the measurement-specific display section
        if (this._els.measurementProps) {
            this._els.measurementProps.style.display = 'block';
        }

        // Show current scale label
        if (this._els.measureScaleLabel) {
            const scale = this.scale;
            this._els.measureScaleLabel.textContent = scale
                ? scale.displayLabel
                : 'Unscaled';
        }

        // Hide secondary row by default — only shown for count
        if (this._els.measureSecondaryRow) {
            this._els.measureSecondaryRow.style.display = 'none';
        }

        const scale = this.scale;

        switch (obj.measurementType) {
            case 'distance': {
                if (this._els.measureLabel) this._els.measureLabel.textContent = 'Distance:';
                const formatted = scale && obj.pixelLength != null
                    ? scale.formatDistance(obj.pixelLength)
                    : (obj.labelText || '—');
                if (this._els.measureValue) this._els.measureValue.textContent = formatted;
                break;
            }

            case 'area': {
                if (this._els.measureLabel) this._els.measureLabel.textContent = 'Area:';
                const formatted = scale && obj.pixelArea != null
                    ? scale.formatArea(obj.pixelArea)
                    : (obj.labelText || '—');
                if (this._els.measureValue) this._els.measureValue.textContent = formatted;
                break;
            }

            case 'count': {
                if (this._els.measureLabel) this._els.measureLabel.textContent = 'Marker:';
                if (this._els.measureValue) {
                    this._els.measureValue.textContent = `#${obj.countIndex || '?'}`;
                }

                // Secondary row: total count on this page
                if (this._els.measureSecondaryRow && this.canvas && this.canvas.fabricCanvas) {
                    const total = this.canvas.fabricCanvas.getObjects()
                        .filter(o => o.measurementType === 'count').length;
                    this._els.measureSecondaryLabel.textContent = 'Total on page:';
                    this._els.measureSecondaryValue.textContent = total;
                    this._els.measureSecondaryRow.style.display = '';
                }
                break;
            }

            default:
                if (this._els.measureValue) this._els.measureValue.textContent = '—';
        }

        // Populate appearance controls (color/width still useful for measurements)
        this._els.strokeColor.value = this._toHexColor(obj.stroke) || '#00ccff';
        const sw = obj.strokeWidth || 2;
        this._els.strokeWidth.value = sw;
        this._els.strokeWidthVal.textContent = sw;
    }

    /**
     * Populate the panel for standard markup objects (pen, rect, ellipse, etc.).
     *
     * Shows the semantic fields (type/status/note), appearance controls, and
     * read-only provenance. Hides the measurement panel.
     *
     * Args:
     *   obj: Fabric markup object with obj.markupType set.
     */
    _showMarkupProps(obj) {
        // Ensure the object has semantic defaults if it was created before
        // the metadata system existed (e.g. loaded from old saves)
        if (!obj.markupType) {
            this.canvas.stampDefaults(obj);
        } else if (!obj.markupId && typeof obj.set === 'function') {
            // Legacy object: has markupType (new enough) but no markupId (pre-photo feature).
            // Guard with typeof obj.set === 'function' to skip synthetic plain-object events
            // (e.g. plugin tests that fire selection:created with non-Fabric objects).
            // stampDefaults() is idempotent — only fills in missing fields.
            this.canvas.stampDefaults(obj);
            // Fire dirty callback so the new markupId is saved before the user can
            // attach a photo — prevents orphaned photos on browser close.
            this._fireChange();
        }

        // Show markup panel, hide doc info and measurement panel
        this._els.markupProps.style.display = 'block';
        this._els.docInfo.style.display = 'none';

        // Restore semantic fields visibility (may have been hidden by measurement switch)
        if (this._els.markupSemanticProps) {
            this._els.markupSemanticProps.style.display = '';
        }

        // Hide measurement panel
        if (this._els.measurementProps) {
            this._els.measurementProps.style.display = 'none';
        }

        // Populate controls from object properties
        this._els.objType.textContent = TYPE_LABELS[obj.type] || obj.type || '—';
        this._els.markupType.value = obj.markupType || 'note';
        this._els.markupStatus.value = obj.markupStatus || 'open';
        this._els.markupNote.value = obj.markupNote || '';

        // Read-only provenance — show author and formatted creation time
        if (this._els.markupAuthor) {
            this._els.markupAuthor.textContent = obj.markupAuthor || 'User';
        }
        if (this._els.markupTimestamp) {
            if (obj.markupTimestamp) {
                // Format ISO timestamp to locale-aware short form, e.g. "2/22/2026, 7:15 AM"
                try {
                    const d = new Date(obj.markupTimestamp);
                    this._els.markupTimestamp.textContent = d.toLocaleString(
                        undefined,
                        { month: 'numeric', day: 'numeric', year: 'numeric',
                          hour: 'numeric', minute: '2-digit' }
                    );
                } catch {
                    this._els.markupTimestamp.textContent = obj.markupTimestamp;
                }
            } else {
                this._els.markupTimestamp.textContent = '—';
            }
        }

        // Visual properties
        this._els.strokeColor.value = this._toHexColor(obj.stroke) || '#ff0000';
        const sw = obj.strokeWidth || 2;
        this._els.strokeWidth.value = sw;
        this._els.strokeWidthVal.textContent = sw;

        // Render tag chips derived from the current note (live feedback)
        this._renderTagChips(parseTags(obj.markupNote));

        // Show photo section and load photos for this markup
        if (this._els.photoSection) {
            this._els.photoSection.style.display = '';
            this._loadPhotos(obj.markupId);
        }
    }

    /**
     * Handle deselection — hide markup and measurement panels, show doc info.
     */
    _onDeselect() {
        this._selectedObject = null;
        this._els.markupProps.style.display = 'none';
        if (this._els.measurementProps) {
            this._els.measurementProps.style.display = 'none';
        }

        // Clear tag chips
        this._renderTagChips([]);

        // Hide photo section and clear thumbnails
        if (this._els.photoSection) {
            this._els.photoSection.style.display = 'none';
        }
        if (this._els.photoGrid) {
            while (this._els.photoGrid.firstChild) {
                this._els.photoGrid.removeChild(this._els.photoGrid.firstChild);
            }
        }

        // Show doc info if a document is loaded
        if (this._els.docInfo) {
            const hasDoc = document.getElementById('prop-filename')?.textContent !== '—';
            this._els.docInfo.style.display = hasDoc ? 'block' : 'none';
        }
    }

    // =========================================================================
    // TAG CHIPS
    // =========================================================================

    /**
     * Render tag chips in the properties panel tag display area.
     *
     * Chips are derived from parseTags(markupNote) — they are display-only.
     * Users add or remove tags by editing the note text directly.
     *
     * Called on:
     *   - _showMarkupProps()      — initial render when an object is selected
     *   - markupNote 'input' handler — live update as the user types
     *   - _onDeselect()           — clear chips on deselection (called with [])
     *
     * Args:
     *   tags: Array of tag strings (without # prefix). Empty array clears chips.
     *
     * Security: all text is set via textContent — never innerHTML.
     */
    _renderTagChips(tags) {
        const container = this._els.tagDisplay;
        if (!container) return;

        // Clear existing chips
        while (container.firstChild) container.removeChild(container.firstChild);

        for (const tag of tags) {
            const chip = document.createElement('span');
            chip.className = 'prop-tag';
            chip.textContent = '#' + tag;  // SECURITY: textContent, never innerHTML
            container.appendChild(chip);
        }
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    /**
     * Fire the property change callback (for dirty tracking).
     */
    _fireChange() {
        if (this.onPropertyChange) this.onPropertyChange();
    }

    /**
     * Convert a CSS color string to a hex color value for the color input.
     * Handles common formats: hex (#rgb, #rrggbb), named colors, rgb().
     *
     * Args:
     *   color: CSS color string or null.
     *
     * Returns:
     *   string — hex color like '#ff0000', or '#ff0000' as fallback.
     */
    _toHexColor(color) {
        if (!color) return '#ff0000';
        // Already a hex color
        if (color.startsWith('#')) {
            // Expand #rgb to #rrggbb
            if (color.length === 4) {
                return '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
            }
            return color;
        }
        // rgb(r,g,b) format
        const rgbMatch = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (rgbMatch) {
            const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
            const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
            const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        }
        // Named color fallback — create a temp element to resolve
        const temp = document.createElement('span');
        temp.style.color = color;
        document.body.appendChild(temp);
        const computed = getComputedStyle(temp).color;
        document.body.removeChild(temp);
        if (computed) return this._toHexColor(computed);
        return '#ff0000';
    }

    /**
     * Re-bind canvas events after canvas re-initialization.
     * Called when a new document is loaded and canvas.init() creates a new
     * Fabric canvas instance.
     */
    rebind() {
        this._onDeselect();
        this._bindCanvasEvents();
    }

    // =========================================================================
    // PHOTO ATTACHMENT
    // =========================================================================

    /**
     * Fetch and render all photos for a markup object.
     *
     * No-ops silently if docId is not set (no document open) or if markupId
     * is missing (happens for measurement objects, which never call this).
     *
     * Args:
     *   markupId: The markupId UUID on the Fabric canvas object.
     */
    async _loadPhotos(markupId) {
        if (!this.docId || !markupId) return;
        const grid = this._els.photoGrid;
        if (!grid) return;

        // Clear while loading
        while (grid.firstChild) grid.removeChild(grid.firstChild);

        try {
            const resp = await fetch(
                `/api/documents/${this.docId}/markup-photos/${encodeURIComponent(markupId)}`
            );
            if (!resp.ok) throw new Error(resp.statusText);
            const data = await resp.json();
            this._renderPhotos(data.photos || [], markupId);
        } catch (err) {
            console.error('[Properties] Failed to load photos:', err);
        }
    }

    /**
     * Render photo thumbnails into the grid and wire the attach/delete buttons.
     *
     * All text content set via textContent — never innerHTML (XSS safe even
     * if description text comes from an untrusted source).
     *
     * Args:
     *   photos:   Array of { photo_id, url, description, created_at }.
     *   markupId: Used to reload after upload or delete.
     */
    _renderPhotos(photos, markupId) {
        const grid = this._els.photoGrid;
        if (!grid) return;

        while (grid.firstChild) grid.removeChild(grid.firstChild);

        for (const photo of photos) {
            const thumb = document.createElement('div');
            thumb.className = 'photo-thumb';

            // Thumbnail image — lazy-loaded, opens full-size on click
            const img = document.createElement('img');
            img.src = photo.url;
            img.alt = photo.description || 'Photo attachment';
            img.loading = 'lazy';
            img.title = 'Click to open full-size';
            img.addEventListener('click', () => window.open(photo.url, '_blank'));
            thumb.appendChild(img);

            // Optional caption
            if (photo.description) {
                const cap = document.createElement('div');
                cap.className = 'photo-caption';
                cap.textContent = photo.description;  // SECURITY: textContent
                thumb.appendChild(cap);
            }

            // Delete button (×)
            const delBtn = document.createElement('button');
            delBtn.className = 'photo-delete-btn';
            delBtn.title = 'Remove this photo';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();  // don't trigger full-size open
                this._deletePhoto(photo.photo_id, markupId);
            });
            thumb.appendChild(delBtn);

            grid.appendChild(thumb);
        }

        // Wire "Attach Photo" button for this markup
        if (this._els.photoAttachBtn) {
            // Replace onclick each selection to capture the current markupId
            this._els.photoAttachBtn.onclick = () => {
                if (this._els.photoFileInput) {
                    this._els.photoFileInput.click();
                }
            };
        }

        if (this._els.photoFileInput) {
            // Replace onchange to capture current markupId in the closure
            this._els.photoFileInput.onchange = (e) => this._uploadPhoto(e, markupId);
        }
    }

    /**
     * Upload a photo file for the currently selected markup.
     *
     * Sends a multipart POST to /api/documents/{docId}/markup-photos.
     * Reloads the photo grid after successful upload.
     *
     * Note: Do NOT set Content-Type manually — the browser sets it with
     * the correct multipart boundary when using FormData.
     *
     * Args:
     *   event:    The file input 'change' event.
     *   markupId: The target markup's UUID.
     */
    async _uploadPhoto(event, markupId) {
        if (!this.docId || !markupId) return;
        const file = event.target.files?.[0];
        if (!file) return;

        // Reset input so the same file can be re-selected immediately after
        event.target.value = '';

        const formData = new FormData();
        formData.append('markup_id', markupId);
        formData.append('photo', file);
        formData.append('description', '');

        try {
            const resp = await fetch(
                `/api/documents/${this.docId}/markup-photos`,
                { method: 'POST', body: formData }
            );
            if (!resp.ok) {
                const detail = await resp.text();
                throw new Error(`Upload failed: ${detail}`);
            }
            // Reload to show the new thumbnail
            this._loadPhotos(markupId);
        } catch (err) {
            console.error('[Properties] Photo upload failed:', err);
        }
    }

    /**
     * Delete a photo from the server and reload the grid.
     *
     * Args:
     *   photoId:  UUID of the photo to delete.
     *   markupId: Used to reload the grid after deletion.
     */
    async _deletePhoto(photoId, markupId) {
        if (!this.docId) return;
        try {
            const resp = await fetch(
                `/api/documents/${this.docId}/markup-photos/${photoId}`,
                { method: 'DELETE' }
            );
            if (!resp.ok) throw new Error(resp.statusText);
            // Reload grid after deletion
            this._loadPhotos(markupId);
        } catch (err) {
            console.error('[Properties] Photo delete failed:', err);
        }
    }
}
