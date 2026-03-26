"""
PortolanCAST — Equipment Entity Registry Routes (Stage 3)

Purpose:
    CRUD for equipment entities, maintenance log entries, markup-entity linking,
    and OCR-based tag detection. Entities are the core of the campus equipment
    database — each entity represents a physical piece of equipment identified
    by a tag number (e.g., PRV-201, AHU-3).

Security assumptions:
    - All string inputs sanitized and length-clamped
    - Entity IDs are UUIDs generated server-side
    - Tag detection uses compiled regex pattern, no user-controlled regex

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import json
import re
import sqlite3
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from config import db

router = APIRouter()

# Tag pattern for OCR detection: 2-5 uppercase letters, dash, 1-4 digits + optional letter.
# Matches: PRV-201, AHU-3, VFD-12A, VAV-102, FCU-1, PUMP-3B
# Does NOT match: A-1 (prefix too short), ABCDEF-1 (prefix too long)
_TAG_PATTERN = re.compile(r'\b([A-Z]{2,5}-\d{1,4}[A-Z]?)\b')


@router.post("/api/entities")
async def create_entity(request: Request):
    """
    Create a new equipment entity, optionally from a pattern.

    When pattern_id is provided:
      - equip_type is auto-populated from the pattern name (if not explicitly set)
      - tag_number is auto-generated from ISA prefix + next sequence (if not set)
      - Haystack tags are auto-assigned from the pattern definition
      - pattern_id is stored on the entity for future lookups

    Returns 409 if (building, tag_number) already exists, with the existing
    entity in the response body so the frontend can show a merge prompt.

    Body:
        { tag_number?, building?, equip_type?, model?, serial?, location?, pattern_id? }

    Returns:
        201: { id, tag_number, building, equip_type, model, serial, location, pattern_id,
               created_at, tags: [...] }
        409: { detail: "tag_exists", entity: {...existing entity...} }
    """
    body = await request.json()

    building   = str(body.get("building", "")).strip()[:256]
    equip_type = str(body.get("equip_type", "")).strip()[:256]
    model      = str(body.get("model", "")).strip()[:256]
    serial     = str(body.get("serial", "")).strip()[:256]
    location   = str(body.get("location", "")).strip()[:512]
    pattern_id = str(body.get("pattern_id", "")).strip() or None

    # Pattern-aware entity creation: auto-fill fields from pattern definition
    pattern = None
    pattern_tags = []
    if pattern_id:
        pattern = db.get_pattern(pattern_id)
        if not pattern:
            raise HTTPException(status_code=400, detail="Invalid pattern_id")

        # Auto-fill equip_type from pattern name if not explicitly provided
        if not equip_type:
            equip_type = pattern["name"]

        # Extract tags from pattern for auto-assignment after entity creation
        pattern_tags = pattern.get("tags", [])
        if isinstance(pattern_tags, str):
            pattern_tags = json.loads(pattern_tags)

    # tag_number: required unless pattern can auto-generate it
    tag_number = str(body.get("tag_number", "")).strip()[:128]
    if not tag_number:
        if pattern and pattern.get("isa_prefix"):
            # Auto-generate ISA tag: e.g., "TT-1", "TT-2"
            next_num = db.get_next_isa_number(pattern["isa_prefix"], building)
            tag_number = f"{pattern['isa_prefix']}{next_num}"
        else:
            raise HTTPException(status_code=400, detail="tag_number is required")

    entity_id = uuid.uuid4().hex

    try:
        entity = db.create_entity(
            entity_id, tag_number, building, equip_type, model, serial, location
        )

        # Store pattern_id on the entity (migration added this nullable column)
        if pattern_id:
            db.update_entity(entity_id, pattern_id=pattern_id)
            entity["pattern_id"] = pattern_id

            # Auto-assign structured tags from the pattern definition
            if pattern_tags:
                db.assign_entity_tags(entity_id, pattern_tags, source='pattern')

        # Include tags in the creation response
        tags = db.get_entity_tags(entity_id)
        entity["tags"] = tags

        return JSONResponse(status_code=201, content=entity)
    except sqlite3.IntegrityError:
        existing = db.get_entity_by_tag(tag_number, building=building)
        return JSONResponse(
            status_code=409,
            content={"detail": "tag_exists", "entity": existing}
        )


@router.get("/api/entities")
async def list_entities(equip_type: str = None, location: str = None,
                        building: str = None):
    """
    Return all entities, optionally filtered by equip_type, location, or building.

    Returns:
        { entities: [...], total: N }
    """
    entities = db.get_all_entities(equip_type=equip_type, location=location,
                                   building=building)
    return JSONResponse({"entities": entities, "total": len(entities)})


@router.get("/api/entities/by-tag/{tag_number:path}")
async def get_entity_by_tag(tag_number: str):
    """
    Look up an entity by its tag number (the natural key).

    Returns:
        { entity: {...} }  or  404
    """
    entity = db.get_entity_by_tag(tag_number)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")
    return JSONResponse({"entity": entity})


@router.get("/api/entities/{entity_id}")
async def get_entity(entity_id: str):
    """
    Return a full entity dossier: fields + log entries + markup count + tags + pattern.

    Returns:
        { entity: {...}, log: [...], markup_count: N, tags: [...], pattern: {...} | null }
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    log = db.get_entity_log(entity_id)
    count = db.get_entity_markup_count(entity_id)
    tags = db.get_entity_tags(entity_id)

    # Include pattern info if entity was created from a pattern
    pattern = None
    if entity.get("pattern_id"):
        pattern = db.get_pattern(entity["pattern_id"])

    return JSONResponse({
        "entity": entity, "log": log, "markup_count": count,
        "tags": tags, "pattern": pattern
    })


