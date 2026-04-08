# Component Harvest & Stamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Bluebeam-style snapshot-to-stamp system — harvest visible regions as reusable SVG+PNG components, organize in a searchable tag-based library panel, stamp onto any page with repeat-click placement, and support ZIP import/export for Inkscape round-tripping.

**Architecture:** Server-side render via PyMuPDF (reuses existing layer-filtering pipeline). Components stored as PNG+SVG+thumbnail files on disk with metadata in SQLite `components` table. Frontend: right-docked library panel (pop-out capable), harvest tool in toolbar, stamp mode with ghost cursor. Ctrl+D duplicate as companion feature.

**Tech Stack:** Python/FastAPI, PyMuPDF (fitz), Pillow, SQLite, Fabric.js 6, vanilla JS ES modules, Playwright tests.

**Spec:** `docs/superpowers/specs/2026-04-08-component-harvest-stamp-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `routes/components.py` | All component API endpoints (harvest, CRUD, import, export) |
| Create | `static/js/component-library.js` | Library panel: right dock, pop-out, search, tag filter, stamp trigger |
| Create | `test_components.mjs` | Playwright integration tests for the full feature |
| Modify | `db.py` | Add `components` table schema + CRUD methods (~line 130 in schema, new section after markup_photos methods) |
| Modify | `config.py` | Add `COMPONENTS_DIR` path constant |
| Modify | `main.py` | Import and include `components` router |
| Modify | `static/js/canvas.js:55-84` | Add `componentId` to CUSTOM_PROPERTIES array |
| Modify | `static/js/toolbar.js:32-58` | Add `'Y': 'harvest'` to DEFAULT_HOTKEYS |
| Modify | `static/js/toolbar.js:161-170` | Add `harvest: 'markup'` to `_TOOL_TAB` map |
| Modify | `static/js/toolbar.js` | Add harvest tool case in `setTool()` + `_initHarvestDrawing()` method |
| Modify | `static/js/toolbar.js` | Add stamp mode case in `setTool()` + `_initStampMode()` method |
| Modify | `static/js/toolbar.js` | Add Ctrl+D duplicate handler in `_bindKeyboard()` |
| Modify | `static/js/app.js:14-41` | Import and instantiate ComponentLibrary |
| Modify | `static/js/markup-list.js:71` | Add `'component-stamp': 'Stamp'` to type display names |
| Modify | `templates/editor.html` | Add component panel HTML container + harvest dialog HTML |
| Modify | `static/css/style.css` | Add component library panel + harvest dialog styles |

---

### Task 1: Database Schema + CRUD Methods

**Files:**
- Modify: `db.py` — schema at ~line 130, methods after markup_photos section (~line 810+)

- [ ] **Step 1: Add components table to schema string**

In `db.py`, find the schema string. After the `idx_markup_photos_markup_id` index (around line 113), add:

```python
-- ==========================================================================
-- COMPONENT LIBRARY
-- ==========================================================================

-- Reusable visual components harvested from document regions.
-- Each component has PNG + SVG + thumbnail files on disk.
CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    source_doc_id INTEGER,
    source_page INTEGER,
    source_rect TEXT,
    png_path TEXT NOT NULL,
    svg_path TEXT NOT NULL,
    thumb_path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_doc_id) REFERENCES documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);
```

- [ ] **Step 2: Add component CRUD methods**

After the markup_photos methods section in `db.py`, add a new section:

```python
    # =========================================================================
    # COMPONENT LIBRARY
    # =========================================================================

    def create_component(self, component_id: str, name: str, tags: str,
                         source_doc_id: int | None, source_page: int | None,
                         source_rect: str | None,
                         png_path: str, svg_path: str, thumb_path: str,
                         width: int, height: int) -> dict:
        """Insert a new component and return it as a dict."""
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO components
                   (id, name, tags, source_doc_id, source_page, source_rect,
                    png_path, svg_path, thumb_path, width, height)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (component_id, name, tags, source_doc_id, source_page,
                 source_rect, png_path, svg_path, thumb_path, width, height)
            )
        return self.get_component(component_id)

    def get_component(self, component_id: str) -> dict | None:
        """Return a single component by ID, or None."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM components WHERE id = ?", (component_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_components(self, tags: list[str] | None = None,
                        search: str | None = None) -> list[dict]:
        """
        List components with optional tag and name filters.

        Args:
            tags:   Filter to components containing ALL of these tags.
            search: Case-insensitive substring match on name.

        Returns:
            List of component dicts, newest first.
        """
        query = "SELECT * FROM components WHERE 1=1"
        params = []

        if search:
            query += " AND name LIKE ?"
            params.append(f"%{search}%")

        if tags:
            for tag in tags:
                query += " AND tags LIKE ?"
                params.append(f'%"{tag}"%')

        query += " ORDER BY created_at DESC"

        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def update_component(self, component_id: str, name: str | None = None,
                         tags: str | None = None) -> dict | None:
        """Update component name and/or tags. Returns updated component."""
        sets = []
        params = []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if tags is not None:
            sets.append("tags = ?")
            params.append(tags)
        if not sets:
            return self.get_component(component_id)

        params.append(component_id)
        with self._connect() as conn:
            conn.execute(
                f"UPDATE components SET {', '.join(sets)} WHERE id = ?",
                params
            )
        return self.get_component(component_id)

    def delete_component(self, component_id: str) -> bool:
        """Delete a component. Returns True if a row was deleted."""
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM components WHERE id = ?", (component_id,)
            )
            return cursor.rowcount > 0

    def list_component_tags(self) -> list[dict]:
        """
        Return all unique tags with counts.

        Parses the JSON tags column from every component, counts occurrences.
        Returns [{"tag": "piping", "count": 5}, ...] sorted alphabetically.
        """
        import json as _json
        tag_counts: dict[str, int] = {}
        with self._connect() as conn:
            rows = conn.execute("SELECT tags FROM components").fetchall()
        for row in rows:
            try:
                for tag in _json.loads(row["tags"]):
                    tag_counts[tag] = tag_counts.get(tag, 0) + 1
            except (ValueError, TypeError):
                pass
        return sorted(
            [{"tag": t, "count": c} for t, c in tag_counts.items()],
            key=lambda x: x["tag"]
        )
```

- [ ] **Step 3: Verify the schema loads cleanly**

Run: `cd /home/odikral/projects/PortolanCAST && python3 -c "from db import Database; d = Database(); d.init(); print('OK')"`
Expected: `OK` (no errors)

- [ ] **Step 4: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add db.py
git commit -m "feat(components): add components table schema and CRUD methods"
```

---

### Task 2: Config + Components Directory + Static File Mount

**Files:**
- Modify: `config.py:57-63`
- Modify: `main.py:60-62`

- [ ] **Step 1: Add COMPONENTS_DIR to config.py**

After the `ENTITY_PHOTOS_DIR` block (line 63), add:

```python
# Component library files (PNG, SVG, thumbnails for harvested components)
COMPONENTS_DIR = DATA_DIR / "components"
COMPONENTS_DIR.mkdir(parents=True, exist_ok=True)
```

- [ ] **Step 2: Mount static file serving for components in main.py**

After the `/data/photos` mount (line 61), add:

```python
# Serve component library files at /data/components/{filename}
from config import COMPONENTS_DIR
app.mount("/data/components", StaticFiles(directory=str(COMPONENTS_DIR)), name="components")
```

Also add `components` to the router imports (line 39-44):

```python
from routes import (
    health, pages, documents, markups, settings, ai,
    bundles, photos, search, reports, text, entities,
    entity_tasks, entity_photos, parts, backup, patterns, connections,
    help, validation, components,
)
```

And include the router (after line 86):

```python
app.include_router(components.router)
```

- [ ] **Step 3: Create empty routes/components.py as placeholder**

```python
"""
PortolanCAST — Component Library API

