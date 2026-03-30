/**
 * PortolanCAST — Floating Text Format Bar
 *
 * Purpose:
 *   When the user edits an IText or Textbox on the Fabric.js canvas, a floating
 *   toolbar appears directly above the text with formatting controls: font family
 *   (including system fonts), font size, bold/italic/underline/strikethrough,
 *   text alignment, color picker, and a spell check button.
 *
 *   This mirrors the Bluebeam Revu / Adobe Acrobat contextual format bar — the
 *   user doesn't have to look away from the text to format it.
 *
 * Architecture:
 *   - Listens to Fabric.js `text:editing:entered` / `text:editing:exited` events
 *   - Positions via `position: fixed` relative to the text bounding rect
 *   - Syncs bidirectionally with PropertiesPanel typography controls
 *   - System font detection via queryLocalFonts() or canvas measurement fallback
 *
 * Security assumptions:
 *   - queryLocalFonts() requires user permission (browser-gated)
 *   - No external API calls — all detection is local
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-03-30
 */

// =============================================================================
// SYSTEM FONT DETECTION
// =============================================================================

/**
 * Common system fonts to test via canvas measurement fallback.
 * Covers Windows, macOS, and Linux. Grouped by family type.
 */
const COMMON_SYSTEM_FONTS = [
    // Sans-serif
    'Arial', 'Calibri', 'Candara', 'Century Gothic', 'Corbel', 'Franklin Gothic Medium',
    'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Lucida Grande', 'Lucida Sans',
    'Noto Sans', 'Open Sans', 'Roboto', 'Segoe UI', 'Tahoma', 'Trebuchet MS',
    'Ubuntu', 'Verdana',
    // Serif
    'Cambria', 'Constantia', 'Book Antiqua', 'Garamond', 'Georgia',
    'Noto Serif', 'Palatino Linotype', 'Times New Roman',
    // Monospace
    'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Courier New', 'DejaVu Sans Mono',
    'Fira Code', 'JetBrains Mono', 'Lucida Console', 'Monaco', 'Noto Mono',
    'Source Code Pro', 'Ubuntu Mono',
    // Display / Handwriting
    'Comic Sans MS', 'Impact', 'Papyrus', 'Segoe Print', 'Segoe Script',
];

/**
 * Detect available system fonts.
 *
 * Strategy:
 *   1. Try queryLocalFonts() (Chrome/Edge 103+) — returns full list, async
 *   2. Fallback: canvas measurement — render text in candidate font vs monospace,
 *      compare widths. Different width = font exists. ~50ms for 50 fonts.
 *
 * Returns:
 *   Sorted array of font family names available on the system.
 */
async function detectSystemFonts() {
    // Strategy 1: queryLocalFonts API (Chrome/Edge, permission required)
    if (typeof window.queryLocalFonts === 'function') {
        try {
            const fonts = await window.queryLocalFonts();
            // Deduplicate family names (queryLocalFonts returns per-style entries)
            const families = new Set();
            for (const font of fonts) {
                families.add(font.family);
            }
            if (families.size > 0) {
                return [...families].sort((a, b) => a.localeCompare(b));
            }
        } catch {
            // Permission denied or API unavailable — fall through to canvas method
        }
    }

    // Strategy 2: Canvas measurement trick
    // Render test string in candidate font + monospace fallback.
    // If rendered width differs from pure monospace, the font exists.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const testStr = 'mmmmmmmmmmWWWWWWWWWW';  // Mix of wide characters for reliable detection
    const baseSize = '48px';

    // Measure baseline width with known monospace
    ctx.font = `${baseSize} monospace`;
    const monoWidth = ctx.measureText(testStr).width;

    // Measure baseline with serif too (some fonts match one but not the other)
    ctx.font = `${baseSize} serif`;
    const serifWidth = ctx.measureText(testStr).width;

    const detected = [];
    for (const family of COMMON_SYSTEM_FONTS) {
        // Test against both baselines to avoid false negatives
        ctx.font = `${baseSize} '${family}', monospace`;
        const w1 = ctx.measureText(testStr).width;
        ctx.font = `${baseSize} '${family}', serif`;
        const w2 = ctx.measureText(testStr).width;

        if (w1 !== monoWidth || w2 !== serifWidth) {
            detected.push(family);
        }
    }

    return detected.sort((a, b) => a.localeCompare(b));
}

