# Component Harvest & Stamp — Design Spec

## Goal

Add a Bluebeam-style snapshot-to-stamp system to PortolanCAST that lets users capture any visible region of a document as a reusable component, organize components in a searchable library, stamp them onto any page, and export/import component sets for use in external tools like Inkscape.

## Architecture

Server-side render approach. The client sends crop coordinates; PyMuPDF renders the region as both PNG (300 DPI) and SVG. Components are stored as files on disk with metadata in SQLite. The library panel is a right-docked panel that can pop out into a separate browser window.

### Three Data Flows

1. **Harvest:** Toolbar drag-rectangle -> POST /api/components/harvest -> PyMuPDF crop render -> PNG + SVG + thumbnail saved to data/components/ and components table
2. **Browse:** Library panel fetches GET /api/components with tag/search filters -> displays thumbnail grid
3. **Stamp:** Click component in library -> stamp mode with ghost cursor -> click on document places fabric.Image via stampDefaults() -> saved as markup on active layer

### New Files

| File | Purpose |
|------|---------|
| `routes/components.py` | All component API endpoints |
| `static/js/component-library.js` | Library panel: dock, pop-out, search, tag filter, stamp trigger |
| Additions to `toolbar.js` | Harvest tool (rectangle drag) + stamp mode (ghost cursor + repeat click) |
| Additions to `canvas.js` | `componentId` added to CUSTOM_PROPERTIES array (line ~55) so it survives Fabric JSON serialization |
| Additions to `db.py` | components table schema + CRUD methods |