@router.put("/api/entities/{entity_id}")
async def update_entity(entity_id: str, request: Request):
    """
    Partial update of an entity's fields.

    Body:
        { equip_type?, model?, serial?, location?, tag_number?, building? }

    Returns:
        { entity: {...updated...} }
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    body = await request.json()

    # SECURITY: sanitize each field; only known fields reach db.update_entity
    allowed = ['tag_number', 'building', 'equip_type', 'model', 'serial', 'location', 'pattern_id']
    updates = {}
    for key in allowed:
        if key in body:
            updates[key] = str(body[key]).strip()[:512]

    try:
        db.update_entity(entity_id, **updates)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="tag_number already in use")

    updated = db.get_entity(entity_id)
    return JSONResponse({"entity": updated})


@router.delete("/api/entities/{entity_id}")
async def delete_entity(entity_id: str):
    """
    Delete an entity and cascade to its log and markup links.

    Returns:
        { deleted: true }  or  404
    """
    deleted = db.delete_entity(entity_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Entity not found")
    return JSONResponse({"deleted": True})


@router.post("/api/entities/{entity_id}/log")
async def add_entity_log(entity_id: str, request: Request):
    """
    Append a maintenance/inspection log entry to an entity.

    Entries are immutable once written — this is intentional (audit trail).

    Body:
        { note: "Replaced valve stem. Torqued to 45 ft-lb." }

    Returns:
        201: { id, entity_id, note, created_at }
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    body = await request.json()
    note = str(body.get("note", "")).strip()[:4096]
    if not note:
        raise HTTPException(status_code=400, detail="note is required")

    log_id = db.add_entity_log(entity_id, note)

    entries = db.get_entity_log(entity_id)
    created = next((e for e in entries if e["id"] == log_id), None)
    return JSONResponse(status_code=201, content=created or {"id": log_id, "entity_id": entity_id, "note": note})


@router.get("/api/entities/{entity_id}/log")
async def get_entity_log(entity_id: str):
    """
    Return all log entries for an entity, newest-first.

    Returns:
        { log: [...entries newest-first...] }
    """
    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")
    log = db.get_entity_log(entity_id)
    return JSONResponse({"log": log})


@router.get("/api/entities/{entity_id}/markups")
async def get_entity_markups(entity_id: str):
    """
    Return all markups linked to an entity, across ALL documents.

    Returns:
        { markups: [{ markup_id, doc_id, doc_name, page_number }] }
    """
    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")
    markups = db.get_entity_markups(entity_id)
    return JSONResponse({"markups": markups})


@router.post("/api/documents/{doc_id}/markup-entities")
async def link_markup_entity(doc_id: int, request: Request):
    """
    Link a markup UUID to an entity (create an observation record).

    Idempotent — calling twice with the same markup_id + entity_id is safe.

    Body:
        { markup_id, entity_id, page_number }

    Returns:
        201: { linked: true }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()

    markup_id = str(body.get("markup_id", "")).strip()[:128]
    entity_id = str(body.get("entity_id", "")).strip()[:128]
    page_number = int(body.get("page_number", 0))

    if not markup_id:
        raise HTTPException(status_code=400, detail="markup_id is required")
    if not entity_id:
        raise HTTPException(status_code=400, detail="entity_id is required")

    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")

    db.link_markup_entity(markup_id, entity_id, doc_id, page_number)
    return JSONResponse(status_code=201, content={"linked": True})


@router.delete("/api/documents/{doc_id}/markup-entities/{markup_id}")
async def unlink_markup_entity(doc_id: int, markup_id: str):
    """
    Remove the link between a markup and its entity.

    Returns:
        { unlinked: true }  or  404
    """
    if not db.get_document(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")

    entity = db.get_markup_entity(markup_id)
    if not entity:
        raise HTTPException(status_code=404, detail="No entity linked to this markup")

    db.unlink_markup_entity(markup_id, entity["id"])
    return JSONResponse({"unlinked": True})


@router.get("/api/documents/{doc_id}/markup-entities/{markup_id}")
async def get_markup_entity(doc_id: int, markup_id: str):
    """
    Return the entity linked to a specific markup, or { entity: null }.

    Returns:
        { entity: {...} }  or  { entity: null }
    """
    if not db.get_document(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")

    entity = db.get_markup_entity(markup_id)
    return JSONResponse({"entity": entity})


@router.post("/api/documents/{doc_id}/pages/{page_number}/detect-tags")
async def detect_tags(doc_id: int, page_number: int):
    """
    Scan a page's stored text layer for equipment tag patterns.

    Returns:
        { tags: [{ tag_number, x, y, width, height, confidence }] }
    """
    if not db.get_document(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")

    text_layer_json = db.get_document_setting(doc_id, f"text_layer_{page_number}")
    if not text_layer_json:
        return JSONResponse({"tags": []})

    try:
        text_layer = json.loads(text_layer_json)
    except Exception:
        return JSONResponse({"tags": []})

    found_tags = []
    if isinstance(text_layer, list):
        for span in text_layer:
            text = str(span.get("text", ""))
            matches = _TAG_PATTERN.findall(text)
            for match in matches:
                found_tags.append({
                    "tag_number": match,
                    "x": span.get("x", 0),
                    "y": span.get("y", 0),
                    "width": span.get("width", 0),
                    "height": span.get("height", 0),
                    "confidence": 1.0,
                })

    return JSONResponse({"tags": found_tags})