// =============================================================================
// TEXT FORMAT BAR CLASS
// =============================================================================

/**
 * Floating format bar that appears above text objects during editing.
 *
 * Usage:
 *   const bar = new TextFormatBar();
 *   bar.init(canvasOverlay, propertiesPanel);
 */
export class TextFormatBar {
    constructor() {
        /** @type {import('./canvas.js').CanvasOverlay|null} */
        this.canvas = null;
        /** @type {import('./properties.js').PropertiesPanel|null} */
        this.properties = null;
        /** @type {fabric.IText|fabric.Textbox|null} Currently editing text object */
        this._activeText = null;
        /** @type {HTMLElement} The floating bar element */
        this._bar = null;
        /** @type {boolean} Whether init() has been called */
        this._initialized = false;
        /** @type {string[]|null} Cached system font list */
        this._systemFonts = null;
        /** @type {boolean} Font detection in progress */
        this._detectingFonts = false;
        /** @type {number} Scroll listener debounce timer */
        this._scrollTimer = 0;
    }

    /**
     * Initialize the format bar. Call once after canvas and properties are ready.
     *
     * Args:
     *   canvas: CanvasOverlay instance
     *   properties: PropertiesPanel instance
     */
    init(canvas, properties) {
        if (this._initialized) return;
        this._initialized = true;
        this.canvas = canvas;
        this.properties = properties;

        this._createBarElement();
        this._bindCanvasEvents();
        this._bindBarControls();

        // Lazy font detection — run on first text edit
        console.log('[TextFormatBar] Initialized');
    }

    // =========================================================================
    // BAR ELEMENT CREATION
    // =========================================================================

    /**
     * Build the floating bar DOM element programmatically and append to body.
     * Using position:fixed so it overlays everything regardless of scroll context.
     */
    _createBarElement() {
        const bar = document.createElement('div');
        bar.id = 'text-format-bar';
        bar.className = 'text-format-bar';
        bar.innerHTML = `
            <select id="tfb-font-family" class="tfb-select" title="Font Family">
                <option value="Arial, sans-serif">Arial</option>
                <option value="'Times New Roman', serif">Times New Roman</option>
                <option value="'Courier New', monospace">Courier New</option>
                <option value="Georgia, serif">Georgia</option>
                <option value="Verdana, sans-serif">Verdana</option>
                <option value="Impact, sans-serif">Impact</option>
            </select>
            <input id="tfb-font-size" type="number" class="tfb-input" title="Font Size"
                   min="6" max="200" value="16" step="1">
            <div class="tfb-separator"></div>
            <button id="tfb-bold" class="tfb-btn" title="Bold (Ctrl+B)"><strong>B</strong></button>
            <button id="tfb-italic" class="tfb-btn" title="Italic (Ctrl+I)"><em>I</em></button>
            <button id="tfb-underline" class="tfb-btn" title="Underline"><u>U</u></button>
            <button id="tfb-strikethrough" class="tfb-btn" title="Strikethrough"><s>S</s></button>
            <div class="tfb-separator"></div>
            <button id="tfb-align-left" class="tfb-btn tfb-align" title="Align Left">&#9776;</button>
            <button id="tfb-align-center" class="tfb-btn tfb-align" title="Center">&#8801;</button>
            <button id="tfb-align-right" class="tfb-btn tfb-align" title="Align Right">&#9776;</button>
            <div class="tfb-separator"></div>
            <input id="tfb-color" type="color" class="tfb-color" title="Text Color" value="#ff0000">
            <button id="tfb-spellcheck" class="tfb-btn" title="Spell Check">&#9997;</button>
        `;
        document.body.appendChild(bar);
        this._bar = bar;
    }

    // =========================================================================
    // CANVAS EVENT BINDINGS
    // =========================================================================