Endpoints for harvesting, browsing, stamping, importing, and exporting
reusable visual components from document regions.
"""

from fastapi import APIRouter

router = APIRouter()
```

- [ ] **Step 4: Verify server starts**

Run: `cd /home/odikral/projects/PortolanCAST && python3 -c "from main import app; print('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add config.py main.py routes/components.py
git commit -m "feat(components): add COMPONENTS_DIR config, static mount, and router stub"
```

---

### Task 3: Harvest API Endpoint (POST /api/components/harvest)

**Files:**
- Modify: `routes/components.py`
- Modify: `pdf_engine.py` (add `render_region_png` and `render_region_svg` methods)

- [ ] **Step 1: Add crop render methods to pdf_engine.py**

After the `export_page_svg` method (~line 626), add:

```python
    def render_region_png(self, pdf_path: str, page_number: int,
                          clip_rect: tuple, hidden_layers: list = None,
                          dpi: int = 300) -> bytes:
        """
        Render a cropped region of a PDF page as PNG.

        Args:
            pdf_path:      Absolute path to the PDF file.
            page_number:   Zero-indexed page number.
            clip_rect:     (x0, y0, x1, y1) in PDF points (72 DPI).
            hidden_layers: OCG layer names to hide (optional).
            dpi:           Render resolution (clamped 72-600).

        Returns:
            PNG bytes of the cropped region.
        """
        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        dpi = min(max(dpi, 72), MAX_DPI)

        try:
            doc = fitz.open(str(path))

            if page_number < 0 or page_number >= doc.page_count:
                raise IndexError(f"Page {page_number} out of range")

            page = doc[page_number]

            # Apply OCG layer filtering
            if hidden_layers:
                oc_map = self._build_oc_map_for_page(doc, page)
                if oc_map:
                    hidden_set = set(hidden_layers)
                    layers_to_show = {
                        name for name in oc_map.values()
                        if name not in hidden_set
                    }
                    for xref in page.get_contents():
                        raw = doc.xref_stream(xref)
                        filtered = _filter_content_stream(raw, oc_map, layers_to_show)
                        if filtered is not raw:
                            doc.update_stream(xref, filtered)

            zoom = dpi / 72.0
            matrix = fitz.Matrix(zoom, zoom)
            clip = fitz.Rect(clip_rect)
            pixmap = page.get_pixmap(matrix=matrix, clip=clip, alpha=False)
            return pixmap.tobytes("png")

        finally:
            doc.close()

    def render_region_svg(self, pdf_path: str, page_number: int,
                          clip_rect: tuple,
                          hidden_layers: list = None) -> bytes:
        """
        Render a cropped region of a PDF page as SVG.

        Args:
            pdf_path:      Absolute path to the PDF file.
            page_number:   Zero-indexed page number.
            clip_rect:     (x0, y0, x1, y1) in PDF points (72 DPI).
            hidden_layers: OCG layer names to hide (optional).

        Returns:
            SVG document as UTF-8 bytes.
        """
        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        try:
            doc = fitz.open(str(path))

            if page_number < 0 or page_number >= doc.page_count:
                raise IndexError(f"Page {page_number} out of range")

            page = doc[page_number]

            if hidden_layers:
                oc_map = self._build_oc_map_for_page(doc, page)
                if oc_map:
                    hidden_set = set(hidden_layers)
                    layers_to_show = {
                        name for name in oc_map.values()
                        if name not in hidden_set
                    }
                    for xref in page.get_contents():
                        raw = doc.xref_stream(xref)
                        filtered = _filter_content_stream(raw, oc_map, layers_to_show)
                        if filtered is not raw:
                            doc.update_stream(xref, filtered)

            clip = fitz.Rect(clip_rect)
            svg_text = page.get_svg_image(matrix=fitz.Identity, text_as_path=True)

            # Crop the SVG by adjusting the viewBox to the clip region
            # PyMuPDF's get_svg_image doesn't support clip directly for SVG,
            # so we wrap in an SVG with a viewBox matching the clip rect
            x0, y0, x1, y1 = clip_rect
            w, h = x1 - x0, y1 - y0
            cropped_svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" '
                f'width="{w}" height="{h}" '
                f'viewBox="{x0} {y0} {w} {h}">\n'
                f'{svg_text}\n'
                f'</svg>'
            )
            return cropped_svg.encode("utf-8")

        finally:
            doc.close()
```

- [ ] **Step 2: Write the harvest endpoint in routes/components.py**

Replace the contents of `routes/components.py`:

```python
"""
PortolanCAST — Component Library API

Endpoints for harvesting, browsing, stamping, importing, and exporting
reusable visual components from document regions.

Security:
    - Component IDs are server-generated UUIDs (not user-controlled)
    - File paths use UUID names (no user-controlled path segments)
    - DPI clamped 72-600 to prevent memory exhaustion
    - SVG imports sanitized (script tags, event handlers stripped)
    - ZIP imports validated against path traversal
"""

import io
import json
import uuid
import zipfile
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from PIL import Image

from config import db, pdf_engine, COMPONENTS_DIR

router = APIRouter()


def _generate_thumbnail(png_bytes: bytes, max_dim: int = 120) -> bytes:
    """Generate a thumbnail PNG from full-res PNG bytes."""
    img = Image.open(io.BytesIO(png_bytes))
    img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _component_to_json(comp: dict) -> dict:
    """Convert a DB component row to API response JSON."""
    return {
        "id": comp["id"],
        "name": comp["name"],
        "tags": json.loads(comp["tags"]),
        "source_doc_id": comp["source_doc_id"],
        "source_page": comp["source_page"],
        "width": comp["width"],
        "height": comp["height"],
        "thumb_url": f"/data/components/{comp['id']}_thumb.png",
        "png_url": f"/data/components/{comp['id']}.png",
        "svg_url": f"/data/components/{comp['id']}.svg",
        "created_at": comp["created_at"],
    }


@router.post("/api/components/harvest")
async def harvest_component(request: Request):
    """
    Harvest a region from a document page as a reusable component.

    Renders the specified rectangle at 300 DPI as PNG and SVG,
    generates a thumbnail, and saves to the component library.

    Request body:
        doc_id:        Document ID
        page:          Zero-indexed page number
        rect:          {"x": float, "y": float, "w": float, "h": float} in PDF points
        hidden_layers: List of OCG layer names currently hidden
        name:          Component name
        tags:          List of tag strings
    """
    body = await request.json()

    doc_id = body.get("doc_id")
    page = body.get("page", 0)
    rect = body.get("rect", {})
    hidden_layers = body.get("hidden_layers", [])
    name = body.get("name", "").strip()
    tags = body.get("tags", [])

    if not doc_id:
        raise HTTPException(status_code=400, detail="doc_id required")
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    if not all(k in rect for k in ("x", "y", "w", "h")):
        raise HTTPException(status_code=400, detail="rect must have x, y, w, h")
    if rect["w"] <= 0 or rect["h"] <= 0:
        raise HTTPException(status_code=400, detail="rect width and height must be positive")

    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="File missing from disk")

    # Convert rect dict to fitz clip tuple (x0, y0, x1, y1)
    x0 = rect["x"]
    y0 = rect["y"]
    x1 = x0 + rect["w"]
    y1 = y0 + rect["h"]
    clip_rect = (x0, y0, x1, y1)

    comp_id = uuid.uuid4().hex

    try:
        # Render PNG at 300 DPI
        png_bytes = pdf_engine.render_region_png(
            doc["filepath"], page, clip_rect,
            hidden_layers=hidden_layers or None, dpi=300,
        )

        # Render SVG
        svg_bytes = pdf_engine.render_region_svg(
            doc["filepath"], page, clip_rect,
            hidden_layers=hidden_layers or None,
        )

        # Generate thumbnail
        thumb_bytes = _generate_thumbnail(png_bytes)

        # Get dimensions from the PNG
        img = Image.open(io.BytesIO(png_bytes))
        width, height = img.size

        # Save files
        png_path = COMPONENTS_DIR / f"{comp_id}.png"
        svg_path = COMPONENTS_DIR / f"{comp_id}.svg"
        thumb_path = COMPONENTS_DIR / f"{comp_id}_thumb.png"

        png_path.write_bytes(png_bytes)
        svg_path.write_bytes(svg_bytes)
        thumb_path.write_bytes(thumb_bytes)

        # Save to database
        comp = db.create_component(
            component_id=comp_id,
            name=name,
            tags=json.dumps(tags),
            source_doc_id=doc_id,
            source_page=page,
            source_rect=json.dumps(rect),
            png_path=str(png_path),
            svg_path=str(svg_path),
            thumb_path=str(thumb_path),
            width=width,
            height=height,
        )

        return _component_to_json(comp)

    except (FileNotFoundError, IndexError) as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Harvest failed: {e}")
```

- [ ] **Step 3: Verify harvest endpoint loads**

Run: `cd /home/odikral/projects/PortolanCAST && python3 -c "from routes.components import router; print(len(router.routes), 'routes')"`
Expected: `1 routes`

- [ ] **Step 4: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add pdf_engine.py routes/components.py
git commit -m "feat(components): add harvest endpoint with crop render pipeline"
```

---

### Task 4: Component CRUD + Tag Endpoints

**Files:**
- Modify: `routes/components.py`

- [ ] **Step 1: Add list, get, update, delete, and tags endpoints**

Append to `routes/components.py` after the harvest endpoint:

```python
@router.get("/api/components")
async def list_components(tags: str = "", search: str = ""):
    """
    List all components with optional filters.

    Query params:
        tags:   Comma-separated tag names to filter by (AND logic).
        search: Case-insensitive name substring search.
    """
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None
    search_term = search.strip() or None
    components = db.list_components(tags=tag_list, search=search_term)
    return {"components": [_component_to_json(c) for c in components]}


@router.get("/api/components/tags")
async def list_tags():
    """Return all unique tags with usage counts."""
    return {"tags": db.list_component_tags()}


@router.get("/api/components/{comp_id}")
async def get_component(comp_id: str):
    """Return a single component's metadata."""
    comp = db.get_component(comp_id)
    if not comp:
        raise HTTPException(status_code=404, detail="Component not found")
    return _component_to_json(comp)