---

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,                    -- UUID hex
    name TEXT NOT NULL,                     -- user-given name: "90 Degree Elbow"
    tags TEXT NOT NULL DEFAULT '[]',        -- JSON array: ["piping", "hot-water"]
    source_doc_id INTEGER,                  -- document it was harvested from (NULL for imports)
    source_page INTEGER,                    -- page number (NULL for imports)
    source_rect TEXT,                       -- JSON: {"x": 100, "y": 200, "w": 50, "h": 50} PDF coords
    png_path TEXT NOT NULL,                 -- relative: data/components/{id}.png
    svg_path TEXT NOT NULL,                 -- relative: data/components/{id}.svg
    thumb_path TEXT NOT NULL,               -- relative: data/components/{id}_thumb.png
    width INTEGER NOT NULL,                 -- natural pixel width of full-res PNG
    height INTEGER NOT NULL,                -- natural pixel height of full-res PNG
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_doc_id) REFERENCES documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);
```

### File Storage

```
data/components/
├── {uuid}.png           # full-res 300 DPI render
├── {uuid}.svg           # vector version
└── {uuid}_thumb.png     # 120px max-dimension thumbnail for library grid
```

---

## Harvest Tool

### Activation

- **Toolbar button** with harvest icon in the markup tools group
- **Hotkey:** `Y` (currently unused in the hotkey map)
- Toolbar treats it as a mode like rect/ellipse — mousedown/mousemove/mouseup cycle

### Harvest Rectangle UX

1. User activates harvest mode (hotkey Y or toolbar button)
2. Cursor becomes crosshair
3. User drags a rectangle over the region to capture
4. On mouseup, a small inline dialog appears anchored near the selection:
   - **Name field** — text input, auto-focused
   - **Tags field** — comma-separated input with autocomplete from existing tags in the database
   - **Save button** (or Enter) — commits the harvest
   - **Cancel button** (or Escape) — discards
5. On save: POST to server with doc_id, page_number, rect (converted to PDF coordinate space), and the current hidden_layers list
6. On success: thumbnail briefly highlights in the library panel as visual confirmation

### Server Processing (POST /api/components/harvest)

Request body:
```json
{
    "doc_id": 42,
    "page": 3,
    "rect": {"x": 100.5, "y": 200.0, "w": 80.0, "h": 60.0},
    "hidden_layers": ["MP-ELEC-PANEL", "MP-TEXT-ANNO"],
    "name": "90 Degree Elbow",
    "tags": ["piping", "hot-water"]
}
```

Server steps:
1. Open the document PDF via PyMuPDF
2. Apply hidden_layers (same OCG filtering as existing render pipeline)
3. Render the crop rect at 300 DPI as PNG (using existing page render + pillow crop, or fitz clip parameter)
4. Render the crop rect as SVG (fitz page.get_svg_image with clip)
5. Generate 120px thumbnail from the PNG
6. Save all three files to data/components/
7. Insert row into components table
8. Return component metadata JSON

Response:
```json
{
    "id": "abc123...",
    "name": "90 Degree Elbow",
    "tags": ["piping", "hot-water"],
    "thumb_url": "/data/components/abc123_thumb.png",
    "width": 240,
    "height": 180
}
```

### Coordinate Conversion

The harvest rectangle is drawn on the Fabric.js canvas in natural coordinates (BASE_DPI = 150). The server needs PDF coordinates. Conversion:

```
pdf_x = fabric_x * (72 / BASE_DPI)
pdf_y = fabric_y * (72 / BASE_DPI)
```

Apply any page rotation before sending. The client handles this conversion before POST.

---

## Library Panel

### Layout

- **Position:** Right-side docked panel, default width 250px
- **Toggle:** Toolbar button or dedicated hotkey to show/hide
- **Pop-out:** Button in panel header opens `window.open()` with the library as a standalone page. The popped-out window communicates back to the main window via `BroadcastChannel('portolancast-components')` for stamp triggers. Messages: `{type: 'stamp', componentId: '...'}` triggers stamp mode in the main window. When the pop-out window closes, the docked panel reappears.

### Panel Structure (top to bottom)

1. **Header bar:** "Components" title + pop-out button (&#x29C9;) + import button + close button (X)
2. **Search input:** Filters by name substring match
3. **Tag filter chips:** Horizontal scrollable row of tag pills. Click to toggle filter. Shows tags that exist in the library with counts.
4. **Thumbnail grid:** 2-3 columns depending on panel width. Each cell:
   - Thumbnail image (120px)
   - Component name below (truncated with ellipsis)
   - Click to enter stamp mode
   - Right-click context menu: Rename, Edit Tags, Export SVG, Export PNG, Delete
5. **Empty state:** "No components yet. Use the Harvest tool (Y) to capture regions from documents."

### Tag Autocomplete

The tags input (both at harvest time and in Edit Tags) provides autocomplete from existing tags in the database. Endpoint: `GET /api/components/tags` returns a deduplicated sorted array of all tags currently in use.

---

## Stamp Mode

### Activation

- Click any component thumbnail in the library panel
- Or: future hotkey to re-stamp the last-used component

### Behavior

1. Cursor changes to show the component thumbnail at 50% opacity, following the mouse in PDF coordinate space
2. Click on the document places a `fabric.Image` loaded from the component's PNG URL
3. The placed image gets:
   - `stampDefaults()` called with `markupType: 'component-stamp'` and `preserveColor: true`
   - `componentId` custom property set to the source component's UUID
   - Assigned to the active annotation layer via the existing `object:added` hook
4. **Repeat mode:** After placement, cursor stays in stamp mode. Click again to place another copy.
5. **Exit:** Press Escape, press V (select), or switch to any other tool
6. The placed stamp is a regular markup object — fully selectable, movable, resizable, deletable. It just happens to be an image sourced from the component library.

### Ghost Cursor Implementation

The ghost preview is a temporary `fabric.Image` added to the canvas with `opacity: 0.5`, `evented: false`, `selectable: false`. It tracks `mouse:move` events and is removed on placement (replaced by the real object) or on tool exit.

---

## Import / Export

### Export (GET /api/components/export)

Query parameters:
- `tags` — comma-separated tag filter (optional, exports all if omitted)
- `ids` — comma-separated component IDs for specific selection (optional)

Returns a ZIP file:
```
portolancast-components/
├── manifest.json
├── 90-degree-elbow.svg
├── 90-degree-elbow.png
├── tee-joint.svg
├── tee-joint.png
└── valve.svg
    valve.png
