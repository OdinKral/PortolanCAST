"""
PortolanCAST — Pattern System Routes (Haystack-Inspired Semantic Modeling)

Purpose:
    API endpoints for the pattern system: pattern definitions, controlled tag
    vocabulary, and entity tag assignment.  Patterns are blueprints for
    equipment types — they define what tags, ISA symbols, ports, and views
    an entity gets when created from the pattern.

    Tag vocabulary is the controlled dictionary of Haystack-inspired markers.
    Only vocabulary tags can be assigned to entities, preventing the "tag soup"
    problem from free-form tagging.

Security assumptions:
    - Pattern definitions are read-only for built-in patterns (is_builtin=1)
    - Tag vocabulary inserts are validated against allowed characters
    - All string inputs sanitized and length-clamped

Author: PortolanCAST
Version: 1.0.0
Date: 2026-03-26
"""

import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from config import db

router = APIRouter()

# Tag names must be lowercase alphanumeric + underscore, 2-32 chars.
# SECURITY: prevents injection via tag names in SQL or JSON contexts.
_TAG_NAME_PATTERN = re.compile(r'^[a-z][a-z0-9_]{1,31}$')


# =============================================================================
# PATTERN ENDPOINTS
# =============================================================================

@router.get("/api/patterns")
async def list_patterns(type: str = None, category: str = None):
    """
    List all pattern definitions, optionally filtered.

    Query params:
        type:     Filter by 'component' or 'system'.
        category: Filter by category ('sensor', 'controller', 'actuator', etc.).

    Returns:
        200: List of pattern dicts with parsed JSON fields.
    """
    patterns = db.get_patterns(pattern_type=type, category=category)
    return JSONResponse(content=patterns)


@router.get("/api/patterns/{pattern_id}")
async def get_pattern(pattern_id: str):
    """
    Get a single pattern definition by ID.

    Returns:
        200: Pattern dict with parsed JSON fields.
        404: Pattern not found.
    """
    pattern = db.get_pattern(pattern_id)
    if not pattern:
        raise HTTPException(status_code=404, detail="Pattern not found")
    return JSONResponse(content=pattern)


@router.get("/api/patterns/{pattern_id}/members")
async def get_pattern_members(pattern_id: str):
    """
    Get the component members of a system pattern.

    Returns the component patterns that compose this system pattern,
    with their roles and sort order.

    Returns:
        200: List of member dicts.
        404: System pattern not found.
    """
    pattern = db.get_pattern(pattern_id)
    if not pattern:
        raise HTTPException(status_code=404, detail="Pattern not found")
    if pattern.get("type") != "system":
        raise HTTPException(status_code=400, detail="Not a system pattern")

    members = db.get_system_pattern_members(pattern_id)
    return JSONResponse(content=members)


# =============================================================================
# TAG VOCABULARY ENDPOINTS
# =============================================================================

@router.get("/api/tag-vocab")
async def list_tag_vocab(category: str = None):
    """
    List all controlled vocabulary tags, optionally filtered by category.

    Query params:
        category: Filter by 'medium', 'measurement', 'function', or 'equipment'.

    Returns:
        200: List of tag dicts with tag, category, description.
    """
    tags = db.get_tag_vocab(category=category)
    return JSONResponse(content=tags)


# =============================================================================
# ENTITY TAG ENDPOINTS
# =============================================================================

@router.get("/api/entities/{entity_id}/tags")
async def get_entity_tags(entity_id: str):
    """
    Get all structured tags assigned to an entity.

    Returns:
        200: List of tag dicts with tag, source, category, description.
        404: Entity not found.
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    tags = db.get_entity_tags(entity_id)
    return JSONResponse(content=tags)


@router.post("/api/entities/{entity_id}/tags")
async def add_entity_tags(entity_id: str, request: Request):
    """
    Manually add structured tags to an entity from the controlled vocabulary.

    Body:
        { "tags": ["tag1", "tag2", ...] }

    Returns:
        200: Updated list of entity tags.
        400: Invalid tag name or tag not in vocabulary.
        404: Entity not found.
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    body = await request.json()
    tags = body.get("tags", [])

    if not isinstance(tags, list) or not tags:
        raise HTTPException(status_code=400, detail="tags must be a non-empty list")

    # SECURITY: validate tag names against allowed pattern
    for tag in tags:
        if not isinstance(tag, str) or not _TAG_NAME_PATTERN.match(tag):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid tag name: '{tag}'. Must be lowercase, 2-32 chars."
            )

    db.assign_entity_tags(entity_id, tags, source='manual')

    # Return updated tag list
    updated_tags = db.get_entity_tags(entity_id)
    return JSONResponse(content=updated_tags)


@router.delete("/api/entities/{entity_id}/tags")
async def remove_entity_tags(entity_id: str, request: Request):
    """
    Remove specific tags from an entity.

    Body:
        { "tags": ["tag1", "tag2", ...] }

    Returns:
        200: Updated list of entity tags.
        404: Entity not found.
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    body = await request.json()
    tags = body.get("tags", [])

    if not isinstance(tags, list) or not tags:
        raise HTTPException(status_code=400, detail="tags must be a non-empty list")

    db.remove_entity_tags(entity_id, tags)

    updated_tags = db.get_entity_tags(entity_id)
    return JSONResponse(content=updated_tags)


# =============================================================================
# PATTERN-BASED QUERY ENDPOINTS
# =============================================================================

@router.get("/api/entities/by-tags")
async def find_entities_by_tags(tags: str, match_all: bool = True):
    """
    Find entities that have specific structured tags.

    Query params:
        tags:      Comma-separated list of tag names (e.g., "temp,sensor").
        match_all: If true (default), entity must have ALL tags. If false, ANY tag.

    Returns:
        200: List of matching entity dicts.
    """
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    if not tag_list:
        raise HTTPException(status_code=400, detail="At least one tag required")

    results = db.find_entities_by_tags(tag_list, match_all=match_all)
    return JSONResponse(content=results)


@router.get("/api/patterns/{pattern_id}/next-isa")
async def get_next_isa_number(pattern_id: str, building: str = ''):
    """
    Get the next available ISA sequence number for a pattern in a building.

    Used by the frontend to auto-generate tag_number when creating entities
    from patterns (e.g., "TT-1", "TT-2", ...).

    Query params:
        building: Building scope for numbering. Default is '' (unscoped).

    Returns:
        200: { "isa_prefix": "TT-", "next_number": 3, "suggested_tag": "TT-3" }
        404: Pattern not found.
    """
    pattern = db.get_pattern(pattern_id)
    if not pattern:
        raise HTTPException(status_code=404, detail="Pattern not found")

    isa_prefix = pattern.get("isa_prefix", "")
    if not isa_prefix:
        # System patterns or patterns without ISA mapping
        return JSONResponse(content={
            "isa_prefix": "",
            "next_number": 0,
            "suggested_tag": ""
        })

    next_num = db.get_next_isa_number(isa_prefix, building)
    return JSONResponse(content={
        "isa_prefix": isa_prefix,
        "next_number": next_num,
        "suggested_tag": f"{isa_prefix}{next_num}"
    })
