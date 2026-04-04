/**
 * PortolanCAST — Drawing Scale Manager
 *
 * Purpose:
 *   Manages the drawing scale setting for the current document.
 *   Phase 2 measurement tools use this to convert Fabric.js pixel distances
 *   to real-world units (feet, inches, meters) based on the title-block scale.
 *
 * Architecture:
 *   - SCALE_PRESETS: lookup table of common construction scales
 *   - ScaleManager: loads/saves scale from server, exposes pixelsPerRealUnit
 *     for measurement tools, updates the status bar selector
 *
 * Coordinate math (from spike_calibration.py — verified 2026-02-22):
 *   RENDER_DPI = 150 (BASE_DPI in canvas.js)
 *   pixelsPerRealUnit = RENDER_DPI × paperInchesPerRealUnit
 *
 *   Example — 1/4" = 1'-0":
 *     paperInchesPerFoot = 0.25
 *     pixelsPerFoot = 150 × 0.25 = 37.5 px/ft
 *     A measured 375px distance = 375 / 37.5 = 10 feet
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-22
 */

// =============================================================================
// SCALE PRESETS — Common construction drawing scales
// =============================================================================

/**
 * Architectural and engineering scale presets.
 *
 * paper_inches_per_unit: how many paper inches represent one real unit.
 * unit_label: the real-world unit ('ft', 'in', 'm').
 *
 * Used both on the server (main.py PAGE_SIZES mirror) and client
 * (status bar selector + measurement tool calculations).
 */
export const SCALE_PRESETS = {
    // key: { label, paper_inches_per_unit, unit_label }

    // Unscaled — pixel ruler mode, no title block scale applied
    unscaled:     { label: 'Unscaled (1px = 1/150")', paper_inches_per_unit: 1.0,      unit_label: 'in' },

    // Architectural series (ANSI/AIA standard scales)
    arch_3_32:    { label: '3/32" = 1\'',             paper_inches_per_unit: 0.09375,  unit_label: 'ft' },
    arch_1_8:     { label: '1/8" = 1\'',              paper_inches_per_unit: 0.125,    unit_label: 'ft' },
    arch_3_16:    { label: '3/16" = 1\'',             paper_inches_per_unit: 0.1875,   unit_label: 'ft' },
    arch_1_4:     { label: '1/4" = 1\'',              paper_inches_per_unit: 0.25,     unit_label: 'ft' },
    arch_3_8:     { label: '3/8" = 1\'',              paper_inches_per_unit: 0.375,    unit_label: 'ft' },
    arch_1_2:     { label: '1/2" = 1\'',              paper_inches_per_unit: 0.5,      unit_label: 'ft' },
    arch_3_4:     { label: '3/4" = 1\'',              paper_inches_per_unit: 0.75,     unit_label: 'ft' },
    arch_1_1:     { label: '1" = 1\'',                paper_inches_per_unit: 1.0,      unit_label: 'ft' },
    arch_1_half:  { label: '1-1/2" = 1\'',            paper_inches_per_unit: 1.5,      unit_label: 'ft' },
    arch_3_1:     { label: '3" = 1\'',                paper_inches_per_unit: 3.0,      unit_label: 'ft' },

    // Engineering series (common for site plans, civil drawings)
    eng_1_10:     { label: '1" = 10\'',               paper_inches_per_unit: 0.1,      unit_label: 'ft' },
    eng_1_20:     { label: '1" = 20\'',               paper_inches_per_unit: 0.05,     unit_label: 'ft' },
    eng_1_30:     { label: '1" = 30\'',               paper_inches_per_unit: 1/30,     unit_label: 'ft' },
    eng_1_40:     { label: '1" = 40\'',               paper_inches_per_unit: 0.025,    unit_label: 'ft' },
    eng_1_50:     { label: '1" = 50\'',               paper_inches_per_unit: 0.02,     unit_label: 'ft' },
    eng_1_60:     { label: '1" = 60\'',               paper_inches_per_unit: 1/60,     unit_label: 'ft' },
    eng_1_100:    { label: '1" = 100\'',              paper_inches_per_unit: 0.01,     unit_label: 'ft' },
};

// Rendering DPI — must match BASE_DPI in canvas.js and RENDER_DPI in main.py
const RENDER_DPI = 150.0;

