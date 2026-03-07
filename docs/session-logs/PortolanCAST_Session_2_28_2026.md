# PortolanCAST Session — 2026-02-28

## Session Overview
Full development day completing the remaining backlog items from the Q/L/OCR batch, ending with 729/729 tests passing across 27 suites.

---

## Features Completed This Session

### Q2: Callout Label Editable
- **Problem**: Fabric.js cannot edit IText inside an active Group. Clicking a placed callout had no re-edit path.
- **Solution**: Deferred grouping on placement — add Line + IText standalone, call `enterEditing()` immediately, regroup on `editing:exited`. Double-click re-edit uses `_enterCalloutEdit()` which decomposes group using `calcTransformMatrix()` + `qrDecompose()`, stands the items back up standalone, re-enters editing, then regroups.
- **Key flag**: `_isCallout` added to `CUSTOM_PROPERTIES` for JSON round-trip.
- **Tests**: 15/15 ✓

### L1: Landscape Canvas Rotation
- **Problem**: No way to rotate portrait PDFs for landscape review.
- **Solution**: Server-side rotation via PyMuPDF `fitz.Matrix(zoom, zoom).prerotate(degrees)`. Added `rotate` query param to page endpoint. Viewer tracks `this.rotation` state with `rotate()` / `setRotation()` methods. `btn-rotate` cycles 0→90→180→270→0.
- **Key insight**: CSS rotation breaks Fabric.js pointer math. Server-side is the clean path — resulting PNG has swapped dimensions and all client code is unaffected.
- **Tests**: 19/19 ✓

### L2: Toolbar Customization
- **Compact mode**: `.toolbar-compact` CSS class toggles `font-size:0` on `.tool-btn` while `.icon` keeps explicit `font-size:15px` (child rule overrides inherited zero). Persisted in localStorage, restored on startup, cleared by Reset.
- **Shortcut hints**: `_populateSettingsLists()` parses `title` attribute with `/\(([A-Z0-9])\)/i` regex and injects `.settings-shortcut-hint` spans.
- **Escape key**: Capture-phase `keydown` listener closes settings modal.
- **Tests**: 19/19 ✓

### L3: Persistent Mode Bar
- **What**: Status-bar widget always showing active tool regardless of which toolbar tab is visible. Shows tool icon + name + color-coded pill + `✋`/`↺` quick-switch buttons.
- **Design**: `_updateModeBar(toolName)` reads icon/label directly from `.tool-btn[data-tool]` DOM (single source of truth). `data-tab` attribute on pill drives CSS color-coding (blue/amber/green). Called at end of `setTool()`.
- **Tests**: 21/21 ✓

### OCR / Page Text Extraction
- **What**: Text tab in left panel. Extracts text from current PDF page.
- **Architecture**: Two-tier. Tier 1: PyMuPDF `page.get_text('blocks')` — native text layer (zero extra deps, works for born-digital PDFs). Tier 2: Tesseract via `pytesseract.image_to_string()` for scanned pages (optional, gracefully disabled if not installed).
- **Endpoint**: `GET /api/documents/{id}/text/{page}?ocr=false` → `{text, word_count, char_count, has_native_text, method, ocr_available, page}`
- **Frontend**: `PageTextPanel` class in `page-text.js`. Lazy fetch (checks `#tab-text.active` DOM state rather than tracked flag). Method badge (green=native, amber=OCR, gray=none). Copy button. OCR section with install instructions when Tesseract absent.
- **Dependencies installed**: `pytesseract 0.3.13`, `pillow 12.1.1`, `tesseract-ocr 5.3.4` (system package).
- **Tests**: 30/30 ✓

---

## Lessons Learned

### Architecture
1. **Tab listener ordering is critical**: `_bindTabSwitching()` in `markup-list.js` attaches listeners to ALL `.panel-tab` buttons at init time. Any new panel's `initForDocument()` must run AFTER `markupList.init()` or the `.active` class won't be on the tab content when the listener fires. Documented as a gotcha.

2. **Never clone-replace `.panel-tab` buttons**: The clone-replace pattern (used elsewhere to prevent duplicate listeners) strips `_bindTabSwitching`'s listener. For tab buttons, use a named `_tabClickHandler` reference with `removeEventListener` + `addEventListener` instead.

3. **DOM state > tracked state**: `refresh()` checking `tabContent.classList.contains('active')` is more robust than tracking `_tabActive` boolean that requires a `deactivate()` call from every other tab. The DOM IS the state.

4. **Server-side wins over CSS transforms for coordinate-sensitive overlays**: CSS `transform:rotate()` breaks `getBoundingClientRect()` which Fabric.js uses for pointer events. Always rotate at the data layer (PyMuPDF) for canvas overlays.

### Testing
1. **Test suite at 729/729 across 27 suites** — clean green on everything including today's new features.
2. **Lazy loading tests**: Set up "tab inactive → navigate → check body unchanged" pattern for detecting spurious background fetches. This is a reusable pattern for any lazy panel.
3. **API endpoint tests first**: Testing the API route directly (inside browser `fetch()`) before testing the UI panel catches backend issues before frontend noise.

### OCR Notes
- Tesseract 5.3.4 available via `sudo apt-get install tesseract-ocr` on WSL Ubuntu.
- PyMuPDF pixmap → PIL Image without temp files: `Image.frombytes("RGB", [pixmap.width, pixmap.height], pixmap.samples)`.
- `_ocr_available()` uses module-level cached probe (`PDFEngine._ocr_checked` / `_is_available`) so we don't re-invoke Tesseract binary on every request.
- For scanned engineering drawings, 200 DPI is a good balance (sharp enough for text, not huge memory).

