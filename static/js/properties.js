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
    // Image overlay: fabric.Image type names (live lowercase, serialized PascalCase)
    'image': 'Image',      'Image': 'Image',
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
            // Typography section — shown only for IText / Textbox objects
            typographySection: document.getElementById('markup-typography'),
            fontFamily:       document.getElementById('prop-font-family'),
            fontSize:         document.getElementById('prop-font-size'),
            fontBold:         document.getElementById('prop-font-bold'),
            fontItalic:       document.getElementById('prop-font-italic'),
            fontUnderline:    document.getElementById('prop-font-underline'),
            fontStrikethrough:document.getElementById('prop-font-strikethrough'),
            textAlignLeft:    document.getElementById('prop-text-align-left'),
            textAlignCenter:  document.getElementById('prop-text-align-center'),
            textAlignRight:   document.getElementById('prop-text-align-right'),
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

        // ── Typography handlers (IText / Textbox only) ───────────────────────
        // These are always bound but only visible when a text object is selected.
        // Changes persist to localStorage so the next text placement inherits them.

        // Font family — dropdown change applies immediately to the selected text
        this._els.fontFamily?.addEventListener('change', (e) => {
            if (!this._selectedObject) return;
            this._selectedObject.set('fontFamily', e.target.value);
            this.canvas.fabricCanvas.renderAll();
            this._saveTextPrefs();
            this._fireChange();
        });

        // Font size — clamped to safe range (8–200px); enforced on change not input
        // so the user can type a full number without mid-digit clamping.
        this._els.fontSize?.addEventListener('change', (e) => {
            if (!this._selectedObject) return;
            const sz = Math.max(8, Math.min(200, parseInt(e.target.value, 10) || 16));
            this._els.fontSize.value = sz;  // write back the clamped value
            this._selectedObject.set('fontSize', sz);
            this.canvas.fabricCanvas.renderAll();
            this._saveTextPrefs();
            this._fireChange();
        });

        // Bold toggle — flips between 'bold' and 'normal'; reflects state in CSS .active
        this._els.fontBold?.addEventListener('click', () => {
            if (!this._selectedObject) return;
            const isBold = this._selectedObject.fontWeight === 'bold'
                || this._selectedObject.fontWeight === '700';
            this._selectedObject.set('fontWeight', isBold ? 'normal' : 'bold');
            this._els.fontBold.classList.toggle('active', !isBold);
            this.canvas.fabricCanvas.renderAll();
            this._saveTextPrefs();
            this._fireChange();
        });

        // Italic toggle — flips between 'italic' and 'normal'; reflects state in .active
        this._els.fontItalic?.addEventListener('click', () => {
            if (!this._selectedObject) return;
            const isItalic = this._selectedObject.fontStyle === 'italic';
            this._selectedObject.set('fontStyle', isItalic ? 'normal' : 'italic');
            this._els.fontItalic.classList.toggle('active', !isItalic);
            this.canvas.fabricCanvas.renderAll();
            this._saveTextPrefs();
            this._fireChange();
        });

        // Underline toggle — Fabric.js uses boolean `underline` property
        this._els.fontUnderline?.addEventListener('click', () => {
            if (!this._selectedObject) return;
            const isUnderline = this._selectedObject.underline === true;
            this._selectedObject.set('underline', !isUnderline);
            this._els.fontUnderline.classList.toggle('active', !isUnderline);
            this.canvas.fabricCanvas.renderAll();
            this._saveTextPrefs();
            this._fireChange();
        });

        // Strikethrough toggle — Fabric.js uses `linethrough` (one word, not camelCase)
        this._els.fontStrikethrough?.addEventListener('click', () => {
            if (!this._selectedObject) return;
            const isStrike = this._selectedObject.linethrough === true;
            this._selectedObject.set('linethrough', !isStrike);
            this._els.fontStrikethrough.classList.toggle('active', !isStrike);
            this.canvas.fabricCanvas.renderAll();
            this._saveTextPrefs();
            this._fireChange();
        });

        // Text alignment — mutually exclusive: left, center, right
        ['left', 'center', 'right'].forEach(align => {
            const btn = this._els[`textAlign${align.charAt(0).toUpperCase() + align.slice(1)}`];
            btn?.addEventListener('click', () => {
                if (!this._selectedObject) return;
                this._selectedObject.set('textAlign', align);
                this._els.textAlignLeft?.classList.toggle('active', align === 'left');
                this._els.textAlignCenter?.classList.toggle('active', align === 'center');
                this._els.textAlignRight?.classList.toggle('active', align === 'right');
                this.canvas.fabricCanvas.renderAll();
                this._saveTextPrefs();
                this._fireChange();
            });
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

            case 'polylength': {
                if (this._els.measureLabel) this._els.measureLabel.textContent = 'Path Length:';
                const plFormatted = scale && obj.pixelLength != null
                    ? scale.formatDistance(obj.pixelLength)
                    : (obj.labelText || '—');
                if (this._els.measureValue) this._els.measureValue.textContent = plFormatted;
                break;
            }

            case 'perimeter': {
                if (this._els.measureLabel) this._els.measureLabel.textContent = 'Perimeter:';
                const pmFormatted = scale && obj.pixelLength != null
                    ? scale.formatDistance(obj.pixelLength)
                    : (obj.labelText || '—');
                if (this._els.measureValue) this._els.measureValue.textContent = pmFormatted;
                break;
            }

            case 'angle': {
                if (this._els.measureLabel) this._els.measureLabel.textContent = 'Angle:';
                if (this._els.measureValue) {
                    this._els.measureValue.textContent = obj.angleDegrees != null
                        ? `${obj.angleDegrees.toFixed(1)}°`
                        : (obj.labelText || '—');
                }
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
        // Highlighter stores its visible color in fill (not stroke), so read
        // fill for non-transparent filled objects, stroke for everything else.
        const displayColor = (obj.fill && obj.fill !== 'transparent')
            ? this._toHexColor(obj.fill)
            : this._toHexColor(obj.stroke);
        this._els.strokeColor.value = displayColor || '#ff0000';
        const sw = obj.strokeWidth || 2;
        this._els.strokeWidth.value = sw;
        this._els.strokeWidthVal.textContent = sw;

        // Render tag chips derived from the current note (live feedback)
        this._renderTagChips(parseTags(obj.markupNote));

        // Typography section — only shown for IText/Textbox; hidden for all shapes.
        // Fabric.js 6 live objects report 'i-text'/'textbox' (lowercase); serialized
        // JSON uses PascalCase 'IText'/'Textbox'. Guard for both.
        const isTextObj = obj.type === 'i-text' || obj.type === 'textbox'
            || obj.type === 'IText' || obj.type === 'Textbox';
        if (this._els.typographySection) {
            this._els.typographySection.style.display = isTextObj ? '' : 'none';
        }
        if (isTextObj) {
            // Populate controls from the object's current state
            if (this._els.fontFamily) {
                this._els.fontFamily.value = obj.fontFamily || 'Arial, sans-serif';
            }
            if (this._els.fontSize) {
                this._els.fontSize.value = obj.fontSize || 16;
            }
            if (this._els.fontBold) {
                const isBold = obj.fontWeight === 'bold' || obj.fontWeight === '700';
                this._els.fontBold.classList.toggle('active', isBold);
            }
            if (this._els.fontItalic) {
                this._els.fontItalic.classList.toggle('active', obj.fontStyle === 'italic');
            }
            if (this._els.fontUnderline) {
                this._els.fontUnderline.classList.toggle('active', obj.underline === true);
            }
            if (this._els.fontStrikethrough) {
                this._els.fontStrikethrough.classList.toggle('active', obj.linethrough === true);
            }
            // Alignment — default to 'left' when not set
            const align = obj.textAlign || 'left';
            this._els.textAlignLeft?.classList.toggle('active', align === 'left');
            this._els.textAlignCenter?.classList.toggle('active', align === 'center');
            this._els.textAlignRight?.classList.toggle('active', align === 'right');
        }

        // Show photo section and load photos for this markup
        if (this._els.photoSection) {
            this._els.photoSection.style.display = '';
            this._loadPhotos(obj.markupId);
        }

        // Load entity section — checks if this markup is already linked to an entity.
        // pageNumber comes from the canvas overlay's currentPage property.
        const pageNumber = this.canvas?.currentPage ?? 0;
        this._loadEntitySection(obj.markupId, this.docId, pageNumber);
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

        // Hide typography section — only relevant when a text object is selected
        if (this._els.typographySection) {
            this._els.typographySection.style.display = 'none';
        }

        // Hide photo section and clear thumbnails
        if (this._els.photoSection) {
            this._els.photoSection.style.display = 'none';
        }
        if (this._els.photoGrid) {
            while (this._els.photoGrid.firstChild) {
                this._els.photoGrid.removeChild(this._els.photoGrid.firstChild);
            }
        }

        // Hide entity section — reset to neutral state for next selection
        const entitySection = document.getElementById('entity-section');
        if (entitySection) entitySection.style.display = 'none';
        this._entityMarkupId = null;
        this._entityPageNumber = null;

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
     * Persist current text object's typography properties to localStorage.
     *
     * toolbar.js reads 'portolancast-text-prefs' when placing new IText objects
     * so newly created text inherits the last-used font settings. Silently
     * ignores storage quota errors — prefs are a convenience, not critical data.
     *
     * Called by all four typography event handlers (fontFamily, fontSize,
     * fontBold, fontItalic) after each change.
     */
    _saveTextPrefs() {
        if (!this._selectedObject) return;
        const prefs = {
            fontFamily:  this._selectedObject.fontFamily  || 'Arial, sans-serif',
            fontSize:    this._selectedObject.fontSize    || 16,
            fontWeight:  this._selectedObject.fontWeight  || 'normal',
            fontStyle:   this._selectedObject.fontStyle   || 'normal',
            underline:   this._selectedObject.underline   || false,
            linethrough: this._selectedObject.linethrough || false,
            textAlign:   this._selectedObject.textAlign   || 'left',
        };
        try {
            localStorage.setItem('portolancast-text-prefs', JSON.stringify(prefs));
        } catch {
            // Silently absorb QuotaExceededError — non-critical preference storage
        }
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

    // =========================================================================
    // ENTITY SECTION (Stage 3 — Equipment Intelligence)
    // =========================================================================

    /**
     * Load and render the entity section for a selected markup.
     *
     * Checks whether this markup is already linked to an entity, then renders
     * the appropriate state:
     *   State 1 — unlinked: show tag input + Promote button
     *   State 3 — linked:   show tag chip + View/Unlink buttons
     *
     * (State 2, the merge prompt, is triggered by _promoteMarkup() on 409.)
     *
     * Args:
     *   markupId: The markupId UUID on the Fabric canvas object.
     *   docId:    The current document ID.
     *   pageNumber: Current 0-indexed page number (needed for the link API call).
     */
    async _loadEntitySection(markupId, docId, pageNumber) {
        const section = document.getElementById('entity-section');
        if (!section || !markupId || !docId) return;

        section.style.display = '';

        // Reset all inner states before the async fetch — prevents stale UI
        // from a previous selection leaking through during the network round-trip
        const unlinked = document.getElementById('entity-unlinked');
        const linked = document.getElementById('entity-linked-view');
        const merge = document.getElementById('entity-merge-prompt');
        if (unlinked) unlinked.style.display = 'none';
        if (linked) linked.style.display = 'none';
        if (merge) merge.style.display = 'none';

        // Store context for event handlers — captured in closures below
        this._entityMarkupId = markupId;
        this._entityPageNumber = pageNumber;

        try {
            const resp = await fetch(
                `/api/documents/${docId}/markup-entities/${encodeURIComponent(markupId)}`
            );
            if (!resp.ok) throw new Error(resp.statusText);
            const data = await resp.json();

            if (data.entity) {
                this._renderEntityLinked(data.entity);
            } else {
                this._renderEntityUnlinked();
            }
        } catch (err) {
            console.error('[Properties] Failed to load entity section:', err);
            // On error show unlinked state — safer than hiding the section entirely
            this._renderEntityUnlinked();
        }
    }

    /**
     * Render State 1: no entity linked.
     * Shows the tag number input and "Promote to Entity" button.
     */
    _renderEntityUnlinked() {
        document.getElementById('entity-unlinked')?.style && (document.getElementById('entity-unlinked').style.display = '');
        document.getElementById('entity-merge-prompt').style.display = 'none';
        document.getElementById('entity-linked-view').style.display = 'none';

        // Clear input
        const input = document.getElementById('entity-tag-input');
        if (input) input.value = '';

        // Wire Promote button — replace onclick each time to capture current markupId
        const promoteBtn = document.getElementById('entity-promote-btn');
        if (promoteBtn) {
            promoteBtn.onclick = () => {
                const tag = document.getElementById('entity-tag-input')?.value?.trim();
                if (tag) this._promoteMarkup(tag);
            };
        }

        // Allow Enter key in the tag input to trigger Promote
        const tagInput = document.getElementById('entity-tag-input');
        if (tagInput) {
            tagInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    const tag = tagInput.value.trim();
                    if (tag) this._promoteMarkup(tag);
                }
            };
        }
    }

    /**
     * Render State 3: entity is linked to this markup.
     *
     * Shows the entity tag chip with type subtitle, plus View and Unlink buttons.
     *
     * Args:
     *   entity: Entity dict { id, tag_number, equip_type, ... }
     */
    _renderEntityLinked(entity) {
        document.getElementById('entity-unlinked').style.display = 'none';
        document.getElementById('entity-merge-prompt').style.display = 'none';
        const view = document.getElementById('entity-linked-view');
        view.style.display = '';

        // Tag chip text — show tag + type if available
        const chipText = document.getElementById('entity-chip-text');
        if (chipText) {
            // SECURITY: textContent only — entity data is DB-stored but still sanitize display
            chipText.textContent = entity.equip_type
                ? `${entity.tag_number} — ${entity.equip_type}`
                : entity.tag_number;
        }

        // View button → open entity detail modal
        const viewBtn = document.getElementById('entity-view-btn');
        if (viewBtn) {
            viewBtn.onclick = () => {
                if (this.entityModal) {
                    this.entityModal.open(entity.id);
                } else if (window.app && window.app.entityModal) {
                    window.app.entityModal.open(entity.id);
                }
            };
        }

        // Unlink button → remove markup→entity link
        const unlinkBtn = document.getElementById('entity-unlink-btn');
        if (unlinkBtn) {
            unlinkBtn.onclick = () => this._unlinkMarkup(this._entityMarkupId);
        }
    }

    /**
     * Render State 2: merge prompt — a different entity already has this tag number.
     *
     * Shows a prompt with two choices:
     *   "Link to existing" — links this markup to the existing entity
     *   "Create new"      — clears the conflict and re-shows the unlinked state
     *                       (user must type a different tag)
     *
     * Args:
     *   existingEntity: The entity that already owns this tag_number.
     *   tagNumber:      The tag number the user typed (same as existingEntity.tag_number).
     */
    _renderEntityMergePrompt(existingEntity, tagNumber) {
        document.getElementById('entity-unlinked').style.display = 'none';
        document.getElementById('entity-linked-view').style.display = 'none';
        const prompt = document.getElementById('entity-merge-prompt');
        prompt.style.display = '';

        const msg = document.getElementById('entity-merge-msg');
        if (msg) {
            // SECURITY: textContent — tag_number from server, not innerHTML
            msg.textContent = `"${existingEntity.tag_number}" already exists. Link this markup to it?`;
        }

        // "Link to existing" — adds this markup as another observation of the existing entity
        const linkBtn = document.getElementById('entity-link-existing-btn');
        if (linkBtn) {
            linkBtn.onclick = () => this._linkToExisting(existingEntity);
        }

        // "Create new" — user wants a different tag; return to unlinked state
        const createBtn = document.getElementById('entity-create-new-btn');
        if (createBtn) {
            createBtn.onclick = () => {
                this._renderEntityUnlinked();
                const input = document.getElementById('entity-tag-input');
                if (input) { input.value = tagNumber; input.focus(); }
            };
        }
    }

    /**
     * Promote a markup to an entity: POST /api/entities, then link the markup.
     *
     * Handles three outcomes:
     *   201 → entity created, link it → show State 3
     *   409 → entity exists → show merge prompt (State 2)
     *   other → log error, stay in State 1
     *
     * Args:
     *   tagNumber: Equipment tag string from the input field.
     */
    async _promoteMarkup(tagNumber) {
        if (!this.docId || !this._entityMarkupId) return;

        try {
            const resp = await fetch('/api/entities', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag_number: tagNumber })
            });

            if (resp.status === 201) {
                const data = await resp.json();
                // New entity created — now link this markup to it
                await this._linkMarkupToEntity(data.id);
                this._renderEntityLinked(data);

            } else if (resp.status === 409) {
                const data = await resp.json();
                // Tag already exists — show merge prompt
                this._renderEntityMergePrompt(data.entity, tagNumber);

            } else {
                const text = await resp.text();
                console.error('[Properties] Entity creation failed:', text);
            }
        } catch (err) {
            console.error('[Properties] _promoteMarkup error:', err);
        }
    }

    /**
     * Link this markup to an existing entity (chosen from the merge prompt).
     *
     * Args:
     *   entity: The existing entity dict to link to.
     */
    async _linkToExisting(entity) {
        if (!this.docId || !this._entityMarkupId) return;
        await this._linkMarkupToEntity(entity.id);
        this._renderEntityLinked(entity);
    }

    /**
     * Internal helper: POST the markup→entity link to the server.
     *
     * Args:
     *   entityId: UUID of the entity to link to.
     */
    async _linkMarkupToEntity(entityId) {
        const resp = await fetch(
            `/api/documents/${this.docId}/markup-entities`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    markup_id: this._entityMarkupId,
                    entity_id: entityId,
                    page_number: this._entityPageNumber || 0
                })
            }
        );
        if (!resp.ok) {
            throw new Error(`Link failed: ${resp.statusText}`);
        }
    }

    /**
     * Unlink this markup from its entity and return to the unlinked state.
     *
     * Args:
     *   markupId: UUID of the markup to unlink.
     */
    async _unlinkMarkup(markupId) {
        if (!this.docId || !markupId) return;
        try {
            const resp = await fetch(
                `/api/documents/${this.docId}/markup-entities/${encodeURIComponent(markupId)}`,
                { method: 'DELETE' }
            );
            if (!resp.ok) throw new Error(resp.statusText);
            this._renderEntityUnlinked();
        } catch (err) {
            console.error('[Properties] Unlink failed:', err);
        }
    }
}
