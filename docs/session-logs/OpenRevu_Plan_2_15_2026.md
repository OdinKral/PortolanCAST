# OpenRevu — Open Source Bluebeam Replacement with AI

**Date:** 2026-02-15
**Status:** Phase 1 COMPLETE (2026-02-17) — Feature requests batch 1 done (2026-02-22) — Pre-Phase 2 gates COMPLETE (2026-02-22) — Phase 2 READY
**Location:** `/mnt/c/Users/User1/ClaudeProjects/OpenRevu/`

---

## Decision: Web-First Architecture

After evaluating the original Tauri + React + TypeScript + Rust plan against the user's background (Python, FastAPI, basic web) and successful ExtendedCognition v1 delivery, we committed to a **web-first** approach:

- **Stack:** FastAPI (Python) + vanilla JS + PDF server-side rendering
- **Rationale:** One new technology at a time (Fabric.js first, then PDF.js text layer, then React/Tauri later)
- **What we lose (temporarily):** Native desktop feel, system tray, drag-and-drop
- **What we gain:** Ship 4-6 weeks faster, stay in comfort zone, nothing is wasted when wrapping later

---

## Architecture

```
Browser (localhost:8000)
├── Server-rendered PNG pages (PyMuPDF → PNG → <img>)
├── Fabric.js canvas overlay (Phase 1 — markup tools)
├── Toolbar, panels, page navigation
└── Plugin panel (Phase 4)

FastAPI Backend (Python)
├── PyMuPDF (fitz) — PDF rendering, annotation embedding
├── SQLite — Project database
├── Tesseract — OCR (Phase 3)
├── Ollama — AI features (Phase 5)
└── Plugin system (Phase 4)
```

---

## Phase 0 Deliverables (Completed 2026-02-15)

### Files Created

| File | Purpose |
|------|---------|
| `main.py` | FastAPI app — routes, upload, page rendering API |
| `db.py` | SQLite database layer — projects, documents, markups schema |
| `pdf_engine.py` | PyMuPDF wrapper — page rendering, thumbnails, metadata |
| `run.sh` | Launch script (activates venv, starts uvicorn) |
| `requirements.txt` | Python dependencies |
| `templates/base.html` | Base HTML template |
| `templates/editor.html` | Main editor UI (toolbar, viewport, panels) |
| `static/css/style.css` | Dark professional theme |
| `static/js/app.js` | Main application controller (ES module) |
| `static/js/pdf-viewer.js` | PDF viewing, zoom, pan, navigation |
| `static/js/toolbar.js` | Toolbar button bindings, keyboard shortcuts |
| `static/js/canvas.js` | Fabric.js overlay stub (Phase 1) |
| `static/js/plugins.js` | Plugin loader stub (Phase 4) |
| `static/lib/pdf.min.mjs` | PDF.js 4.10.38 (kept for future use) |
| `static/lib/pdf.worker.min.mjs` | PDF.js worker |
| `static/lib/fabric.min.js` | Fabric.js 6.9.1 |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Home page with welcome screen + recent files |
| GET | `/edit/{doc_id}` | Editor page for a specific document |
| POST | `/api/upload` | Upload a PDF file |
| GET | `/api/documents/{id}/info` | Document metadata |
| GET | `/api/documents/{id}/page/{n}` | Render page as PNG |
| GET | `/api/documents/{id}/thumbnail/{n}` | Page thumbnail |
| GET | `/api/documents/recent` | Recent documents list |
| DELETE | `/api/documents/{id}` | Delete a document |

### Test Results (All Passing)

- Home page serves correctly (HTTP 200)
- Static files (CSS, JS, libraries) all load
- PDF upload validates file type and magic bytes
- Page rendering produces valid PNG images
- Thumbnails generate correctly
- Error handling works (404 for invalid docs/pages)
- Recent documents tracking works
- Database initializes schema on first run

---

## Phase Timeline

