"""
PortolanCAST — Component Library API

Endpoints for harvesting, browsing, stamping, importing, and exporting
reusable visual components from document regions.

Security assumptions:
    - doc_id validated against DB before any file access
    - DPI clamped 72-300 — no unbounded render size
    - File paths use UUID hex names only — no user input reaches the filesystem path

Author: PortolanCAST
Version: 0.1.0
Date: 2026-04-08
"""

import io
import json
import re
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image

from config import db, pdf_engine, COMPONENTS_DIR

router = APIRouter()


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def _generate_thumbnail(png_bytes: bytes, max_dim: int = 120) -> bytes:
    """
    Resize PNG bytes to a thumbnail that fits within max_dim x max_dim.

    Preserves aspect ratio using LANCZOS resampling. Always returns PNG bytes.

    Args:
        png_bytes: Source PNG as bytes.
        max_dim:   Maximum dimension (width or height) in pixels.

    Returns:
        PNG bytes of the resized thumbnail.
    """
    img = Image.open(io.BytesIO(png_bytes))
    img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _component_to_json(comp: dict) -> dict:
    """
    Convert a component DB row to an API response dict.

    Adds thumb_url, png_url, svg_url convenience fields derived from the
    component's UUID so the client can request files via static mount.

    Args:
        comp: Component dict from db.get_component() or db.create_component().

    Returns:
        Response dict with all DB fields plus URL fields.
    """
    cid = comp["id"]
    result = dict(comp)

    # Deserialize tags from JSON string to list if needed
    if isinstance(result.get("tags"), str):
        try:
            result["tags"] = json.loads(result["tags"])
        except (json.JSONDecodeError, TypeError):
            result["tags"] = []

    result["png_url"]   = f"/data/components/{cid}.png"
    result["svg_url"]   = f"/data/components/{cid}.svg"
    result["thumb_url"] = f"/data/components/{cid}_thumb.png"

    return result


