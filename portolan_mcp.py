"""
portolan_mcp.py — PortolanCAST Operational MCP Server (Phase 1)
================================================================

Purpose:
    Exposes PortolanCAST's FastAPI backend as an MCP (Model Context Protocol)
    server, making AI agents first-class clients of the document markup system.
    This is the DATA PLANE server — agents can read documents, create/edit/delete
    markups, manage equipment entities, and link observations to equipment.

Key features:
    - 20 MCP tools across 5 domains: Documents, Markups, Entities, Linking, Intelligence
    - Markup tools hide the Fabric.js blob pattern (GET page → modify objects → PUT back)
      so AI agents see clean create/update/delete verbs
    - Communicates with FastAPI at http://127.0.0.1:8000 via async httpx
    - Run as a separate process; never modifies FastAPI source code

Security assumptions:
    - Runs locally on 127.0.0.1 only — no internet exposure
    - No authentication layer: assumes trust boundary is the local machine
    - All string inputs are passed through to FastAPI, which validates them

Threat model:
    - AI agents are trusted callers (same machine, same session)
    - FastAPI handles length limits and SQL injection prevention
    - This server does NOT do additional validation beyond what FastAPI enforces

Usage:
    venv/bin/python3 portolan_mcp.py

    Or via Claude Desktop claude_desktop_config.json (see QUICKSTART.md).

Architecture:
    MCP Client (Claude Desktop / Claude Code)
        │  stdio (MCP protocol)
        ▼
    portolan_mcp.py        ← this file
        │  HTTP (httpx.AsyncClient)
        ▼
    FastAPI @ 127.0.0.1:8000

Author: PortolanCAST project
Version: 1.0.0
Date: 2026-03-02
"""

# =============================================================================
# IMPORTS
# =============================================================================

import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP

# =============================================================================
# SERVER SETUP
# =============================================================================

# FastMCP handles the stdio MCP protocol transport automatically.
# The name appears in Claude Desktop's server list.
mcp = FastMCP("PortolanCAST")

# Base URL for the PortolanCAST FastAPI server.
# Must be running before this MCP server can serve useful responses.
BASE_URL = "http://127.0.0.1:8000"

# =============================================================================
# MARKUP COLOR CONSTANTS
# Replicated from static/js/canvas.js — must stay in sync if canvas.js changes.
# Maps markupType semantic labels to stroke colors for Fabric.js Rect objects.
# =============================================================================

MARKUP_COLORS = {
    "note":           "#aaaaaa",   # Gray — neutral annotation
    "issue":          "#ff4444",   # Red — problem, needs attention
    "question":       "#ffaa00",   # Amber — uncertainty, needs answer
    "approval":       "#44cc66",   # Green — accepted, good to go
    "change":         "#4a9eff",   # Blue — modification, scope change
    # Image overlays carry no stroke — transparent placeholder
    "image-overlay":  "transparent",
}

VALID_MARKUP_TYPES = set(MARKUP_COLORS.keys())
VALID_STATUSES = {"open", "resolved", "pending"}

# =============================================================================
# INTERNAL HELPERS
# =============================================================================

def _http_client() -> httpx.AsyncClient:
    """
    Create a fresh httpx.AsyncClient pointed at the FastAPI server.

    Timeout is generous (30s) to handle large PDF text extraction calls.
    Called per-request inside async context managers — no connection pooling
    needed for a local stdio MCP server (low concurrency).
    """
    return httpx.AsyncClient(base_url=BASE_URL, timeout=30.0)


def _markup_summary(obj: dict, page: int) -> dict:
    """
    Strip rendering-only fields from a Fabric.js object for AI consumption.

    AI agents don't need scaleX/scaleY/angle/opacity — they need semantics.
    Returns only the fields that have decision-making value.

    Args:
        obj:  A Fabric.js object dict from the markups blob
        page: The page number this object lives on

    Returns:
        Simplified dict with markupId, markupType, markupNote, markupStatus,
        markupAuthor, markupTag, page, left, top, width, height
    """
    return {
        "markupId":     obj.get("markupId", ""),
        "markupType":   obj.get("markupType", "note"),
        "markupNote":   obj.get("markupNote", ""),
        "markupStatus": obj.get("markupStatus", "open"),
        "markupAuthor": obj.get("markupAuthor", ""),
        "markupTag":    obj.get("markupTag", ""),
        "page":         page,
        "left":         obj.get("left", 0),
        "top":          obj.get("top", 0),
        "width":        obj.get("width", 0),
        "height":       obj.get("height", 0),
    }