// =============================================================================
// SCALE MANAGER
// =============================================================================

/**
 * Manages drawing scale for the open document.
 *
 * The scale tells Phase 2 measurement tools how to convert pixel distances
 * to real-world lengths. Construction drawings always have a title-block scale
 * (e.g. "1/4" = 1'-0"") that must be communicated to the tool.
 *
 * Usage:
 *   const scale = new ScaleManager();
 *   await scale.load(docId);
 *   const feet = scale.convertPixels(pixels);
 *   const text = scale.formatDistance(pixels);   // → "12.5 ft"
 */
export class ScaleManager {
    constructor() {
        /** @type {number|null} Document ID for the currently open document */
        this.docId = null;

        /** @type {string} Active preset key (from SCALE_PRESETS, or 'custom') */
        this.preset = 'unscaled';

        /**
         * Paper inches per one real-world unit.
         * For 1/4"=1': paper_inches_per_unit = 0.25, unit_label = 'ft'
         * @type {number}
         */
        this.paperInchesPerUnit = 1.0;

        /** @type {string} Real-world unit label: 'ft', 'in', 'm', etc. */
        this.unitLabel = 'in';

        /**
         * Derived: Fabric pixels per one real-world unit.
         * Phase 2 measurement tools use this directly.
         * distance_real = distance_pixels / pixelsPerRealUnit
         * @type {number}
         */
        this.pixelsPerRealUnit = RENDER_DPI;  // default: 1 inch = 150 pixels
    }

    // =========================================================================
    // LOAD / SAVE
    // =========================================================================

    /**
     * Load scale setting from server for the given document.
     *
     * Falls back to 'unscaled' if none is saved or fetch fails.
     *
     * Args:
     *   docId: Document database ID.
     */
    async load(docId) {
        this.docId = docId;
        try {
            const resp = await fetch(`/api/documents/${docId}/scale`);
            if (resp.ok) {
                const data = await resp.json();
                this._applyServerResponse(data);
            }
        } catch (err) {
            console.warn('[Scale] Failed to load scale, using default:', err);
            this._applyPreset('unscaled');
        }
        this._updateStatusBar();
    }

