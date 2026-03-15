"""
PortolanCAST — HTML Page Routes

Purpose:
    Serves the HTML template pages (home and editor). These are the only
    routes that return full HTML responses rather than JSON API data.

Security assumptions:
    - Templates are server-side Jinja2 — no user-controlled template injection
    - Document IDs are integers validated by FastAPI path typing

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

from fastapi import APIRouter, HTTPException, Request

from config import db, templates

router = APIRouter()


@router.get("/")
async def home(request: Request):
    """
    Home page — shows recent documents and upload option.
    """
    recent = db.get_recent_documents(limit=10)
    return templates.TemplateResponse("editor.html", {
        "request": request,
        "recent_documents": recent
    })


@router.get("/edit/{doc_id}")
async def edit_document(request: Request, doc_id: int):
    """
    Editor page — opens a specific document for viewing/markup.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Update last-opened timestamp
    db.touch_document(doc_id)

    return templates.TemplateResponse("editor.html", {
        "request": request,
        "document": doc,
        "recent_documents": db.get_recent_documents(limit=10)
    })
