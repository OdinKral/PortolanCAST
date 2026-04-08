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
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
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
