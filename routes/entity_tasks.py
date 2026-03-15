"""
PortolanCAST — Entity Task Routes

Purpose:
    CRUD for maintenance/work tasks assigned to entities. Tasks have title,
    priority, due date, notes, and status (open/in_progress/done).
    Also provides a cross-entity task list for maintenance reports.

Security assumptions:
    - All string inputs sanitized and length-clamped
    - Entity existence validated before task creation

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from config import db

router = APIRouter()


@router.post("/api/entities/{entity_id}/tasks")
async def create_entity_task(entity_id: str, request: Request):
    """
    Create a maintenance/work task for an entity.

    Body:
        { title, priority?, due_date?, notes? }

    Returns:
        201: { task: {...} }
    """
    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")

    body = await request.json()

    # SECURITY: validate and sanitize inputs
    title = str(body.get("title", "")).strip()[:500]
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    priority = str(body.get("priority", "normal")).strip()
    due_date = body.get("due_date")
    if due_date:
        due_date = str(due_date).strip()[:20]
    notes = str(body.get("notes", "")).strip()[:2000]

    task = db.create_task(entity_id, title, priority=priority,
                          due_date=due_date, notes=notes)
    return JSONResponse(status_code=201, content={"task": task})


@router.get("/api/entities/{entity_id}/tasks")
async def get_entity_tasks(entity_id: str, request: Request):
    """
    List tasks for an entity, optionally filtered by status query param.

    Query params:
        ?status=open|in_progress|done  (optional)

    Returns:
        { tasks: [...] }
    """
    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")

    status_filter = request.query_params.get("status")
    tasks = db.get_tasks(entity_id, status=status_filter)
    return JSONResponse({"tasks": tasks})


@router.put("/api/tasks/{task_id}")
async def update_task(task_id: int, request: Request):
    """
    Update a task's fields (title, status, priority, due_date, notes).

    Body:
        { title?, status?, priority?, due_date?, notes? }

    Returns:
        { updated: true }  or  404
    """
    body = await request.json()

    # SECURITY: sanitize string fields
    fields = {}
    if "title" in body:
        fields["title"] = str(body["title"]).strip()[:500]
    if "status" in body:
        fields["status"] = str(body["status"]).strip()
    if "priority" in body:
        fields["priority"] = str(body["priority"]).strip()
    if "due_date" in body:
        val = body["due_date"]
        fields["due_date"] = str(val).strip()[:20] if val else None
    if "notes" in body:
        fields["notes"] = str(body["notes"]).strip()[:2000]

    if not fields:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    success = db.update_task(task_id, **fields)
    if not success:
        raise HTTPException(status_code=404, detail="Task not found")

    return JSONResponse({"updated": True})


@router.delete("/api/tasks/{task_id}")
async def delete_task(task_id: int):
    """
    Delete a task.

    Returns:
        { deleted: true }  or  404
    """
    success = db.delete_task(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="Task not found")
    return JSONResponse({"deleted": True})


@router.get("/api/tasks")
async def get_all_tasks(request: Request):
    """
    Cross-entity task list — for maintenance report generation.

    Query params:
        ?status=open|in_progress|done  (optional)

    Returns:
        { tasks: [...] }  — each task includes entity tag_number and location.
    """
    status_filter = request.query_params.get("status")
    tasks = db.get_all_tasks(status=status_filter)
    return JSONResponse({"tasks": tasks})