---

## Test Suite Summary (End of Session)
```
Total: 729 passed, 0 failed, 729 total
Suites: 27 run, 0 failed

test_shapes.mjs              40 passed
test_properties.mjs          30 passed
test_markup_list.mjs         30 passed
test_color_meaning.mjs       28 passed
test_phase1_tools.mjs        48 passed
test_phase1_polish.mjs       28 passed
test_phase2.mjs              48 passed
test_phase3a.mjs             48 passed
test_phase3b.mjs             53 passed
test_phase4a.mjs             34 passed
test_phase4b.mjs             26 passed
test_phase4c.mjs             25 passed
test_phase5_layers.mjs       26 passed
test_bundle.mjs              15 passed
test_photos.mjs              23 passed
test_search.mjs              22 passed
test_brief_tags.mjs          26 passed
test_rfi_generator.mjs       26 passed
test_highlight_color.mjs      7 passed
test_b3_scroll.mjs            8 passed
test_q3_layer_context.mjs    17 passed
test_q1_bundle_naming.mjs    17 passed
test_q2_callout_edit.mjs     15 passed
test_l1_rotation.mjs         19 passed
test_l2_toolbar_custom.mjs   19 passed
test_l3_mode_bar.mjs         21 passed
test_ocr_text.mjs            30 passed
```

---

## Bluebeam Tool Reference (for next Counsel session)
Source: https://support.bluebeam.com/online-help/revu20/Content/RevuHelp/Menus/Tools/Toolbars/Toolbars--MV.htm

**PortolanCAST has (✓) or is missing (—):**

### Annotation/Markup
| Tool | BB shortcut | Status |
|------|------------|--------|
| Pen (free-draw) | P | ✓ |
| Highlighter | H | ✓ |
| Rectangle | R | ✓ |
| Ellipse | E | ✓ |
| Line | L | ✓ |
| Polyline | SHIFT+N | — |
| Polygon | SHIFT+P | — (area measurement uses polygon) |
| Cloud | C | ✓ |
| Cloud+ (cloud with callout) | K | — (callout exists, not cloud+) |
| Callout | Q | ✓ |
| Text Box | T | ✓ (IText) |
| Typewriter (inline text) | W | — |
| Note (sticky) | N | — |
| Arrow | A | — |
| Dimension / leader line | SHIFT+L | — |
| Arc | SHIFT+C | — |
| Squiggly | SHIFT+U | — |
| Strikethrough | D | — |
| Underline | U | — |
| Select Text | SHIFT+T | — |
| Stamp | — | — |
| Image markup | I | — |
| File attachment | F | — (photos attached to markups) |
| Erase content | SHIFT+E | — |
| Lasso select | SHIFT+O | — |
| Format Painter | CTRL+SHIFT+C | — |

### Measurement
| Tool | BB shortcut | Status |
|------|------------|--------|
| Distance/Length | SHIFT+ALT+L | ✓ (Distance Ruler, U) |
| Area | SHIFT+ALT+A | ✓ |
| Count | SHIFT+ALT+C | ✓ |
| Calibrate/Set Scale | — | ✓ |
| Perimeter | SHIFT+ALT+P | — |
| Diameter | SHIFT+ALT+D | — |
| Radius | SHIFT+ALT+U | — |
| Angle | SHIFT+ALT+G | — |
| Volume | SHIFT+ALT+V | — |
| Polylength | SHIFT+ALT+Q | — |
| 3-Point Radius | SHIFT+ALT+U | — |

### Alignment / Arrangement (multi-select)
| Tool | Status |
|------|--------|
| Align Left/Right/Top/Bottom | — |
| Align Center/Middle | — |
| Align Size/Width/Height | — |
| Distribute H/V | — |
| Bring Forward/Back | — |
| Send to Front/Back | — |
| Flip H/V | — |
| Snap to Grid / Content / Markup | — |
| Show Grid | — |

### Navigation
| Tool | Status |
|------|--------|
| Pan | ✓ (G / hand tool) |
| Zoom In/Out | ✓ |
| Fit Width / Fit Page | ✓ |
| Actual Size | — |
| Next/Prev Page | ✓ |
| Rotate CW/CCW | ✓ (CW only, L1) |
| Dimmer | — |
| Presentation mode | — |
| Snapshot | — |
| Dynamic Fill | — |
| Overlay Pages | — |

### Document Operations
| Tool | Status |
|------|--------|
| Insert Pages | ✓ (Add Page) |
| Delete Pages | — |
| Extract Pages | — |
| Replace Pages | — |
| Crop Pages | — |
| Rotate Pages | — |
| Deskew | — |
| Combine PDFs | — |
| Compare Documents | — |
| OCR | ✓ (Text tab, Tesseract) |

---

## State for Counsel Session
- **PortolanCAST** is a Bluebeam-class PDF markup tool at ~50% of core annotation parity
- **nodeCAST** is the graph/knowledge layer planned for Phase 2 of the vision
- Key question: deepen PortolanCAST tools first OR move to nodeCAST architecture?
- Bluebeam gaps that matter most for construction: Polyline, Arrow, Dimension/leader, Sticky Note, Align tools, Sketch-to-Scale, Volume, Stamp
- Open-source CAD direction: SVG export, snap-to-content, sketch-to-scale tools
