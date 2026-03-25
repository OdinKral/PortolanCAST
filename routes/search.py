"""
PortolanCAST — Global Search Routes

Purpose:
    Search across all documents and markup content. Also provides shared helper
    functions (_parse_tags, _extract_markup_entries) used by reports.py.

Security assumptions:
    - Query string length-clamped to prevent abuse
    - Parameterized SQL in db.search_all prevents SQL injection

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import re

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from config import db

router = APIRouter()

# Human-readable shape labels — mirrors SHAPE_LABELS in markup-list.js.
# Kept here so the brief matches what users see in the markup list panel.
_SHAPE_LABELS = {
    'rect': 'Rect', 'Rect': 'Rect',
    'ellipse': 'Ellipse', 'Ellipse': 'Ellipse',
    'line': 'Line', 'Line': 'Line',
    'path': 'Pen', 'Path': 'Pen',
    'circle': 'Circle', 'Circle': 'Circle',
    'polygon': 'Polygon', 'Polygon': 'Polygon',
    'i-text': 'Text', 'IText': 'Text',
    'textbox': 'Text', 'Textbox': 'Text',
    'group': 'Group', 'Group': 'Group',
}


def _parse_tags(note: str) -> list:
    """
    Extract hashtags from a markup note string.

    Tags are #word patterns: alphanumeric + dash/underscore, no spaces.
    Returns deduplicated, lowercase tag names (without # prefix) in order
    of first appearance. Mirrors parseTags() in markup-list.js and properties.js.

    Args:
        note: Raw markupNote string.

    Returns:
        List of lowercase tag name strings.
    """
    if not note:
        return []
    matches = re.findall(r'#([a-zA-Z0-9_-]+)', note)
    seen = set()
    result = []
    for m in matches:
        t = m.lower()
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result


def _extract_markup_entries(pages: dict) -> list:
    """
    Extract a flat, sorted list of annotation markup entries from all pages.

    Scans all Fabric.js page JSON blobs and collects annotation markup objects
    (non-measurement, non-area-companion). Each entry carries page index,
    shape label, markup type/status/note/author for brief generation.

    Args:
        pages: Dict mapping page index string → Fabric JSON { objects: [...] }

    Returns:
        List of dicts sorted by (page_num, markupType priority).
    """
    # Type priority used for stable sort within each page
    TYPE_PRIORITY = {"issue": 0, "question": 1, "change": 2, "note": 3, "approval": 4}
    entries = []

    for page_key, fabric_json in pages.items():
        if not isinstance(fabric_json, dict):
            continue
        objects = fabric_json.get("objects", [])
        if not isinstance(objects, list):
            continue

        try:
            page_num = int(page_key)
        except (ValueError, TypeError):
            page_num = 0

        for obj in objects:
            if not isinstance(obj, dict):
                continue

            m_type = obj.get("measurementType")
            obj_type = obj.get("type", "")

            # Skip area companion IText labels (visual pairing labels for area polygons)
            if m_type == "area" and obj_type in ("IText", "i-text"):
                continue

            # Skip measurement tool objects — they go in the Measures tab, not the Brief
            if m_type in ("distance", "area", "count"):
                continue

            # Only include the 5 annotation intent types
            markup_type = obj.get("markupType", "note")
            if markup_type not in TYPE_PRIORITY:
                continue

            entries.append({
                "page_num":      page_num,
                "shape_label":   _SHAPE_LABELS.get(obj_type, obj_type or "Shape"),
                "markup_type":   markup_type,
                "markup_status": obj.get("markupStatus", "open"),
                "markup_note":   str(obj.get("markupNote", "") or "").strip(),
                "markup_author": str(obj.get("markupAuthor", "") or "").strip(),
            })

    entries.sort(key=lambda e: (e["page_num"], TYPE_PRIORITY.get(e["markup_type"], 99)))
    return entries


@router.get("/api/search")
async def search(q: str = ""):
    """
    Search across all documents and markup content.

    Args:
        q: Query string (URL parameter). Empty string returns empty list.

    Returns:
        { "results": [{ entity_type, doc_id, doc_name, page_number,
                         match_field, match_text, context }, ...] }

    Security:
        - q length-clamped before passing to search_all
        - Parameterized SQL prevents SQL injection
    """
    # SECURITY: clamp query length to prevent abuse
    q = str(q)[:200].strip()
    if not q:
        return JSONResponse({"results": []})

    results = db.search_all(q)
    return JSONResponse({"results": results})