    /**
     * Save the given preset to the server and update local state.
     *
     * Args:
     *   presetKey: Key from SCALE_PRESETS, or 'custom'.
     *   customPaperInches: Required when presetKey = 'custom'.
     *   customUnit: Required when presetKey = 'custom'.
     */
    async setPreset(presetKey, customPaperInches = null, customUnit = null) {
        if (!this.docId) return;

        let paperInches, unitLabel;

        if (presetKey === 'custom' && customPaperInches !== null) {
            paperInches = customPaperInches;
            unitLabel = customUnit || 'ft';
        } else if (SCALE_PRESETS[presetKey]) {
            const p = SCALE_PRESETS[presetKey];
            paperInches = p.paper_inches_per_unit;
            unitLabel = p.unit_label;
        } else {
            // Unknown preset — fall back to unscaled
            presetKey = 'unscaled';
            paperInches = 1.0;
            unitLabel = 'in';
        }

        try {
            const resp = await fetch(`/api/documents/${this.docId}/scale`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preset: presetKey,
                    paper_inches_per_unit: paperInches,
                    unit_label: unitLabel,
                }),
            });
            if (resp.ok) {
                const data = await resp.json();
                this._applyServerResponse(data);
            }
        } catch (err) {
            console.error('[Scale] Failed to save scale:', err);
        }

        this._updateStatusBar();
    }

    // =========================================================================
    // CONVERSION HELPERS — Phase 2 measurement tools call these
    // =========================================================================

    /**
     * Convert a Fabric pixel distance to real-world units.
     *
     * Args:
     *   pixels: Distance in Fabric natural coordinates.
     *
     * Returns:
     *   number — Real-world distance in this.unitLabel units.
     */
    convertPixels(pixels) {
        if (this.pixelsPerRealUnit <= 0) return 0;
        return pixels / this.pixelsPerRealUnit;
    }

    /**
     * Format a pixel distance as a human-readable string with units.
     *
     * Examples: "10.5 ft", "8.25 in", "3.2 m"
     *
     * Args:
     *   pixels: Distance in Fabric natural coordinates.
     *   decimals: Decimal places (default 2).
     *
     * Returns:
     *   string — Formatted distance with unit label.
     */
    formatDistance(pixels, decimals = 2) {
        const value = this.convertPixels(pixels);
        return `${value.toFixed(decimals)} ${this.unitLabel}`;
    }

    /**
     * Convert square Fabric pixels to real-world area in square real units.
     *
     * Uses the Shoelace-computed pixel area from the Area tool.
     * Divides by pixelsPerRealUnit² because area scales as the square
     * of the linear scale factor.
     *
     * Example — 1/4"=1' scale:
     *   pixelsPerFoot = 37.5 → pixelsPerFoot² = 1406.25
     *   5000 sq px / 1406.25 = 3.56 sq ft
     *
     * Args:
     *   pixelArea: Area in square Fabric pixels (from Shoelace formula).
     *
     * Returns:
     *   number — Real-world area in this.unitLabel² units.
     */
    convertArea(pixelArea) {
        if (this.pixelsPerRealUnit <= 0) return 0;
        return pixelArea / (this.pixelsPerRealUnit ** 2);
    }

    /**
     * Format a pixel area as a human-readable string with units.
     *
     * Examples: "150.32 sq ft", "4.25 sq m", "18.00 sq in"
     *
     * Args:
     *   pixelArea: Area in square Fabric pixels.
     *   decimals: Decimal places (default 2).
     *
     * Returns:
     *   string — Formatted area with "sq <unitLabel>" suffix.
     */
    formatArea(pixelArea, decimals = 2) {
        const value = this.convertArea(pixelArea);
        return `${value.toFixed(decimals)} sq ${this.unitLabel}`;
    }

    /**
     * Format a volume as a human-readable string with units.
     *
     * Volume = area × depth. Area is in sq units, depth in linear units,
     * result is in cubic units.
     *
     * Examples: "150.32 cu ft", "4.25 cu m"
     */
    formatVolume(pixelArea, depthInRealUnits, decimals = 2) {
        const area = this.convertArea(pixelArea);
        const volume = area * depthInRealUnits;
        return `${volume.toFixed(decimals)} cu ${this.unitLabel}`;
    }

    /**
     * Get a short label for the current scale for display in the status bar.
     *
     * Returns:
     *   string — e.g. "1/4" = 1'" or "Unscaled"
     */
    get displayLabel() {
        if (this.preset === 'unscaled') return 'Unscaled';
        const p = SCALE_PRESETS[this.preset];
        return p ? p.label : this.preset;
    }

    // =========================================================================
    // INTERNAL
    // =========================================================================

    /**
     * Apply state from a server scale response object.
     */
    _applyServerResponse(data) {
        this.preset = data.preset || 'unscaled';
        this.paperInchesPerUnit = data.paper_inches_per_unit || 1.0;
        this.unitLabel = data.unit_label || 'in';
        // Use server-computed value if present, else compute locally
        this.pixelsPerRealUnit = data.pixels_per_unit || (RENDER_DPI * this.paperInchesPerUnit);
    }

    /**
     * Apply a preset directly (without server round-trip).
     * Used for fast UI updates before the save completes.
     */
    _applyPreset(presetKey) {
        const p = SCALE_PRESETS[presetKey];
        if (p) {
            this.preset = presetKey;
            this.paperInchesPerUnit = p.paper_inches_per_unit;
            this.unitLabel = p.unit_label;
            this.pixelsPerRealUnit = RENDER_DPI * p.paper_inches_per_unit;
        }
    }

    /**
     * Update the scale selector in the status bar to reflect current state.
     *
     * For standard presets: the <select> is shown, label span is hidden.
     * For 'custom' preset: the <select> is hidden (no matching visible option),
     * and the text label is shown as "Custom" so the user sees something meaningful.
     * This avoids showing a blank/broken dropdown for the calibration result.
     */
    _updateStatusBar() {
        const el = document.getElementById('scale-select');
        const label = document.getElementById('scale-label');

        if (this.preset === 'custom') {
            // Show text label, hide dropdown (it has no visible 'custom' option)
            if (el) el.style.display = 'none';
            if (label) {
                label.textContent = 'Custom';
                label.style.display = '';
            }
        } else {
            // Show dropdown (standard preset), hide text label
            if (el) {
                el.style.display = '';
                el.value = this.preset;
            }
            if (label) label.style.display = 'none';
        }
    }
}