    _bindCanvasEvents() {
        const fc = this.canvas.fabricCanvas;

        fc.on('text:editing:entered', (e) => {
            this._activeText = e.target;
            this._ensureFontsDetected();
            this._syncControls();
            // Delay positioning by one frame — bounding rect not stable on first frame
            requestAnimationFrame(() => {
                this._position();
                this._bar.style.display = 'flex';
            });
        });

        fc.on('text:editing:exited', () => {
            this._activeText = null;
            this._bar.style.display = 'none';
        });

        // Reposition if the text object moves while editing
        fc.on('object:moving', (e) => {
            if (e.target === this._activeText) {
                this._position();
            }
        });

        // Hide during scroll (reposition is expensive and jarring)
        const viewport = document.getElementById('viewport');
        if (viewport) {
            viewport.addEventListener('scroll', () => {
                if (this._activeText) {
                    this._bar.style.display = 'none';
                    clearTimeout(this._scrollTimer);
                    this._scrollTimer = setTimeout(() => {
                        if (this._activeText) {
                            this._position();
                            this._bar.style.display = 'flex';
                        }
                    }, 150);
                }
            });
        }
    }

    // =========================================================================
    // POSITIONING
    // =========================================================================

    /**
     * Position the bar above the active text object using fixed positioning.
     * Falls below the text if there's no room above.
     */
    _position() {
        const obj = this._activeText;
        if (!obj) return;

        const fc = this.canvas.fabricCanvas;
        const bound = obj.getBoundingRect();
        const canvasEl = fc.lowerCanvasEl || fc.getElement();
        const canvasRect = canvasEl.getBoundingClientRect();

        const barHeight = this._bar.offsetHeight || 36;
        const barWidth = this._bar.offsetWidth || 500;

        // Try above the text
        let top = canvasRect.top + bound.top - barHeight - 8;
        let left = canvasRect.left + bound.left;

        // If bar goes above viewport, put it below the text
        if (top < 0) {
            top = canvasRect.top + bound.top + bound.height + 8;
        }

        // Keep within viewport horizontally
        if (left + barWidth > window.innerWidth) {
            left = window.innerWidth - barWidth - 8;
        }
        if (left < 8) left = 8;

        this._bar.style.top = `${top}px`;
        this._bar.style.left = `${left}px`;
    }

    // =========================================================================
    // CONTROL SYNC (object state → bar controls)
    // =========================================================================

    _syncControls() {
        const obj = this._activeText;
        if (!obj) return;

        // Font family
        const fontSelect = document.getElementById('tfb-font-family');
        if (fontSelect) {
            // Try to match the object's font to a dropdown option
            fontSelect.value = obj.fontFamily || 'Arial, sans-serif';
            // If no match (system font not in dropdown), add it temporarily
            if (fontSelect.value !== obj.fontFamily && obj.fontFamily) {
                const opt = document.createElement('option');
                opt.value = obj.fontFamily;
                opt.textContent = obj.fontFamily.replace(/'/g, '');
                fontSelect.appendChild(opt);
                fontSelect.value = obj.fontFamily;
            }
        }

        // Font size
        const sizeInput = document.getElementById('tfb-font-size');
        if (sizeInput) sizeInput.value = obj.fontSize || 16;

        // Toggles
        this._setToggle('tfb-bold', obj.fontWeight === 'bold' || obj.fontWeight === '700');
        this._setToggle('tfb-italic', obj.fontStyle === 'italic');
        this._setToggle('tfb-underline', obj.underline === true);
        this._setToggle('tfb-strikethrough', obj.linethrough === true);

        // Alignment
        const align = obj.textAlign || 'left';
        this._setToggle('tfb-align-left', align === 'left');
        this._setToggle('tfb-align-center', align === 'center');
        this._setToggle('tfb-align-right', align === 'right');

        // Color — convert fill to hex for the color input
        const colorInput = document.getElementById('tfb-color');
        if (colorInput) {
            colorInput.value = this._toHex(obj.fill) || '#ff0000';
        }
    }

    _setToggle(id, active) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', active);
    }