def _slugify(text: str) -> str:
    """Convert component name to a filesystem-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[\s_]+', '-', slug)
    slug = re.sub(r'-+', '-', slug).strip('-')
    return slug or 'component'


def _sanitize_svg(svg_bytes: bytes) -> bytes:
    """Strip dangerous content from SVG imports."""
    text = svg_bytes.decode("utf-8", errors="replace")
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'\s+on\w+\s*=\s*["\'][^"\']*["\']', '', text, flags=re.IGNORECASE)
    text = re.sub(r'javascript\s*:', '', text, flags=re.IGNORECASE)
    return text.encode("utf-8")


def _name_from_filename(filename: str) -> str:
    """Convert a filename to a display name: 'hot-water-valve.svg' -> 'Hot Water Valve'."""
    stem = Path(filename).stem
    return stem.replace("-", " ").replace("_", " ").title()


MAX_IMPORT_SIZE = 50 * 1024 * 1024  # 50 MB total for ZIP


# =============================================================================
# HARVEST ENDPOINT
# =============================================================================

@router.post("/api/components/harvest")
async def harvest_component(request: Request):
    """
    Harvest a component by cropping a rectangular region from a PDF page.

    Renders the region as both PNG (300 DPI) and SVG, generates a thumbnail,
    saves all three files to COMPONENTS_DIR, and inserts a record into the
    component library.

    Request body JSON:
        {
          "doc_id":        42,
          "page":          0,
          "rect":          {"x": 100, "y": 200, "w": 80, "h": 60},
          "hidden_layers": [],
          "name":          "90° Elbow",
          "tags":          ["piping"]
        }

    Returns:
        Component record JSON with thumb_url, png_url, svg_url fields.

    Status codes:
        400 — validation error (missing/invalid fields)
        404 — document not found or PDF file missing
        500 — render failure
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------
    doc_id = body.get("doc_id")
    if doc_id is None:
        raise HTTPException(status_code=400, detail="doc_id is required")
    try:
        doc_id = int(doc_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="doc_id must be an integer")

    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")

    rect = body.get("rect")
    if not rect or not isinstance(rect, dict):
        raise HTTPException(status_code=400, detail="rect is required")
    try:
        rx = float(rect["x"])
        ry = float(rect["y"])
        rw = float(rect["w"])
        rh = float(rect["h"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="rect must have numeric x, y, w, h")
    if rw <= 0 or rh <= 0:
        raise HTTPException(status_code=400, detail="rect w and h must be > 0")

    try:
        page_number = int(body.get("page", 0))
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="page must be an integer")
    hidden_layers = body.get("hidden_layers") or []
    tags = body.get("tags") or []
    if not isinstance(tags, list):
        tags = []

    # ------------------------------------------------------------------
    # Document lookup
    # ------------------------------------------------------------------
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document {doc_id} not found")

    pdf_path = doc.get("filepath") or doc.get("file_path") or ""
    if not pdf_path or not Path(pdf_path).exists():
        raise HTTPException(status_code=404, detail="PDF file not found on disk")

    # ------------------------------------------------------------------
    # Render
    # ------------------------------------------------------------------
    clip_rect = (rx, ry, rx + rw, ry + rh)

    try:
        png_bytes = pdf_engine.render_region_png(
            pdf_path, page_number, clip_rect,
            hidden_layers=hidden_layers or None,
            dpi=300
        )
    except (FileNotFoundError, IndexError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"PNG render failed: {exc}")

    try:
        svg_bytes = pdf_engine.render_region_svg(
            pdf_path, page_number, clip_rect,
            hidden_layers=hidden_layers or None
        )
    except (FileNotFoundError, IndexError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SVG render failed: {exc}")

    # ------------------------------------------------------------------
    # Thumbnail + dimensions
    # ------------------------------------------------------------------
    try:
        thumb_bytes = _generate_thumbnail(png_bytes, max_dim=120)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Thumbnail generation failed: {exc}")

    try:
        img = Image.open(io.BytesIO(png_bytes))
        width, height = img.size
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read PNG dimensions: {exc}")

    # ------------------------------------------------------------------
    # Persist files
    # ------------------------------------------------------------------
    component_id = uuid.uuid4().hex

    png_path   = COMPONENTS_DIR / f"{component_id}.png"
    svg_path   = COMPONENTS_DIR / f"{component_id}.svg"
    thumb_path = COMPONENTS_DIR / f"{component_id}_thumb.png"

    try:
        png_path.write_bytes(png_bytes)
        svg_path.write_bytes(svg_bytes)
        thumb_path.write_bytes(thumb_bytes)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save component files: {exc}")

    # ------------------------------------------------------------------
    # DB insert
    # ------------------------------------------------------------------
    source_rect_json = json.dumps({"x": rx, "y": ry, "w": rw, "h": rh})

    try:
        comp = db.create_component(
            component_id=component_id,
            name=name,
            tags=tags,
            source_doc_id=doc_id,
            source_page=page_number,
            source_rect=source_rect_json,
            png_path=str(png_path),
            svg_path=str(svg_path),
            thumb_path=str(thumb_path),
            width=width,
            height=height,
        )
    except Exception as exc:
        # Clean up files if DB insert fails
        for p in (png_path, svg_path, thumb_path):
            try:
                p.unlink()
            except OSError:
                pass
        raise HTTPException(status_code=500, detail=f"Database insert failed: {exc}")

    return _component_to_json(comp)


# =============================================================================
# LIST / SEARCH
# =============================================================================

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
            base_slug = slug
            counter = 1
            while slug in used_slugs:
                slug = f"{base_slug}-{counter}"
                counter += 1
            used_slugs.add(slug)

            png_path = Path(comp["png_path"])
            if png_path.exists():
                zf.write(png_path, f"portolancast-components/{slug}.png")

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


# =============================================================================
# SINGLE COMPONENT CRUD
# =============================================================================

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


# =============================================================================
# IMPORT ENDPOINT
# =============================================================================

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
        for name in zf.namelist():
            if ".." in name or name.startswith("/"):
                raise HTTPException(status_code=400, detail=f"Invalid path in ZIP: {name}")

        total_size = sum(info.file_size for info in zf.infolist())
        if total_size > MAX_IMPORT_SIZE:
            raise HTTPException(status_code=413, detail="Extracted ZIP too large")

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
                    png_bytes = svg_bytes  # Placeholder — proper SVG→PNG requires cairosvg

                result = _save_imported_component(
                    new_id, name, tags, png_bytes, svg_bytes,
                    entry.get("width"), entry.get("height"),
                )
                if result:
                    results.append(result)
        else:
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

    svg_path = COMPONENTS_DIR / f"{comp_id}.svg"
    svg_path.write_bytes(svg_bytes)

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
