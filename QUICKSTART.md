# PortolanCAST Quick Start Guide

PortolanCAST is an open-source PDF markup and measurement tool for construction
professionals. Mark up drawings, measure distances and areas, organize by layer,
and generate structured review briefs — all in a local web app with no cloud dependency.

---

## Table of Contents

1. [Starting the Server](#starting-the-server)
2. [Loading Documents](#loading-documents)
3. [Drawing Markups](#drawing-markups)
4. [Properties Panel](#properties-panel)
5. [Measurement Tools](#measurement-tools)
6. [Left Panel Tabs](#left-panel-tabs)
7. [Layers](#layers)
8. [Review Brief + Tags](#review-brief--tags)
9. [RFI Generator](#rfi-generator)
10. [Search](#search)
11. [Photo Attachments](#photo-attachments)
12. [Navigating Pages](#navigating-pages)
13. [Keyboard Shortcuts](#keyboard-shortcuts)
14. [Save, Export, and Bundles](#save-export-and-bundles)
15. [Tips and Workflow](#tips-and-workflow)

---

## Starting the Server

From WSL:

```bash
cd /mnt/c/Users/User1/ClaudeProjects/PortolanCAST
venv/bin/python -c "import uvicorn, os; os.chdir('/mnt/c/Users/User1/ClaudeProjects/PortolanCAST'); uvicorn.run('main:app', host='0.0.0.0', port=8000)"
```

Then open **http://172.22.35.128:8000** in your browser (Windows Firefox).

> **WSL2 networking note:** Bind to `0.0.0.0` (not `127.0.0.1`) so Windows can reach it.
> Use the WSL IP `172.22.35.128` if `localhost:8000` doesn't connect.
> If the old process is still running: `kill $(ss -tlnp 'sport = :8000' | awk 'NR>1{gsub(/.*pid=/,"",$NF); gsub(/,.*/,"",$NF); print $NF}')`

All data is stored locally in `data/portolancast.db`. Nothing leaves your machine.

---

## Loading Documents

| Action | How |
|--------|-----|
| Open a PDF | Click **Open** in the toolbar → select a PDF |
| Create a blank document | Click **New** in the toolbar → enter a name and page size |
| Import a bundle | Click **Import** → select a `.portolan` file (restores PDF + all markups, layers, and scale) |
| Reopen a recent document | Click its name in the welcome screen list |

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
| **C** | Cloud | Click + drag — revision cloud (construction standard) |
| **O** | Callout | Click anchor point, then click text position |
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

## Measurement Tools

Set the drawing scale first (bottom status bar → scale selector), then measure.

| Key | Tool | How to use |
|-----|------|------------|
| **U** | Distance | Click start point, click end point |
| **A** | Area | Click vertices; double-click to close polygon |
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

## Navigating Pages

| Action | Key / Method |
|--------|-------------|
| Next page | → (right arrow) or PageDown |
| Previous page | ← (left arrow) or PageUp |
| First page | Home |
| Last page | End |
| Jump to page | Click thumbnail in Pages tab |
| Zoom in | Ctrl + `+` or Ctrl + scroll up |
| Zoom out | Ctrl + `-` or Ctrl + scroll down |
| Reset zoom | Ctrl + 0 |
| Fit to width | Click **Fit** in toolbar |
| Pan | Scroll normally, or press G for Hand tool |

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

### Editing
| Key | Action |
|-----|--------|
| Delete / Backspace | Delete selected markup |
| Ctrl + Z | Undo |
| Ctrl + Shift + Z | Redo |
| Esc | Deselect / exit tool |

---

## Save, Export, and Bundles

### Auto-Save
Markups save automatically to the local database 3 seconds after any change.
The status bar shows **Unsaved changes** briefly, then clears. Markups also
save when you navigate between pages.

### Export PDF
Click **Export** in the toolbar to download a PDF with all markups baked in as
native shapes. The original file is never modified.

### Save Bundle (.portolan)
Click **Save Bundle** to download a `.portolan` file — a ZIP archive containing:
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