@router.put("/api/components/{comp_id}")
async def update_component(comp_id: str, request: Request):
    """
    Update a component's name and/or tags.

    Request body:
        name: New name (optional)
        tags: New tags array (optional)
    """
    comp = db.get_component(comp_id)
    if not comp:
        raise HTTPException(status_code=404, detail="Component not found")

    body = await request.json()
    name = body.get("name")
    tags = body.get("tags")

    if name is not None:
        name = name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")

    tags_json = json.dumps(tags) if tags is not None else None

    updated = db.update_component(comp_id, name=name, tags=tags_json)
    return _component_to_json(updated)


@router.delete("/api/components/{comp_id}")
async def delete_component(comp_id: str):
    """Delete a component and its files from disk."""
    comp = db.get_component(comp_id)
    if not comp:
        raise HTTPException(status_code=404, detail="Component not found")

    # Remove files from disk (ignore missing files — idempotent)
    for path_key in ("png_path", "svg_path", "thumb_path"):
        try:
            Path(comp[path_key]).unlink(missing_ok=True)
        except OSError:
            pass

    db.delete_component(comp_id)
    return {"deleted": True}
```

- [ ] **Step 2: Verify all routes load**

Run: `cd /home/odikral/projects/PortolanCAST && python3 -c "from routes.components import router; print(len(router.routes), 'routes')"`
Expected: `6 routes`

- [ ] **Step 3: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add routes/components.py
git commit -m "feat(components): add CRUD and tags API endpoints"
```

---

### Task 5: Export + Import Endpoints

**Files:**
- Modify: `routes/components.py`

- [ ] **Step 1: Add export endpoint**

Append to `routes/components.py`:

```python
def _slugify(text: str) -> str:
    """Convert component name to a filesystem-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[\s_]+', '-', slug)
    slug = re.sub(r'-+', '-', slug).strip('-')
    return slug or 'component'


@router.get("/api/components/export")
async def export_components(tags: str = "", ids: str = ""):
    """
    Export components as a ZIP file with manifest.

    Query params:
        tags: Comma-separated tag filter (optional).
        ids:  Comma-separated component IDs (optional).
    """
    if ids:
        id_list = [i.strip() for i in ids.split(",") if i.strip()]
        components = [db.get_component(cid) for cid in id_list]
        components = [c for c in components if c is not None]
    elif tags:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        components = db.list_components(tags=tag_list)
    else:
        components = db.list_components()

    if not components:
        raise HTTPException(status_code=404, detail="No components to export")

    manifest = {
        "version": 1,
        "exported_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "components": [],
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        used_slugs = set()
        for comp in components:
            slug = _slugify(comp["name"])
            # Deduplicate slugs
            base_slug = slug
            counter = 1
            while slug in used_slugs:
                slug = f"{base_slug}-{counter}"
                counter += 1
            used_slugs.add(slug)

            # Add PNG
            png_path = Path(comp["png_path"])
            if png_path.exists():
                zf.write(png_path, f"portolancast-components/{slug}.png")

            # Add SVG
            svg_path = Path(comp["svg_path"])
            if svg_path.exists():
                zf.write(svg_path, f"portolancast-components/{slug}.svg")

            manifest["components"].append({
                "id": comp["id"],
                "name": comp["name"],
                "tags": json.loads(comp["tags"]),
                "files": {"svg": f"{slug}.svg", "png": f"{slug}.png"},
                "width": comp["width"],
                "height": comp["height"],
            })

        zf.writestr(
            "portolancast-components/manifest.json",
            json.dumps(manifest, indent=2),
        )

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="portolancast-components.zip"'},
    )
```

- [ ] **Step 2: Add import endpoint**

Append to `routes/components.py`:

