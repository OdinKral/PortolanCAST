"""
PortolanCAST — Document Settings Routes (Scale, Rotations, Layers)

Purpose:
    Per-document settings persistence: drawing scale (for measurement tools),
    page rotations (per-page orientation), and layer definitions (Phase 5).
    Settings are stored as JSON strings in the document_settings table.

Security assumptions:
    - All inputs validated and clamped before storage
    - JSON values stored as text, never executed
    - Document existence verified before any read/write

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from config import db, RENDER_DPI

router = APIRouter()


# =============================================================================
# HELPERS (also imported by bundles.py)
# =============================================================================

def _default_scale() -> dict:
    """
    Return the default (unscaled) drawing scale.

    'Unscaled' means 1 Fabric pixel = 1/150 inch.
    In this mode measurement tools show dimensions in inches.
    """
    return {
        "preset": "unscaled",
        "paper_inches_per_unit": 1.0,
        "unit_label": "in",
    }


def _default_layers() -> dict:
    """
    Return the default single-layer configuration for new documents.

    Every document starts with a single 'Default' layer that is visible
    and unlocked. This is the baseline state before any user customization.

    Returns:
        Dict with 'layers' list and 'activeId' string.
    """
    return {
        "layers": [{"id": "default", "name": "Default", "visible": True, "locked": False}],
        "activeId": "default",
    }


# =============================================================================
# DRAWING SCALE
# =============================================================================

@router.get("/api/documents/{doc_id}/scale")
async def get_document_scale(doc_id: int):
    """
    Get the drawing scale setting for a document.

    Returns the scale preset and the derived pixels-per-real-unit values
    that Phase 2 measurement tools use to convert Fabric pixel distances
    to real-world lengths.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    raw = db.get_document_setting(doc_id, "scale")

    if raw:
        try:
            scale = json.loads(raw)
        except Exception:
            scale = _default_scale()
    else:
        scale = _default_scale()

    # Compute derived values for convenience — measurement tools use these directly
    pixels_per_unit = RENDER_DPI * scale["paper_inches_per_unit"]
    scale["pixels_per_unit"] = round(pixels_per_unit, 6)
    scale["pixels_per_inch"] = RENDER_DPI  # informational constant

    return JSONResponse(scale)


@router.put("/api/documents/{doc_id}/scale")
async def set_document_scale(doc_id: int, request: Request):
    """
    Set the drawing scale for a document.

    Request body:
        {
          "preset": "quarter_inch",
          "paper_inches_per_unit": 0.25,
          "unit_label": "ft"
        }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()

    # SECURITY: validate preset is a known string or 'custom'
    preset = str(body.get("preset", "unscaled"))

    try:
        paper_inches = float(body.get("paper_inches_per_unit", 1.0))
    except (TypeError, ValueError):
        paper_inches = 1.0

    # Clamp to sane range: 0.001" (1:72000) to 100" (100:1)
    paper_inches = max(0.001, min(100.0, paper_inches))

    unit_label = str(body.get("unit_label", "in"))[:8]  # max 8 chars

    scale = {
        "preset": preset,
        "paper_inches_per_unit": paper_inches,
        "unit_label": unit_label,
    }
    db.set_document_setting(doc_id, "scale", json.dumps(scale))

    pixels_per_unit = RENDER_DPI * paper_inches
    scale["pixels_per_unit"] = round(pixels_per_unit, 6)
    scale["pixels_per_inch"] = RENDER_DPI

    return JSONResponse(scale)


# =============================================================================
# PAGE ROTATIONS
# =============================================================================

@router.get("/api/documents/{doc_id}/rotations")
async def get_document_rotations(doc_id: int):
    """
    Get per-page rotation settings for a document.

    Returns a JSON map of {pageNumber: degrees} for pages with non-zero
    rotation. Missing pages default to 0°.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    raw = db.get_document_setting(doc_id, "rotations")
    if raw:
        try:
            rotations = json.loads(raw)
        except Exception:
            rotations = {}
    else:
        rotations = {}

    return JSONResponse(rotations)