def _is_markup(obj: dict) -> bool:
    """
    Determine if a Fabric.js canvas object is a semantic markup.

    Skips temp drawing objects, measurement companions, and other non-markup
    canvas residents that share the objects array.

    Args:
        obj: A Fabric.js object dict

    Returns:
        True if the object has a markupType field (the canonical markup signal)
    """
    return bool(obj.get("markupType"))


def _build_rect_markup(
    x: float,
    y: float,
    width: float,
    height: float,
    markup_type: str,
    note: str,
    status: str,
) -> dict:
    """
    Construct a Fabric.js Rect object dict suitable for insertion into the
    markups canvas blob.

    Mirrors the structure created by canvas.js stampDefaults() so that markups
    created via this MCP server are visually indistinguishable from those drawn
    in the UI.

    Args:
        x:           Left coordinate in Fabric.js canvas pixels
        y:           Top coordinate in Fabric.js canvas pixels
        width:       Rectangle width in pixels
        height:      Rectangle height in pixels
        markup_type: Semantic type — must be a key in MARKUP_COLORS
        note:        Free-text annotation content
        status:      Lifecycle state ('open', 'resolved', 'pending')

    Returns:
        Dict matching Fabric.js serialized Rect format (version 6.9.1)
    """
    markup_id = uuid.uuid4().hex  # Unique ID for this markup object
    stroke_color = MARKUP_COLORS.get(markup_type, MARKUP_COLORS["note"])
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    return {
        "type":         "Rect",
        "version":      "6.9.1",
        "left":         x,
        "top":          y,
        "width":        width,
        "height":       height,
        "fill":         "transparent",
        "stroke":       stroke_color,
        "strokeWidth":  2,
        "opacity":      1,
        "angle":        0,
        "scaleX":       1,
        "scaleY":       1,
        # Semantic fields — our custom properties registered in canvas.js
        "markupId":        markup_id,
        "markupType":      markup_type,
        "markupNote":      note,
        "markupStatus":    status,
        "markupAuthor":    "AI Agent",
        "markupTimestamp": timestamp,
        "markupTag":       "",
        "layerId":         "",
    }


# =============================================================================
# TOOL GROUP 1 — DOCUMENTS (3 tools)
# =============================================================================

@mcp.tool()
async def list_documents() -> dict:
    """
    List all documents in the PortolanCAST database.

    Returns a list of documents with id, filename, and the file path.
    Use this to discover available document IDs before calling other tools.

    Returns:
        {"documents": [{"id": int, "filename": str, "filepath": str}, ...]}
    """
    async with _http_client() as client:
        resp = await client.get("/api/documents")
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_document(doc_id: int) -> dict:
    """
    Get metadata for a single document.

    Returns page count, file size, title, author, and per-page dimensions.
    Use page_count to know which page numbers are valid for other calls.

    Args:
        doc_id: The document ID (integer, from list_documents)

    Returns:
        {"id": int, "filename": str, "page_count": int, "file_size": int,
         "page_sizes": [...], "title": str, "author": str}
    """
    async with _http_client() as client:
        resp = await client.get(f"/api/documents/{doc_id}/info")
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_page_text(doc_id: int, page: int, ocr: bool = False) -> dict:
    """
    Extract text content from a specific page of a document.

    By default uses PyMuPDF's native text extraction (fast, for searchable PDFs).
    Set ocr=True to use Tesseract OCR (slower, for scanned drawings without
    embedded text).

    Args:
        doc_id: The document ID
        page:   The 1-based page number
        ocr:    Whether to use OCR fallback (default: False)

    Returns:
        {"text": str, "method": "native" | "ocr", "page": int}
    """
    async with _http_client() as client:
        resp = await client.get(
            f"/api/documents/{doc_id}/text/{page}",
            params={"ocr": "true" if ocr else "false"},
        )
        resp.raise_for_status()
        return resp.json()


