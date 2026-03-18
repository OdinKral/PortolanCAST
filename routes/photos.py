"""
PortolanCAST — Markup Photo Attachment Routes

Purpose:
    Upload, list, and delete photo attachments linked to individual markup
    objects via their markupId UUID.

Security assumptions:
    - File extension validated against allowlist
    - UUID filenames prevent path traversal and collisions
    - Photos scoped to document IDs for access control
    - markup_id stored as text, never executed

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

from config import db, PHOTOS_DIR, MAX_PHOTO_SIZE, ALLOWED_PHOTO_EXTENSIONS

router = APIRouter()


@router.post("/api/documents/{doc_id}/markup-photos")
async def upload_markup_photo(
    doc_id: int,
    markup_id: str = Form(""),
    description: str = Form(""),
    photo: UploadFile = File(...)
):
    """
    Attach a photo to a specific markup object.

    Form fields:
        markup_id:   UUID string from obj.markupId on the Fabric canvas object
        description: Optional caption (clamped to 500 chars)
        photo:       Image file (JPEG/PNG/GIF/WEBP, max 20MB)

    Returns:
        { photo_id, markup_id, url, description, created_at }

    Security:
        - markup_id stored as text, never executed
        - File extension validated against allowlist
        - UUID filename prevents path traversal and name collisions
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # SECURITY: validate and clamp markup_id
    markup_id = str(markup_id).strip()[:128]
    if not markup_id:
        raise HTTPException(status_code=400, detail="markup_id is required")

    # SECURITY: validate file extension
    if not photo.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    ext = Path(photo.filename).suffix.lower()
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Only image files allowed ({', '.join(ALLOWED_PHOTO_EXTENSIONS)})"
        )

    content = await photo.read()

    # SECURITY: enforce size limit
    if len(content) > MAX_PHOTO_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Photo too large (max {MAX_PHOTO_SIZE // 1024 // 1024}MB)"
        )

    # Save with UUID filename — prevents path traversal and name collisions
    photo_id = uuid.uuid4().hex
    filename = f"{photo_id}{ext}"
    save_path = PHOTOS_DIR / filename

    with open(save_path, "wb") as f:
        f.write(content)

    description = str(description).strip()[:500]

    db.add_markup_photo(photo_id, doc_id, markup_id, str(save_path), description)

    return JSONResponse({
        "photo_id": photo_id,
        "markup_id": markup_id,
        "url": f"/data/photos/{filename}",
        "description": description,
        "created_at": datetime.utcnow().isoformat() + "Z",
    })


@router.get("/api/documents/{doc_id}/markup-photos/{markup_id}")
async def get_markup_photos(doc_id: int, markup_id: str):
    """
    Return all photos attached to a specific markup object.

    Returns:
        { "photos": [{ photo_id, url, description, created_at }, ...] }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    photos = db.get_markup_photos(doc_id, markup_id)

    result = []
    for p in photos:
        fname = Path(p["file_path"]).name
        result.append({
            "photo_id": p["photo_id"],
            "url": f"/data/photos/{fname}",
            "description": p["description"],
            "created_at": p["created_at"],
        })

    return JSONResponse({"photos": result})


@router.delete("/api/documents/{doc_id}/markup-photos/{photo_id}")
async def delete_markup_photo(doc_id: int, photo_id: str):
    """
    Delete a photo attachment — removes both the DB record and the image file.

    Scoped to doc_id to prevent cross-document deletion attacks.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Fetch file path BEFORE deleting DB record
    file_path = db.get_markup_photo_path(doc_id, photo_id)
    if not file_path:
        raise HTTPException(status_code=404, detail="Photo not found")

    # Delete DB record first — ensures no zombie entry if file deletion fails
    db.delete_markup_photo(doc_id, photo_id)

    # Best-effort file deletion
    try:
        Path(file_path).unlink(missing_ok=True)
    except OSError as e:
        print(f"[WARN] Could not delete photo file {file_path}: {e}")

    return JSONResponse({"status": "deleted", "photo_id": photo_id})