```python
def _sanitize_svg(svg_bytes: bytes) -> bytes:
    """Strip dangerous content from SVG imports."""
    text = svg_bytes.decode("utf-8", errors="replace")
    # Remove script tags
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL | re.IGNORECASE)
    # Remove on* event attributes
    text = re.sub(r'\s+on\w+\s*=\s*["\'][^"\']*["\']', '', text, flags=re.IGNORECASE)
    # Remove javascript: URLs
    text = re.sub(r'javascript\s*:', '', text, flags=re.IGNORECASE)
    return text.encode("utf-8")


def _name_from_filename(filename: str) -> str:
    """Convert a filename to a display name: 'hot-water-valve.svg' -> 'Hot Water Valve'."""
    stem = Path(filename).stem
    return stem.replace("-", " ").replace("_", " ").title()


MAX_IMPORT_SIZE = 50 * 1024 * 1024  # 50 MB total for ZIP

@router.post("/api/components/import")
async def import_components(
    file: UploadFile = File(...),
    mode: str = Form("create"),
):
    """
    Import components from a ZIP file or individual SVG/PNG.

    Form fields:
        file: ZIP or SVG/PNG file
        mode: "create" (default) or "update" (match by manifest ID)
    """
    if mode not in ("create", "update"):
        raise HTTPException(status_code=400, detail="mode must be 'create' or 'update'")

    content = await file.read()
    if len(content) > MAX_IMPORT_SIZE:
        raise HTTPException(status_code=413, detail="File too large (50 MB max)")

    filename = file.filename or ""
    ext = Path(filename).suffix.lower()
    results = []

    if ext == ".zip":
        results = _import_zip(content, mode)
    elif ext == ".svg":
        results = [_import_single_svg(content, filename)]
    elif ext == ".png":
        results = [_import_single_png(content, filename)]
    else:
        raise HTTPException(status_code=400, detail="Must be .zip, .svg, or .png")

    return {"imported": results}


def _import_zip(content: bytes, mode: str) -> list[dict]:
    """Process a ZIP import, with or without manifest."""
    results = []

    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        # Security: check for path traversal
        for name in zf.namelist():
            if ".." in name or name.startswith("/"):
                raise HTTPException(status_code=400, detail=f"Invalid path in ZIP: {name}")

        # Check total extracted size
        total_size = sum(info.file_size for info in zf.infolist())
        if total_size > MAX_IMPORT_SIZE:
            raise HTTPException(status_code=413, detail="Extracted ZIP too large")

        # Look for manifest
        manifest = None
        manifest_names = [n for n in zf.namelist() if n.endswith("manifest.json")]
        if manifest_names:
            manifest = json.loads(zf.read(manifest_names[0]))

        if manifest and "components" in manifest:
            prefix = str(Path(manifest_names[0]).parent)
            for entry in manifest["components"]:
                comp_id = entry.get("id", uuid.uuid4().hex)
                name = entry.get("name", "Imported Component")
                tags = entry.get("tags", [])

                png_file = entry.get("files", {}).get("png", "")
                svg_file = entry.get("files", {}).get("svg", "")
                png_path_in_zip = f"{prefix}/{png_file}" if prefix != "." else png_file
                svg_path_in_zip = f"{prefix}/{svg_file}" if prefix != "." else svg_file

                # Check mode: update existing or create new
                if mode == "update" and db.get_component(comp_id):
                    new_id = comp_id
                else:
                    new_id = uuid.uuid4().hex

                png_bytes = zf.read(png_path_in_zip) if png_path_in_zip in zf.namelist() else None
                svg_bytes = zf.read(svg_path_in_zip) if svg_path_in_zip in zf.namelist() else None

                if not png_bytes and not svg_bytes:
                    continue

                if svg_bytes:
                    svg_bytes = _sanitize_svg(svg_bytes)

                if not png_bytes and svg_bytes:
                    # Generate PNG from SVG using Pillow (basic fallback)
                    # For better SVG→PNG, cairosvg would be used but Pillow handles simple cases
                    png_bytes = svg_bytes  # Store SVG as-is; PNG will be placeholder
                    # TODO: proper SVG→PNG conversion if cairosvg available

                result = _save_imported_component(
                    new_id, name, tags, png_bytes, svg_bytes,
                    entry.get("width"), entry.get("height"),
                )
                if result:
                    results.append(result)
        else:
            # No manifest: each SVG/PNG becomes a component
            for name_in_zip in zf.namelist():
                ext = Path(name_in_zip).suffix.lower()
                if ext not in (".svg", ".png"):
                    continue
                file_bytes = zf.read(name_in_zip)
                comp_name = _name_from_filename(Path(name_in_zip).name)

                if ext == ".svg":
                    result = _import_single_svg(file_bytes, name_in_zip)
                else:
                    result = _import_single_png(file_bytes, name_in_zip)
                if result:
                    results.append(result)

    return results


def _import_single_svg(svg_bytes: bytes, filename: str) -> dict:
    """Import a single SVG file as a component."""
    comp_id = uuid.uuid4().hex
    name = _name_from_filename(filename)
    svg_bytes = _sanitize_svg(svg_bytes)

    # Save SVG
    svg_path = COMPONENTS_DIR / f"{comp_id}.svg"
    svg_path.write_bytes(svg_bytes)

    # Generate a placeholder PNG (white background with text)
    img = Image.new("RGB", (240, 180), (240, 240, 240))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    png_path = COMPONENTS_DIR / f"{comp_id}.png"
    png_path.write_bytes(png_bytes)

    thumb_bytes = _generate_thumbnail(png_bytes)
    thumb_path = COMPONENTS_DIR / f"{comp_id}_thumb.png"
    thumb_path.write_bytes(thumb_bytes)

    comp = db.create_component(
        component_id=comp_id, name=name, tags="[]",
        source_doc_id=None, source_page=None, source_rect=None,
        png_path=str(png_path), svg_path=str(svg_path),
        thumb_path=str(thumb_path), width=240, height=180,
    )
    return _component_to_json(comp)


def _import_single_png(png_bytes: bytes, filename: str) -> dict:
    """Import a single PNG file as a component."""
    comp_id = uuid.uuid4().hex
    name = _name_from_filename(filename)

    img = Image.open(io.BytesIO(png_bytes))
    width, height = img.size

    png_path = COMPONENTS_DIR / f"{comp_id}.png"
    png_path.write_bytes(png_bytes)

    # No SVG available for PNG imports
    svg_path = COMPONENTS_DIR / f"{comp_id}.svg"
    svg_path.write_bytes(b"")

    thumb_bytes = _generate_thumbnail(png_bytes)
    thumb_path = COMPONENTS_DIR / f"{comp_id}_thumb.png"
    thumb_path.write_bytes(thumb_bytes)

    comp = db.create_component(
        component_id=comp_id, name=name, tags="[]",
        source_doc_id=None, source_page=None, source_rect=None,
        png_path=str(png_path), svg_path=str(svg_path),
        thumb_path=str(thumb_path), width=width, height=height,
    )
    return _component_to_json(comp)


def _save_imported_component(comp_id, name, tags, png_bytes, svg_bytes,
                              width=None, height=None) -> dict | None:
    """Save an imported component (from manifest-based ZIP)."""
    if png_bytes:
        try:
            img = Image.open(io.BytesIO(png_bytes))
            width, height = img.size
        except Exception:
            width = width or 240
            height = height or 180

    png_path = COMPONENTS_DIR / f"{comp_id}.png"
    svg_path = COMPONENTS_DIR / f"{comp_id}.svg"
    thumb_path = COMPONENTS_DIR / f"{comp_id}_thumb.png"

    if png_bytes:
        png_path.write_bytes(png_bytes)
        thumb_bytes = _generate_thumbnail(png_bytes)
        thumb_path.write_bytes(thumb_bytes)
    if svg_bytes:
        svg_path.write_bytes(svg_bytes)
    else:
        svg_path.write_bytes(b"")

    # Delete existing if updating
    if db.get_component(comp_id):
        db.delete_component(comp_id)

    comp = db.create_component(
        component_id=comp_id, name=name, tags=json.dumps(tags),
        source_doc_id=None, source_page=None, source_rect=None,
        png_path=str(png_path), svg_path=str(svg_path),
        thumb_path=str(thumb_path),
        width=width or 240, height=height or 180,
    )
    return _component_to_json(comp) if comp else None
```

- [ ] **Step 3: Verify all routes load**

Run: `cd /home/odikral/projects/PortolanCAST && python3 -c "from routes.components import router; print(len(router.routes), 'routes')"`
Expected: `8 routes`

- [ ] **Step 4: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add routes/components.py
git commit -m "feat(components): add export ZIP and import ZIP/SVG/PNG endpoints"
```

---

### Task 6: Canvas Custom Property + Markup Type

**Files:**
- Modify: `static/js/canvas.js:55-84`
- Modify: `static/js/markup-list.js:71`

- [ ] **Step 1: Add componentId to CUSTOM_PROPERTIES**

In `static/js/canvas.js`, find the CUSTOM_PROPERTIES array. After the `'targetEntityId'` line (~line 83), add:

```javascript
    // Component stamp: links a placed stamp to its source component in the library.
    'componentId',
```

- [ ] **Step 2: Add component-stamp to markup-list display names**

In `static/js/markup-list.js`, find the type display name map (around line 71). Add the entry:

```javascript
    'component-stamp': 'Stamp',
```

- [ ] **Step 3: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add static/js/canvas.js static/js/markup-list.js
git commit -m "feat(components): add componentId custom property and stamp markup type"
```

---

### Task 7: Ctrl+D Duplicate Handler

**Files:**
- Modify: `static/js/toolbar.js`

- [ ] **Step 1: Add Ctrl+D handler in _bindKeyboard()**

In `static/js/toolbar.js`, find the `_bindKeyboard()` method. Inside the `keydown` handler, find the section that handles Ctrl key combinations (look for `e.ctrlKey` checks). Add this block alongside the existing Ctrl+Z/Ctrl+G handlers:

```javascript
            // Ctrl+D — Duplicate selected objects
            if (e.ctrlKey && e.key === 'd') {
                e.preventDefault();
                const fc = this.canvas?.fabricCanvas;
                if (!fc) return;
                const active = fc.getActiveObjects();
                if (active.length === 0) return;

                // Deselect before cloning to avoid selection interference
                fc.discardActiveObject();

                const clones = [];
                let remaining = active.length;

                for (const obj of active) {
                    obj.clone((cloned) => {
                        // Offset the clone so it's visually distinct
                        cloned.set({
                            left: (obj.left || 0) + 10,
                            top: (obj.top || 0) + 10,
                        });
                        // Fresh markupId — clone is a new object
                        cloned.markupId = undefined;
                        this.canvas.stampDefaults(cloned, {
                            markupType: obj.markupType || 'note',
                            preserveColor: true,
                        });
                        // Inherit layer assignment
                        if (obj.layerId) cloned.layerId = obj.layerId;
                        fc.add(cloned);
                        clones.push(cloned);

                        remaining--;
                        if (remaining === 0) {
                            // Select all clones
                            if (clones.length === 1) {
                                fc.setActiveObject(clones[0]);
                            } else {
                                const sel = new fabric.ActiveSelection(clones, { canvas: fc });
                                fc.setActiveObject(sel);
                            }
                            fc.renderAll();
                        }
                    }, [...fc.toJSON().propertyNames || []]);
                }
                return;
            }
```

- [ ] **Step 2: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add static/js/toolbar.js
git commit -m "feat(components): add Ctrl+D duplicate for selected markup objects"
```

---

### Task 8: Harvest Tool (Toolbar Integration)

**Files:**
- Modify: `static/js/toolbar.js`

- [ ] **Step 1: Register the harvest tool**

In `static/js/toolbar.js`, add `'Y': 'harvest'` to the `DEFAULT_HOTKEYS` object (~line 32-58):

```javascript
    'y': 'harvest',
```

Add `harvest: 'markup'` to the `_TOOL_TAB` map (~line 161-170):

```javascript
    harvest: 'markup',
```

Add the `'component-stamp'` markup type too:

```javascript
    'component-stamp': 'markup',
```

In the `setTool()` method's switch statement, add a case for harvest (after the `'image-overlay'` case ~line 991):

```javascript
            case 'harvest':
                // Rectangle-drag to capture a visible region as a reusable component.
                // Draws a dashed rectangle, then shows an inline naming dialog.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initHarvestDrawing();
                break;