# =============================================================================
# TOOL GROUP 2 — MARKUPS (5 tools)
# All markup tools implement the GET→modify→PUT pattern internally.
# The Fabric.js canvas blob is loaded, mutated, and written back atomically.
# AI agents never see the raw blob structure.
# =============================================================================

@mcp.tool()
async def list_markups(doc_id: int, page: Optional[int] = None) -> dict:
    """
    List all markups in a document, optionally filtered to one page.

    Returns a simplified view (markupId, markupType, markupNote, markupStatus,
    page, left, top, width, height) — rendering fields are stripped.

    Args:
        doc_id: The document ID
        page:   Optional 1-based page number filter. Omit to get all pages.

    Returns:
        {"markups": [...], "total": int}
    """
    async with _http_client() as client:
        resp = await client.get(f"/api/documents/{doc_id}/markups")
        resp.raise_for_status()
        data = resp.json()

    pages = data.get("pages", {})
    results = []

    for page_str, fabric_json in pages.items():
        page_num = int(page_str)
        # Apply page filter if requested
        if page is not None and page_num != page:
            continue
        objects = fabric_json.get("objects", [])
        for obj in objects:
            if _is_markup(obj):
                results.append(_markup_summary(obj, page_num))

    return {"markups": results, "total": len(results)}


@mcp.tool()
async def get_markup(doc_id: int, markup_id: str) -> dict:
    """
    Get a single markup by its markupId, searching all pages.

    Args:
        doc_id:    The document ID
        markup_id: The markup UUID (hex string from list_markups)

    Returns:
        {"markup": {...}} or {"markup": null} if not found
    """
    async with _http_client() as client:
        resp = await client.get(f"/api/documents/{doc_id}/markups")
        resp.raise_for_status()
        data = resp.json()

    pages = data.get("pages", {})
    for page_str, fabric_json in pages.items():
        page_num = int(page_str)
        for obj in fabric_json.get("objects", []):
            if obj.get("markupId") == markup_id and _is_markup(obj):
                return {"markup": _markup_summary(obj, page_num)}

    return {"markup": None}


@mcp.tool()
async def create_markup(
    doc_id: int,
    page: int,
    markup_type: str,
    note: str,
    x: float,
    y: float,
    width: float = 200.0,
    height: float = 100.0,
    status: str = "open",
) -> dict:
    """
    Create a new markup rectangle on a document page.

    Constructs a Fabric.js Rect object and inserts it into the page's canvas
    blob. The markup is immediately visible in the browser after page reload.

    Args:
        doc_id:      The document ID
        page:        The 1-based page number to add the markup to
        markup_type: Semantic type — one of: note, issue, question, approval,
                     change, image-overlay
        note:        Free-text annotation content (the markup comment)
        x:           Left coordinate in canvas pixels
        y:           Top coordinate in canvas pixels
        width:       Rectangle width in pixels (default: 200)
        height:      Rectangle height in pixels (default: 100)
        status:      Lifecycle state — one of: open, resolved, pending
                     (default: "open")

    Returns:
        {"created": true, "markupId": str, "page": int}
    """
    # Validate markup_type before touching the database
    if markup_type not in VALID_MARKUP_TYPES:
        return {
            "error": f"Invalid markup_type '{markup_type}'. "
                     f"Valid types: {sorted(VALID_MARKUP_TYPES)}"
        }

    if status not in VALID_STATUSES:
        return {
            "error": f"Invalid status '{status}'. "
                     f"Valid statuses: {sorted(VALID_STATUSES)}"
        }

    new_obj = _build_rect_markup(x, y, width, height, markup_type, note, status)

    async with _http_client() as client:
        # Load current canvas state for this document
        resp = await client.get(f"/api/documents/{doc_id}/markups")
        if resp.status_code == 404:
            return {"error": f"Document {doc_id} not found"}
        resp.raise_for_status()
        data = resp.json()

        pages = data.get("pages", {})
        page_str = str(page)

        # Get existing canvas JSON for the target page, or start fresh
        if page_str in pages:
            fabric_json = pages[page_str]
        else:
            # Page has no markups yet — create a minimal canvas JSON
            fabric_json = {"version": "6.9.1", "objects": []}

        # Append the new markup to the objects array
        fabric_json.setdefault("objects", []).append(new_obj)
        pages[page_str] = fabric_json

        # Write the full blob back — atomic PUT
        put_resp = await client.put(
            f"/api/documents/{doc_id}/markups",
            json={"pages": pages},
        )
        put_resp.raise_for_status()

    return {
        "created":  True,
        "markupId": new_obj["markupId"],
        "page":     page,
    }


