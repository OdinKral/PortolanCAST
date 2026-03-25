"""
PortolanCAST — Entity Photo Routes (Sprint 1 Quick Capture)

Purpose:
    Upload, list, and delete photos attached directly to entities (not via
    markup). Photos are stored in PHOTOS_DIR/entities/ with UUID filenames.

Security assumptions:
    - File extension validated against allowlist
    - UUID filenames prevent path traversal
    - Size limit enforced before write

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import uuid
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse

from config import db, ENTITY_PHOTOS_DIR, MAX_PHOTO_SIZE, ALLOWED_PHOTO_EXTENSIONS

router = APIRouter()


@router.post("/api/entities/{entity_id}/photos")
async def upload_entity_photo(entity_id: str, file: UploadFile = File(...)):
    """
    Upload a photo directly to an entity (not via markup).

    Returns:
        201: { photo: { id, entity_id, filename, caption, created_at, url } }
    """
    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")

    # SECURITY: validate file extension
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"File type not allowed. Allowed: {', '.join(ALLOWED_PHOTO_EXTENSIONS)}"
        )

    # SECURITY: check file size
    contents = await file.read()
    if len(contents) > MAX_PHOTO_SIZE:
        raise HTTPException(status_code=400, detail="Photo exceeds 20MB limit")

    # Generate unique filename — UUID prevents collisions and path traversal
    stored_name = f"{uuid.uuid4().hex}{ext}"
    stored_path = ENTITY_PHOTOS_DIR / stored_name

    with open(stored_path, "wb") as f:
        f.write(contents)

    photo = db.add_entity_photo(entity_id, stored_name)
    photo["url"] = f"/data/photos/entities/{stored_name}"
    return JSONResponse(status_code=201, content={"photo": photo})


@router.get("/api/entities/{entity_id}/photos")
async def get_entity_photos(entity_id: str):
    """
    List all photos for an entity, with URLs.

    Returns:
        { photos: [{ id, entity_id, filename, caption, created_at, url }] }
    """
    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")

    photos = db.get_entity_photos(entity_id)
    for p in photos:
        p["url"] = f"/data/photos/entities/{p['filename']}"
    return JSONResponse({"photos": photos})


@router.delete("/api/entity-photos/{photo_id}")
async def delete_entity_photo(photo_id: int):
    """
    Delete an entity photo record and its file on disk.

    Returns:
        { deleted: true }  or  404
    """
    photo = db.delete_entity_photo(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    # Delete the file from disk (best-effort — DB record already removed)
    file_path = ENTITY_PHOTOS_DIR / photo["filename"]
    try:
        if file_path.exists():
            file_path.unlink()
    except OSError as e:
        print(f"[WARN] Failed to delete entity photo file {file_path}: {e}")

    return JSONResponse({"deleted": True})