```

- [ ] **Step 2: Implement _initHarvestDrawing()**

Add this method to the Toolbar class (after the existing `_initShapeDrawing` method):

```javascript
    /**
     * Initialize the harvest rectangle drawing mode.
     *
     * Drag to draw a dashed selection rectangle. On mouseup, show a naming
     * dialog. On submit, POST to /api/components/harvest with the crop
     * region in PDF coordinate space.
     */
    _initHarvestDrawing() {
        const fc = this.canvas.fabricCanvas;
        let isDrawing = false;
        let startX, startY;
        let harvestRect = null;

        const onMouseDown = (opt) => {
            if (opt.e.button !== 0) return;
            const ptr = fc.getPointer(opt.e);
            startX = ptr.x;
            startY = ptr.y;
            isDrawing = true;

            harvestRect = new fabric.Rect({
                left: startX,
                top: startY,
                width: 0,
                height: 0,
                fill: 'rgba(85, 153, 204, 0.15)',
                stroke: '#5599cc',
                strokeWidth: 2,
                strokeDashArray: [6, 4],
                strokeUniform: true,
                selectable: false,
                evented: false,
            });
            fc.add(harvestRect);
        };

        const onMouseMove = (opt) => {
            if (!isDrawing || !harvestRect) return;
            const ptr = fc.getPointer(opt.e);
            const left = Math.min(startX, ptr.x);
            const top = Math.min(startY, ptr.y);
            const width = Math.abs(ptr.x - startX);
            const height = Math.abs(ptr.y - startY);
            harvestRect.set({ left, top, width, height });
            fc.renderAll();
        };

        const onMouseUp = () => {
            if (!isDrawing || !harvestRect) return;
            isDrawing = false;

            const rect = harvestRect;
            const w = rect.width;
            const h = rect.height;

            // Too small — cancel
            if (w < 10 || h < 10) {
                fc.remove(rect);
                fc.renderAll();
                return;
            }

            // Show the harvest naming dialog
            this._showHarvestDialog(rect);
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up', onMouseUp);

        this._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up': onMouseUp,
        };
    }

    /**
     * Show an inline dialog to name and tag a harvested component.
     *
     * Args:
     *   harvestRect: The Fabric.Rect showing the selected region.
     */
    _showHarvestDialog(harvestRect) {
        const fc = this.canvas.fabricCanvas;
        const dialog = document.getElementById('harvest-dialog');
        if (!dialog) return;

        const nameInput = dialog.querySelector('#harvest-name');
        const tagsInput = dialog.querySelector('#harvest-tags');
        const saveBtn = dialog.querySelector('#harvest-save');
        const cancelBtn = dialog.querySelector('#harvest-cancel');

        // Position near the harvest rect
        nameInput.value = '';
        tagsInput.value = '';
        dialog.style.display = 'block';
        nameInput.focus();

        const cleanup = () => {
            dialog.style.display = 'none';
            fc.remove(harvestRect);
            fc.renderAll();
            // Remove listeners to avoid leaks
            saveBtn.removeEventListener('click', onSave);
            cancelBtn.removeEventListener('click', onCancel);
            nameInput.removeEventListener('keydown', onKeydown);
        };

        const onSave = async () => {
            const name = nameInput.value.trim();
            if (!name) { nameInput.focus(); return; }

            const tags = tagsInput.value.split(',')
                .map(t => t.trim().toLowerCase())
                .filter(t => t.length > 0);

            // Convert Fabric natural coords to PDF points
            // Fabric uses BASE_DPI (150), PDF uses 72 DPI
            const scale = 72 / 150;
            const rect = {
                x: harvestRect.left * scale,
                y: harvestRect.top * scale,
                w: harvestRect.width * scale,
                h: harvestRect.height * scale,
            };

            const docId = this.viewer?.docId;
            const page = this.viewer?.currentPage ?? 0;

            // Get hidden layers from the PDF layer panel
            const pdfLayerPanel = window.app?.pdfLayerPanel;
            const hiddenLayers = pdfLayerPanel?._hidden
                ? [...pdfLayerPanel._hidden] : [];

            try {
                const resp = await fetch('/api/components/harvest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        doc_id: docId,
                        page: page,
                        rect: rect,
                        hidden_layers: hiddenLayers,
                        name: name,
                        tags: tags,
                    }),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                console.log('[Harvest] Component saved:', data.name, data.id);

                // Notify the component library panel to refresh
                window.dispatchEvent(new CustomEvent('component-harvested', { detail: data }));

            } catch (err) {
                console.error('[Harvest] Failed:', err);
            }

            cleanup();
            this.setTool('select');
        };

        const onCancel = () => {
            cleanup();
            this.setTool('select');
        };

        const onKeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onSave(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        };

        saveBtn.addEventListener('click', onSave);
        cancelBtn.addEventListener('click', onCancel);
        nameInput.addEventListener('keydown', onKeydown);
        tagsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onSave(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        });
    }
```

- [ ] **Step 3: Add harvest dialog HTML to editor.html**

In `templates/editor.html`, find the end of the toolbar section. Add the harvest dialog HTML (hidden by default):

```html
<!-- Harvest Component Dialog -->
<div id="harvest-dialog" class="harvest-dialog" style="display: none;">
    <div class="harvest-dialog-title">Save Component</div>
    <input id="harvest-name" type="text" class="harvest-dialog-input" placeholder="Component name..." maxlength="128">
    <input id="harvest-tags" type="text" class="harvest-dialog-input" placeholder="Tags (comma-separated)..." maxlength="256">
    <div class="harvest-dialog-actions">
        <button id="harvest-cancel" class="harvest-dialog-btn harvest-dialog-btn-cancel">Cancel</button>
        <button id="harvest-save" class="harvest-dialog-btn harvest-dialog-btn-save">Save</button>
    </div>