```

manifest.json:
```json
{
    "version": 1,
    "exported_at": "2026-04-08T10:30:00Z",
    "components": [
        {
            "id": "abc123",
            "name": "90 Degree Elbow",
            "tags": ["piping", "hot-water"],
            "files": {
                "svg": "90-degree-elbow.svg",
                "png": "90-degree-elbow.png"
            },
            "width": 240,
            "height": 180
        }
    ]
}
```

Filenames are slugified from the component name for human readability.

### Import (POST /api/components/import)

Accepts multipart form upload of:
- A ZIP file matching the export format above, OR
- Individual SVG or PNG files

Processing:
1. If ZIP with manifest.json: read names and tags from manifest, create components with those metadata
2. If ZIP without manifest: each SVG/PNG becomes a component, name derived from filename (slugified to title case)
3. If individual file: single component, name from filename
4. For SVG imports: server renders a PNG version at 300 DPI using cairosvg or similar, plus thumbnail
5. For PNG imports: server generates thumbnail, SVG field stores empty string (no vector available)
6. If manifest contains IDs that match existing components: prompt user to update existing or create new (handled via a `mode` form field: "create" or "update", default "create")

Response: array of created/updated component metadata objects.

### Library Panel Export UX

- Multi-select mode: click checkboxes on component thumbnails
- "Export Selected" button appears in header when selection is active
- Or: right-click a single component -> "Export SVG" / "Export PNG" for individual download

---

## Ctrl+D Duplicate (Companion Feature)

Separate from the component system but included in this implementation:

- **Trigger:** Ctrl+D with one or more markup objects selected on the Fabric canvas
- **Behavior:** Clone each selected object, offset +10px right and +10px down
- **Metadata:** Each clone gets a fresh `markupId` via `stampDefaults()` (does not inherit the original's ID)
- **Layer:** Clones inherit the source object's `layerId`
- **Implementation:** Keyboard handler in toolbar.js, uses Fabric's `clone()` method

---

## API Endpoint Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/components/harvest` | Crop region from document, save as component |
| GET | `/api/components` | List components, optional `?tags=` and `?search=` filters |
| GET | `/api/components/tags` | List all unique tags with counts |
| GET | `/api/components/{id}` | Single component metadata |
| GET | `/api/components/{id}/png` | Serve full-res PNG |
| GET | `/api/components/{id}/svg` | Serve SVG file |
| GET | `/api/components/{id}/thumb` | Serve thumbnail |
| PUT | `/api/components/{id}` | Update name and/or tags |
| DELETE | `/api/components/{id}` | Delete component and its files |
| GET | `/api/components/export` | Export filtered set as ZIP |
| POST | `/api/components/import` | Import ZIP or individual files |

---

## Security

- Component names and tags set via `textContent` (never `innerHTML`) — XSS safe
- File uploads validated: only SVG/PNG accepted, size capped (10 MB per file)
- SVG imports sanitized: strip `<script>`, `on*` attributes, and `javascript:` URLs before storage
- Component IDs are UUIDs — not user-controlled, not sequential
- File paths on disk use UUID filenames — no user-controlled path components
- Import ZIP extraction: validate no path traversal (`../`), cap total extracted size
- DPI clamped 72-600 on harvest render (same as batch export)

---

## Non-Goals (Explicitly Out of Scope)

- Component versioning / history — update replaces, no rollback
- Sharing components across PortolanCAST instances over network — export/import via ZIP is the sharing mechanism
- Component scaling presets or snap-to-grid — placed stamps use standard Fabric transform handles
- AI-powered component recognition — harvest is always manual rectangle selection
- Annotation markup capture — component harvest captures PDF content only (what's visible). Markup duplication is handled by Ctrl+D.