| Phase | Weeks | Focus |
|-------|-------|-------|
| **Phase 0** | 1 | Project setup, PDF viewing ✅ |
| Phase 1 | 2-5 | Basic markup tools (Fabric.js) |
| Phase 2 | 6-9 | Measurement & takeoff |
| Phase 3 | 10-13 | OCR & search |
| Phase 4 | 14-17 | Plugin system + ExtendedCognition port |
| Phase 5 | 18-24 | AI integration (Ollama) |
| Phase 6 | 25-30 | Desktop shell (Electron/Tauri) |

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Backend | FastAPI | 0.115.0 |
| PDF Engine | PyMuPDF (fitz) | 1.24.9 |
| Canvas | Fabric.js | 6.9.1 |
| PDF Rendering (future) | PDF.js | 4.10.38 |
| Database | SQLite | (built-in) |
| Server | Uvicorn | 0.30.6 |

---

## Phase 1 Progress — Canvas Integration Layer (Completed 2026-02-15)

### Files Modified
| File | Change |
|------|--------|
| `templates/editor.html` | Added `<canvas id="fabric-canvas">` + Fabric.js 6.9.1 script tag |
| `static/css/style.css` | Absolute positioning, pointer-events passthrough, `.drawing-active` toggle |
| `static/js/canvas.js` | Full CanvasOverlay: init, zoom sync, page save/restore, drawing mode, serialization |
| `static/js/app.js` | Wired canvas to viewer callbacks, lastPage tracking, `window.app` exposed |

### Key Design Decisions
- Natural coords (BASE_DPI 150) + Fabric.setZoom(scale) for display
- Pan sync free (canvas child of scrolling container)
- Pointer-events CSS toggle for drawing/panning mode switch
- Image load listener to fix init race condition
- In-memory Map for per-page markups (persistence not yet wired to DB)

### Verified: 26/26 browser tests passed

---

## Phase 1 Progress — Core Infrastructure (Completed 2026-02-15)

### Delivered
- **Markup Persistence API:** `PUT/POST/GET /api/documents/{id}/markups` with SQLite storage
- **Undo/Redo:** Async JSON snapshot stack (50 deep), Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
- **Pen Tool:** PencilBrush, red ink, 3px, toolbar button, P shortcut

### Files Modified
| File | Change |
|------|--------|
| `db.py` | `save_markups()`, `get_markups()` methods |
| `main.py` | PUT/POST/GET markup endpoints (api_route for sendBeacon compat) |
| `canvas.js` | `loadAllPageMarkups()`, undo/redo stack, `onContentChange` callback |
| `app.js` | Auto-save (3s debounce), sendBeacon on unload, dirty tracking |
| `toolbar.js` | Tool selection system, pen config, keyboard shortcuts |

### Verified: 24/24 browser tests passed

---

## Phase 1 Progress — Shape Tools + Semantic Metadata (Completed 2026-02-16)

### Delivered
- **Shape Tools:** Rectangle (R), Ellipse (E), Line (L) with interactive mouse drawing
- **Semantic Metadata:** Every Fabric object carries `markupType`, `markupStatus`, `markupNote`
- **Custom Property Serialization:** `fabric.Object.prototype.toObject` patched for CUSTOM_PROPERTIES
- **`canvas.stampDefaults(obj)`** stamps metadata at creation time
- **Delete key** removes selected objects

### Key Decisions
- Fabric.js 6 `loadFromJSON` uses Promise API (not callbacks) — all calls made async
- Prototype patch ensures custom properties survive all serialization paths
- `_isShapeTooSmall()` prevents accidental zero-size shapes

### Verified: 40/40 browser tests passed

---

## Phase 1 Progress — Properties Panel (Completed 2026-02-16)

### Delivered
- **Selection-driven panel:** Shows type/status/note/color/width when markup selected
- **Bi-directional sync:** Panel reads from object, edits write back immediately
- **Type dropdown:** Note, Issue, Question, Approval, Change
- **Status dropdown:** Open, Resolved
- **Note textarea:** Free text
- **Appearance controls:** Color picker, stroke width slider

### Files Created/Modified
| File | Change |
|------|--------|
| `static/js/properties.js` | **New** — PropertiesPanel class |
| `templates/editor.html` | Markup props section with form controls |
| `static/css/style.css` | Dark-themed selects, textarea, color/range inputs |
| `app.js` | Import PropertiesPanel, init/rebind, dirty wiring |

### Verified: 30/30 browser tests passed (70/70 cumulative)

---

## Phase 1 Progress — Markup List Panel (Completed 2026-02-17)