@mcp.tool()
async def update_markup(
    doc_id: int,
    markup_id: str,
    note: Optional[str] = None,
    status: Optional[str] = None,
) -> dict:
    """
    Update the note or status of an existing markup.

    Only the fields you provide are changed; others are preserved.
    Finds the markup by markupId across all pages.

    Args:
        doc_id:    The document ID
        markup_id: The markup UUID to update
        note:      New annotation text (omit to keep existing)
        status:    New status — one of: open, resolved, pending (omit to keep)

    Returns:
        {"updated": true, "markupId": str} or {"error": str}
    """
    if status is not None and status not in VALID_STATUSES:
        return {
            "error": f"Invalid status '{status}'. "
                     f"Valid statuses: {sorted(VALID_STATUSES)}"
        }

    async with _http_client() as client:
        resp = await client.get(f"/api/documents/{doc_id}/markups")
        if resp.status_code == 404:
            return {"error": f"Document {doc_id} not found"}
        resp.raise_for_status()
        data = resp.json()

        pages = data.get("pages", {})
        found_page = None

        # Search all pages for the target markupId
        for page_str, fabric_json in pages.items():
            for obj in fabric_json.get("objects", []):
                if obj.get("markupId") == markup_id:
                    found_page = page_str
                    # Apply the requested field updates
                    if note is not None:
                        obj["markupNote"] = note
                    if status is not None:
                        obj["markupStatus"] = status
                    break
            if found_page:
                break

        if found_page is None:
            return {"error": f"Markup {markup_id} not found in document {doc_id}"}

        # Write back only the modified page (optimization — all pages in one PUT)
        put_resp = await client.put(
            f"/api/documents/{doc_id}/markups",
            json={"pages": pages},
        )
        put_resp.raise_for_status()

    return {"updated": True, "markupId": markup_id}


@mcp.tool()
async def delete_markup(doc_id: int, markup_id: str) -> dict:
    """
    Delete a markup from a document.

    Finds the markup by markupId across all pages and removes it from the
    Fabric.js canvas blob. The change is immediately visible in the browser
    after page reload.

    Args:
        doc_id:    The document ID
        markup_id: The markup UUID to delete

    Returns:
        {"deleted": true, "markupId": str, "page": int} or {"error": str}
    """
    async with _http_client() as client:
        resp = await client.get(f"/api/documents/{doc_id}/markups")
        if resp.status_code == 404:
            return {"error": f"Document {doc_id} not found"}
        resp.raise_for_status()
        data = resp.json()

        pages = data.get("pages", {})
        found_page = None
        deleted_from_page = None

        for page_str, fabric_json in pages.items():
            objects = fabric_json.get("objects", [])
            filtered = [o for o in objects if o.get("markupId") != markup_id]
            if len(filtered) < len(objects):
                # We removed something — record which page it came from
                fabric_json["objects"] = filtered
                found_page = page_str
                deleted_from_page = int(page_str)
                break

        if found_page is None:
            return {"error": f"Markup {markup_id} not found in document {doc_id}"}

        put_resp = await client.put(
            f"/api/documents/{doc_id}/markups",
            json={"pages": pages},
        )
        put_resp.raise_for_status()

    return {"deleted": True, "markupId": markup_id, "page": deleted_from_page}


# =============================================================================
# TOOL GROUP 3 — ENTITIES (7 tools)
# Equipment entities are the physical asset records (tag number, type, location).
# Markups can be linked to entities to create observations on specific equipment.
# =============================================================================