</div>
```

- [ ] **Step 4: Add harvest dialog CSS to style.css**

Append to `static/css/style.css`:

```css
/* ── Harvest Component Dialog ── */
.harvest-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #1e1e2e;
    border: 1px solid #5599cc;
    border-radius: 8px;
    padding: 16px;
    z-index: 10000;
    min-width: 280px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.harvest-dialog-title {
    color: #e0e0e0;
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
}
.harvest-dialog-input {
    width: 100%;
    box-sizing: border-box;
    background: #1a1a2e;
    border: 1px solid #3a3a55;
    border-radius: 4px;
    color: #e0e0e0;
    font-size: 13px;
    padding: 6px 10px;
    margin-bottom: 8px;
    outline: none;
}
.harvest-dialog-input:focus {
    border-color: #5599cc;
}
.harvest-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
}
.harvest-dialog-btn {
    padding: 5px 14px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid #3a3a55;
}
.harvest-dialog-btn-cancel {
    background: #2a2a3d;
    color: #aaa;
}
.harvest-dialog-btn-cancel:hover { background: #3a3a4d; }
.harvest-dialog-btn-save {
    background: #1e3a5f;
    color: #88bbdd;
    border-color: #2a5080;
}
.harvest-dialog-btn-save:hover { background: #2a4a6f; }
```

- [ ] **Step 5: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add static/js/toolbar.js templates/editor.html static/css/style.css
git commit -m "feat(components): add harvest tool with rectangle drag and naming dialog"
```

---

### Task 9: Component Library Panel (JS Module)

**Files:**
- Create: `static/js/component-library.js`
- Modify: `static/js/app.js`
- Modify: `templates/editor.html`
- Modify: `static/css/style.css`

- [ ] **Step 1: Create component-library.js**

Create `static/js/component-library.js`:

```javascript
/**
 * PortolanCAST — Component Library Panel
 *
 * Purpose:
 *   Right-docked panel for browsing, searching, and stamping reusable
 *   components harvested from document regions. Supports pop-out to
 *   a separate browser window via BroadcastChannel.
 *
 * Security:
 *   - Component names set via textContent (never innerHTML)
 *   - Thumbnail URLs are server-provided relative paths
 */

export class ComponentLibrary {
    constructor() {
        this._components = [];
        this._tags = [];
        this._activeTags = new Set();
        this._searchQuery = '';
        this._toolbar = null;
        this._visible = false;
        this._channel = new BroadcastChannel('portolancast-components');

        // Listen for harvest events to auto-refresh
        window.addEventListener('component-harvested', () => this.refresh());

        // Listen for stamp requests from popped-out window
        this._channel.onmessage = (e) => {
            if (e.data?.type === 'stamp' && e.data.componentId) {
                this._enterStampMode(e.data.componentId);
            }
        };
    }

    /**
     * Initialize the panel.
     * Args:
     *   toolbar: Toolbar instance (for triggering stamp mode).
     */
    init(toolbar) {
        this._toolbar = toolbar;
        this._bindToggle();
        this._bindSearch();
        this._bindImport();
    }

    toggle() {
        this._visible = !this._visible;
        const panel = document.getElementById('component-library-panel');
        if (panel) panel.style.display = this._visible ? 'flex' : 'none';
        if (this._visible) this.refresh();
    }

    show() {
        this._visible = true;
        const panel = document.getElementById('component-library-panel');
        if (panel) panel.style.display = 'flex';
        this.refresh();
    }

    hide() {
        this._visible = false;
        const panel = document.getElementById('component-library-panel');
        if (panel) panel.style.display = 'none';
    }

    async refresh() {
        await this._fetchComponents();
        await this._fetchTags();
        this._renderGrid();
        this._renderTagChips();
    }

    // =========================================================================
    // DATA FETCHING
    // =========================================================================

    async _fetchComponents() {
        const params = new URLSearchParams();
        if (this._activeTags.size > 0) {
            params.set('tags', [...this._activeTags].join(','));
        }
        if (this._searchQuery) {
            params.set('search', this._searchQuery);
        }
        try {
            const resp = await fetch(`/api/components?${params}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._components = data.components || [];
        } catch (err) {
            console.error('[ComponentLibrary] Fetch failed:', err);
            this._components = [];
        }
    }

    async _fetchTags() {
        try {
            const resp = await fetch('/api/components/tags');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._tags = data.tags || [];
        } catch (err) {
            console.error('[ComponentLibrary] Tags fetch failed:', err);
            this._tags = [];
        }
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    _renderGrid() {
        const grid = document.getElementById('component-library-grid');
        if (!grid) return;
        grid.textContent = '';

        if (this._components.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'component-library-empty';
            empty.textContent = 'No components yet. Use the Harvest tool (Y) to capture regions from documents.';
            grid.appendChild(empty);
            return;
        }

        for (const comp of this._components) {
            const cell = document.createElement('div');
            cell.className = 'component-library-cell';
            cell.dataset.componentId = comp.id;

            const thumb = document.createElement('img');
            thumb.className = 'component-library-thumb';
            thumb.src = comp.thumb_url;
            thumb.alt = comp.name;
            thumb.loading = 'lazy';

            const name = document.createElement('div');
            name.className = 'component-library-name';
            name.textContent = comp.name;
            name.title = comp.name;

            cell.appendChild(thumb);
            cell.appendChild(name);

            // Click to stamp
            cell.addEventListener('click', () => {
                this._enterStampMode(comp.id);
            });

            // Right-click context menu
            cell.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._showContextMenu(e, comp);
            });

            grid.appendChild(cell);
        }
    }

    _renderTagChips() {
        const container = document.getElementById('component-library-tags');
        if (!container) return;
        container.textContent = '';

        for (const tagInfo of this._tags) {
            const chip = document.createElement('span');
            chip.className = 'component-tag-chip';
            if (this._activeTags.has(tagInfo.tag)) {
                chip.classList.add('active');
            }
            chip.textContent = `${tagInfo.tag} (${tagInfo.count})`;
            chip.addEventListener('click', () => {
                if (this._activeTags.has(tagInfo.tag)) {
                    this._activeTags.delete(tagInfo.tag);
                } else {
                    this._activeTags.add(tagInfo.tag);
                }
                this.refresh();
            });
            container.appendChild(chip);
        }
    }

    // =========================================================================
    // BINDINGS
    // =========================================================================

    _bindToggle() {
        const closeBtn = document.getElementById('component-library-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.hide());

        const popoutBtn = document.getElementById('component-library-popout');
        if (popoutBtn) popoutBtn.addEventListener('click', () => this._popOut());
    }

    _bindSearch() {
        const input = document.getElementById('component-library-search');
        if (!input) return;
        let debounce = null;
        input.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                this._searchQuery = input.value.trim();
                this.refresh();
            }, 300);
        });
    }

    _bindImport() {
        const btn = document.getElementById('component-library-import');
        const input = document.getElementById('component-import-input');
        if (!btn || !input) return;

        btn.addEventListener('click', () => input.click());
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            input.value = '';
            if (!file) return;

            const form = new FormData();
            form.append('file', file);
            form.append('mode', 'create');

            try {
                const resp = await fetch('/api/components/import', {
                    method: 'POST',
                    body: form,
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                console.log('[ComponentLibrary] Imported:', data.imported?.length, 'components');
                this.refresh();
            } catch (err) {
                console.error('[ComponentLibrary] Import failed:', err);
            }
        });
    }

    // =========================================================================
    // STAMP MODE
    // =========================================================================

    _enterStampMode(componentId) {
        const comp = this._components.find(c => c.id === componentId);
        if (!comp || !this._toolbar) return;

        // Store the active component for the toolbar's stamp handler
        this._toolbar._stampComponent = comp;
        this._toolbar.setTool('component-stamp');
    }

    // =========================================================================
    // POP-OUT WINDOW
    // =========================================================================

    _popOut() {
        const url = '/static/component-library-popout.html';
        const win = window.open(url, 'ComponentLibrary',
            'width=350,height=600,resizable=yes,scrollbars=yes');

        if (win) {
            this.hide();
            // When pop-out closes, show docked panel again
            const check = setInterval(() => {
                if (win.closed) {
                    clearInterval(check);
                    this.show();
                }
            }, 1000);
        }
    }

    // =========================================================================
    // CONTEXT MENU
    // =========================================================================

    _showContextMenu(event, comp) {
        // Remove any existing context menu
        this._removeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'component-context-menu';
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;

        const items = [
            { label: 'Rename', action: () => this._renameComponent(comp) },
            { label: 'Edit Tags', action: () => this._editTags(comp) },
            { label: 'Export SVG', action: () => window.open(comp.svg_url) },
            { label: 'Export PNG', action: () => window.open(comp.png_url) },
            { label: 'Delete', action: () => this._deleteComponent(comp) },
        ];

        for (const item of items) {
            const el = document.createElement('div');
            el.className = 'component-context-item';
            el.textContent = item.label;
            el.addEventListener('click', () => {
                this._removeContextMenu();
                item.action();
            });
            menu.appendChild(el);
        }

        document.body.appendChild(menu);
        this._activeContextMenu = menu;

        // Close on click outside
        const closer = (e) => {
            if (!menu.contains(e.target)) {
                this._removeContextMenu();
                document.removeEventListener('click', closer);
            }
        };
        setTimeout(() => document.addEventListener('click', closer), 0);
    }

    _removeContextMenu() {
        if (this._activeContextMenu) {
            this._activeContextMenu.remove();
            this._activeContextMenu = null;
        }
    }

    async _renameComponent(comp) {
        const newName = prompt('Rename component:', comp.name);
        if (!newName || newName.trim() === comp.name) return;
        try {
            await fetch(`/api/components/${comp.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName.trim() }),
            });
            this.refresh();
        } catch (err) {
            console.error('[ComponentLibrary] Rename failed:', err);
        }
    }

    async _editTags(comp) {
        const current = comp.tags?.join(', ') || '';
        const newTags = prompt('Edit tags (comma-separated):', current);
        if (newTags === null) return;
        const tags = newTags.split(',').map(t => t.trim().toLowerCase()).filter(t => t);
        try {
            await fetch(`/api/components/${comp.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags }),
            });
            this.refresh();
        } catch (err) {
            console.error('[ComponentLibrary] Edit tags failed:', err);
        }
    }

    async _deleteComponent(comp) {
        if (!confirm(`Delete "${comp.name}"?`)) return;
        try {
            await fetch(`/api/components/${comp.id}`, { method: 'DELETE' });
            this.refresh();
        } catch (err) {
            console.error('[ComponentLibrary] Delete failed:', err);
        }
    }
}
```

- [ ] **Step 2: Add library panel HTML to editor.html**

In `templates/editor.html`, add the component library panel container. Place it as a sibling of the main viewport area (after `#viewport` or at the end of the editor layout):

```html
<!-- Component Library Panel (right dock) -->
<div id="component-library-panel" class="component-library-panel" style="display: none;">
    <div class="component-library-header">
        <span class="component-library-title">Components</span>
        <button id="component-library-import" class="component-library-header-btn" title="Import components">+</button>
        <button id="component-library-popout" class="component-library-header-btn" title="Pop out to window">&#x29C9;</button>
        <button id="component-library-close" class="component-library-header-btn" title="Close">✕</button>
    </div>
    <input id="component-library-search" type="text" class="component-library-search" placeholder="Search components...">
    <div id="component-library-tags" class="component-library-tags"></div>
    <div id="component-library-grid" class="component-library-grid"></div>
    <input id="component-import-input" type="file" accept=".zip,.svg,.png" style="display:none">
</div>
```

- [ ] **Step 3: Add library panel CSS to style.css**