### Delivered
- **Tabbed left panel:** Pages/Markups tabs replace single Pages panel
- **Markup list:** Aggregates all markups across all pages into filterable table
- **Type filter:** Dropdown filters by note/issue/question/approval/change
- **Status filter:** Dropdown filters by open/resolved
- **Combined filters:** Both filters work together
- **Click to select:** Same-page click selects object, cross-page click navigates + selects
- **Count summary:** "N markups" (unfiltered) or "N/M markups" (filtered)
- **Active row highlight:** Clicked row gets blue left border highlight
- **Auto-refresh:** Debounced 300ms refresh on canvas content changes

### Files Created/Modified
| File | Change |
|------|--------|
| `static/js/markup-list.js` | **New** — MarkupList class with scan/render/filter/navigate |
| `templates/editor.html` | Left panel → tabbed (Pages/Markups), markup list HTML |
| `static/css/style.css` | Tab styles, markup row/badge/dot styles, filter dropdown |
| `app.js` | Import MarkupList, init/wire, navigate/select/refresh logic |

### Key Decisions
- Tabbed panel (not a new panel) — saves horizontal space
- `refresh()` calls `onPageChanging()` to include current page in scan
- Cross-page navigation uses `_pendingSelect` + `onPageChanged().then()`
- `_selectObjectByIndex` checks `activeTool !== 'select'` before calling `setTool` to avoid toggle-off bug
- Tests clear server markups at start to prevent stale data interference

### Verified: 30/30 browser tests passed (100/100 cumulative)

---

## Phase 1 Completion Summary (2026-02-17)

All Phase 1 items delivered:

| # | Item | Status |
|---|------|--------|
| 1 | Markup list panel (filterable) | Done (2026-02-17) |
| 2 | Color-as-meaning + intent modes (1-5 keys) | Done (2026-02-17) |
| 3 | Ambient status bar counts | Done (2026-02-17) |
| 4 | Highlighter tool | Done (2026-02-17) |
| 5 | Text annotations (IText) | Done (2026-02-17) |
| 6 | Cloud tool (revision cloud) | Done (2026-02-17) |
| 7 | Callout tool (leader line + text) | Done (2026-02-17) |
| 8 | Test runner consolidation (run_tests.mjs) | Done (2026-02-17) |
| 9 | PDF export with flattened annotations | Done (2026-02-17) |
| 10 | Design manifesto | Done (2026-02-17) |

**Total tests:** 204 passing across 6 suites (shapes, properties, markup-list, color-meaning, phase1-tools, polish)

**Tools available:** Select, Pen, Rectangle, Ellipse, Line, Highlighter, Text, Cloud, Callout
**Export:** GET /api/documents/{id}/export returns PDF with annotations as native shapes

---

## Pre-Phase 2 Gates — COMPLETE (2026-02-22)

| Gate | Status | Notes |
|------|--------|-------|
| 1. Self-guided user test with real construction PDF | Pending user action | — |
| 2. markupAuthor + markupTimestamp metadata | Done | canvas.js, properties.js, editor.html |
| 3. Calibration spike + scale infrastructure | Done | spike_calibration.py (23/23 ✓), ScaleManager, document_settings table, GET/PUT /api/documents/{id}/scale, status bar selector |

**Calibration result (spike_calibration.py 2026-02-22):**
- RENDER_DPI = 150, PDF_DPI = 72, scale = 0.48 px→pt — all verified end-to-end with PyMuPDF
- pixelsPerFoot at 1/4"=1': **37.5 px/ft** (core measurement constant for Phase 2)
- Formula: `pixelsPerRealUnit = 150 × paperInchesPerUnit`

**Scale infrastructure:**
- `document_settings` table (key/value per doc, generic for future phases)
- `GET/PUT /api/documents/{id}/scale` — preset + derived `pixels_per_unit`
- `static/js/scale.js` — `ScaleManager` with `SCALE_PRESETS` (Arch + Engineering series)
- Status bar scale selector (Unscaled through 3"=1', 1"=10' through 1"=100')
- `app.scale.formatDistance(pixels)` → "10.00 ft" at any active scale

---

## User Feature Requests (from real-world testing 2026-02-18)

These come directly from daily construction/facilities management workflow — the features that make the difference between a drawing tool and a work management system.

