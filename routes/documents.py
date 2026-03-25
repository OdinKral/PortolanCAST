"""
PortolanCAST — Document CRUD Routes

Purpose:
    PDF upload, blank document creation, page addition, document info/listing,
    thumbnail rendering, deletion, and PDF export with annotations.

Security assumptions:
    - File uploads restricted to PDF format with magic byte validation
    - UUID filenames prevent path traversal and collisions
    - Document IDs validated against DB before any file operation

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import uuid
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from fastapi.responses import Response, JSONResponse

from config import (
    db, pdf_engine, PROJECTS_DIR, PAGE_SIZES,
    MAX_UPLOAD_SIZE, ALLOWED_EXTENSIONS,
)

router = APIRouter()


@router.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    """
    Upload a PDF file.

    Validates the file is a PDF, saves it to the projects directory,
    extracts metadata, and registers it in the database.

    Returns:
        JSON with document ID and metadata for immediate viewing.
    """
    # SECURITY: Validate file extension
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Only PDF files are allowed (got {ext})"
        )

    # Read the file content
    content = await file.read()

    # SECURITY: Check file size
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large (max {MAX_UPLOAD_SIZE // 1024 // 1024}MB)"
        )

    # SECURITY: Basic PDF magic number check
    if not content[:5] == b'%PDF-':
        raise HTTPException(
            status_code=400,
            detail="File does not appear to be a valid PDF"
        )

    # Generate unique filename to prevent collisions
    unique_name = f"{uuid.uuid4().hex}_{file.filename}"
    # SECURITY: sanitize filename — remove path separators
    safe_name = unique_name.replace("/", "_").replace("\\", "_")
    save_path = PROJECTS_DIR / safe_name

    # Write file to disk
    with open(save_path, "wb") as f:
        f.write(content)

    # Extract PDF metadata
    try:
        info = pdf_engine.get_pdf_info(str(save_path))
    except (ValueError, Exception) as e:
        # Clean up the invalid file
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Invalid PDF: {e}")

    # Register in database
    doc_id = db.add_document(
        filename=file.filename,
        filepath=str(save_path),
        page_count=info["page_count"],
        file_size=info["file_size"]
    )

    return JSONResponse({
        "id": doc_id,
        "filename": file.filename,
        "page_count": info["page_count"],
        "file_size": info["file_size"],
        "page_sizes": info["page_sizes"],
        "redirect": f"/edit/{doc_id}"
    })


@router.post("/api/documents/blank")
async def create_blank_document(request: Request):
    """
    Create a new blank document with white pages (no PDF upload required).

    Request body:
        {
          "name": "Meeting Notes",
          "page_count": 1,
          "page_size": "letter"
        }

    Returns:
        JSON with document ID and redirect URL.
    """
    body = await request.json()

    # Sanitize name — strip whitespace, fall back to "Untitled"
    name = (body.get("name") or "Untitled").strip() or "Untitled"

    # SECURITY: clamp page count to prevent absurdly large PDFs
    try:
        page_count = max(1, min(50, int(body.get("page_count", 1))))
    except (ValueError, TypeError):
        page_count = 1

    # Resolve page size — fall back to Letter if unrecognized
    size_key = str(body.get("page_size", "letter")).lower()
    width_pts, height_pts = PAGE_SIZES.get(size_key, PAGE_SIZES["letter"])

    # Create the blank PDF in memory
    pdf_bytes = pdf_engine.create_blank_document(page_count, width_pts, height_pts)

    # Build a safe filename: "Meeting Notes.pdf"
    if not name.lower().endswith(".pdf"):
        filename = f"{name}.pdf"
    else:
        filename = name

    # SECURITY: generate unique name to avoid collisions, strip path chars
    safe_name = f"{uuid.uuid4().hex}_{filename.replace('/', '_').replace(chr(92), '_')}"
    save_path = PROJECTS_DIR / safe_name

    with open(save_path, "wb") as f:
        f.write(pdf_bytes)

    doc_id = db.add_document(
        filename=filename,
        filepath=str(save_path),
        page_count=page_count,
        file_size=len(pdf_bytes)
    )

    return JSONResponse({
        "id": doc_id,
        "filename": filename,
        "page_count": page_count,
        "redirect": f"/edit/{doc_id}"
    })


@router.post("/api/documents/{doc_id}/pages/blank")
async def add_blank_page(doc_id: int, request: Request):
    """
    Append a blank white page to an existing document.

    Only appends at the END — inserting in the middle would shift page
    indices and invalidate markup references stored in the database.

    Request body (all optional):
        { "page_size": "letter" }

    Returns:
        JSON with updated page count and index of the new page.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    body = await request.json()
    size_key = body.get("page_size")  # None means "match last page"

    # Resolve page dimensions
    if size_key and size_key in PAGE_SIZES:
        width_pts, height_pts = PAGE_SIZES[size_key]
    else:
        # Match the last page's dimensions — blank pages should fit the document
        try:
            info = pdf_engine.get_pdf_info(doc["filepath"])
            if info["page_sizes"]:
                last = info["page_sizes"][-1]
                width_pts = last["width"]
                height_pts = last["height"]
            else:
                width_pts, height_pts = PAGE_SIZES["letter"]
        except Exception:
            width_pts, height_pts = PAGE_SIZES["letter"]

    try:
        new_page_count = pdf_engine.add_blank_page(
            doc["filepath"], width_pts, height_pts
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to add page: {e}")

    # Keep DB page count in sync with the actual PDF
    db.update_document_page_count(doc_id, new_page_count)

    return JSONResponse({
        "page_count": new_page_count,
        # Zero-indexed — new page is always the last one
        "new_page_index": new_page_count - 1
    })


@router.get("/api/documents/{doc_id}/info")
async def get_document_info(doc_id: int):
    """
    Get metadata for a document.

    Returns page count, file size, page dimensions, etc.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # SECURITY: Verify the PDF file still exists on disk
    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    try:
        info = pdf_engine.get_pdf_info(doc["filepath"])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cannot read PDF: {e}")

    return JSONResponse({
        "id": doc_id,
        "filename": doc["filename"],
        "page_count": info["page_count"],
        "file_size": info["file_size"],
        "page_sizes": info["page_sizes"],
        "title": info["title"],
        "author": info["author"]
    })


@router.get("/api/documents/{doc_id}/pdf-layers")
async def get_pdf_layers(doc_id: int):
    """
    Get the Optional Content Group (OCG) layers from a PDF document.

    OCGs are the PDF equivalent of CAD layers — engineering drawings from
    AutoCAD/Bluebeam carry named layers for each discipline (walls, piping,
    text, borders, etc.).

    Returns:
        JSON with 'layers' list: [{'name': str, 'on': bool}, ...]
        Returns {'layers': []} if the document has no OCG layers.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    try:
        layers = pdf_engine.get_pdf_layers(doc["filepath"])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cannot read PDF layers: {e}")

    return JSONResponse({"layers": layers})


@router.get("/api/documents/{doc_id}/page/{page_number}")
async def get_page_image(
    doc_id: int,
    page_number: int,
    dpi: int = 150,
    rotate: int = 0,
    hidden_layers: str = "",
):
    """
    Render a single PDF page as a PNG image.

    Args:
        doc_id: Document database ID.
        page_number: Zero-indexed page number.
        dpi: Rendering resolution (72-300, default 150).
        rotate: Clockwise rotation in degrees (0, 90, 180, 270).
        hidden_layers: Comma-separated OCG layer names to hide (optional).
                       Example: "BORDER,Text PS,Thermostat"
                       Pass empty string (default) to show all layers.

    Returns:
        PNG image bytes with appropriate content-type.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    # Parse hidden_layers query param into a list of layer names
    # SECURITY: layer names are passed to the content stream filter, not executed
    hidden_list = [name.strip() for name in hidden_layers.split(",") if name.strip()] \
                  if hidden_layers else []

    try:
        if hidden_list:
            png_bytes = pdf_engine.render_page_with_layers(
                doc["filepath"], page_number,
                hidden_layers=hidden_list, dpi=dpi, rotate=rotate
            )
        else:
            png_bytes = pdf_engine.render_page(
                doc["filepath"], page_number, dpi=dpi, rotate=rotate
            )
    except IndexError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Render error: {e}")

    # When layers are being filtered the response is unique per layer state,
    # so we shorten the cache window to avoid stale renders after layer toggles.
    cache_ttl = 60 if hidden_list else 300

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Cache-Control": f"private, max-age={cache_ttl}"}
    )


@router.get("/api/documents/{doc_id}/thumbnail/{page_number}")
async def get_page_thumbnail(doc_id: int, page_number: int):
    """
    Render a small thumbnail of a PDF page for the sidebar navigation.

    Returns a ~200px wide PNG image.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    try:
        png_bytes = pdf_engine.render_thumbnail(doc["filepath"], page_number)
    except IndexError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Thumbnail error: {e}")

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=600"}
    )


