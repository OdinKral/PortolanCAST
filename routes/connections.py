"""
Entity Connections API — Haystack Phase 2.

Directed edges between entities: sensor → controller → actuator.
Each connection has a type (signal/physical/logical), optional port
names, and an optional Fabric.js line representation for canvas rendering.

Endpoints:
    POST   /api/connections                              — create connection
    GET    /api/connections/{id}                          — single connection
    PUT    /api/connections/{id}                          — update connection
    DELETE /api/connections/{id}                          — delete connection
    GET    /api/entities/{entity_id}/connections          — entity's in/out edges
    GET    /api/documents/{doc_id}/pages/{page}/connections — page connections

Threat model:
    - source_id/target_id are validated as existing entity UUIDs via FK
    - connection_type is allowlisted (signal/physical/logical)
    - Self-loops are rejected at the DB layer
    - Duplicate (source, target, ports) prevented by UNIQUE constraint

Author: PAI (Haystack Phase 2)
Version: 1.0.0
Date: 2026-03-26
"""

import uuid
import sqlite3

from fastapi import APIRouter, HTTPException, Request

from config import db

# =============================================================================
# ROUTER
# =============================================================================

router = APIRouter()


# =============================================================================
# CREATE CONNECTION
# =============================================================================

@router.post("/api/connections")
async def create_connection(request: Request):
    """
    Create a directed connection between two entities.

    Body JSON:
        source_id (str, required): UUID of the source entity.
        target_id (str, required): UUID of the target entity.
        connection_type (str): 'signal' | 'physical' | 'logical'. Default 'signal'.
        source_port (str): Port name on source. Default 'output'.
        target_port (str): Port name on target. Default 'input'.
        label (str): Optional midpoint label.
        doc_id (int): Document where the visual line lives.
        page_number (int): Page number within the document.
        fabric_data (str): JSON of the Fabric.js line object.

    Returns:
        201 with the created connection dict.
        400 if source_id or target_id missing, or self-loop attempted.
        404 if source or target entity not found.
        409 if duplicate connection (same source, target, ports).
    """
    body = await request.json()

    source_id = body.get("source_id", "").strip()
    target_id = body.get("target_id", "").strip()

    if not source_id or not target_id:
        raise HTTPException(400, "source_id and target_id are required")

    connection_id = str(uuid.uuid4())

    try:
        connection = db.create_connection(
            connection_id=connection_id,
            source_id=source_id,
            target_id=target_id,
            connection_type=body.get("connection_type", "signal"),
            source_port=body.get("source_port", "output"),
            target_port=body.get("target_port", "input"),
            label=body.get("label", ""),
            doc_id=body.get("doc_id"),
            page_number=body.get("page_number"),
            fabric_data=body.get("fabric_data", ""),
        )
    except ValueError as e:
        # Self-loop or invalid connection_type
        raise HTTPException(400, str(e))
    except sqlite3.IntegrityError as e:
        error_msg = str(e).lower()
        if "unique" in error_msg:
            raise HTTPException(
                409,
                "Connection already exists between these entities with these ports",
            )
        # FK violation — entity not found
        raise HTTPException(404, "Source or target entity not found")

    return {"connection": connection, "status": "created"}


# =============================================================================
# READ CONNECTIONS
# =============================================================================

@router.get("/api/connections/{connection_id}")
async def get_connection(connection_id: str):
    """Fetch a single connection by ID."""
    connection = db.get_connection(connection_id)
    if not connection:
        raise HTTPException(404, "Connection not found")
    return {"connection": connection}


@router.get("/api/entities/{entity_id}/connections")
async def get_entity_connections(entity_id: str):
    """
    Fetch all connections for an entity (both directions).

    Returns outgoing (entity is source) and incoming (entity is target)
    lists, each enriched with the connected entity's tag and building.
    """
    # Verify entity exists
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(404, "Entity not found")

    result = db.get_entity_connections(entity_id)
    return {
        "entity_id": entity_id,
        "outgoing": result["outgoing"],
        "incoming": result["incoming"],
        "total": len(result["outgoing"]) + len(result["incoming"]),
    }


@router.get("/api/documents/{doc_id}/pages/{page}/connections")
async def get_page_connections(doc_id: int, page: int):
    """
    Fetch all connections drawn on a specific document page.

    Used to render connection lines when a page loads.
    """
    connections = db.get_connections_for_page(doc_id, page)
    return {"connections": connections, "count": len(connections)}


# =============================================================================
# UPDATE CONNECTION
# =============================================================================

@router.put("/api/connections/{connection_id}")
async def update_connection(connection_id: str, request: Request):
    """
    Update mutable fields on a connection.

    Body JSON (all optional):
        connection_type, label, source_port, target_port,
        fabric_data, doc_id, page_number.
    """
    # Verify exists
    existing = db.get_connection(connection_id)
    if not existing:
        raise HTTPException(404, "Connection not found")

    body = await request.json()

    try:
        updated = db.update_connection(connection_id, **body)
    except ValueError as e:
        raise HTTPException(400, str(e))

    return {"connection": updated}


# =============================================================================
# DELETE CONNECTION
# =============================================================================

@router.delete("/api/connections/{connection_id}")
async def delete_connection(connection_id: str):
    """Delete a connection by ID."""
    deleted = db.delete_connection(connection_id)
    if not deleted:
        raise HTTPException(404, "Connection not found")
    return {"status": "deleted", "id": connection_id}