### Blank Pages & Documents
- **Blank document**: Create a new document without uploading a PDF (sketch pad, notes)
- **Add blank page**: Insert a blank page into an existing document
- *Phase fit: Phase 1.5 or early Phase 2 — low complexity, high utility*

### Cross-Page Navigation & Table of Contents
- **Table of contents**: User-created TOC page with clickable links to specific regions on other pages
- **Cross-page links**: Select an area on page 5, create a link to it from page 1
- *Phase fit: Phase 3+ — needs internal link/bookmark data model*

### Rich Text & Annotations
- **In-document text**: Add text blocks beyond markup labels (paragraphs, descriptions)
- **Footnotes**: Numbered footnotes tied to specific locations in the document
- **Enhanced comments**: Comments pointing at specific items with threading/context (beyond current callout)
- *Phase fit: Phase 3 (text layer) — needs richer text model than current IText*

### Image Insertion
- **Embed images**: Insert photos, diagrams, or screenshots into document pages
- Use case: site photos next to the corresponding plan area
- *Phase fit: Phase 2-3 — Fabric.js `Image` object + upload endpoint*

### Change & Equipment Tracking
- **Track changes/equipment**: Record and track devices, equipment locations, changes over time
- Use case: mark where devices are located on plans, track status across revisions
- *Phase fit: Phase 4-5 — needs revision history + entity model (equipment as first-class objects, not just shapes)*

### Customizable Toolsets (Bluebeam Tool Chest equivalent)
- **Saved tool configurations**: Pre-configured markup tools for specific workflows
- Example: "HVAC Review" toolset with equipment-specific shapes, colors, and metadata defaults
- Example: "Electrical Inspection" toolset with device symbols and checklist metadata
- Most impactful Bluebeam feature for domain-specific work
- *Phase fit: Phase 4 (plugin system) — tool chest = plugin that provides custom tool palettes*

### Completed (2026-02-22)

| Feature | Status |
|---------|--------|
| Blank document (New button + modal, name/pages/size) | Done |
| Add blank page (+ Add Page in Pages panel, appends at end) | Done |

**Files changed:** `pdf_engine.py` (create_blank_document, add_blank_page), `db.py` (update_document_page_count), `main.py` (PAGE_SIZES, POST /api/documents/blank, POST /api/documents/{id}/pages/blank), `editor.html` (New button, pages-panel-footer, modal), `style.css` (modal + btn-add-page styles), `toolbar.js` (_showNewDocModal, _hideNewDocModal, _handleNewDocument), `app.js` (_addBlankPage, _addPageBound wire-up)

**Test baseline:** 204/204 still passing after changes.

### Priority Assessment
| Feature | Impact | Complexity | Suggested Phase |
|---------|--------|-----------|----------------|
| Blank pages/docs | Medium | Low | 1.5 / 2 ✅ done |
| Image insertion | Medium | Low-Med | 2-3 |
| Enhanced comments | High | Medium | 3 |
| Footnotes | Medium | Medium | 3 |
| Cross-page links / TOC | High | High | 3+ |
| Change/equipment tracking | Very High | High | 4-5 |
| Customizable toolsets | Very High | High | 4 |

---

## Session Resumption

```
"Continue OpenRevu development. Read the plan at:
PKM/Inbox/OpenRevu_Plan_2_15_2026.md

Project location: /mnt/c/Users/User1/ClaudeProjects/OpenRevu/
Current phase: Phase 1 COMPLETE. Phase 2 pending calibration spike.
Design manifesto: PKM/Permanent Notes/OpenRevu_Design_Manifesto.md
Latest council: PKM/AI/Sessions/2026-02-17_openrevu-phase1-completion-meta-review.md

Next action: Pre-Phase 2 gating — user test, author metadata, calibration spike."
```

---

## Links

- Original pipeline: `~/.claude/PIPELINES/Engineering_OpenRevu/PIPELINE.md`
- ExtendedCognition v1: `/mnt/c/Users/User1/ClaudeProjects/ExtendedCognition_v1/`
- Cybernetic security framework: `PKM/Inbox/Cybernetic_*.md`
- Lessons learned: `PKM/Permanent Notes/OpenRevu_Lessons_Learned.md`
- Council sessions: `PKM/AI/Sessions/2026-02-1*_openrevu-*.md`
