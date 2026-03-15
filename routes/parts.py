"""
PortolanCAST — Entity Parts Inventory & Maintenance Report Routes

Purpose:
    CRUD for parts/components attached to equipment entities, cross-entity
    parts listing, and Markdown maintenance report generation.

Security assumptions:
    - All string inputs sanitized and length-clamped
    - Entity existence validated before part creation

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from config import db

router = APIRouter()


@router.post("/api/entities/{entity_id}/parts")
async def add_entity_part(entity_id: str, request: Request):
    """
    Create a new part record for an entity.

    Request body JSON:
        part_number:  SKU or part code (required, max 128 chars)
        description:  Part name/description (required, max 500 chars)
        quantity:     Integer count (default 1, min 0)
        unit:         Unit of measure (optional, max 32 chars)
        location:     Storage location (optional, max 256 chars)
        notes:        Compatibility/vendor notes (optional, max 2000 chars)

    Returns:
        201: { status: "created", part: { id, part_number, ... } }
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    body = await request.json()

    # SECURITY: validate and sanitize inputs
    part_number = str(body.get("part_number", "")).strip()[:128]
    if not part_number:
        raise HTTPException(status_code=400, detail="part_number is required")

    description = str(body.get("description", "")).strip()[:500]
    if not description:
        raise HTTPException(status_code=400, detail="description is required")

    try:
        quantity = max(0, int(body.get("quantity", 1)))
    except (ValueError, TypeError):
        quantity = 1

    unit = str(body.get("unit", "")).strip()[:32]
    location = str(body.get("location", "")).strip()[:256]
    notes = str(body.get("notes", "")).strip()[:2000]

    part = db.add_entity_part(
        entity_id, part_number, description, quantity, unit, location, notes
    )

    return JSONResponse({
        "status": "created",
        "part": {
            "id": part["id"],
            "entity_id": part["entity_id"],
            "part_number": part["part_number"],
            "description": part["description"],
            "quantity": part["quantity"],
            "unit": part["unit"],
            "location": part["location"],
            "notes": part["notes"],
            "created_at": part["created_at"],
            "updated_at": part["updated_at"],
        }
    }, status_code=201)


@router.get("/api/entities/{entity_id}/parts")
async def get_entity_parts(entity_id: str):
    """
    List all parts for an entity.

    Returns:
        { parts: [{ id, part_number, description, quantity, ... }] }
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    parts = db.get_entity_parts(entity_id)

    return JSONResponse({
        "parts": [
            {
                "id": p["id"],
                "part_number": p["part_number"],
                "description": p["description"],
                "quantity": p["quantity"],
                "unit": p["unit"],
                "location": p["location"],
                "notes": p["notes"],
                "created_at": p["created_at"],
                "updated_at": p["updated_at"],
            }
            for p in parts
        ]
    })


@router.put("/api/entity-parts/{part_id}")
async def update_entity_part(part_id: int, request: Request):
    """
    Update a part record.

    Request body JSON — any subset of:
        part_number, description, quantity, unit, location, notes

    Returns:
        200: { status: "updated", part_id: int }
    """
    body = await request.json()

    # SECURITY: sanitize each field before passing to DB layer
    updates = {}
    if "part_number" in body:
        val = str(body["part_number"]).strip()[:128]
        if val:
            updates["part_number"] = val
    if "description" in body:
        val = str(body["description"]).strip()[:500]
        if val:
            updates["description"] = val
    if "quantity" in body:
        try:
            updates["quantity"] = max(0, int(body["quantity"]))
        except (ValueError, TypeError):
            pass
    if "unit" in body:
        updates["unit"] = str(body["unit"]).strip()[:32]
    if "location" in body:
        updates["location"] = str(body["location"]).strip()[:256]
    if "notes" in body:
        updates["notes"] = str(body["notes"]).strip()[:2000]

    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    success = db.update_entity_part(part_id, **updates)
    if not success:
        raise HTTPException(status_code=404, detail="Part not found")

    return JSONResponse({"status": "updated", "part_id": part_id})


@router.delete("/api/entity-parts/{part_id}")
async def delete_entity_part(part_id: int):
    """
    Delete a part record.

    Returns:
        200: { status: "deleted", part_id: int }
    """
    success = db.delete_entity_part(part_id)
    if not success:
        raise HTTPException(status_code=404, detail="Part not found")

    return JSONResponse({"status": "deleted", "part_id": part_id})


@router.get("/api/parts")
async def list_all_parts(entity_id: str = None):
    """
    Cross-entity parts inventory list — used by reports and inventory views.

    Query params:
        entity_id: Optional filter to one entity.

    Returns:
        { parts: [...], total: int }
    """
    parts = db.get_all_parts(entity_id)

    return JSONResponse({
        "parts": [
            {
                "id": p["id"],
                "entity_id": p["entity_id"],
                "tag_number": p["tag_number"],
                "building": p.get("building", ""),
                "entity_location": p.get("entity_location", ""),
                "part_number": p["part_number"],
                "description": p["description"],
                "quantity": p["quantity"],
                "unit": p["unit"],
                "location": p["location"],
                "notes": p["notes"],
            }
            for p in parts
        ],
        "total": len(parts),
    })


@router.get("/api/maintenance-report")
async def get_maintenance_report():
    """
    Generate a Markdown maintenance report grouped by location.

    Each entity section shows open tasks and last 3 log entries.

    Returns:
        { report: "# Maintenance Report\\n..." }
    """
    data = db.get_maintenance_report_data()

    lines = [
        "# Maintenance Report",
        f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*",
        "",
    ]

    if not data:
        lines.append("No equipment entities in the database.")
        return JSONResponse({"report": "\n".join(lines)})

    # Group by building, then by location within each building
    buildings = {}
    for item in data:
        bldg = item["entity"].get("building") or "Unspecified Building"
        if bldg not in buildings:
            buildings[bldg] = {}
        loc = item["entity"]["location"] or "Unspecified Location"
        if loc not in buildings[bldg]:
            buildings[bldg][loc] = []
        buildings[bldg][loc].append(item)

    for bldg, locations in sorted(buildings.items()):
        lines.append(f"## {bldg}")
        lines.append("")

        for loc, items in sorted(locations.items()):
            if loc != bldg:
                lines.append(f"### {loc}")
                lines.append("")

            for item in items:
                entity = item["entity"]
                tasks = item["open_tasks"]
                logs = item["recent_log"]

                lines.append(f"#### {entity['tag_number']}")
                if entity["equip_type"]:
                    lines.append(f"**Type:** {entity['equip_type']}")
            lines.append("")

            # Open tasks
            if tasks:
                lines.append("**Open Tasks:**")
                for t in tasks:
                    priority_marker = ""
                    if t["priority"] == "urgent":
                        priority_marker = " [URGENT]"
                    elif t["priority"] == "high":
                        priority_marker = " [HIGH]"
                    due = f" (due: {t['due_date']})" if t.get("due_date") else ""
                    lines.append(f"- [ ] {t['title']}{priority_marker}{due}")
                lines.append("")

            # Recent log entries
            if logs:
                lines.append("**Recent Log:**")
                for entry in logs:
                    date = (entry.get("created_at") or "")[:10]
                    lines.append(f"- {date}: {entry['note']}")
                lines.append("")

        lines.append("---")
        lines.append("")

    return JSONResponse({"report": "\n".join(lines)})