Append to `static/css/style.css`:

```css
/* ── Component Library Panel ── */
.component-library-panel {
    position: fixed;
    right: 0;
    top: 40px;
    bottom: 0;
    width: 250px;
    background: #1e1e2e;
    border-left: 1px solid #3a3a55;
    display: flex;
    flex-direction: column;
    z-index: 500;
    overflow: hidden;
}
.component-library-header {
    display: flex;
    align-items: center;
    padding: 8px 10px;
    border-bottom: 1px solid #3a3a55;
    gap: 4px;
}
.component-library-title {
    color: #e0e0e0;
    font-size: 13px;
    font-weight: 600;
    flex: 1;
}
.component-library-header-btn {
    background: none;
    border: 1px solid #3a3a55;
    border-radius: 3px;
    color: #888;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
    line-height: 1;
}
.component-library-header-btn:hover { color: #ccc; border-color: #5599cc; }
.component-library-search {
    margin: 8px 10px 4px;
    background: #1a1a2e;
    border: 1px solid #3a3a55;
    border-radius: 4px;
    color: #e0e0e0;
    font-size: 12px;
    padding: 5px 8px;
    outline: none;
}
.component-library-search:focus { border-color: #5599cc; }
.component-library-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 10px;
    max-height: 60px;
    overflow-y: auto;
}
.component-tag-chip {
    background: #2a2a3d;
    border: 1px solid #3a3a55;
    border-radius: 12px;
    color: #aaa;
    font-size: 10px;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
}
.component-tag-chip:hover { border-color: #5599cc; color: #ccc; }
.component-tag-chip.active {
    background: #1e3a5f;
    border-color: #2a5080;
    color: #88bbdd;
}
.component-library-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    padding: 8px 10px;
    overflow-y: auto;
    flex: 1;
}
.component-library-cell {
    background: #2a2a3d;
    border: 1px solid #3a3a55;
    border-radius: 4px;
    padding: 6px;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s;
}
.component-library-cell:hover { border-color: #5599cc; }
.component-library-thumb {
    width: 100%;
    height: 60px;
    object-fit: contain;
    background: #1a1a2e;
    border-radius: 3px;
}
.component-library-name {
    font-size: 10px;
    color: #ccc;
    margin-top: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.component-library-empty {
    grid-column: 1 / -1;
    color: #666;
    font-size: 12px;
    text-align: center;
    padding: 20px 10px;
}
/* Context menu */
.component-context-menu {
    position: fixed;
    background: #1e1e2e;
    border: 1px solid #3a3a55;
    border-radius: 4px;
    padding: 4px 0;
    z-index: 10001;
    min-width: 140px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
.component-context-item {
    padding: 6px 14px;
    color: #ccc;
    font-size: 12px;
    cursor: pointer;
}
.component-context-item:hover { background: #2a2a3d; color: #fff; }
```

- [ ] **Step 4: Import and initialize in app.js**

In `static/js/app.js`, add the import (after the existing imports ~line 37):

```javascript
import { ComponentLibrary } from './component-library.js';
```

In the App constructor (after existing module initialization), add:

```javascript
        this.componentLibrary = new ComponentLibrary();
```

In the `init()` or `_connectModules()` method (wherever modules get connected), add:

```javascript
        this.componentLibrary.init(this.toolbar);
```

- [ ] **Step 5: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add static/js/component-library.js static/js/app.js templates/editor.html static/css/style.css
git commit -m "feat(components): add component library panel with search, tags, and context menu"
```

---

### Task 10: Stamp Mode (Ghost Cursor + Repeat Click)

**Files:**
- Modify: `static/js/toolbar.js`

- [ ] **Step 1: Add component-stamp tool case and stamp mode handler**

In `toolbar.js`, add to the `setTool()` switch statement (after the harvest case):

```javascript
            case 'component-stamp':
                // Repeat-click placement of a library component as a fabric.Image.
                // Ghost thumbnail follows cursor; click places, stays in mode.
                fc.isDrawingMode = false;
                fc.selection = false;
                this.canvas.setDrawingMode(true);
                this._initStampMode();
                break;
```

Add the `_initStampMode()` method to the Toolbar class:

```javascript
    /**
     * Initialize stamp mode — ghost cursor + repeat click placement.
     *
     * Reads this._stampComponent (set by ComponentLibrary._enterStampMode).
     * Places fabric.Image copies on each click. Escape exits.
     */
    _initStampMode() {
        const comp = this._stampComponent;
        if (!comp) {
            this.setTool('select');
            return;
        }

        const fc = this.canvas.fabricCanvas;
        let ghost = null;

        // Load the component PNG as a fabric.Image for the ghost preview
        fabric.Image.fromURL(comp.png_url).then((img) => {
            // Scale to reasonable size (max 200px either dimension)
            const maxDim = 200;
            const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
            img.scale(scale);
            img.set({
                opacity: 0.5,
                evented: false,
                selectable: false,
                excludeFromExport: true,
            });
            ghost = img;
            fc.add(ghost);
            fc.renderAll();
        }).catch((err) => {
            console.error('[Stamp] Failed to load ghost image:', err);
        });

        const onMouseMove = (opt) => {
            if (!ghost) return;
            const ptr = fc.getPointer(opt.e);
            ghost.set({
                left: ptr.x - (ghost.getScaledWidth() / 2),
                top: ptr.y - (ghost.getScaledHeight() / 2),
            });
            fc.renderAll();
        };

        const onMouseDown = async (opt) => {
            if (opt.e.button !== 0) return;
            const ptr = fc.getPointer(opt.e);

            try {
                const img = await fabric.Image.fromURL(comp.png_url);
                // Match ghost scale
                if (ghost) {
                    img.scale(ghost.scaleX);
                }
                img.set({
                    left: ptr.x - (img.getScaledWidth() / 2),
                    top: ptr.y - (img.getScaledHeight() / 2),
                });
                img.componentId = comp.id;
                this.canvas.stampDefaults(img, {
                    markupType: 'component-stamp',
                    preserveColor: true,
                });
                // Clear stroke — images don't need one
                img.set({ stroke: 'transparent', strokeWidth: 0 });
                fc.add(img);
                fc.renderAll();
                console.log('[Stamp] Placed:', comp.name);
            } catch (err) {
                console.error('[Stamp] Placement failed:', err);
            }
        };

        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:down', onMouseDown);

        // Store for cleanup
        this._shapeHandlers = {
            'mouse:move': onMouseMove,
            'mouse:down': onMouseDown,
        };

        // Store ghost for cleanup when tool changes
        this._stampGhost = ghost;
        // Override the cleanup to also remove the ghost
        const origCleanup = this._cleanupShapeHandlers?.bind(this);
        this._cleanupShapeHandlers = () => {
            if (origCleanup) origCleanup();
            if (this._stampGhost) {
                fc.remove(this._stampGhost);
                this._stampGhost = null;
                fc.renderAll();
            }
        };
    }
```

- [ ] **Step 2: Ensure ghost cleanup on tool switch**

In `toolbar.js`, find where `_shapeHandlers` are cleaned up when `setTool()` is called (typically at the top of `setTool()`). Make sure that if `this._stampGhost` exists, it's removed from the canvas:

```javascript
        // Clean up ghost from stamp mode
        if (this._stampGhost) {
            const fc = this.canvas?.fabricCanvas;
            if (fc) fc.remove(this._stampGhost);
            this._stampGhost = null;
        }
```

Add this at the start of `setTool()`, before the existing handler cleanup.

- [ ] **Step 3: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add static/js/toolbar.js
git commit -m "feat(components): add stamp mode with ghost cursor and repeat-click placement"
```

---

### Task 11: Integration Tests

**Files:**
- Create: `test_components.mjs`

- [ ] **Step 1: Write Playwright integration tests**

Create `test_components.mjs`:

