# PortolanCAST — As-Built Architecture

**Last updated:** 2026-03-30
**Status:** Living document — updated with each major feature addition

---

## Overview

PortolanCAST is a local-first web application for construction document markup,
measurement, and equipment management. It runs as a FastAPI backend with a
Fabric.js 6.9.1 canvas frontend, storing all data in SQLite. No cloud dependency.

### Core Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3 / FastAPI / Uvicorn |
| **PDF Engine** | PyMuPDF (fitz) — render, OCG layers, text extraction |
| **CAD Engine** | ezdxf + matplotlib — DXF parsing, layer extraction, PNG rendering |
| **DWG Converter** | LibreDWG (dwg2dxf.exe) + custom repair pipeline |
| **Frontend** | Fabric.js 6.9.1, vanilla JS, CSS |
| **Database** | SQLite (`data/portolancast.db`) |
| **Tests** | Playwright + custom smart runner (`node run_smart_tests.mjs`) |

### Directory Layout

```
PortolanCAST/
├── main.py                 # FastAPI app entry point
├── config.py               # Server configuration
├── database.py             # SQLite connection + schema
├── pdf_engine.py           # PDF rendering, OCG layers, text extraction
├── dxf_engine.py           # DXF/DWG rendering, layer extraction, text entities
├── dwg_converter.py        # DWG→DXF conversion with R10 repair pipeline
├── routes/
│   ├── documents.py        # Upload, render, layers, thumbnails, export, delete
│   ├── text.py             # Text extraction (PDF + CAD)
│   ├── markups.py          # Markup CRUD
│   ├── entities.py         # Equipment entity management
│   ├── patterns.py         # Haystack pattern system
│   ├── connections.py      # Entity-to-entity connections
│   └── ...
├── static/
│   ├── css/style.css       # All styles including menu bar
│   └── js/
│       ├── toolbar.js      # Menu bar (File/Edit/View/Help) + tool buttons
│       ├── viewer.js       # Fabric.js canvas, rendering, page navigation
│       ├── markups.js       # Markup creation and management
│       └── ...
├── templates/
│   └── editor.html         # Main SPA template
├── data/                   # SQLite DB + uploaded files (gitignored)
├── tests/                  # Playwright test suites
├── docs/                   # Design specs + session logs
├── QUICKSTART.md           # User guide (served at /help)
└── AS_BUILT.md             # This file
```

---

## Document Format Support

PortolanCAST handles three document formats through a unified upload/render pipeline.

### PDF (primary)

- Upload stores the PDF file; PyMuPDF renders pages to PNG on demand
- OCG (Optional Content Groups) layer visibility toggles
- Text extraction via PyMuPDF for search

### DXF (native CAD)

- Parsed directly by `dxf_engine.py` using ezdxf
- Layer extraction: each DXF layer becomes a toggleable visibility layer
- Block definitions and insertions preserved
- Text entities (TEXT, MTEXT, ATTRIB) extracted for search
- Rendered to PNG via ezdxf's matplotlib backend with selective layer visibility
- Color mapping: AutoCAD ACI colors converted to RGB

### DWG (converted to DXF)

- `dwg_converter.py` handles the conversion pipeline
- Uses LibreDWG's `dwg2dxf.exe` (win64 binary at `~/.local/libredwg/`)
- **R10 repair pipeline**: LibreDWG produces malformed BLOCKS sections for
  legacy AC1006/R10 DWG files. The converter works around this by:
  1. Running `dwg2dxf.exe` to get raw DXF output
  2. Skipping the malformed BLOCKS section entirely
  3. Text-parsing the ENTITIES section to extract LINE, ARC, CIRCLE, TEXT, etc.
  4. Rebuilding a clean R2010 DXF using ezdxf's document model
  5. Writing the repaired DXF for use by `dxf_engine.py`
- Entity count capped at 100,000 to prevent memory exhaustion
- Subprocess called with list args (no shell injection)
- Source format (`dwg` or `dxf`) stored in document settings for downstream routing

### Format-Agnostic Routing (routes/documents.py)

The document routes detect format from stored settings and delegate:

| Operation | PDF path | CAD path |
|-----------|----------|----------|
| Upload | Store PDF directly | Convert DWG→DXF if needed, store DXF |
| Render page | PyMuPDF → PNG | dxf_engine → matplotlib → PNG |
| Get layers | PyMuPDF OCG groups | ezdxf layer list |
| Text extraction | PyMuPDF text blocks | dxf_engine text entities |
| Thumbnail | PyMuPDF low-res render | dxf_engine render with bbox |
| Export | PyMuPDF with markups baked | DXF source file download |
| Delete | Remove PDF + DB records | Remove DXF + DB records |