@mcp.tool()
async def list_entities(
    search: Optional[str] = None,
    equip_type: Optional[str] = None,
) -> dict:
    """
    List equipment entities, with optional search and type filters.

    Args:
        search:     Free-text search query (searches tag_number and location)
        equip_type: Exact match filter on equipment type (e.g., "valve", "pump")

    Returns:
        {"entities": [...], "total": int}
    """
    params = {}
    if equip_type:
        params["equip_type"] = equip_type
    if search:
        params["q"] = search

    async with _http_client() as client:
        resp = await client.get("/api/entities", params=params)
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_entity(entity_id: str) -> dict:
    """
    Get a single equipment entity by its ID.

    Args:
        entity_id: The entity UUID (hex string)

    Returns:
        {"id": str, "tag_number": str, "equip_type": str, "location": str,
         "model": str, "serial": str, "created_at": str}
    """
    async with _http_client() as client:
        resp = await client.get(f"/api/entities/{entity_id}")
        if resp.status_code == 404:
            return {"error": f"Entity {entity_id} not found"}
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_entity_by_tag(tag_number: str) -> dict:
    """
    Find an equipment entity by its tag number (e.g., "PRV-201").

    Tag numbers are unique across the database — this always returns at most
    one entity.

    Args:
        tag_number: The equipment tag number (case-sensitive)

    Returns:
        {"entity": {...}} or {"entity": null}
    """
    async with _http_client() as client:
        resp = await client.get(f"/api/entities/by-tag/{tag_number}")
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def create_entity(
    tag_number: str,
    equip_type: str = "",
    location: str = "",
    model: str = "",
    serial: str = "",
) -> dict:
    """
    Create a new equipment entity record.

    If the tag_number already exists (tags are unique), returns the existing
    entity with a note explaining the conflict — no error is thrown.

    Args:
        tag_number: Equipment tag (e.g., "PRV-201"). Must be unique.
        equip_type: Equipment type label (e.g., "valve", "pump", "sensor")
        location:   Physical location string (e.g., "Mechanical Room B")
        model:      Manufacturer model number
        serial:     Serial number

    Returns:
        {"id": str, "tag_number": str, ...} on creation (HTTP 201)
        {"note": "tag_exists", "entity": {...}} if tag already exists
    """
    async with _http_client() as client:
        resp = await client.post(
            "/api/entities",
            json={
                "tag_number": tag_number,
                "equip_type": equip_type,
                "location":   location,
                "model":      model,
                "serial":     serial,
            },
        )

        if resp.status_code == 409:
            # Tag already exists — return the existing entity with a note
            body = resp.json()
            return {
                "note":   "tag_exists",
                "entity": body.get("entity"),
            }

        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def update_entity(
    entity_id: str,
    tag_number: Optional[str] = None,
    equip_type: Optional[str] = None,
    location: Optional[str] = None,
    model: Optional[str] = None,
    serial: Optional[str] = None,
) -> dict:
    """
    Update fields on an equipment entity.

    Only the fields you provide are changed. Pass None (or omit) for fields
    you want to leave unchanged.

    Args:
        entity_id:  The entity UUID to update
        tag_number: New tag number (must remain unique across the database)
        equip_type: New equipment type
        location:   New physical location
        model:      New model number
        serial:     New serial number

    Returns:
        {"updated": true, "id": str} or {"error": str}
    """
    # Build payload with only the fields that were explicitly provided
    payload = {}
    if tag_number is not None:
        payload["tag_number"] = tag_number
    if equip_type is not None:
        payload["equip_type"] = equip_type
    if location is not None:
        payload["location"] = location
    if model is not None:
        payload["model"] = model
    if serial is not None:
        payload["serial"] = serial

    async with _http_client() as client:
        resp = await client.put(f"/api/entities/{entity_id}", json=payload)
        if resp.status_code == 404:
            return {"error": f"Entity {entity_id} not found"}
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def add_entity_log(entity_id: str, note: str) -> dict:
    """
    Add a log entry (observation note) to an equipment entity.

    Log entries are timestamped and append-only — they create an audit trail
    of observations, inspections, and actions taken on the equipment.

    Args:
        entity_id: The entity UUID
        note:      The observation text to record

    Returns:
        {"id": int, "entity_id": str, "note": str, "created_at": str}
    """
    async with _http_client() as client:
        resp = await client.post(
            f"/api/entities/{entity_id}/log",
            json={"note": note},
        )
        if resp.status_code == 404:
            return {"error": f"Entity {entity_id} not found"}
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_entity_log(entity_id: str) -> dict:
    """
    Get the full observation log for an equipment entity.

    Entries are returned in reverse chronological order (newest first).

    Args:
        entity_id: The entity UUID

    Returns:
        {"log": [{"id": int, "note": str, "created_at": str}, ...]}
    """
    async with _http_client() as client:
        resp = await client.get(f"/api/entities/{entity_id}/log")
        if resp.status_code == 404:
            return {"error": f"Entity {entity_id} not found"}
        resp.raise_for_status()
        return resp.json()