    /**
     * Convert a CSS color (name, rgb(), hex) to #rrggbb for the color input.
     * Returns null if conversion fails.
     */
    _toHex(color) {
        if (!color) return null;
        if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
            return color.length === 4
                ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
                : color;
        }
        // Use a temporary element for complex formats (rgb, named colors)
        const tmp = document.createElement('div');
        tmp.style.color = color;
        document.body.appendChild(tmp);
        const computed = getComputedStyle(tmp).color;
        document.body.removeChild(tmp);
        const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) return null;
        const hex = (n) => parseInt(n).toString(16).padStart(2, '0');
        return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`;
    }

    // =========================================================================
    // BAR CONTROL BINDINGS (bar controls → object state)
    // =========================================================================

    _bindBarControls() {
        // Helper: apply a property change to the active text and sync
        const apply = (prop, value) => {
            if (!this._activeText) return;
            this._activeText.set(prop, value);
            this.canvas.fabricCanvas.renderAll();
            // Sync the properties panel by re-showing for this object
            if (this.properties && this.properties._selectedObject === this._activeText) {
                this.properties._showMarkupProps(this._activeText);
            }
            // Persist text prefs
            if (this.properties) {
                this.properties._saveTextPrefs();
            }
        };

        // Font family
        document.getElementById('tfb-font-family')?.addEventListener('change', (e) => {
            apply('fontFamily', e.target.value);
        });

        // Font size
        document.getElementById('tfb-font-size')?.addEventListener('change', (e) => {
            const sz = Math.min(200, Math.max(6, parseInt(e.target.value) || 16));
            e.target.value = sz;
            apply('fontSize', sz);
        });

        // Bold toggle
        document.getElementById('tfb-bold')?.addEventListener('click', () => {
            if (!this._activeText) return;
            const isBold = this._activeText.fontWeight === 'bold' || this._activeText.fontWeight === '700';
            apply('fontWeight', isBold ? 'normal' : 'bold');
            this._setToggle('tfb-bold', !isBold);
        });

        // Italic toggle
        document.getElementById('tfb-italic')?.addEventListener('click', () => {
            if (!this._activeText) return;
            const isItalic = this._activeText.fontStyle === 'italic';
            apply('fontStyle', isItalic ? 'normal' : 'italic');
            this._setToggle('tfb-italic', !isItalic);
        });

        // Underline toggle
        document.getElementById('tfb-underline')?.addEventListener('click', () => {
            if (!this._activeText) return;
            apply('underline', !this._activeText.underline);
            this._setToggle('tfb-underline', this._activeText.underline);
        });

        // Strikethrough toggle
        document.getElementById('tfb-strikethrough')?.addEventListener('click', () => {
            if (!this._activeText) return;
            apply('linethrough', !this._activeText.linethrough);
            this._setToggle('tfb-strikethrough', this._activeText.linethrough);
        });

        // Alignment buttons — mutually exclusive
        ['left', 'center', 'right'].forEach(align => {
            document.getElementById(`tfb-align-${align}`)?.addEventListener('click', () => {
                apply('textAlign', align);
                this._setToggle('tfb-align-left', align === 'left');
                this._setToggle('tfb-align-center', align === 'center');
                this._setToggle('tfb-align-right', align === 'right');
            });
        });

        // Color picker
        document.getElementById('tfb-color')?.addEventListener('input', (e) => {
            apply('fill', e.target.value);
        });

        // Spell check button — opens the spell check modal
        document.getElementById('tfb-spellcheck')?.addEventListener('click', () => {
            this._openSpellCheck();
        });

        // Prevent bar clicks from stealing focus from the IText editing
        this._bar.addEventListener('mousedown', (e) => {
            // Allow interaction with inputs/selects but prevent focus steal
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            e.preventDefault();
        });
    }

    // =========================================================================
    // SPELL CHECK
    // =========================================================================

    /**
     * Open the spell check modal with the active text object's content.
     * The modal uses a native <textarea spellcheck="true"> so the browser's
     * built-in spell checker provides red squiggles and right-click suggestions.
     */
    _openSpellCheck() {
        if (!this._activeText) return;

        // Store reference — modal focus will deselect the canvas object
        const targetObj = this._activeText;

        const modal = document.getElementById('modal-spellcheck');
        const overlay = document.getElementById('modal-spellcheck-overlay');
        const textarea = document.getElementById('spellcheck-textarea');
        const applyBtn = document.getElementById('spellcheck-apply');
        const cancelBtn = document.getElementById('spellcheck-cancel');
        if (!modal || !textarea) return;

        // Pre-fill with current text
        textarea.value = targetObj.text || '';
        modal.style.display = 'block';
        if (overlay) overlay.style.display = 'block';
        textarea.focus();

        const close = () => {
            modal.style.display = 'none';
            if (overlay) overlay.style.display = 'none';
            // Clean up listeners to prevent memory leaks on repeated opens
            applyBtn.onclick = null;
            cancelBtn.onclick = null;
            if (overlay) overlay.onclick = null;
        };

        applyBtn.onclick = () => {
            // Sync edited text back to the canvas object
            targetObj.set('text', textarea.value);
            // Also update markupNote if it was a sticky note (synced on edit exit)
            if (targetObj.type === 'textbox' && targetObj.backgroundColor) {
                targetObj.set('markupNote', textarea.value.trim());
            }
            this.canvas.fabricCanvas.renderAll();
            close();
        };

        cancelBtn.onclick = close;
        if (overlay) overlay.onclick = close;
    }

    // =========================================================================
    // SYSTEM FONT DETECTION
    // =========================================================================

    /**
     * Trigger system font detection if not already done.
     * Lazy: only runs on first text edit to avoid startup cost.
     */
    async _ensureFontsDetected() {
        if (this._systemFonts || this._detectingFonts) return;
        this._detectingFonts = true;

        try {
            const fonts = await detectSystemFonts();
            this._systemFonts = fonts;
            this._populateFontDropdowns(fonts);
            console.log(`[TextFormatBar] Detected ${fonts.length} system fonts`);
        } catch (err) {
            console.warn('[TextFormatBar] Font detection failed:', err);
        } finally {
            this._detectingFonts = false;
        }
    }

    /**
     * Populate both the format bar and properties panel font dropdowns
     * with detected system fonts.
     *
     * Args:
     *   fonts: Array of font family name strings
     */
    _populateFontDropdowns(fonts) {
        if (!fonts || fonts.length === 0) return;

        // Build option groups: detected system fonts + guaranteed fallbacks
        const fallbacks = [
            { value: 'Arial, sans-serif', label: 'Arial' },
            { value: "'Times New Roman', serif", label: 'Times New Roman' },
            { value: "'Courier New', monospace", label: 'Courier New' },
            { value: 'Georgia, serif', label: 'Georgia' },
            { value: 'Verdana, sans-serif', label: 'Verdana' },
            { value: 'Impact, sans-serif', label: 'Impact' },
        ];
        const fallbackNames = new Set(fallbacks.map(f => f.label));

        // Build the full option list: system fonts (that aren't duplicates of fallbacks)
        // followed by a separator group with the guaranteed fallbacks
        const buildOptions = (select) => {
            if (!select) return;
            const currentValue = select.value;
            select.innerHTML = '';

            // System fonts group
            const sysGroup = document.createElement('optgroup');
            sysGroup.label = 'System Fonts';
            for (const family of fonts) {
                if (fallbackNames.has(family)) continue;  // Avoid duplicates
                const opt = document.createElement('option');
                opt.value = `'${family}'`;
                opt.textContent = family;
                opt.style.fontFamily = `'${family}'`;
                sysGroup.appendChild(opt);
            }
            select.appendChild(sysGroup);

            // Fallback fonts group
            const fbGroup = document.createElement('optgroup');
            fbGroup.label = 'Standard Fonts';
            for (const fb of fallbacks) {
                const opt = document.createElement('option');
                opt.value = fb.value;
                opt.textContent = fb.label;
                fbGroup.appendChild(opt);
            }
            select.appendChild(fbGroup);

            // Restore previous selection
            select.value = currentValue;
        };

        // Update format bar dropdown
        buildOptions(document.getElementById('tfb-font-family'));

        // Update properties panel dropdown
        buildOptions(document.getElementById('prop-font-family'));
    }
}