### CAD-Specific Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/cad/converter-status` | Check if LibreDWG is available |
| `GET /api/documents/{id}/cad-info` | Layer list, block count, text entity count |

---

## Menu Bar Architecture

The toolbar uses a Bluebeam/Acrobat-style menu bar with four top-level menus.

### Menu Structure

| Menu | Items |
|------|-------|
| **File** | New, Open (Ctrl+O), Close, Save Bundle (Ctrl+S), Export PDF, Export Page as Image, Export to Obsidian, Print (Ctrl+P), Delete Document |
| **Edit** | Undo (Ctrl+Z), Redo (Ctrl+Y), Delete Selected (Del), Select All (Ctrl+A), Deselect All (Esc) |
| **View** | Zoom In/Out/Fit, Rotate Page (Ctrl+R), Pages Panel toggle, Properties Panel toggle, Toolbar Settings |
| **Help** | Quick Start Guide (F1), Keyboard Shortcuts (?), About |

### Implementation

- **HTML**: `templates/editor.html` — menu bar div with nested dropdown structures
- **CSS**: `static/css/style.css` — `.dropdown-shortcut` for right-aligned keyboard
  hints, `.dropdown-item-danger` for red destructive actions (Delete Document)
- **JS**: `static/js/toolbar.js` — click handlers for each menu item, delegating
  to existing viewer/canvas methods. File input accepts `.pdf,.dxf,.dwg,.portolan`.

The menu bar replaced the previous toolbar dropdown menus. All functionality is
unchanged; the menus organize it into conventional categories that match user
expectations from Bluebeam Revu and Adobe Acrobat.

---

## Text Editing Enhancements

Bluebeam/Acrobat-parity text editing for field inventory workflow.

### Floating Text Format Bar (`static/js/text-format-bar.js`)

Appears above IText/Textbox objects during editing. Contains: font family
(system fonts detected via `queryLocalFonts()` or canvas measurement fallback),
font size, bold/italic/underline/strikethrough toggles, L/C/R alignment, color
picker, and spell check button. Uses `position: fixed` with scroll-aware
repositioning. Prevents focus theft via `mousedown preventDefault` on non-input
elements.

### Quick Text Stamps (`static/js/tools-panel.js`)

15 built-in entries in the Stamps panel: 9 HVAC equipment prefixes (AHU-, VAV-,
FCU-, RTU-, CHP-, CHW-, HW-, EF-, P-) and 6 status labels (VERIFIED, NEEDS
ATTENTION, NOT FOUND, REPLACED, FIELD VERIFY, AS-BUILT DIFFERS). Equipment
prefixes create editable IText with cursor at end for immediate appending
(e.g., "AHU-" → user types "1" → "AHU-1"). Status labels place as immutable text.

### Find & Replace (`static/js/find-replace.js`)

Ctrl+H or Edit menu. Searches all text-bearing objects on the current page
(IText `.text` and `.markupNote` metadata). Live search with match count,
prev/next navigation (highlights with cyan border), Replace/Replace All.
Case-sensitive toggle.

### Additional Typography Controls

- **Underline & Strikethrough**: Toggle buttons in properties panel typography
  section (Fabric.js `underline` and `linethrough` properties)
- **Text Alignment**: Left/center/right buttons in properties panel
- **Continuous Text Placement**: Text and sticky note tools stay active after
  placing, enabling click-type-click-type workflow. Escape exits.
- **Spell Check**: Modal with native `<textarea spellcheck="true">` — browser
  handles red squiggles and right-click suggestions. Apply syncs back.
- **System Fonts**: Detected lazily on first text edit. Populates both format
  bar and properties panel font dropdowns.

---

## Haystack Pattern System

Equipment identification using ISA-5.1 structured patterns. 12 HVAC patterns,
45 tags, auto-generated ISA tag numbers (TT-101, TV-201, etc.).

See `QUICKSTART.md` sections: Equipment Patterns & ISA View, Validation Engine.

---

## Key Design Decisions

1. **Local-first**: All data in SQLite + filesystem. No cloud, no accounts.
2. **Format-agnostic document model**: PDF and CAD share the same markup/entity
   database. The rendering layer is the only difference.
3. **DWG repair over rejection**: Rather than refusing old DWG files, the converter
   text-parses and rebuilds them. This trades some fidelity (block definitions may
   be simplified) for broad compatibility with legacy drawings.
4. **Menu bar convention**: Following Bluebeam/Acrobat menu patterns so users from
   those tools find familiar navigation.
5. **Intent-first markup**: Press 1-5 for meaning, then draw the shape. Every
   markup carries semantic type from creation.
