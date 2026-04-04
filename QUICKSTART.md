# PortolanCAST Quick Start Guide

PortolanCAST is an open-source markup and measurement tool for construction
professionals. Open PDFs, DXF, and DWG files. Mark up drawings, measure distances
and areas, organize by layer, and generate structured review briefs — all in a
local web app with no cloud dependency.

---

## Table of Contents

1. [Starting the Server](#starting-the-server)
2. [Loading Documents](#loading-documents)
3. [Opening DWG and DXF Files](#opening-dwg-and-dxf-files)
4. [Menu Bar](#menu-bar)
5. [Drawing Markups](#drawing-markups)
6. [Properties Panel](#properties-panel)
7. [Text Editing](#text-editing)
8. [Measurement Tools](#measurement-tools)
9. [Left Panel Tabs](#left-panel-tabs)
10. [Layers](#layers)
11. [Review Brief + Tags](#review-brief--tags)
12. [RFI Generator](#rfi-generator)
13. [Search](#search)
14. [Photo Attachments](#photo-attachments)
15. [Entity Management](#entity-management-equipment-tab)
16. [Quick Capture](#quick-capture)
17. [Image Overlays](#image-overlays)
18. [PDF Layers (OCG)](#pdf-layers-ocg)
19. [Obsidian Export](#obsidian-export)
20. [Health Monitor](#health-monitor)
21. [nodeCAST (Graph View)](#nodecast-graph-view)
22. [Equipment Patterns & ISA View](#equipment-patterns--isa-view)
23. [Validation Engine](#validation-engine)
24. [Navigating Pages](#navigating-pages)
25. [Keyboard Shortcuts](#keyboard-shortcuts)
26. [Save, Export, and Bundles](#save-export-and-bundles)
27. [Tips and Workflow](#tips-and-workflow)

---

## Starting the Server

### Option 1 — Windows Desktop Launcher (recommended)

Copy `scripts/PortolanCAST.bat` to your Windows Desktop and double-click it.

The launcher automatically:
- Resolves the current WSL2 IP (it changes on every reboot)
- Starts the FastAPI server in WSL
- Starts a TCP relay so `localhost:8000` works from Windows
- Opens your browser once the server is ready

A **PortolanCAST Server** terminal window will appear — this is your server log. Keep it open while using the app. Close it to stop the server.

> **First-time setup:** Right-click `PortolanCAST.bat` → Properties → Unblock (if Windows flags it). Then double-click to run.

---

### Option 2 — WSL Terminal

```bash
cd ~/projects/PortolanCAST
venv/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Then open your browser to **`http://localhost:8000`**.

> **WSL2 networking note:** If `localhost:8000` does not connect, use the WSL IP directly.
> Get it with: `wsl hostname -I`
> Then open `http://<that-ip>:8000` in your Windows browser.

> **Stop a stuck server:**
> ```bash
> kill $(ss -tlnp 'sport = :8000' | awk 'NR>1{gsub(/.*pid=/,"",$NF); gsub(/,.*/,"",$NF); print $NF}')
> ```

---

All data is stored locally in `data/portolancast.db`. Nothing leaves your machine.

---

## Loading Documents

| Action | How |
|--------|-----|
| Open a file | **File → Open** (Ctrl+O) → select a PDF, DXF, or DWG |
| Create a blank document | **File → New** → enter a name and page size |
| Import a bundle | **File → Open** → select a `.portolan` file (restores document + all markups, layers, and scale) |
| Reopen a recent document | Click its name in the welcome screen list |

PortolanCAST accepts PDF, DXF, and DWG files. DWG files are automatically
converted to DXF on upload (see [Opening DWG and DXF Files](#opening-dwg-and-dxf-files)).

---

## Opening DWG and DXF Files

PortolanCAST natively supports DXF (AutoCAD Drawing Exchange Format) and DWG
(AutoCAD native binary format) files alongside PDF.

### DXF Files

DXF files open directly with no additional requirements. PortolanCAST extracts:

- **Layers** — each DXF layer appears in the Layers panel with independent
  visibility toggles, just like PDF OCG layers
- **Text entities** — TEXT, MTEXT, and ATTRIB elements are searchable
- **Block insertions** — block references are rendered in place

### DWG Files

DWG files are converted to DXF automatically on upload. This requires the
**LibreDWG** converter to be installed.

**Installing LibreDWG:**

1. Download the win64 release from [LibreDWG GitHub](https://github.com/LibreDWG/libredwg/releases) (v0.13.4 or later)
2. Extract to `~/.local/libredwg/` so that `~/.local/libredwg/dwg2dxf.exe` exists
3. No PATH changes needed — PortolanCAST looks for it at that location

**Check converter status:** Visit `/api/cad/converter-status` or check the
Health Monitor panel.

> **Legacy DWG files (R10/AC1006):** PortolanCAST includes a repair pipeline
> for old DWG files that produce malformed DXF output. The converter extracts
> entities directly from the raw DXF text and rebuilds a clean file. Some block
> definitions may be simplified, but lines, arcs, text, and circles are preserved.

### CAD Layer Visibility

When a CAD file is open, the **Layers panel** shows all DXF layers. Toggle
the eye icon to show or hide individual layers. The page re-renders with only
the visible layers drawn — useful for isolating mechanical, electrical, or
architectural disciplines.

---

## Menu Bar

PortolanCAST uses a Bluebeam/Acrobat-style menu bar with four top-level menus.

| Menu | Key Items |
|------|-----------|
| **File** | New, Open (Ctrl+O), Close, Save Bundle (Ctrl+S), Export PDF, Export Page as Image, Export to Obsidian, Print (Ctrl+P), Delete Document |
| **Edit** | Undo (Ctrl+Z), Redo (Ctrl+Y), Delete Selected (Del), Select All (Ctrl+A), Deselect All (Esc), Find & Replace (Ctrl+H) |
| **View** | Zoom In/Out/Fit, Rotate Page (Ctrl+R), Pages Panel, Properties Panel, Toolbar Settings |
| **Help** | Quick Start Guide (F1), Keyboard Shortcuts (?), About |

Keyboard shortcuts are shown on the right side of each menu item.

Destructive actions (Delete Document) appear in red to prevent accidental clicks.

---

## Drawing Markups

### Intent First, Shape Second

The core workflow is two keystrokes: **set what it means**, then **draw it**.

**Step 1 — Set your intent (what the markup means):**

| Key | Intent | Color | Use for |
|-----|--------|-------|---------|
| **1** | Note | Gray | General observations, reminders |
| **2** | Issue | Red | Problems requiring action |
| **3** | Question | Amber | Items needing clarification |
| **4** | Approval | Green | Sign-offs, confirmed items |
| **5** | Change | Blue | Scope or design changes |

The toolbar shows your active intent (colored dot + label). Every markup you draw
carries this meaning automatically — no need to re-assign after the fact.

**Step 2 — Pick a tool (how you mark it):**

| Key | Tool | How to use |
|-----|------|------------|
| **V** | Select | Click to select, move, or resize markups |
| **P** | Pen | Free-draw strokes |
| **R** | Rectangle | Click + drag |
| **E** | Ellipse | Click + drag |
| **L** | Line | Click + drag |
| **H** | Highlighter | Click + drag — semi-transparent overlay |
| **T** | Text | Click to place; type annotation; auto-returns to Select |
| **W** | Polyline | Click to add vertices; double-click to finish open path |
| — | Polygon | Click to add vertices; double-click to close and fill (25% opacity) |
| **Shift+A** | Arrow | Click + drag — line with arrowhead |
| — | Arc | Click + drag — semicircular arc between two points |
| **C** | Cloud | Click + drag — revision cloud (construction standard) |
| **O** | Callout | Click anchor point, then click text position |
| — | Dimension | Click + drag — line with auto-measured text from scale |
| — | Eraser | Click on any markup to delete it |
| **S** | Sticky Note | Click to place a yellow note box |
| **G** | Hand | Click + drag to pan without activating a tool |
| **Esc** | Deselect | Exit current tool, return to pan/scroll |

### Example Workflow

```
Press 2  →  Issue mode (red)
Press R  →  Rectangle tool
Drag on the drawing  →  Red rectangle appears
Press V  →  Select the rectangle
Type a note: "Duct conflicts with beam at grid C-4 #structural #urgent"
```

---

## Properties Panel

When a markup is selected, the **right panel** shows its properties.

| Field | Description |
|-------|-------------|
| **Type** | Dropdown — change intent (Note / Issue / Question / Approval / Change) |
| **Status** | Dropdown — Open or Resolved |
| **Note** | Free text. Use `#tag` syntax to add topics (see [Review Brief + Tags](#review-brief--tags)) |
| **Author** | Who created it (read-only, set at creation time) |
| **Created** | Timestamp (read-only) |
| **Stroke / Width** | Visual properties — color and line weight |
| **Photos** | Attach reference photos to this markup (see [Photo Attachments](#photo-attachments)) |

Tag chips appear live below the Note field as you type `#word` patterns.

---

## Text Editing

PortolanCAST includes Bluebeam/Acrobat-style text editing features designed for
field inventory work.

### Floating Format Bar

When you edit any text object (Text tool, Sticky Note, Callout), a floating
toolbar appears directly above the text with:

- **Font family** — includes your system fonts (detected automatically)
- **Font size** — 6–200px
- **B / I / U / S** — Bold, Italic, Underline, Strikethrough
- **Alignment** — Left, Center, Right
- **Color picker** — change text color
- **Spell check** — opens a browser-native spell check dialog

The bar follows the text if you move it and hides during scrolling.

### Quick Text (Stamps Panel)

The Stamps panel (in the collapsible right-side Tools area) includes a
**Quick Text** section with pre-built HVAC equipment tags and status labels:

**Equipment prefixes** (editable — cursor at end for appending):
AHU-, VAV-, FCU-, RTU-, CHP-, CHW-, HW-, EF-, P-

**Status labels** (placed as-is):
VERIFIED, NEEDS ATTENTION, NOT FOUND, REPLACED, FIELD VERIFY, AS-BUILT DIFFERS

Click a Quick Text item, then click on the drawing to place it. Equipment
prefixes enter editing mode so you can immediately type the tag number
(e.g., click "AHU-" → click on drawing → type "1" → result is "AHU-1").

### Continuous Text Placement

The Text tool and Sticky Note tool stay active after placing text. You can
click → type → click elsewhere → type again without re-selecting the tool.
Press **Escape** to exit text placement mode.

### Find & Replace

**Ctrl+H** (or **Edit → Find & Replace**) opens the search dialog:

- Searches all text markups and notes on the current page
- Live match count with **▲ / ▼** navigation between matches
- **Replace** (current match) and **Replace All** buttons
- Optional case-sensitive matching

### Spell Check

Click the pencil button (✏) in the floating format bar while editing text.
A dialog opens with your text in a standard text area where your browser's
built-in spell check is active — misspelled words get red underlines and
right-click shows suggestions. Click **Apply** to sync corrections back.

### PDF Text Selection

In **Hand mode** (press **G** or **Esc**), you can click and drag over PDF text to
select it — just like in Bluebeam or Adobe Reader. Selected text can be copied
with Ctrl+C. Text selection is automatically disabled when any drawing or
measurement tool is active.

The text layer works by overlaying invisible positioned text spans that match
the PDF's native text positions. This only works for born-digital PDFs (not
scanned images).

### Grouping

Select multiple markups, then press **Ctrl+G** to combine them into a single
group. The group moves, scales, and rotates as one object.

Press **Ctrl+Shift+G** to ungroup back into individual markups. Only
user-created groups can be ungrouped — measurement groups, callouts, and
equipment markers are protected.

Group and Ungroup are also available in the **Edit** menu.

---

## Measurement Tools

Set the drawing scale first (bottom status bar → scale selector), then measure.

| Key | Tool | How to use |
|-----|------|------------|
| **U** | Distance | Click start point, click end point |
| — | Polylength | Click to add segments; double-click to finish. Shows per-segment + total distance |
| **A** | Area | Click vertices; double-click to close polygon |
| — | Perimeter | Click vertices; double-click or snap to close. Measures total edge length |
| — | Angle | Click 3 points: ray endpoint, vertex, ray endpoint. Shows angle in degrees |
| — | Radius/Diameter | Click center, drag to edge. Shows circle outline, diameter line, and measurement |
| — | Volume | Click vertices like Area; after closing, enter depth for cubic measurement |
| — | Cloud+ | Click-drag to draw a cloud shape with auto-calculated enclosed area |
| — | Sketch to Scale | Click to place, enter width and height — draws a rectangle at calibrated dimensions |
| **N** | Count | Click to place numbered markers |
| **K** | Calibrate | Click two known points, enter the real-world distance |

Measurements appear on the canvas with live-formatted labels. Select a measurement
object to see its value in the Properties panel. Move or resize it and the value
recalculates automatically.

### Setting Scale

Use the **scale selector** in the bottom status bar:
- Pick a preset (1/4"=1', 1/8"=1', etc.)
- Or click **Calibrate (K)** to derive scale from a known dimension on the drawing

---

## Left Panel Tabs

Click any tab in the left panel to switch views.

### Pages
Thumbnail strip for all pages. Click a thumbnail to navigate. Use **+ Add Page**
at the bottom to append a blank page to the document.

### Markups
Filterable table of every markup across all pages.

- **Type filter**: narrow to Issues, Questions, Changes, Notes, or Approvals
- **Status filter**: show only Open or Resolved items
- **Tag cloud**: appears automatically when any markup has `#tags` in its note.
  Click a tag chip to filter the list. Click the active chip (or "All") to clear.
- **Click any row** to jump to that page and select the markup on canvas

### Measures
Aggregated measurement summary for the document.
- Stat cards: total distances, areas, and count markers
- Filterable rows with formatted values (respects current scale)
- **Export CSV** button to download all measurements

### Layers
Organize markups into named layers (see [Layers](#layers)).

### Search
Full-text search across all documents and markup notes — see [Search](#search).

### Brief
Structured review brief — see [Review Brief + Tags](#review-brief--tags).

### RFI
Formal numbered RFI document generator — see [RFI Generator](#rfi-generator).

---

## Layers

The **Layers tab** lets you organize markups into named groups with independent
visibility and locking.

| Action | How |
|--------|-----|
| Create a layer | Click **+ Layer** in the Layers tab |
| Rename a layer | Click the layer name to edit inline |
| Set active layer | Click the layer row — new markups go onto this layer |
| Toggle visibility | Click the eye icon |
| Lock a layer | Click the lock icon — locked layer markups cannot be selected |
| Delete a layer | Click the × button (markups on that layer move to Default) |

New markups are automatically assigned to the active layer.

---

## Review Brief + Tags

### Tags

Tags are `#word` patterns typed directly in the Note field:

```
Beam clash at grid C-4 #structural #urgent
```

- Tag chips appear **live** below the note field as you type
- The **Markups tab** shows a tag cloud — click any chip to filter the list
- Tags are normalized to lowercase (`#RFI-042` = `#rfi-042`)
- The **Review Brief** includes a Tag Index section at the end
- The **Search** tab already finds `#tags` — just search `#structural`

### Review Brief

Click the **Brief tab** in the left panel.

1. Click **Refresh** — generates a structured Markdown brief from the live canvas state
2. The brief groups markups by type: Issues → Questions → Changes → Notes → Approvals
3. Within each type: Open items first, then Resolved, sorted by page number
4. A **Tag Index** at the end cross-references every `#tag` with the markups that use it
5. Click **Copy MD** to copy raw Markdown to the clipboard

Paste the Markdown directly into an RFI, review letter, email, or documentation system.

**Example output:**
```
# Review Brief — Site-Plan-Rev3.pdf
February 25, 2026   3 open / 4 total
---
## Issues  (2)
### Open
- p.1 Rect — Duct conflicts with beam at C-4 #structural  [by J.Smith]
- p.3 Ellipse — Fire rating not shown #code
### Resolved
- p.2 Line — Column grid misalignment corrected
## Tag Index
### #code  (1)
- p.3 Ellipse — Fire rating not shown #code
### #structural  (1)
- p.1 Rect — Duct conflicts with beam at C-4 #structural
```

---

## RFI Generator

Click the **RFI tab** in the left panel to generate a formal numbered RFI document
from the live markup state.

### Header Fields

Fill in the project header fields at the top of the panel:

| Field | Description |
|-------|-------------|
| **RFI No** | Document reference number (e.g. RFI-042) |
| **Project** | Project name or code |
| **Drawing** | Drawing number or revision (e.g. M-101 Rev C) |
| **To** | Recipient (e.g. Mechanical Engineer) |
| **From** | Sender (e.g. Facilities Manager) |

Empty fields are shown as `—` placeholders in the output.

### Filters

Narrow which markups appear in the RFI:

| Filter | Options |
|--------|---------|
| **Type** | All / Issue / Question / Change / Note / Approval |
| **Status** | All / Open / Resolved |
| **Tag** | Type a `#tag` to include only markups with that tag in their note |

### Generating the RFI

1. Fill in header fields (optional — all can remain blank)
2. Set filters if you only want certain markups
3. Click **Generate** — the RFI Markdown appears in the panel
4. Click **Copy MD** to copy to the clipboard

**Example output:**

```
# RFI — RFI-042

**Project:** Campus HVAC Retrofit
**Drawing:** M-101 Rev C
**To:** Mechanical Engineer
**From:** Facilities Manager
**Date:** February 25, 2026

---

## Item 1 — Issue  (p.1 Rect)
**Location:** Page 1 — Rectangle
**Status:** Open
**Submitted by:** J.Smith
**Description:** Duct conflicts with beam at grid C-4 #structural #urgent

---

## Item 2 — Question  (p.1 Rect)
**Location:** Page 1 — Rectangle
**Status:** Open
**Submitted by:** K.Jones
**Description:** Clarify beam specification #rfi-042
```

Paste the Markdown into an email, Word doc, or documentation system. Each markup
becomes a numbered item with full attribution and location reference.

---

## Search

The **Search tab** searches across all documents and markup content.

- Searches document filenames
- Searches markup notes, types, and authors across all pages
- Results show document name, page number, and a context excerpt
- Click a result to navigate directly to that document and page
- Works across documents — not just the currently open one

---

## Photo Attachments

Attach reference photos to any markup object.

1. Select a markup (V + click)
2. In the Properties panel, click **+ Attach Photo**
3. Select an image file (JPEG, PNG, GIF, WEBP — max 20MB)
4. Thumbnails appear in the panel; hover a thumbnail to reveal the delete button

Photos are stored locally in `data/photos/` and linked to the markup by its UUID.
They survive save/load cycles and are independent of page number.

---

## Entity Management (Equipment Tab)

The **Equipment tab** in the left panel is your equipment registry — a database of
every piece of equipment across all your drawings.

### Viewing Entities

Click the **Equipment** tab in the left panel to see all registered entities.

| Column | Description |
|--------|-------------|
| **Tag** | ISA tag number (e.g., TT-101, TV-201) |
| **Type** | Equipment type (e.g., sensor, controller, actuator) |
| **Building** | Building or zone the equipment belongs to |

Click any row to open the **Entity Modal** with full details.

### Entity Modal

The Entity Modal is the central hub for a single piece of equipment. It shows:

| Section | Description |
|---------|-------------|
| **Header** | Tag number, building, equipment type, pattern name + ISA symbol |
| **Tags** | Colored pills showing structured tags (from pattern assignment) |
| **Log** | Timestamped activity log — add notes about inspections, issues, changes |
| **Tasks** | Task list for this entity — track maintenance items with status |
| **Parts** | Parts and spares inventory — model numbers, quantities, suppliers |
| **Photos** | Reference photos attached to this entity |
| **Connections** | Incoming (←) and outgoing (→) connections to other entities |

### Creating Entities

Entities are created two ways:

1. **Equipment Marker tool (M key)**: Place a pin on a drawing → create or link
   an entity in the panel that opens. Best for spatial mapping.
2. **Quick Capture**: Rapid field entry mode for bulk equipment registration.

---

## Quick Capture

Quick Capture is designed for fast field work — register multiple pieces of
equipment in rapid succession without placing markers on drawings.

### How to Use

1. Open **Quick Capture** from the Equipment tab (or the toolbar)
2. Select a **building** from the dropdown (or type a new one)
3. Select a **pattern** (e.g., "Zone Air Temperature Sensor")
4. Click **Create** — the entity is registered with an auto-generated ISA tag
5. The form resets for the next entry — keep going

Quick Capture is optimized for the workflow: arrive at a building, scan the
mechanical room, and register every piece of equipment you see. Sort out
connections and spatial placement later.

---

## Image Overlays

Place reference images directly on the canvas — useful for overlaying site photos,
manufacturer diagrams, or detail sketches on top of your drawings.

### Placing an Image

1. Click the **Image** button in the markup toolbar
2. Select an image file (JPEG, PNG, GIF, WEBP)
3. The image appears on the canvas as a resizable, movable object
4. Drag corners to resize; drag the body to reposition

### Properties

Image overlays are full markups — they appear in:
- The **Markup List** (type badge shows "Image")
- The **Properties Panel** (note, tags, status, entity link, photos)
- The **Review Brief** and **RFI Generator**
- **nodeCAST** (force graph)

---

## PDF Layers (OCG)

If your PDF contains named layers (common in AutoCAD/Revit exports), PortolanCAST
can toggle their visibility individually.

### Using PDF Layers

1. Open a PDF that has embedded layers (OCG groups)
2. The **PDF Layers** panel appears in the left panel
3. Each layer shows its name with an eye toggle
4. Click the eye icon to show/hide that layer
5. The page re-renders with the selected layers visible

### What Are OCG Layers?

OCG (Optional Content Groups) are named layer groups embedded in the PDF by
the authoring software (AutoCAD, Revit, Bluebeam). Common layers include:

- Walls, doors, windows (architectural)
- Ductwork, piping, equipment (mechanical)
- Wiring, panels, fixtures (electrical)
- Grid lines, dimensions, title block (annotation)

> **Note:** Layer quality depends on how the PDF was authored. Some AutoCAD
> exports place multiple disciplines on a single layer — this is a source file
> issue, not a PortolanCAST limitation.

---

## Obsidian Export

Export your markups as a structured folder of Markdown files, ready to import
into an [Obsidian](https://obsidian.md/) vault.

### How to Export

1. Open a document with markups
2. Click **File → Export to Obsidian** in the menu bar
3. A `.zip` file downloads containing one `.md` file per markup

### File Structure

```
DocumentName/
├── page-1/
│   ├── issue-abc123.md
│   ├── question-def456.md
│   └── note-ghi789.md
└── page-3/
    └── change-jkl012.md
```

Each file contains YAML frontmatter (type, status, author, page, tags) and the
markup note as the body. Files use `[[wikilinks]]` for cross-referencing.

---

## Health Monitor

The **Health Monitor** panel shows real-time system diagnostics.

### Status Indicator

A colored dot in the bottom-right of the status bar shows overall health:

| Color | Status | Meaning |
|-------|--------|---------|
| Green | Healthy | All checks passing |
| Yellow | Degraded | Non-critical check failing (e.g., AI endpoint offline) |
| Red | Unhealthy | Critical check failing (e.g., database unreachable) |

### Health Checks

Click the health dot to open the full Health Monitor panel:

| Check | What It Tests |
|-------|---------------|
| **Database** | SQLite connection + response time |
| **PDF Engine** | PyMuPDF version + availability |
| **Disk Space** | Free disk space on data volume |
| **Filesystem** | Read/write access to data directory |
| **AI Endpoint** | ClaudeProxy availability (optional — degraded is OK) |

### Running Tests

The Health Monitor panel includes a **Run Tests** button that streams the output
of the full test suite directly in the panel — useful for verifying the
installation is working correctly.

---

## nodeCAST (Graph View)

nodeCAST is a force-directed graph visualization of your markups, showing
relationships between markups, entities, and tags.

### Opening the Graph

Click the **Graph** tab in the right panel. The graph builds automatically from
the markups on the current page.

### What the Graph Shows

- **Nodes**: Each markup on the current page becomes a node
- **Colors**: Nodes are colored by markup type (red = issue, amber = question, etc.)
- **Edges**: Connections between related markups (shared entities, tags)
- **Layout**: Force-directed — related items cluster together

Click a node in the graph to select the corresponding markup on the canvas.

---

## Navigating Pages

| Action | Key / Method |
|--------|-------------|
| Next page | → (right arrow) or PageDown |
| Previous page | ← (left arrow) or PageUp |
| First page | Home |
| Last page | End |
| Jump to page | Click thumbnail in Pages tab |
| Scroll to next/prev page | Scroll past the top or bottom edge of a page |
| Zoom in | Ctrl + `+` or Ctrl + scroll up |
| Zoom out | Ctrl + `-` or Ctrl + scroll down |
| Reset zoom | Ctrl + 0 |
| Fit to width | **View → Zoom to Fit** or click **Fit** in toolbar |
| Pan | Scroll normally, or press G for Hand tool |

### Scroll-to-Page Navigation

When you scroll past the top or bottom edge of a page, a blue glow appears at
the edge and grows as you keep scrolling. Once the threshold is reached, the
viewer automatically advances to the next (or previous) page.

A 1.2-second cooldown prevents accidentally skipping multiple pages in one gesture.

**Adjusting sensitivity:** Open **View → Toolbar Settings** → drag the
**Scroll page sensitivity** slider.

| Setting | Behaviour |
|---------|-----------|
| Low | Requires a long deliberate push — hard to trigger accidentally |
| Medium (default) | Comfortable for most workflows |
| High | Light touch — good for quickly flipping through many pages |

---

## Toolbar Customization

Open **View → Toolbar Settings** to configure:

### Multi-Row Layout
Choose 1-4 rows for the tools palette. More rows show more tools without
horizontal scrolling. Default is 1 row (scrollable).

### Editable Keyboard Shortcuts
Each tool shows its current key binding in an editable field. Click a field and
press any key to rebind. Conflicts are resolved automatically — if the new key
was assigned to another tool, that tool becomes unbound.

Reset all bindings with the **Reset to Default** button.

### Auto-Landscape
When enabled (default), portrait-oriented pages are automatically rotated 90°
on first open. Useful for engineering drawings stored in portrait PDF orientation.
Uncheck to disable.

---

## Equipment Patterns & ISA View

PortolanCAST includes a Haystack-inspired pattern system for structured equipment
identification. Instead of free-form text labels, you select a **pattern** when
placing equipment markers — the system auto-assigns structured tags, ISA-5.1
symbols, and sequential tag numbers.

### Placing Equipment with Patterns

1. Press **M** to activate the Equipment Marker tool
2. Click on the drawing to place a marker
3. In the Equipment Marker panel, select a **pattern** from the dropdown
   (e.g., "Zone Air Temperature Sensor", "Damper Command")
4. Enter the **building** name and click **Create**
5. The entity is created with:
   - An auto-generated ISA tag number (e.g., TT-101, TV-201)
   - Structured tags from the pattern (e.g., `zone`, `air`, `temp`, `sensor`)
   - The correct equipment type pre-filled

### Connecting Equipment

Draw directed connections between equipment markers to model control loops
(sensor → controller → actuator):

1. Press **Shift+C** to activate the Connect tool
2. Click a **source** equipment marker (e.g., a temperature sensor)
3. A rubber-band preview line follows your cursor
4. Click a **target** equipment marker (e.g., a temperature controller)
5. A dashed cyan line with an arrowhead appears, saved to the database

Connections are visible in the **Entity Modal** — open any equipment marker to
see its incoming (←) and outgoing (→) connections with type badges
(signal / physical / logical).

### ISA View Toggle

The status bar shows a **SYS | ISA** toggle when a document is loaded:

| Mode | Labels show | Example |
|------|-------------|---------|
| **SYS** (default) | Human-readable pattern names | "Zone Temp Sensor" |
| **ISA** | ISA-5.1 engineering notation | "TT-101" |

Click **ISA** to switch all equipment marker labels to engineering notation.
Click **SYS** to switch back. The preference is saved per document and persists
across sessions.

> **Tip:** Use ISA view when sharing drawings with engineers who work in
> ISA-5.1 notation. Use System view when the audience is facility managers
> or technicians who prefer descriptive names.

### Available Patterns

| Pattern | Category | ISA Symbol | Example Tag |
|---------|----------|------------|-------------|
| Zone Air Temperature Sensor | Sensor | TT | TT-101 |
| Zone Air Temperature Setpoint | Setpoint | TSP | TSP-101 |
| Temperature Controller | Controller | TIC | TIC-101 |
| Damper Command | Actuator | TV | TV-101 |
| Valve Command | Actuator | TV | TV-201 |
| Fan Command | Actuator | SC | SC-101 |
| Flow Transmitter | Sensor | FT | FT-101 |
| Pressure Transmitter | Sensor | PT | PT-101 |
| Humidity Sensor | Sensor | MT | MT-101 |
| VFD/Speed Controller | Controller | SIC | SIC-101 |
| CO₂ Sensor | Sensor | AT | AT-101 |

---

## Validation Engine

The Validation tab in the right panel scans equipment markers for incomplete
control loops, orphan sensors, and missing connections. Pattern constraints
define the rules — the engine enforces them automatically.

### Running Validation

1. Open a document that has equipment markers linked to entities
2. Click the **Validate** tab in the right panel
3. Click **▶ Validate**
4. Review the findings list — each card is color-coded by severity

### Severity Levels

| Color | Level | Meaning |
|-------|-------|---------|
| Red | Error | Broken constraint — must be fixed (orphan sensor, incomplete controller) |
| Orange | Warning | Suspicious but not necessarily wrong (entity with pattern but no connections) |
| Blue | Info | Suggestion for better data quality (entity without a pattern assigned) |

### Validation Rules

| Rule | Category | Trigger |
|------|----------|---------|
| Orphan Sensor | Sensor | Zero outgoing connections (nobody reads the signal) |
| Orphan Actuator | Actuator | Zero incoming connections (nothing controls it) |
| Incomplete Controller | Controller | Missing input OR output connections |
| Unlinked Entity | Any | Has a pattern but zero total connections |
| No Pattern | Any | Entity without a pattern — consider assigning one |

### Click-to-Navigate

Click any finding card to jump to that entity's page and select its marker
on the canvas. The tag number is shown on the right side of each card for
quick identification.

> **Tip:** After fixing a finding (e.g., drawing a connection from a sensor
> to a controller with Shift+C), click **▶ Validate** again to confirm the
> finding disappears.

---

## Keyboard Shortcuts

### Intent (Markup Meaning)
| Key | Intent |
|-----|--------|
| 1 | Note (gray) |
| 2 | Issue (red) |
| 3 | Question (amber) |
| 4 | Approval (green) |
| 5 | Change (blue) |

### Drawing Tools
| Key | Tool |
|-----|------|
| V | Select |
| P | Pen |
| R | Rectangle |
| E | Ellipse |
| L | Line |
| H | Highlighter |
| T | Text |
| C | Cloud |
| O | Callout |
| G | Hand (pan) |
| U | Distance measurement |
| A | Area measurement |
| N | Count marker |
| K | Calibrate scale |
| M | Equipment Marker |
| Shift+C | Connect (draw entity connection) |

> **Customizable:** All tool shortcuts can be rebound in **View → Toolbar Settings → Keyboard Shortcuts**.

### Editing
| Key | Action |
|-----|--------|
| Delete / Backspace | Delete selected markup |
| Ctrl + Z | Undo |
| Ctrl + Shift + Z | Redo |
| Ctrl + G | Group selected markups |
| Ctrl + Shift + G | Ungroup |
| Ctrl + H | Find & Replace |
| Esc | Deselect / exit tool |

---

## Save, Export, and Bundles

### Auto-Save
Markups save automatically to the local database 3 seconds after any change.
The status bar shows **Unsaved changes** briefly, then clears. Markups also
save when you navigate between pages.

### Export PDF
Click **File → Export PDF** to download a PDF with all markups baked in as
native shapes. The original file is never modified.

### Save Bundle (.portolan)
Click **File → Save Bundle** (Ctrl+S) to download a `.portolan` file — a ZIP archive containing:
- The original PDF
- All markup data (all pages)
- Layer configuration
- Scale settings

Recipients can click **Import** on any PortolanCAST installation to restore the
complete session. Use this for sharing reviewed drawings with collaborators.

---

## Tips and Workflow

- **Intent first, shape second.** Press 1–5 to declare meaning, then draw. This
  is the whole workflow in two keystrokes.

- **Use `#tags` in notes for topics.** Tags like `#structural`, `#electrical`, or
  `#RFI-042` let you filter the markup list and generate a tag-indexed brief.

- **Callouts** need two clicks: first click sets the anchor (what you're pointing
  at), second click places the text label. A leader line connects them automatically.

- **Text** is one-shot: click to place, type, then you're automatically back in
  Select mode.

- **Cloud** is the construction industry standard for marking revision areas.
  Draw it around any change zone.

- **Calibrate before measuring.** Use a known dimension (a door width, grid
  spacing, or dimension string on the drawing) to set the scale before taking
  measurements. All existing measurements recalculate immediately.

- **The Brief is a deliverable.** After a review session: open the Brief tab,
  click Refresh, click Copy MD, and paste into an email or RFI template. The
  Tag Index gives you a cross-reference table for free.

- **The RFI Generator turns markups into formal documents.** Open the RFI tab,
  fill in the header fields, click Generate, then Copy MD. Use the type/status/tag
  filters to scope it — e.g. type=Question + status=Open for an outstanding queries list.

- **Layers keep disciplines separate.** Use one layer per trade (Structural,
  MEP, Civil) so reviewers can toggle visibility without losing their own markups.

---

## Database Migration (Rename Notice)

The project was renamed from **OpenRevu** to **PortolanCAST** on 2026-02-24.
If you have existing documents in `data/openrevu.db`, migrate with:

```bash
mv data/openrevu.db data/portolancast.db
```

New installations automatically use `data/portolancast.db`.