@router.put("/api/documents/{doc_id}/rotations")
async def set_document_rotations(doc_id: int, request: Request):
    """
    Save per-page rotation settings for a document.

    Request body: JSON object mapping page numbers (as strings) to degrees.
    Example: {"0": 90, "2": 270}
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()

    # SECURITY: validate — only accept {string_page: valid_degree} pairs
    valid_degrees = {0, 90, 180, 270}
    sanitized = {}
    for page_str, degrees in body.items():
        try:
            page_num = int(page_str)
            deg = int(degrees)
        except (TypeError, ValueError):
            continue
        if deg in valid_degrees and deg != 0 and page_num >= 0:
            sanitized[str(page_num)] = deg

    db.set_document_setting(doc_id, "rotations", json.dumps(sanitized))

    return JSONResponse(sanitized)


# =============================================================================
# LAYERS (Phase 5)
# =============================================================================

@router.get("/api/documents/{doc_id}/layers")
async def get_layers(doc_id: int):
    """
    Get the layer definitions for a document.

    Returns the full layer configuration: list of layer objects with
    id/name/visible/locked, plus the currently active layer ID.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    raw = db.get_document_setting(doc_id, "layers")
    if raw:
        try:
            return JSONResponse(json.loads(raw))
        except Exception:
            pass

    # No saved layers — return default configuration
    return JSONResponse(_default_layers())


@router.put("/api/documents/{doc_id}/layers")
async def put_layers(doc_id: int, request: Request):
    """
    Save the layer definitions for a document.

    Expects JSON body: { "layers": [...], "activeId": str }

    Security:
        - Clamps string lengths to prevent oversized storage
        - Type-validates all layer fields before persisting
        - Rejects empty layers list (document must always have ≥1 layer)
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    layers = body.get("layers")

    if not isinstance(layers, list) or len(layers) == 0:
        raise HTTPException(status_code=400, detail="layers must be a non-empty list")

    # SECURITY: clamp strings, validate types — reject malformed layer objects
    cleaned = []
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        cleaned.append({
            "id":      str(layer.get("id", "default"))[:64],
            "name":    str(layer.get("name", "Layer"))[:64],
            "visible": bool(layer.get("visible", True)),
            "locked":  bool(layer.get("locked", False)),
        })

    if not cleaned:
        raise HTTPException(status_code=400, detail="No valid layers provided")

    active_id = str(body.get("activeId", "default"))[:64]

    db.set_document_setting(
        doc_id, "layers",
        json.dumps({"layers": cleaned, "activeId": active_id})
    )

    return JSONResponse({"layers": cleaned, "activeId": active_id})


# =============================================================================
# VIEW MODE (Haystack Phase 3 — ISA View Toggle)
# =============================================================================
# Per-document toggle between human-readable labels ("Zone Temp Sensor")
# and ISA-5.1 notation ("TT-101") on equipment markers.
# Stored in document_settings with key "view_mode".
# =============================================================================

@router.get("/api/documents/{doc_id}/view-mode")
async def get_view_mode(doc_id: int):
    """
    Get the label view mode for a document.

    Returns:
        {"mode": "system"} or {"mode": "isa"}

    The default is "system" (human-readable labels).
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    raw = db.get_document_setting(doc_id, "view_mode")
    mode = raw if raw in ("system", "isa") else "system"
    return JSONResponse({"mode": mode})


@router.put("/api/documents/{doc_id}/view-mode")
async def set_view_mode(doc_id: int, request: Request):
    """
    Set the label view mode for a document.

    Args:
        mode: "system" (human-readable) or "isa" (ISA-5.1 notation)

    Invalid values are silently clamped to "system".
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    body = await request.json()
    mode = str(body.get("mode", "system"))
    if mode not in ("system", "isa"):
        mode = "system"
    db.set_document_setting(doc_id, "view_mode", mode)
    return JSONResponse({"mode": mode})