@router.get("/api/documents")
async def list_documents():
    """
    List all documents — used by tests and the search panel to resolve doc filenames.
    """
    docs = db.get_all_documents()
    return JSONResponse({"documents": docs})


@router.get("/api/documents/recent")
async def get_recent_documents():
    """
    Get recently opened documents for the home screen.
    """
    recent = db.get_recent_documents(limit=10)
    return JSONResponse(recent)


@router.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: int):
    """
    Delete a document and its PDF file.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Remove the PDF file from disk
    filepath = Path(doc["filepath"])
    if filepath.exists():
        filepath.unlink()

    # Remove from database
    db.delete_document(doc_id)

    return JSONResponse({"status": "deleted", "id": doc_id})


@router.get("/api/documents/{doc_id}/export")
async def export_pdf(doc_id: int):
    """
    Export a PDF with Fabric.js markups drawn as native PDF annotations.

    Loads the original PDF and all saved markups, converts Fabric.js objects
    to PyMuPDF drawing commands, and returns a downloadable PDF.

    Security:
        - Validates document exists before processing
        - Read-only operation on the original PDF
        - Markup JSON is parsed but never executed
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    # Load saved markups from database
    markups = db.get_markups(doc_id)

    try:
        pdf_bytes = pdf_engine.export_with_annotations(
            doc["filepath"], markups
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export error: {e}")

    # Build download filename: original name with "_annotated" suffix
    original_name = doc["filename"]
    if original_name.lower().endswith('.pdf'):
        download_name = original_name[:-4] + '_annotated.pdf'
    else:
        download_name = original_name + '_annotated.pdf'

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"',
        }
    )