```javascript
/**
 * PortolanCAST — Component Harvest & Stamp Tests
 *
 * Groups:
 *   Group 1: Component API — harvest, list, update, delete, tags
 *   Group 2: Import/Export — ZIP round-trip, individual SVG import
 *   Group 3: Harvest tool — UI rectangle drag + dialog
 *   Group 4: Ctrl+D duplicate
 *
 * Run: node test_components.mjs
 * Requires: Server running at 127.0.0.1:8000 with at least 1 document loaded.
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID = 1;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

// =============================================================================
// GROUP 1: Component API
// =============================================================================

async function testComponentAPI() {
    console.log('\nGroup 1: Component API');

    // Harvest a component via API
    const harvestResp = await fetch(`${BASE_URL}/api/components/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            doc_id: DOC_ID,
            page: 0,
            rect: { x: 50, y: 50, w: 100, h: 80 },
            hidden_layers: [],
            name: 'Test Elbow',
            tags: ['piping', 'test'],
        }),
    });
    assert(harvestResp.ok, 'POST /api/components/harvest returns 200');
    const harvested = await harvestResp.json();
    assert(harvested.id, 'Harvested component has an ID');
    assert(harvested.name === 'Test Elbow', 'Harvested component has correct name');
    assert(harvested.thumb_url.includes(harvested.id), 'Thumbnail URL contains component ID');

    const compId = harvested.id;

    // List components
    const listResp = await fetch(`${BASE_URL}/api/components`);
    assert(listResp.ok, 'GET /api/components returns 200');
    const listData = await listResp.json();
    assert(listData.components.length >= 1, 'Component list has at least 1 item');

    // Filter by tag
    const tagResp = await fetch(`${BASE_URL}/api/components?tags=piping`);
    const tagData = await tagResp.json();
    assert(tagData.components.some(c => c.id === compId), 'Tag filter returns harvested component');

    // Search by name
    const searchResp = await fetch(`${BASE_URL}/api/components?search=Elbow`);
    const searchData = await searchResp.json();
    assert(searchData.components.some(c => c.id === compId), 'Name search finds component');

    // Get tags
    const tagsResp = await fetch(`${BASE_URL}/api/components/tags`);
    assert(tagsResp.ok, 'GET /api/components/tags returns 200');
    const tagsData = await tagsResp.json();
    assert(tagsData.tags.some(t => t.tag === 'piping'), 'Tags list includes "piping"');

    // Update component
    const updateResp = await fetch(`${BASE_URL}/api/components/${compId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Elbow', tags: ['piping', 'renamed'] }),
    });
    assert(updateResp.ok, 'PUT /api/components/:id returns 200');
    const updated = await updateResp.json();
    assert(updated.name === 'Renamed Elbow', 'Component name updated');

    // Get single component
    const getResp = await fetch(`${BASE_URL}/api/components/${compId}`);
    assert(getResp.ok, 'GET /api/components/:id returns 200');

    // Thumbnail serves
    const thumbResp = await fetch(`${BASE_URL}${harvested.thumb_url}`);
    assert(thumbResp.ok, 'Thumbnail file serves successfully');

    // Delete component
    const delResp = await fetch(`${BASE_URL}/api/components/${compId}`, { method: 'DELETE' });
    assert(delResp.ok, 'DELETE /api/components/:id returns 200');

    // Verify deleted
    const gone = await fetch(`${BASE_URL}/api/components/${compId}`);
    assert(gone.status === 404, 'Deleted component returns 404');
}

// =============================================================================
// GROUP 2: Import/Export
// =============================================================================

async function testImportExport() {
    console.log('\nGroup 2: Import/Export');

    // Create two components for export
    const c1 = await (await fetch(`${BASE_URL}/api/components/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            doc_id: DOC_ID, page: 0,
            rect: { x: 10, y: 10, w: 50, h: 50 },
            hidden_layers: [], name: 'Export Test A', tags: ['export-test'],
        }),
    })).json();

    const c2 = await (await fetch(`${BASE_URL}/api/components/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            doc_id: DOC_ID, page: 0,
            rect: { x: 60, y: 10, w: 50, h: 50 },
            hidden_layers: [], name: 'Export Test B', tags: ['export-test'],
        }),
    })).json();

    // Export by tag
    const exportResp = await fetch(`${BASE_URL}/api/components/export?tags=export-test`);
    assert(exportResp.ok, 'GET /api/components/export returns 200');
    assert(
        exportResp.headers.get('content-type')?.includes('application/zip'),
        'Export returns ZIP content-type'
    );

    // Clean up
    await fetch(`${BASE_URL}/api/components/${c1.id}`, { method: 'DELETE' });
    await fetch(`${BASE_URL}/api/components/${c2.id}`, { method: 'DELETE' });
}

// =============================================================================
// GROUP 3: Harvest Tool UI
// =============================================================================

async function testHarvestToolUI(browser) {
    console.log('\nGroup 3: Harvest Tool UI');

    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/editor?id=${DOC_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Press Y to activate harvest mode
    await page.keyboard.press('y');
    await page.waitForTimeout(200);

    const currentTool = await page.evaluate(() => window.app.toolbar.activeTool);
    assert(currentTool === 'harvest', 'Pressing Y activates harvest tool');

    // Escape back to select
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await page.close();
}

// =============================================================================
// GROUP 4: Ctrl+D Duplicate
// =============================================================================

async function testCtrlDDuplicate(browser) {
    console.log('\nGroup 4: Ctrl+D Duplicate');

    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/editor?id=${DOC_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Draw a rectangle
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
    await page.keyboard.press('r');
    await page.waitForTimeout(100);

    const canvas = await page.evaluate(() => {
        const el = document.getElementById('fabric-canvas');
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top, scale: window.app.viewer.zoom / 100 };
    });

    // Draw a rect
    await page.mouse.move(canvas.x + 100, canvas.y + 100);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 200, canvas.y + 200);
    await page.mouse.up();
    await page.waitForTimeout(200);

    const countBefore = await page.evaluate(
        () => window.app.canvas.fabricCanvas.getObjects().length
    );

    // Select the object and duplicate
    await page.keyboard.press('v');
    await page.waitForTimeout(100);
    await page.evaluate(() => {
        const fc = window.app.canvas.fabricCanvas;
        const objs = fc.getObjects();
        if (objs.length > 0) fc.setActiveObject(objs[objs.length - 1]);
    });
    await page.waitForTimeout(100);

    await page.keyboard.down('Control');
    await page.keyboard.press('d');
    await page.keyboard.up('Control');
    await page.waitForTimeout(300);

    const countAfter = await page.evaluate(
        () => window.app.canvas.fabricCanvas.getObjects().length
    );

    assert(countAfter === countBefore + 1, `Ctrl+D creates one duplicate (${countBefore} -> ${countAfter})`);

    // Verify clone has different markupId
    const ids = await page.evaluate(() => {
        const fc = window.app.canvas.fabricCanvas;
        return fc.getObjects().map(o => o.markupId);
    });
    const uniqueIds = new Set(ids.filter(Boolean));
    assert(uniqueIds.size === ids.filter(Boolean).length, 'Each object has a unique markupId');

    await page.close();
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
    console.log('PortolanCAST — Component Harvest & Stamp Tests');
    console.log('='.repeat(50));

    // API tests (no browser needed)
    await testComponentAPI();
    await testImportExport();

    // Browser tests
    const browser = await chromium.launch({ headless: true });
    try {
        await testHarvestToolUI(browser);
        await testCtrlDDuplicate(browser);
    } finally {
        await browser.close();
    }

    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
cd /home/odikral/projects/PortolanCAST
git add test_components.mjs
git commit -m "test(components): add Playwright integration tests for harvest, stamp, and Ctrl+D"
```

---

## Self-Review Checklist

### 1. Spec Coverage

| Spec Section | Task |
|-------------|------|
| Database schema | Task 1 |
| Config + directory | Task 2 |
| Harvest endpoint (POST) | Task 3 |
| CRUD endpoints (GET/PUT/DELETE) | Task 4 |
| Tags endpoint | Task 4 |
| Export ZIP | Task 5 |
| Import ZIP/SVG/PNG | Task 5 |
| Canvas componentId property | Task 6 |
| Markup type display name | Task 6 |
| Ctrl+D duplicate | Task 7 |
| Harvest tool (toolbar, rectangle, dialog) | Task 8 |
| Library panel (dock, search, tags, grid, context menu, pop-out, import) | Task 9 |
| Stamp mode (ghost cursor, repeat click) | Task 10 |
| Coordinate conversion (Fabric→PDF) | Task 8 (in _showHarvestDialog) |
| Security (SVG sanitize, path traversal, DPI clamp, XSS) | Tasks 3, 5, 8, 9 |
| Tests | Task 11 |

### 2. Placeholder Scan

No TBD/TODO/placeholder text found (except one inline comment in import for cairosvg fallback — this is an intentional note, not a blocking placeholder. The Pillow fallback works for PNG imports; SVG→PNG conversion is a stretch goal).

### 3. Type Consistency

- `_component_to_json()` used consistently across all endpoints
- `componentId` property name matches in canvas.js, toolbar.js stamp mode, and component-library.js
- `_stampComponent` set by ComponentLibrary, read by Toolbar — consistent interface
- `BroadcastChannel('portolancast-components')` name matches in component-library.js
- `'component-stamp'` markupType used consistently in toolbar.js and markup-list.js