# =============================================================================
# TOOL GROUP 4 — LINKING (2 tools)
# Links connect canvas markups to equipment entity records, turning a drawing
# annotation into a structured observation on a physical asset.
# =============================================================================

@mcp.tool()
async def link_markup_to_entity(
    doc_id: int,
    markup_id: str,
    entity_id: str,
    page: int,
) -> dict:
    """
    Link a markup to an equipment entity (create an observation record).

    After linking, the markup appears in the entity's observation list in the
    properties panel. The link is idempotent — calling twice is safe.

    Args:
        doc_id:    The document ID containing the markup
        markup_id: The markup UUID
        entity_id: The equipment entity UUID to link to
        page:      The 1-based page number where the markup lives

    Returns:
        {"linked": true} or {"error": str}
    """
    async with _http_client() as client:
        resp = await client.post(
            f"/api/documents/{doc_id}/markup-entities",
            json={
                "markup_id":   markup_id,
                "entity_id":   entity_id,
                "page_number": page,
            },
        )
        if resp.status_code == 404:
            return {"error": resp.json().get("detail", "Not found")}
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_markup_entity(doc_id: int, markup_id: str) -> dict:
    """
    Get the equipment entity linked to a specific markup.

    Args:
        doc_id:    The document ID
        markup_id: The markup UUID

    Returns:
        {"entity": {...}} if linked, or {"entity": null} if not linked
    """
    async with _http_client() as client:
        resp = await client.get(
            f"/api/documents/{doc_id}/markup-entities/{markup_id}"
        )
        if resp.status_code == 404:
            return {"entity": None}
        resp.raise_for_status()
        return resp.json()


# =============================================================================
# TOOL GROUP 5 — INTELLIGENCE (3 tools)
# Higher-level AI-facing tools: full-text search, OCR tag detection, health.
# =============================================================================

@mcp.tool()
async def search(query: str) -> dict:
    """
    Full-text search across documents, markups, and entities.

    Returns ranked results from all content types in the PortolanCAST database.

    Args:
        query: Search string (e.g., "PRV-201", "pressure anomaly", "Mech Room")

    Returns:
        {"results": [...], "total": int} where each result has type and content
    """
    async with _http_client() as client:
        resp = await client.get("/api/search", params={"q": query})
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def detect_equipment_tags(doc_id: int, page: int) -> dict:
    """
    Scan a page for equipment tag patterns (e.g., "PRV-201", "AHU-03").

    Uses the stored text layer (from get_page_text) to find tags matching
    the project's equipment naming conventions. Returns each tag with its
    approximate bounding box in canvas coordinates.

    Best practice: Call get_page_text first to ensure the text layer is cached,
    then call this to get structured tag detections.

    Args:
        doc_id: The document ID
        page:   The 1-based page number to scan

    Returns:
        {"tags": [{"tag_number": str, "x": float, "y": float,
                   "width": float, "height": float, "confidence": float}]}
    """
    async with _http_client() as client:
        resp = await client.post(
            f"/api/documents/{doc_id}/pages/{page}/detect-tags"
        )
        if resp.status_code == 404:
            return {"error": f"Document {doc_id} not found"}
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_health() -> dict:
    """
    Run the PortolanCAST diagnostic health check.

    Returns the status of all system components: database, PDF engine,
    OCR engine, storage, and API server. Use this to verify the server
    is running and all dependencies are available before issuing other calls.

    Returns:
        {"status": "ok" | "degraded", "checks": {...}}
    """
    async with _http_client() as client:
        resp = await client.get("/api/health")
        resp.raise_for_status()
        return resp.json()


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    # FastMCP handles stdio transport automatically.
    # The MCP client (Claude Desktop, Claude Code) communicates via stdin/stdout.
    mcp.run()
