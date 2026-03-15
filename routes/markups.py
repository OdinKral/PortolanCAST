"""
PortolanCAST — Markup Persistence Routes

Purpose:
    Save and load Fabric.js canvas JSON for document pages. Supports both
    PUT (normal fetch) and POST (sendBeacon on page unload) for save.

Security assumptions:
    - JSON body stored as-is — no code execution
    - Document IDs validated against DB before write
    - Size limited by FastAPI default body size limits

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from config import db

router = APIRouter()


@router.api_route("/api/documents/{doc_id}/markups", methods=["PUT", "POST"])
async def save_markups(doc_id: int, request: Request):
    """
    Save all page markups for a document.

    Accepts both PUT (normal fetch) and POST (sendBeacon on page unload).
    Expects JSON body: { "pages": { "0": {fabricJSON}, "2": {fabricJSON}, ... } }

    Security:
        - Validates document exists before saving
        - JSON body is stored as-is — no code execution
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()

    # SECURITY: validate expected structure
    pages = body.get("pages")
    if not isinstance(pages, dict):
        raise HTTPException(status_code=400, detail="Expected {pages: {pageNum: fabricJSON}}")

    db.save_markups(doc_id, pages)

    return JSONResponse({"status": "saved", "id": doc_id, "page_count": len(pages)})


@router.get("/api/documents/{doc_id}/markups")
async def get_markups(doc_id: int):
    """
    Load all page markups for a document.

    Returns: { "pages": { "0": {fabricJSON}, ... } }
    Empty pages object if no markups exist.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    markups = db.get_markups(doc_id)

    # Convert int keys to string keys for JSON transport consistency
    pages = {str(k): v for k, v in markups.items()}

    return JSONResponse({"pages": pages})
