"""
PortolanCAST — Main Application Entry Point

Purpose:
    FastAPI web server for PortolanCAST, an open-source PDF markup and
    measurement tool for construction professionals. Serves the web UI
    and provides API endpoints for PDF operations.

Security assumptions:
    - Runs on localhost only (no network exposure by default)
    - Single-user application (no auth needed for local use)
    - File uploads are restricted to PDF format
    - All file paths are sanitized to prevent directory traversal

Threat model:
    - Malformed PDF uploads could exploit parser vulnerabilities
    - Mitigation: file extension check, size limits, PyMuPDF error handling
    - Path traversal in document IDs
    - Mitigation: database IDs used instead of raw file paths

Author: PortolanCAST
Version: 0.1.0
Date: 2026-02-15

Usage:
    uvicorn main:app --host 127.0.0.1 --port 8000 --reload
"""

import asyncio
import io
import json as _json_top
import os
import shutil
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import Response, JSONResponse, StreamingResponse

from db import Database
from pdf_engine import PDFEngine

# =============================================================================
# CONFIGURATION
# =============================================================================

# Base directory — all paths relative to this (app code, templates, static)
BASE_DIR = Path(__file__).parent

# Data directory — user-writable location for projects, DB, photos.
# When running inside Electron, PORTOLANCAST_DATA_DIR points to
# app.getPath('userData')/data (e.g. %APPDATA%/PortolanCAST/data on Windows).
# In development, falls back to BASE_DIR/data alongside the source code.
DATA_DIR = Path(os.environ.get('PORTOLANCAST_DATA_DIR', BASE_DIR / "data"))

# Where uploaded PDFs are stored
PROJECTS_DIR = DATA_DIR / "projects"
TEMP_DIR = DATA_DIR / "temp"

# Where markup photo attachments are stored (served statically at /data/photos/)
# Created here at module load (not in startup()) because StaticFiles mount
# below requires the directory to exist at import time.
PHOTOS_DIR = DATA_DIR / "photos"
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

# Entity photos subdirectory — direct photo attachments to entities (Sprint 1).
# Under PHOTOS_DIR so the existing StaticFiles mount at /data/photos/ serves them.
ENTITY_PHOTOS_DIR = PHOTOS_DIR / "entities"
ENTITY_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

# Maximum upload size: 200MB (large-format construction drawings can be big)
MAX_UPLOAD_SIZE = 200 * 1024 * 1024

# Maximum photo upload size: 20MB
MAX_PHOTO_SIZE = 20 * 1024 * 1024

# Allowed upload extensions — PDF only for now
ALLOWED_EXTENSIONS = {".pdf"}

# Allowed photo extensions for markup attachments
ALLOWED_PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}

# Page size presets in PDF points (1 pt = 1/72 inch).
# Construction professionals use arch series; office work uses letter/A4.
PAGE_SIZES = {
    "letter":  (612,  792),   # 8.5" × 11"
    "legal":   (612,  1008),  # 8.5" × 14"
    "tabloid": (792,  1224),  # 11" × 17"
    "arch_c":  (1296, 1728),  # 18" × 24" — standard construction sheet
    "arch_d":  (1728, 2592),  # 24" × 36" — large construction sheet
    "arch_e":  (2592, 3456),  # 36" × 48" — very large construction sheet
    "a4":      (595,  842),   # ISO A4
}

# =============================================================================
# APPLICATION SETUP
# =============================================================================

app = FastAPI(
    title="PortolanCAST",
    description="Open-source PDF markup and measurement tool",
    version="0.1.0"
)

# Static file serving (CSS, JS, images)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# Serve markup photo attachments at /data/photos/{filename}
# Mounted before route definitions so FastAPI sees it during startup
app.mount("/data/photos", StaticFiles(directory=str(PHOTOS_DIR)), name="photos")

# HTML templates
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Database and PDF engine — initialized on startup
db = Database()
pdf_engine = PDFEngine()

# Tracks server start time; exposed by GET /api/health for uptime reporting
_app_start_time: float = time.time()


# =============================================================================
# STARTUP / SHUTDOWN
# =============================================================================

@app.on_event("startup")
async def startup():
    """Initialize database, run auto-backup, and ensure required directories exist."""
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    db.init()
    # Auto-backup protects the growing campus equipment database.
    # Runs after init() so migrations complete before the backup snapshot.
    db.auto_backup(max_backups=10)


# =============================================================================
# HEALTH + DEV ENDPOINTS
# =============================================================================

@app.get('/api/health')
async def health_check():
    """
    Fast self-diagnostic: DB, PDF engine, disk space, filesystem write, AI endpoint.

    Used by the HealthMonitor plugin (right-panel "Health" tab) and the status-bar
    dot indicator. Intentionally avoids touching private internals — uses only the
    public Database API so the check mirrors real usage.

    Returns:
        JSON: { status, timestamp, uptime_seconds, checks }
        where status is 'healthy' | 'degraded' | 'unhealthy'.
    """
    checks = {}
    overall = 'healthy'

    # 1. Database — use public API to exercise the same path as real requests
    t0 = time.time()
    try:
        db.get_all_documents()
        ms = round((time.time() - t0) * 1000, 1)
        checks['database'] = {'status': 'ok', 'response_time_ms': ms}
    except Exception as e:
        checks['database'] = {'status': 'fail', 'detail': str(e)}
        overall = 'unhealthy'

    # 2. PDF engine — confirm PyMuPDF is importable and report version
    try:
        import fitz
        checks['pdf_engine'] = {'status': 'ok', 'detail': f'PyMuPDF {fitz.version[0]}'}
    except Exception as e:
        checks['pdf_engine'] = {'status': 'fail', 'detail': str(e)}
        overall = 'unhealthy'

    # 3. Disk space — warn at <1 GB free (large PDFs need headroom)
    try:
        usage = shutil.disk_usage(PROJECTS_DIR)
        free_gb = round(usage.free / (1024 ** 3), 1)
        status = 'warn' if free_gb < 1.0 else 'ok'
        checks['disk_space'] = {'status': status, 'free_gb': free_gb}
        if status == 'warn' and overall == 'healthy':
            overall = 'degraded'
    except Exception as e:
        checks['disk_space'] = {'status': 'fail', 'detail': str(e)}

    # 4. Filesystem write test — confirm data directory is writable
    try:
        test_path = TEMP_DIR / f'health_{uuid.uuid4().hex[:8]}.tmp'
        test_path.write_text('ok')
        test_path.unlink()
        checks['filesystem'] = {'status': 'ok'}
    except Exception as e:
        checks['filesystem'] = {'status': 'fail', 'detail': str(e)}
        overall = 'unhealthy'

    # 5. AI endpoint — ClaudeProxy is optional; offline = degraded, not unhealthy
    try:
        import requests as req
        r = req.get('http://127.0.0.1:11435/health', timeout=2)
        checks['ai_endpoint'] = {'status': 'ok', 'detail': f'HTTP {r.status_code}'}
    except Exception:
        checks['ai_endpoint'] = {'status': 'unavailable', 'detail': 'ClaudeProxy offline'}
        if overall == 'healthy':
            overall = 'degraded'

    return {
        'status': overall,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'uptime_seconds': round(time.time() - _app_start_time),
        'checks': checks,
    }


@app.post('/api/dev/run-tests')
async def run_dev_tests():
    """
    DEV ONLY: Spawn the Playwright test suite and stream stdout line-by-line.

    Runs `node run_tests.mjs` in the project root as an async subprocess.
    Each line of output is yielded immediately via StreamingResponse so the
    browser panel updates in real time — no need to wait for all 33 suites.

    Security note:
        - No user input accepted; command is hardcoded.
        - Subprocess inherits the server's PATH (node must be on PATH).
        - Intended for local dev use only (same trust level as the rest of the app).
    """
    project_root = Path(__file__).parent

    async def _stream():
        proc = await asyncio.create_subprocess_exec(
            'node', 'run_tests.mjs',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(project_root),
        )
        async for line in proc.stdout:
            yield line.decode('utf-8', errors='replace')
        await proc.wait()

    return StreamingResponse(_stream(), media_type='text/plain; charset=utf-8')


# =============================================================================
# PAGE ROUTES (HTML)
# =============================================================================

@app.get("/")
async def home(request: Request):
    """
    Home page — shows recent documents and upload option.
    """
    recent = db.get_recent_documents(limit=10)
    return templates.TemplateResponse("editor.html", {
        "request": request,
        "recent_documents": recent
    })


@app.get("/edit/{doc_id}")
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


# =============================================================================
# API ROUTES — PDF OPERATIONS
# =============================================================================

@app.post("/api/upload")
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


@app.post("/api/documents/blank")
async def create_blank_document(request: Request):
    """
    Create a new blank document with white pages (no PDF upload required).

    Useful for sketch pads, meeting notes, and field annotations where
    there is no source drawing. The resulting document behaves identically
    to an uploaded PDF — same viewer, same markup tools.

    Request body:
        {
          "name": "Meeting Notes",      // display name (default: "Untitled")
          "page_count": 1,              // 1–50 pages
          "page_size": "letter"         // one of PAGE_SIZES keys
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


@app.post("/api/documents/{doc_id}/pages/blank")
async def add_blank_page(doc_id: int, request: Request):
    """
    Append a blank white page to an existing document.

    Only appends at the END — inserting in the middle would shift page
    indices and invalidate markup references stored in the database.

    Request body (all optional):
        {
          "page_size": "letter"   // size preset, or null to match last page
        }

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


@app.get("/api/documents/{doc_id}/info")
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


@app.get("/api/documents/{doc_id}/page/{page_number}")
async def get_page_image(
    doc_id: int,
    page_number: int,
    dpi: int = 150,
    rotate: int = 0,
):
    """
    Render a single PDF page as a PNG image.

    Args:
        doc_id: Document database ID.
        page_number: Zero-indexed page number.
        dpi: Rendering resolution (72-300, default 150).
        rotate: Clockwise rotation in degrees (0, 90, 180, 270).
                Invalid values are silently treated as 0 by pdf_engine.

    Returns:
        PNG image bytes with appropriate content-type.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    try:
        png_bytes = pdf_engine.render_page(
            doc["filepath"], page_number, dpi=dpi, rotate=rotate
        )
    except IndexError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Render error: {e}")

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            # Cache rendered pages for 5 minutes — same page/DPI won't change
            "Cache-Control": "private, max-age=300"
        }
    )


@app.get("/api/documents/{doc_id}/thumbnail/{page_number}")
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


@app.get("/api/documents")
async def list_documents():
    """
    List all documents — used by tests and the search panel to resolve doc filenames.
    """
    docs = db.get_all_documents()
    return JSONResponse({"documents": docs})


@app.get("/api/documents/recent")
async def get_recent_documents():
    """
    Get recently opened documents for the home screen.
    """
    recent = db.get_recent_documents(limit=10)
    return JSONResponse(recent)


@app.delete("/api/documents/{doc_id}")
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


# =============================================================================
# API ROUTES — PDF EXPORT
# =============================================================================

@app.get("/api/documents/{doc_id}/export")
async def export_pdf(doc_id: int):
    """
    Export a PDF with Fabric.js markups drawn as native PDF annotations.

    Loads the original PDF and all saved markups, converts Fabric.js objects
    to PyMuPDF drawing commands, and returns a downloadable PDF with
    annotations baked in. The original file is not modified.

    Security:
        - Validates document exists before processing
        - Read-only operation on the original PDF (copies to temp in memory)
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


# =============================================================================
# API ROUTES — MARKUP PERSISTENCE
# =============================================================================

@app.api_route("/api/documents/{doc_id}/markups", methods=["PUT", "POST"])
async def save_markups(doc_id: int, request: Request):
    """
    Save all page markups for a document.

    Accepts both PUT (normal fetch) and POST (sendBeacon on page unload).
    Expects JSON body: { "pages": { "0": {fabricJSON}, "2": {fabricJSON}, ... } }
    Pages without markups should be omitted (they'll be cleared from the DB).

    Security:
        - Validates document exists before saving
        - JSON body is stored as-is — no code execution
        - Size limited by FastAPI default body size limits
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


@app.get("/api/documents/{doc_id}/markups")
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


# =============================================================================
# API ROUTES — DRAWING SCALE
# =============================================================================

# Rendering DPI — must match BASE_DPI in canvas.js
RENDER_DPI = 150.0


@app.get("/api/documents/{doc_id}/scale")
async def get_document_scale(doc_id: int):
    """
    Get the drawing scale setting for a document.

    Returns the scale preset and the derived pixels-per-real-unit values
    that Phase 2 measurement tools use to convert Fabric pixel distances
    to real-world lengths.

    Returns:
        JSON with preset name, paper_inches_per_unit, unit_label,
        pixels_per_unit (=RENDER_DPI * paper_inches_per_unit), and
        pixels_per_inch (always RENDER_DPI = 150, for reference).
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    raw = db.get_document_setting(doc_id, "scale")

    if raw:
        import json as _json
        try:
            scale = _json.loads(raw)
        except Exception:
            scale = _default_scale()
    else:
        scale = _default_scale()

    # Compute derived values for convenience — measurement tools use these directly
    pixels_per_unit = RENDER_DPI * scale["paper_inches_per_unit"]
    scale["pixels_per_unit"] = round(pixels_per_unit, 6)
    scale["pixels_per_inch"] = RENDER_DPI  # informational constant

    return JSONResponse(scale)


@app.put("/api/documents/{doc_id}/scale")
async def set_document_scale(doc_id: int, request: Request):
    """
    Set the drawing scale for a document.

    The scale tells measurement tools how to convert Fabric pixel distances
    to real-world units (feet, inches, meters).

    Request body:
        {
          "preset": "quarter_inch",      // key from SCALE_PRESETS, or "custom"
          "paper_inches_per_unit": 0.25, // paper inches per one real unit
          "unit_label": "ft"             // 'ft', 'in', 'm', etc.
        }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()

    # SECURITY: validate preset is a known string or 'custom'
    preset = str(body.get("preset", "unscaled"))

    try:
        paper_inches = float(body.get("paper_inches_per_unit", 1.0))
    except (TypeError, ValueError):
        paper_inches = 1.0

    # Clamp to sane range: 0.001" (1:72000) to 100" (100:1)
    paper_inches = max(0.001, min(100.0, paper_inches))

    unit_label = str(body.get("unit_label", "in"))[:8]  # max 8 chars

    import json as _json
    scale = {
        "preset": preset,
        "paper_inches_per_unit": paper_inches,
        "unit_label": unit_label,
    }
    db.set_document_setting(doc_id, "scale", _json.dumps(scale))

    pixels_per_unit = RENDER_DPI * paper_inches
    scale["pixels_per_unit"] = round(pixels_per_unit, 6)
    scale["pixels_per_inch"] = RENDER_DPI

    return JSONResponse(scale)


def _default_scale() -> dict:
    """
    Return the default (unscaled) drawing scale.

    'Unscaled' means 1 Fabric pixel = 1/150 inch.
    In this mode measurement tools show dimensions in inches.
    """
    return {
        "preset": "unscaled",
        "paper_inches_per_unit": 1.0,
        "unit_label": "in",
    }


# =============================================================================
# API ROUTES — AI SUMMARY (ExtendedCognition Plugin backend)
# =============================================================================

def _extract_stats(pages: dict) -> dict:
    """
    Extract markup statistics from a dict of Fabric.js page JSON objects.

    Iterates all Fabric object lists across all pages, counts by markupType
    and markupStatus, and identifies the most active pages.

    Skips area companion IText objects — these are visual labels that pair
    with polygon area measurements and should not be counted as markup annotations.
    An area companion is identified by: measurementType == 'area' AND
    type in ('IText', 'i-text').

    Args:
        pages: Dict mapping page index string → Fabric JSON { objects: [...] }

    Returns:
        {
          total: int,
          byType: { issue, question, approval, change, note },
          byStatus: { open, resolved },
          measurements: { distances, areas, counts },
          pages: int,              # number of pages with at least one markup
          mostActivePages: list    # 1-indexed, top-3 pages by markup count
        }
    """
    # Initialize all 5 markup type counts so the response shape is always complete
    by_type = {t: 0 for t in ("issue", "question", "approval", "change", "note")}
    by_status = {"open": 0, "resolved": 0}
    measurements = {"distances": 0, "areas": 0, "counts": 0}
    total = 0
    page_counts = {}  # page_index → count for mostActivePages ranking

    for page_key, fabric_json in pages.items():
        if not isinstance(fabric_json, dict):
            continue
        objects = fabric_json.get("objects", [])
        if not isinstance(objects, list):
            continue

        page_markup_count = 0

        for obj in objects:
            if not isinstance(obj, dict):
                continue

            # Skip area companion IText labels — they are visual annotations
            # paired with polygon area measurements (see pairedId in measure.js).
            # Counting them would double-count area measurements as markup items.
            m_type = obj.get("measurementType")
            obj_type = obj.get("type", "")
            if m_type == "area" and obj_type in ("IText", "i-text"):
                continue

            # Count measurement tool objects separately from annotation markups
            if m_type == "distance":
                measurements["distances"] += 1
                page_markup_count += 1
                continue
            if m_type == "area":
                measurements["areas"] += 1
                page_markup_count += 1
                continue
            if m_type == "count":
                measurements["counts"] += 1
                page_markup_count += 1
                continue

            # Regular annotation markup
            total += 1
            page_markup_count += 1

            markup_type = obj.get("markupType", "note")
            if markup_type in by_type:
                by_type[markup_type] += 1
            else:
                # Unknown types fall into 'note' bucket
                by_type["note"] += 1

            status = obj.get("markupStatus", "open")
            if status == "resolved":
                by_status["resolved"] += 1
            else:
                by_status["open"] += 1

        if page_markup_count > 0:
            page_counts[page_key] = page_markup_count

    # Build 1-indexed most-active page list (top 3 by count)
    sorted_pages = sorted(page_counts.items(), key=lambda x: x[1], reverse=True)
    most_active = []
    for page_key, _ in sorted_pages[:3]:
        try:
            most_active.append(int(page_key) + 1)  # convert 0-indexed to 1-indexed
        except (ValueError, TypeError):
            pass

    return {
        "total": total,
        "byType": by_type,
        "byStatus": by_status,
        "measurements": measurements,
        "pages": len(page_counts),
        "mostActivePages": most_active,
    }


def _build_prompt(stats: dict, filename: str) -> str:
    """
    Build a compact prompt for the AI to generate a status briefing.

    Includes: file name, markup counts by type and status, measurement
    summary, and most active pages. Ends with a clear instruction that
    keeps the output concise and PM-focused.

    Args:
        stats:    Output of _extract_stats().
        filename: Document filename (for context in the briefing).

    Returns:
        A string prompt ready to pass to the AI endpoint.
    """
    by_type = stats.get("byType", {})
    by_status = stats.get("byStatus", {})
    measurements = stats.get("measurements", {})
    most_active = stats.get("mostActivePages", [])

    lines = [
        f"Document: {filename}",
        f"Total annotations: {stats.get('total', 0)} "
        f"({by_status.get('open', 0)} open, {by_status.get('resolved', 0)} resolved)",
        "Breakdown by type:",
    ]

    for t, count in by_type.items():
        if count > 0:
            lines.append(f"  - {t.capitalize()}: {count}")

    if any(v > 0 for v in measurements.values()):
        lines.append("Measurements on drawing:")
        if measurements.get("distances"):
            lines.append(f"  - Distance measurements: {measurements['distances']}")
        if measurements.get("areas"):
            lines.append(f"  - Area measurements: {measurements['areas']}")
        if measurements.get("counts"):
            lines.append(f"  - Count/quantity markers: {measurements['counts']}")

    if most_active:
        pages_str = ", ".join(str(p) for p in most_active)
        lines.append(f"Most annotated pages: {pages_str}")

    lines.append("")
    lines.append(
        "Write a concise status briefing for a project manager. "
        "Two to three sentences. No bullet points."
    )

    return "\n".join(lines)


def _build_fallback_summary(stats: dict) -> str:
    """
    Build a computed (non-AI) summary string from markup statistics.

    Used when ClaudeProxy is offline or any network error prevents the
    AI response from being retrieved.

    Args:
        stats: Output of _extract_stats().

    Returns:
        A human-readable summary sentence.
    """
    total = stats.get("total", 0)

    if total == 0:
        # Check if there are measurements even with no annotations
        measurements = stats.get("measurements", {})
        if any(v > 0 for v in measurements.values()):
            m_count = sum(measurements.values())
            return f"No annotation markups on this document. {m_count} measurement(s) recorded."
        return "No markups on this document yet."

    by_status = stats.get("byStatus", {})
    by_type = stats.get("byType", {})
    open_count = by_status.get("open", 0)
    resolved_count = by_status.get("resolved", 0)

    # Build type summary for types with non-zero counts
    type_parts = []
    for t in ("issue", "question", "change", "approval", "note"):
        count = by_type.get(t, 0)
        if count > 0:
            type_parts.append(f"{count} {t}{'s' if count != 1 else ''}")

    type_summary = ", ".join(type_parts) if type_parts else ""

    summary = (
        f"This document has {total} markup{'s' if total != 1 else ''} "
        f"({open_count} open, {resolved_count} resolved)"
    )
    if type_summary:
        summary += f": {type_summary}."
    else:
        summary += "."

    # Append measurement counts if any
    measurements = stats.get("measurements", {})
    m_total = sum(measurements.values())
    if m_total > 0:
        summary += f" {m_total} measurement(s) are recorded on the drawing."

    return summary


@app.post("/api/documents/{doc_id}/ai-summary")
async def ai_summary(doc_id: int, request: Request):
    """
    Generate a status briefing for all markups in a document.

    Accepts the full page markup payload from the browser (same format
    as /api/documents/{id}/markups), extracts statistics, then attempts
    to call ClaudeProxy (http://127.0.0.1:11435) for a Claude-quality narrative.

    Falls back to a computed summary if ClaudeProxy is unavailable or any
    network/timeout error occurs. This means the endpoint always returns a
    useful response — Claude quality when proxy is running, stats-based otherwise.

    Request body:
        { "pages": { "0": {fabricJSON}, "1": {fabricJSON}, ... } }

    Response:
        {
          "summary": str,           # narrative text (AI or computed)
          "stats": {...},           # full stats object from _extract_stats
          "mode": "ai"|"computed",  # which path was taken
          "model": str|null         # model name if AI mode, else null
        }

    Security:
        - Only talks to localhost:11435 (ClaudeProxy) — still localhost-only
        - The `requests` import is inside the function so a missing package
          fails gracefully at call time rather than crashing server startup
        - AI response content is returned as-is (plain text); the browser
          renders it with textContent (no HTML injection risk)
        - ClaudeProxy itself enforces its own subprocess timeout (120s)
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    pages = body.get("pages", {})
    if not isinstance(pages, dict):
        pages = {}

    stats = _extract_stats(pages)
    mode = "computed"
    summary = _build_fallback_summary(stats)
    # Route through ClaudeProxy (OpenAI-compatible, localhost:11435).
    # Falls back to computed summary if proxy is offline — same resilience as before.
    model_name = "claude-sonnet-4-6"

    try:
        # Lazy import — avoids ImportError crashing the server if `requests`
        # isn't installed. Falls back to computed summary on any exception.
        import requests as req_lib

        # Fast pre-flight check — if ClaudeProxy is offline this fails in <2s
        # instead of hanging for 60s and blocking the browser's networkidle state.
        # This is critical for Playwright tests which time out on networkidle.
        req_lib.get("http://127.0.0.1:11435/health", timeout=2).raise_for_status()

        prompt = _build_prompt(stats, doc["filename"])

        # CHANGED: ClaudeProxy endpoint instead of Ollama /api/generate.
        # The proxy translates OpenAI-format requests into claude -p calls.
        r = req_lib.post(
            "http://127.0.0.1:11435/v1/chat/completions",
            json={
                "model": model_name,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
            },
            timeout=60,  # Claude can be slower than Ollama on complex prompts
        )
        r.raise_for_status()

        text = (r.json()["choices"][0]["message"]["content"] or "").strip()
        if text:
            summary = text
            mode = "ai"
    except Exception:
        # Proxy offline, timeout, or requests not installed —
        # stay on computed fallback; do not expose error details to the client
        pass

    return JSONResponse({
        "summary": summary,
        "stats": stats,
        "mode": mode,
        "model": model_name if mode == "ai" else None,
    })


# =============================================================================
# API ROUTES — LAYERS (Phase 5)
# =============================================================================

def _default_layers() -> dict:
    """
    Return the default single-layer configuration for new documents.

    Every document starts with a single 'Default' layer that is visible
    and unlocked. This is the baseline state before any user customization.

    Returns:
        Dict with 'layers' list and 'activeId' string.
    """
    return {
        "layers": [{"id": "default", "name": "Default", "visible": True, "locked": False}],
        "activeId": "default",
    }


@app.get("/api/documents/{doc_id}/layers")
async def get_layers(doc_id: int):
    """
    Get the layer definitions for a document.

    Returns the full layer configuration: a list of layer objects
    with id/name/visible/locked, plus the currently active layer ID.
    If no layer configuration has been saved, returns the default
    single-layer setup.

    Args:
        doc_id: Document database ID.

    Returns:
        { "layers": [...], "activeId": str }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    raw = db.get_document_setting(doc_id, "layers")
    if raw:
        import json as _j
        try:
            return JSONResponse(_j.loads(raw))
        except Exception:
            pass

    # No saved layers — return default configuration
    return JSONResponse(_default_layers())


@app.put("/api/documents/{doc_id}/layers")
async def put_layers(doc_id: int, request: Request):
    """
    Save the layer definitions for a document.

    Expects JSON body: { "layers": [...], "activeId": str }

    Each layer must be a dict with id, name, visible, locked.
    At least one layer is required. Strings are clamped to 64 chars
    to prevent excessively large payloads.

    Security:
        - Validates document exists before writing
        - Clamps string lengths to prevent oversized storage
        - Type-validates all layer fields before persisting
        - Rejects empty layers list (document must always have ≥1 layer)

    Args:
        doc_id: Document database ID.

    Returns:
        The cleaned layer configuration that was saved.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    layers = body.get("layers")

    if not isinstance(layers, list) or len(layers) == 0:
        raise HTTPException(status_code=400, detail="layers must be a non-empty list")

    # SECURITY: clamp strings, validate types — reject malformed layer objects
    cleaned = []
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        cleaned.append({
            "id":      str(layer.get("id", "default"))[:64],
            "name":    str(layer.get("name", "Layer"))[:64],
            "visible": bool(layer.get("visible", True)),
            "locked":  bool(layer.get("locked", False)),
        })

    if not cleaned:
        raise HTTPException(status_code=400, detail="No valid layers provided")

    active_id = str(body.get("activeId", "default"))[:64]

    import json as _j
    db.set_document_setting(
        doc_id, "layers",
        _j.dumps({"layers": cleaned, "activeId": active_id})
    )

    return JSONResponse({"layers": cleaned, "activeId": active_id})


# =============================================================================
# API ROUTES — BUNDLE EXPORT/IMPORT (.portolan)
# =============================================================================

@app.get("/api/documents/{doc_id}/export-bundle")
async def export_bundle(doc_id: int):
    """
    Export a portable .portolan bundle for a document.

    A .portolan file is a ZIP archive containing the original PDF, all markup
    data, layer configuration, and scale settings. Recipients can import the
    bundle to restore the full session — PDF + markups + layers — on any
    PortolanCAST installation without needing access to the original file.

    Bundle contents:
        metadata.json  — app version, filename, page count, export timestamp
        original.pdf   — byte-exact copy of the source PDF
        markups.json   — { pages: { "0": fabricJSON, ... } }
        layers.json    — { layers: [...], activeId }
        scale.json     — { preset, paper_inches_per_unit, unit_label }
        photos.json    — photo manifest (omitted if no photos exist)
        photos/        — image files named {photo_id}.{ext} (omitted if no photos)

    Security:
        - Validates document + PDF file exist before building the bundle
        - In-memory ZIP — no temp files written to disk
        - Markup/layer/scale data is read from DB, never from request body

    Args:
        doc_id: Document database ID.

    Returns:
        ZIP file as application/zip with Content-Disposition attachment.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    pdf_path = Path(doc["filepath"])
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    # Load all document state from DB
    markups = db.get_markups(doc_id)
    pages_str = {str(k): v for k, v in markups.items()}

    raw_layers = db.get_document_setting(doc_id, "layers")
    if raw_layers:
        try:
            layers_obj = _json_top.loads(raw_layers)
        except Exception:
            layers_obj = _default_layers()
    else:
        layers_obj = _default_layers()

    raw_scale = db.get_document_setting(doc_id, "scale")
    if raw_scale:
        try:
            scale_obj = _json_top.loads(raw_scale)
        except Exception:
            scale_obj = _default_scale()
    else:
        scale_obj = _default_scale()

    metadata = {
        "version": "1",
        "app": "PortolanCAST",
        "filename": doc["filename"],
        "page_count": doc["page_count"],
        "exported_at": datetime.utcnow().isoformat() + "Z",
    }

    # Collect photo attachments — read file bytes now so the ZIP write is clean.
    # Skip photos whose files are missing from disk (DB record exists but file
    # was manually deleted — don't fail the export over a single missing image).
    all_photos = db.get_all_document_photos(doc_id)
    photos_manifest = []
    photo_file_data = []  # list of (zip_entry_path, bytes)
    for p in all_photos:
        photo_path = Path(p["file_path"])
        if not photo_path.exists():
            continue  # file gone from disk — skip, don't abort export
        filename = photo_path.name          # e.g. "abc123def456.jpg"
        photos_manifest.append({
            "photo_id":   p["photo_id"],
            "markup_id":  p["markup_id"],
            "filename":   filename,
            "description": p["description"],
            "created_at": p["created_at"],
        })
        photo_file_data.append((f"photos/{filename}", photo_path.read_bytes()))

    # Build ZIP in memory — avoids writing temp files to disk
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.json", _json_top.dumps(metadata, indent=2))
        zf.write(str(pdf_path), "original.pdf")
        zf.writestr("markups.json", _json_top.dumps({"pages": pages_str}, indent=2))
        zf.writestr("layers.json", _json_top.dumps(layers_obj, indent=2))
        zf.writestr("scale.json", _json_top.dumps(scale_obj, indent=2))
        # Include photos only when this document has attachments
        if photos_manifest:
            zf.writestr("photos.json", _json_top.dumps(photos_manifest, indent=2))
            for entry_name, photo_bytes in photo_file_data:
                zf.writestr(entry_name, photo_bytes)

    # Build download filename: strip .pdf extension, add .portolan
    base_name = doc["filename"]
    if base_name.lower().endswith(".pdf"):
        base_name = base_name[:-4]
    download_name = base_name + ".portolan"

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"',
        },
    )


@app.post("/api/documents/import-bundle")
async def import_bundle(file: UploadFile = File(...)):
    """
    Import a .portolan bundle and restore the document + all markup state.

    Reads the ZIP, validates required members, saves the PDF, creates a new
    document record, and restores markups/layers/scale from the bundle.
    Always creates a NEW document — never overwrites an existing one.

    Expected bundle (minimum required):
        metadata.json  — must be present (version check future-proofing)
        original.pdf   — PDF bytes; must start with %PDF- magic bytes

    Optional (imported if present, defaults used if absent):
        markups.json, layers.json, scale.json
        photos.json + photos/  — photo attachments (restored under new_doc_id)

    Security:
        - Extension must be .portolan
        - Size limited by MAX_UPLOAD_SIZE constant
        - zipfile.BadZipFile caught to reject corrupt or spoofed ZIPs
        - PDF magic bytes validated before saving
        - Optional members are schema-validated before DB write

    Args:
        file: The uploaded .portolan bundle (multipart form).

    Returns:
        { id, filename, page_count, redirect }
    """
    # SECURITY: extension check — only .portolan bundles accepted here
    if not file.filename or not file.filename.lower().endswith(".portolan"):
        raise HTTPException(status_code=400, detail="File must be a .portolan bundle")

    raw = await file.read()

    # SECURITY: size limit
    if len(raw) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail="Bundle exceeds maximum upload size")

    # SECURITY: reject corrupt or non-ZIP files
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            namelist = zf.namelist()

            # Required members
            if "metadata.json" not in namelist:
                raise HTTPException(status_code=400, detail="Bundle missing metadata.json")
            if "original.pdf" not in namelist:
                raise HTTPException(status_code=400, detail="Bundle missing original.pdf")

            pdf_bytes = zf.read("original.pdf")

            # SECURITY: validate PDF magic bytes
            if not pdf_bytes.startswith(b"%PDF-"):
                raise HTTPException(status_code=400, detail="Bundle contains invalid PDF")

            # Read metadata to get original filename
            try:
                meta = _json_top.loads(zf.read("metadata.json"))
            except Exception:
                meta = {}
            original_filename = str(meta.get("filename", file.filename))

            # Read optional members — use defaults if absent
            markups_pages = {}
            if "markups.json" in namelist:
                try:
                    markups_data = _json_top.loads(zf.read("markups.json"))
                    markups_pages = markups_data.get("pages", {})
                    if not isinstance(markups_pages, dict):
                        markups_pages = {}
                except Exception:
                    markups_pages = {}

            layers_raw = None
            if "layers.json" in namelist:
                try:
                    layers_obj = _json_top.loads(zf.read("layers.json"))
                    if isinstance(layers_obj, dict) and "layers" in layers_obj:
                        layers_raw = _json_top.dumps(layers_obj)
                except Exception:
                    pass

            scale_raw = None
            if "scale.json" in namelist:
                try:
                    scale_obj = _json_top.loads(zf.read("scale.json"))
                    if isinstance(scale_obj, dict) and "preset" in scale_obj:
                        scale_raw = _json_top.dumps(scale_obj)
                except Exception:
                    pass

            # Read photo manifest and collect image bytes in memory.
            # Photos are restored after new_doc_id is known (below).
            # Each photo gets a fresh photo_id UUID so it can't collide with
            # photos belonging to other documents on this installation.
            photos_to_restore = []
            if "photos.json" in namelist:
                try:
                    photos_meta = _json_top.loads(zf.read("photos.json"))
                    if isinstance(photos_meta, list):
                        for entry in photos_meta:
                            filename = str(entry.get("filename", ""))
                            # SECURITY: validate extension — only known image types
                            ext = Path(filename).suffix.lower()
                            if ext not in ALLOWED_PHOTO_EXTENSIONS:
                                continue
                            # SECURITY: only read entries inside the photos/ folder
                            zip_entry = f"photos/{filename}"
                            if zip_entry not in namelist:
                                continue  # manifest references missing file — skip
                            photo_bytes = zf.read(zip_entry)
                            # SECURITY: enforce per-photo size limit
                            if len(photo_bytes) > MAX_PHOTO_SIZE:
                                continue
                            photos_to_restore.append({
                                "markup_id":   str(entry.get("markup_id", ""))[:128],
                                "description": str(entry.get("description", ""))[:500],
                                "ext":         ext,
                                "bytes":       photo_bytes,
                            })
                except Exception:
                    photos_to_restore = []  # don't abort the whole import for photos

    except HTTPException:
        raise  # re-raise our own validation errors
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="File is not a valid ZIP/portolan bundle")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bundle read error: {e}")

    # Save PDF to projects directory with a unique filename
    pdf_filename = uuid.uuid4().hex + ".pdf"
    pdf_dest = PROJECTS_DIR / pdf_filename
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    pdf_dest.write_bytes(pdf_bytes)

    # Validate + measure the PDF
    try:
        pdf_info = pdf_engine.get_pdf_info(str(pdf_dest))
    except Exception as e:
        pdf_dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"PDF validation failed: {e}")

    file_size = len(pdf_bytes)
    page_count = pdf_info.get("page_count", 1)

    # Create document record in DB
    new_doc_id = db.add_document(original_filename, str(pdf_dest), page_count, file_size)

    # Restore optional state
    if markups_pages:
        db.save_markups(new_doc_id, markups_pages)
    if layers_raw:
        db.set_document_setting(new_doc_id, "layers", layers_raw)
    if scale_raw:
        db.set_document_setting(new_doc_id, "scale", scale_raw)

    # Restore photo attachments — write image files first, then DB records.
    # New photo_id UUIDs are generated so files never collide with existing
    # photos from other documents on this installation.
    for p in photos_to_restore:
        new_photo_id = uuid.uuid4().hex
        photo_filename = f"{new_photo_id}{p['ext']}"
        save_path = PHOTOS_DIR / photo_filename
        try:
            save_path.write_bytes(p["bytes"])
            db.add_markup_photo(
                new_photo_id,
                new_doc_id,
                p["markup_id"],
                str(save_path),
                p["description"],
            )
        except Exception as e:
            # Best-effort: log and skip the individual photo rather than
            # failing the entire import over one broken attachment.
            save_path.unlink(missing_ok=True)
            print(f"[WARN] Could not restore photo during import: {e}")

    return JSONResponse({
        "id": new_doc_id,
        "filename": original_filename,
        "page_count": page_count,
        "redirect": f"/edit/{new_doc_id}",
    })


# =============================================================================
# API ROUTES — MARKUP PHOTO ATTACHMENTS
# =============================================================================

@app.post("/api/documents/{doc_id}/markup-photos")
async def upload_markup_photo(
    doc_id: int,
    markup_id: str = Form(""),   # validated manually below so we return 400 not 422
    description: str = Form(""),
    photo: UploadFile = File(...)
):
    """
    Attach a photo to a specific markup object.

    The markup is identified by its markupId UUID (stamped on Fabric objects
    at creation time). This UUID survives save/load cycles and is stable
    across sessions — unlike canvas object indices which are runtime-only.

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
        - document_id validated against DB before saving
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

    # Save with UUID filename — prevents path traversal and name collisions.
    # The UUID hex is also the photo_id used in the DB and DELETE route.
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


@app.get("/api/documents/{doc_id}/markup-photos/{markup_id}")
async def get_markup_photos(doc_id: int, markup_id: str):
    """
    Return all photos attached to a specific markup object.

    Args:
        doc_id:    Document database ID (security scope).
        markup_id: The markupId UUID on the Fabric object.

    Returns:
        { "photos": [{ photo_id, url, description, created_at }, ...] }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    photos = db.get_markup_photos(doc_id, markup_id)

    result = []
    for p in photos:
        # Derive the URL from the stored file_path (filename only — no dir)
        fname = Path(p["file_path"]).name
        result.append({
            "photo_id": p["photo_id"],
            "url": f"/data/photos/{fname}",
            "description": p["description"],
            "created_at": p["created_at"],
        })

    return JSONResponse({"photos": result})


@app.delete("/api/documents/{doc_id}/markup-photos/{photo_id}")
async def delete_markup_photo(doc_id: int, photo_id: str):
    """
    Delete a photo attachment — removes both the DB record and the image file.

    Scoped to doc_id to prevent cross-document deletion attacks.
    DB record is deleted first; file deletion is best-effort (won't fail
    the response if the file is already missing).

    Args:
        doc_id:   Document database ID (security scope).
        photo_id: UUID of the photo to delete.

    Returns:
        { "status": "deleted", "photo_id": str }
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

    # Best-effort file deletion — log but don't fail the response
    try:
        Path(file_path).unlink(missing_ok=True)
    except OSError as e:
        print(f"[WARN] Could not delete photo file {file_path}: {e}")

    return JSONResponse({"status": "deleted", "photo_id": photo_id})


# =============================================================================
# API ROUTES — GLOBAL SEARCH
# =============================================================================

@app.get("/api/search")
async def search(q: str = ""):
    """
    Search across all documents and markup content.

    Searches document filenames and markup semantic fields (markupNote,
    markupType, markupAuthor) by scanning Fabric.js canvas JSON blobs.

    Args:
        q: Query string (URL parameter). Empty string returns empty list.

    Returns:
        { "results": [{ entity_type, doc_id, doc_name, page_number,
                         match_field, match_text, context }, ...] }

    Security:
        - q is passed as a URL parameter (no path traversal risk)
        - Length-clamped before passing to search_all
        - Parameterized SQL in search_all prevents SQL injection
    """
    # SECURITY: clamp query length to prevent abuse
    q = str(q)[:200].strip()
    if not q:
        return JSONResponse({"results": []})

    results = db.search_all(q)
    return JSONResponse({"results": results})


# =============================================================================
# API ROUTES — REVIEW BRIEF
# =============================================================================

import re as _re

# Human-readable shape labels — mirrors SHAPE_LABELS in markup-list.js.
# Kept here so the brief matches what users see in the markup list panel.
_SHAPE_LABELS = {
    'rect': 'Rect', 'Rect': 'Rect',
    'ellipse': 'Ellipse', 'Ellipse': 'Ellipse',
    'line': 'Line', 'Line': 'Line',
    'path': 'Pen', 'Path': 'Pen',
    'circle': 'Circle', 'Circle': 'Circle',
    'polygon': 'Polygon', 'Polygon': 'Polygon',
    'i-text': 'Text', 'IText': 'Text',
    'textbox': 'Text', 'Textbox': 'Text',
    'group': 'Group', 'Group': 'Group',
}


def _parse_tags(note: str) -> list:
    """
    Extract hashtags from a markup note string.

    Tags are #word patterns: alphanumeric + dash/underscore, no spaces.
    Returns deduplicated, lowercase tag names (without # prefix) in order
    of first appearance. Mirrors parseTags() in markup-list.js and properties.js.

    Args:
        note: Raw markupNote string.

    Returns:
        List of lowercase tag name strings.
    """
    if not note:
        return []
    matches = _re.findall(r'#([a-zA-Z0-9_-]+)', note)
    seen = set()
    result = []
    for m in matches:
        t = m.lower()
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result


def _extract_markup_entries(pages: dict) -> list:
    """
    Extract a flat, sorted list of annotation markup entries from all pages.

    Scans all Fabric.js page JSON blobs and collects annotation markup objects
    (non-measurement, non-area-companion). Each entry carries page index,
    shape label, markup type/status/note/author for brief generation.

    Skips:
        - Area companion IText labels (measurementType == 'area' AND type IText/i-text)
        - Measurement objects (measurementType in distance, area, count)
        - Objects with unrecognised markupType values

    Args:
        pages: Dict mapping page index string → Fabric JSON { objects: [...] }

    Returns:
        List of dicts sorted by (page_num, markupType priority):
        {
          page_num:      int,  # 0-indexed page number
          shape_label:   str,  # human-readable shape type
          markup_type:   str,  # 'issue' | 'question' | 'change' | 'note' | 'approval'
          markup_status: str,  # 'open' | 'resolved'
          markup_note:   str,  # free-text note (may be empty)
          markup_author: str,  # author name (may be empty)
        }
    """
    # Type priority used for stable sort within each page
    TYPE_PRIORITY = {"issue": 0, "question": 1, "change": 2, "note": 3, "approval": 4}
    entries = []

    for page_key, fabric_json in pages.items():
        if not isinstance(fabric_json, dict):
            continue
        objects = fabric_json.get("objects", [])
        if not isinstance(objects, list):
            continue

        try:
            page_num = int(page_key)
        except (ValueError, TypeError):
            page_num = 0

        for obj in objects:
            if not isinstance(obj, dict):
                continue

            m_type = obj.get("measurementType")
            obj_type = obj.get("type", "")

            # Skip area companion IText labels (visual pairing labels for area polygons)
            if m_type == "area" and obj_type in ("IText", "i-text"):
                continue

            # Skip measurement tool objects — they go in the Measures tab, not the Brief
            if m_type in ("distance", "area", "count"):
                continue

            # Only include the 5 annotation intent types
            markup_type = obj.get("markupType", "note")
            if markup_type not in TYPE_PRIORITY:
                continue

            entries.append({
                "page_num":      page_num,
                "shape_label":   _SHAPE_LABELS.get(obj_type, obj_type or "Shape"),
                "markup_type":   markup_type,
                "markup_status": obj.get("markupStatus", "open"),
                "markup_note":   str(obj.get("markupNote", "") or "").strip(),
                "markup_author": str(obj.get("markupAuthor", "") or "").strip(),
            })

    entries.sort(key=lambda e: (e["page_num"], TYPE_PRIORITY.get(e["markup_type"], 99)))
    return entries


def _generate_review_brief(doc: dict, pages: dict) -> str:
    """
    Generate a Markdown-formatted review brief for a document.

    Groups annotation markups by type (issue → question → change → note → approval),
    open items listed before resolved within each group. Entries within each
    status group are sorted by page number (already guaranteed by _extract_markup_entries).

    Format overview:
        # Review Brief — {filename}
        {date}   {open} open / {total} total
        ---
        ## Issues  (n)
        ### Open
        - p.{N} {Shape} — {note or (no note)}  [by {author}]
        ### Resolved
        - p.{N} {Shape} — …
        ## Questions  (n)
        …
        (Sections with zero items are omitted entirely)

    Args:
        doc:   Document record dict from db.get_document().
        pages: Dict mapping page index string → Fabric JSON { objects: [...] }.

    Returns:
        Markdown string. The browser renders it via DOM (no innerHTML) — safe to
        return as-is without further sanitization.
    """
    entries = _extract_markup_entries(pages)
    filename = doc.get("filename", "Untitled")
    date_str = datetime.utcnow().strftime("%B %d, %Y")

    total = len(entries)
    open_count = sum(1 for e in entries if e["markup_status"] != "resolved")

    lines = [
        f"# Review Brief — {filename}",
        f"{date_str}   {open_count} open / {total} total",
        "---",
    ]

    if total == 0:
        lines.append("*No annotation markups on this document yet.*")
        return "\n".join(lines)

    TYPE_ORDER = ("issue", "question", "change", "note", "approval")
    TYPE_TITLES = {
        "issue":    "Issues",
        "question": "Questions",
        "change":   "Change Requests",
        "note":     "Notes",
        "approval": "Approvals",
    }

    for mtype in TYPE_ORDER:
        type_entries = [e for e in entries if e["markup_type"] == mtype]
        if not type_entries:
            continue

        lines.append(f"## {TYPE_TITLES[mtype]}  ({len(type_entries)})")

        open_group     = [e for e in type_entries if e["markup_status"] != "resolved"]
        resolved_group = [e for e in type_entries if e["markup_status"] == "resolved"]

        for group_label, group in [("Open", open_group), ("Resolved", resolved_group)]:
            if not group:
                continue
            lines.append(f"### {group_label}")
            for e in group:
                page_disp = e["page_num"] + 1  # convert 0-indexed → 1-indexed for display
                note = e["markup_note"] if e["markup_note"] else "(no note)"
                entry_line = f"- p.{page_disp} {e['shape_label']} — {note}"
                if e["markup_author"]:
                    entry_line += f"  [by {e['markup_author']}]"
                lines.append(entry_line)

    # Build tag index — collect all tags and the entries that reference them.
    # Entries reference format: "p.N Shape — first 70 chars of note"
    tag_index: dict = {}
    for e in entries:
        for tag in _parse_tags(e["markup_note"]):
            if tag not in tag_index:
                tag_index[tag] = []
            note_preview = e["markup_note"][:70].rstrip()
            if len(e["markup_note"]) > 70:
                note_preview += "…"
            tag_index[tag].append(
                f"p.{e['page_num'] + 1} {e['shape_label']} — {note_preview}"
            )

    if tag_index:
        lines.append("## Tag Index")
        for tag in sorted(tag_index.keys()):
            refs = tag_index[tag]
            lines.append(f"### #{tag}  ({len(refs)})")
            for ref in refs:
                lines.append(f"- {ref}")

    return "\n".join(lines)


def _generate_rfi_document(
    doc: dict,
    pages: dict,
    filters: dict,
    header: dict,
) -> str:
    """
    Generate a Markdown-formatted RFI (Request for Information) document.

    Unlike the Review Brief (which groups by type), an RFI is a numbered list
    of discrete items submitted to a specific party. The format mirrors industry
    RFI practice: formal header block, numbered items with location and description.

    Filters:
        types    — list of markupType strings to include, e.g. ['issue', 'question']
                   Empty list means include all types.
        tags     — list of tag strings (without #) to filter by; empty = all
        statuses — list of status strings ('open', 'resolved'); empty = all

    Header fields (all optional, default to placeholder text):
        rfi_no   — RFI number/ID, e.g. "RFI-042"
        project  — Project name
        drawing  — Drawing reference (sheet number, revision)
        to       — Recipient name/role
        from_    — Sender name/role (key is 'from' in the dict)

    Returns:
        Markdown string. Browser renders via DOM (no innerHTML) — safe as-is.
    """
    entries = _extract_markup_entries(pages)
    filename = doc.get("filename", "Untitled")
    date_str = datetime.utcnow().strftime("%B %d, %Y")

    # --- Apply filters ---
    allowed_types    = set(filters.get("types", []))
    allowed_tags     = set(t.lstrip("#").lower() for t in filters.get("tags", []))
    allowed_statuses = set(filters.get("statuses", []))

    def _entry_passes(e: dict) -> bool:
        """Return True if the entry should be included in the RFI."""
        if allowed_types and e["markup_type"] not in allowed_types:
            return False
        if allowed_statuses and e["markup_status"] not in allowed_statuses:
            return False
        if allowed_tags:
            entry_tags = set(_parse_tags(e["markup_note"]))
            if not entry_tags.intersection(allowed_tags):
                return False
        return True

    filtered = [e for e in entries if _entry_passes(e)]

    # --- RFI header block ---
    rfi_no   = header.get("rfi_no",  "").strip() or "—"
    project  = header.get("project", "").strip() or "—"
    drawing  = header.get("drawing", "").strip() or "—"
    to_party = header.get("to",      "").strip() or "—"
    fr_party = header.get("from",    "").strip() or "—"

    lines = [
        f"# RFI {rfi_no} — {filename}",
        "",
        f"**Date:** {date_str}",
        f"**Project:** {project}",
        f"**Drawing:** {drawing}",
        f"**To:** {to_party}",
        f"**From:** {fr_party}",
        f"**Items:** {len(filtered)}",
        "",
        "---",
        "",
    ]

    if not filtered:
        lines.append("*No markups match the selected filters.*")
        return "\n".join(lines)

    # --- Numbered items ---
    for i, e in enumerate(filtered, start=1):
        pg  = e["page_num"] + 1          # 1-based page number for display
        shp = e["shape_label"]
        typ = e["markup_type"].capitalize()
        sts = e["markup_status"].capitalize()
        note = e["markup_note"] or "—"
        author = e.get("markup_author", "")

        lines.append(f"## Item {i} — {typ} (p.{pg} {shp})")
        lines.append("")
        lines.append(f"**Location:** Page {pg}, {shp}")
        lines.append(f"**Status:** {sts}")
        if author:
            lines.append(f"**Submitted by:** {author}")
        lines.append("")
        lines.append(f"**Description:**")
        lines.append(note)
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


@app.post("/api/documents/{doc_id}/generate-rfi")
async def generate_rfi(doc_id: int, request: Request):
    """
    Generate and return a Markdown RFI document from live canvas data.

    Identical payload pattern to /review-brief: the browser sends the full
    live canvas state so the RFI reflects unsaved changes. The caller also
    provides filter criteria and header metadata for the formal RFI block.

    Request body:
        {
          "pages":   { "0": {fabricJSON}, "1": {fabricJSON}, ... },
          "filters": { "types": [...], "tags": [...], "statuses": [...] },
          "header":  { "rfi_no": str, "project": str, "drawing": str, "to": str, "from": str }
        }

    Returns:
        { "markdown": str, "item_count": int }

    Security:
        - Validates document exists before processing
        - Pages data parsed from JSON body (never executed)
        - All string fields sanitized by _generate_rfi_document (treated as text, not HTML)
        - Markdown returned as plain text; browser renders via DOM (no innerHTML risk)
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    pages   = body.get("pages",   {})
    filters = body.get("filters", {})
    header  = body.get("header",  {})

    if not isinstance(pages,   dict): pages   = {}
    if not isinstance(filters, dict): filters = {}
    if not isinstance(header,  dict): header  = {}

    md = _generate_rfi_document(doc, pages, filters, header)

    # Count the generated items (lines that start with "## Item ")
    item_count = sum(1 for line in md.splitlines() if line.startswith("## Item "))

    return JSONResponse({"markdown": md, "item_count": item_count})


@app.post("/api/documents/{doc_id}/review-brief")
async def review_brief(doc_id: int, request: Request):
    """
    Generate and return a Markdown review brief from live canvas data.

    The browser sends the full page markup payload in the request body
    (same format as /api/documents/{id}/markups) so the brief always reflects
    the current working state including unsaved changes — not just what's in the DB.

    Request body:
        { "pages": { "0": {fabricJSON}, "1": {fabricJSON}, ... } }

    Returns:
        {
          "markdown":  str,  # full Markdown brief
          "total":     int,  # total annotation markups
          "open":      int,  # open items
          "resolved":  int,  # resolved items
        }

    Security:
        - Validates document exists before processing
        - Pages data parsed from JSON body (never executed)
        - Markdown returned as plain text; browser renders via DOM (no innerHTML risk)
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    pages = body.get("pages", {})
    if not isinstance(pages, dict):
        pages = {}

    md = _generate_review_brief(doc, pages)

    # Compute summary counts for the panel header badges
    entries = _extract_markup_entries(pages)
    total = len(entries)
    open_count = sum(1 for e in entries if e["markup_status"] != "resolved")

    return JSONResponse({
        "markdown": md,
        "total":    total,
        "open":     open_count,
        "resolved": total - open_count,
    })


# =============================================================================
# API ROUTES — OBSIDIAN EXPORT
# =============================================================================

@app.post("/api/documents/{doc_id}/export-obsidian")
async def export_obsidian(doc_id: int, request: Request):
    """
    Export all markup annotations as an Obsidian-compatible ZIP of Markdown files.

    Implements the one-way SyncAdapter described in the nodeCAST Phase 2 council
    session. Each markup becomes one atomic Markdown note with YAML frontmatter
    so the notes are immediately queryable via Obsidian Dataview.

    Request body:
        { "pages": { "0": {fabricJSON}, "1": {fabricJSON}, ... } }

    The browser sends the live canvas state (same format as the markups save
    endpoint) so the export always reflects the current session including any
    unsaved changes.

    ZIP structure:
        {document_stem}/
            page-{N}/
                {type}-{uuid}.md   — one file per markup annotation

    Each .md file YAML frontmatter fields:
        markupId:   UUID string (stable key for future sync)
        type:       markupType ('issue' | 'question' | 'change' | 'note' | 'approval')
        status:     markupStatus ('open' | 'resolved')
        tags:       YAML list of tag name strings (without # prefix)
        document:   original PDF filename
        page:       1-based page number
        source:     deep-link URL back to the PortolanCAST canvas (markupId select)

    After the frontmatter, the note body contains:
        - The markupNote text (if present), then a blank line
        - Obsidian wikilinks for each tag  ([[tagname]])

    Security:
        - Validates document exists before processing
        - All user text written via yaml.safe_dump-style manual escaping
          (no yaml module dependency needed — values are safe primitives)
        - ZIP bytes returned in-memory — no temp files written to disk
        - Content-Disposition filename derived from document stem (no path traversal)

    Args:
        doc_id: Document database ID.

    Returns:
        ZIP file as application/zip with Content-Disposition attachment.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    pages = body.get("pages", {})
    if not isinstance(pages, dict):
        pages = {}

    # Document stem used as the top-level folder inside the ZIP
    # e.g. "Drawing_A1.pdf" → "Drawing_A1"
    doc_stem = Path(doc["filename"]).stem

    # Build an in-memory ZIP
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for page_key, fabric_json in pages.items():
            if not isinstance(fabric_json, dict):
                continue

            try:
                page_num_0 = int(page_key)   # 0-based page index
            except (ValueError, TypeError):
                continue

            page_num_1 = page_num_0 + 1      # 1-based for human display

            objects = fabric_json.get("objects", [])
            if not isinstance(objects, list):
                continue

            for obj in objects:
                if not isinstance(obj, dict):
                    continue

                # Only annotation markup objects — skip measurements + companions
                markup_type = obj.get("markupType", "")
                if not markup_type:
                    continue
                measurement_type = obj.get("measurementType", "")
                if measurement_type in ("distance", "area", "count"):
                    continue
                # Area companion IText labels
                obj_type = obj.get("type", "")
                if measurement_type == "area" and obj_type in ("IText", "i-text"):
                    continue

                markup_id     = obj.get("markupId", "")
                markup_status = obj.get("markupStatus", "open")
                markup_note   = obj.get("markupNote", "") or ""
                markup_author = obj.get("markupAuthor", "") or ""

                tags = _parse_tags(markup_note)

                # ── Build deep-link source URL ─────────────────────────────────
                # The markupId UUID + page are enough to navigate back from Obsidian.
                # Example: http://127.0.0.1:8000/edit/1?page=3&select=uuid
                # This URL opens PortolanCAST, navigates to the page, and selects
                # the markup — bidirectional navigation with no extra server changes.
                source_url = (
                    f"http://127.0.0.1:8000/edit/{doc_id}"
                    f"?page={page_num_1}"
                    + (f"&select={markup_id}" if markup_id else "")
                )

                # ── Build YAML frontmatter ─────────────────────────────────────
                # Manual construction avoids a PyYAML dependency.
                # Values are safe string primitives — no injection risk.
                # Strings containing special YAML chars are quoted.

                def yaml_str(s: str) -> str:
                    """Quote a string value if it contains YAML special chars."""
                    s = str(s)
                    if any(c in s for c in (':', '#', '[', ']', '{', '}', ',', '|', '>', '"', "'")):
                        # Use double-quote style; escape inner double quotes
                        return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
                    return s if s else '""'

                # Build YAML tag list.  Each tag is scoped under the document
                # stem so Obsidian's tag pane shows a hierarchy:
                #   #example_mechanical2/valve
                #   #example_mechanical2/pressure
                # The trailing \n is required on the empty-list branch so that
                # the next YAML key ("document:") starts on its own line.
                tag_list = (
                    "\n" + "".join(f"  - {doc_stem}/{t}\n" for t in tags)
                    if tags else " []\n"
                )

                frontmatter = (
                    "---\n"
                    f"markupId: {yaml_str(markup_id)}\n"
                    f"type: {yaml_str(markup_type)}\n"
                    f"status: {yaml_str(markup_status)}\n"
                    f"tags:{tag_list}"
                    f"document: {yaml_str(doc['filename'])}\n"
                    f"page: {page_num_1}\n"
                    f"author: {yaml_str(markup_author)}\n"
                    f"source: {yaml_str(source_url)}\n"
                    "---\n"
                )

                # ── Build note body ────────────────────────────────────────────
                body_parts = []
                if markup_note:
                    body_parts.append(markup_note.strip())
                if tags:
                    wikilinks = "  ".join(f"[[{t}]]" for t in tags)
                    body_parts.append(wikilinks)

                note_body = "\n\n".join(body_parts) + "\n" if body_parts else "\n"

                # ── ZIP path: {stem}/page-{N}/{type}-{uuid}.md ─────────────────
                # Use a short suffix of the UUID if no ID exists (shouldn't happen
                # in practice — all Fabric objects get a markupId via stampDefaults)
                file_id = markup_id if markup_id else f"nouid-{obj_type}"
                zip_path = f"{doc_stem}/page-{page_num_1}/{markup_type}-{file_id}.md"

                zf.writestr(zip_path, frontmatter + note_body)

    # Rewind buffer and return as a ZIP download
    buf.seek(0)
    safe_stem = doc_stem.replace(" ", "_")
    filename  = f"{safe_stem}_obsidian.zip"

    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# =============================================================================
# TEXT / OCR EXTRACTION
# =============================================================================

@app.get("/api/documents/{doc_id}/text/{page_number}")
async def get_page_text(doc_id: int, page_number: int, ocr: bool = False):
    """
    Extract text content from a PDF page.

    Two-tier extraction:
      - Tier 1 (always): PyMuPDF native text layer — fast, zero extra deps.
        Works for born-digital PDFs (reports, specifications, CAD exports).
        Returns empty text for scanned image PDFs.
      - Tier 2 (ocr=true): Tesseract OCR fallback for scanned documents.
        Only attempted when native text is empty AND Tesseract is installed.
        Gracefully disabled when pytesseract / tesseract binary are absent.

    Query params:
        ocr (bool): If True, fall back to OCR when no native text is found.

    Returns:
        JSON with:
          text            (str)  — extracted text, whitespace-normalised
          word_count      (int)  — approximate word count
          char_count      (int)  — character count (excluding whitespace)
          has_native_text (bool) — whether native text layer had content
          method          (str)  — 'native' | 'ocr' | 'none'
          ocr_available   (bool) — whether Tesseract can be used
          page            (int)  — echo of page_number
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    filepath = doc['filepath']
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="PDF file not found on disk")

    try:
        result = pdf_engine.extract_text(filepath, page_number, use_ocr=ocr)
        return JSONResponse(content=result)
    except IndexError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# API ROUTES — EQUIPMENT ENTITY REGISTRY (Stage 3)
# =============================================================================

import re as _re_stage3

# Tag pattern for OCR detection: 2-5 uppercase letters, dash, 1-4 digits + optional letter.
# Matches: PRV-201, AHU-3, VFD-12A, VAV-102, FCU-1, PUMP-3B
# Does NOT match: A-1 (prefix too short), ABCDEF-1 (prefix too long)
_TAG_PATTERN = _re_stage3.compile(r'\b([A-Z]{2,5}-\d{1,4}[A-Z]?)\b')


@app.post("/api/entities")
async def create_entity(request: Request):
    """
    Create a new equipment entity.

    Returns 409 if (building, tag_number) already exists, with the existing
    entity in the response body so the frontend can show a merge prompt.

    Body:
        { tag_number, building?, equip_type?, model?, serial?, location? }

    Returns:
        201: { id, tag_number, building, equip_type, model, serial, location, created_at }
        409: { detail: "tag_exists", entity: {...existing entity...} }
    """
    body = await request.json()

    # SECURITY: validate required field
    tag_number = str(body.get("tag_number", "")).strip()[:128]
    if not tag_number:
        raise HTTPException(status_code=400, detail="tag_number is required")

    building   = str(body.get("building", "")).strip()[:256]
    equip_type = str(body.get("equip_type", "")).strip()[:256]
    model      = str(body.get("model", "")).strip()[:256]
    serial     = str(body.get("serial", "")).strip()[:256]
    location   = str(body.get("location", "")).strip()[:512]

    entity_id = uuid.uuid4().hex

    import sqlite3 as _sqlite3
    try:
        entity = db.create_entity(
            entity_id, tag_number, building, equip_type, model, serial, location
        )
        return JSONResponse(status_code=201, content=entity)
    except _sqlite3.IntegrityError:
        # (building, tag_number) already exists — return 409 with the existing entity
        # so the frontend can prompt "merge with existing?" instead of silently failing.
        existing = db.get_entity_by_tag(tag_number, building=building)
        return JSONResponse(
            status_code=409,
            content={"detail": "tag_exists", "entity": existing}
        )


@app.get("/api/entities")
async def list_entities(equip_type: str = None, location: str = None,
                        building: str = None):
    """
    Return all entities, optionally filtered by equip_type, location, or building.

    Query params:
        equip_type: Exact match filter
        location:   Prefix match filter (e.g., "Floor-2" also returns "Floor-2 / MER")
        building:   Exact match filter (e.g., "Bldg-A")

    Returns:
        { entities: [...], total: N }
    """
    entities = db.get_all_entities(equip_type=equip_type, location=location,
                                   building=building)
    return JSONResponse({"entities": entities, "total": len(entities)})


@app.get("/api/entities/by-tag/{tag_number:path}")
async def get_entity_by_tag(tag_number: str):
    """
    Look up an entity by its tag number (the natural key).

    Uses :path so slashes in the tag are preserved, though standard equipment
    tags don't contain slashes (PRV-201, AHU-3 etc.).

    Returns:
        { entity: {...} }  or  404
    """
    entity = db.get_entity_by_tag(tag_number)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")
    return JSONResponse({"entity": entity})


@app.get("/api/entities/{entity_id}")
async def get_entity(entity_id: str):
    """
    Return a full entity dossier: fields + log entries + markup count.

    Used by the Entity detail modal which needs all three in one shot.

    Returns:
        { entity: {...}, log: [...], markup_count: N }
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    log = db.get_entity_log(entity_id)
    count = db.get_entity_markup_count(entity_id)
    return JSONResponse({"entity": entity, "log": log, "markup_count": count})


@app.put("/api/entities/{entity_id}")
async def update_entity(entity_id: str, request: Request):
    """
    Partial update of an entity's fields.

    Only fields present in the body are updated; omitted fields are unchanged.
    tag_number updates go through the same UNIQUE constraint — IntegrityError → 409.

    Body:
        { equip_type?, model?, serial?, location?, tag_number?, building? }  (all optional)

    Returns:
        { entity: {...updated...} }
    """
    entity = db.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    body = await request.json()

    # SECURITY: sanitize each field; only known fields reach db.update_entity
    allowed = ['tag_number', 'building', 'equip_type', 'model', 'serial', 'location']
    updates = {}
    for key in allowed:
        if key in body:
            updates[key] = str(body[key]).strip()[:512]

    import sqlite3 as _sqlite3
    try:
        db.update_entity(entity_id, **updates)
    except _sqlite3.IntegrityError:
        # tag_number conflict — another entity already has that tag
        raise HTTPException(status_code=409, detail="tag_number already in use")

    updated = db.get_entity(entity_id)
    return JSONResponse({"entity": updated})


@app.delete("/api/entities/{entity_id}")
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


@app.post("/api/entities/{entity_id}/log")
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

    # Return the created entry — fetch it to include server-generated created_at
    entries = db.get_entity_log(entity_id)
    created = next((e for e in entries if e["id"] == log_id), None)
    return JSONResponse(status_code=201, content=created or {"id": log_id, "entity_id": entity_id, "note": note})


@app.get("/api/entities/{entity_id}/log")
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


@app.get("/api/entities/{entity_id}/markups")
async def get_entity_markups(entity_id: str):
    """
    Return all markups linked to an entity, across ALL documents.

    This is the core cross-document query — one entity, many observations
    spread across different drawings. Each row includes doc_name so the
    Entity modal can display "Riser Diagram.pdf  Page 2" without a second fetch.

    Returns:
        { markups: [{ markup_id, doc_id, doc_name, page_number }] }
    """
    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")
    markups = db.get_entity_markups(entity_id)
    return JSONResponse({"markups": markups})


@app.post("/api/documents/{doc_id}/markup-entities")
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

    # SECURITY: validate required fields
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


@app.delete("/api/documents/{doc_id}/markup-entities/{markup_id}")
async def unlink_markup_entity(doc_id: int, markup_id: str):
    """
    Remove the link between a markup and its entity.

    The doc_id is validated to ensure the document exists, but the markup→entity
    link in markup_entities is keyed only by markup_id (not scoped to doc_id),
    so a markup can only be linked to one entity and the unlink is unambiguous.

    Returns:
        { unlinked: true }  or  404
    """
    if not db.get_document(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")

    # We need the entity_id to call unlink_markup_entity — fetch via markup_id
    entity = db.get_markup_entity(markup_id)
    if not entity:
        raise HTTPException(status_code=404, detail="No entity linked to this markup")

    db.unlink_markup_entity(markup_id, entity["id"])
    return JSONResponse({"unlinked": True})


@app.get("/api/documents/{doc_id}/markup-entities/{markup_id}")
async def get_markup_entity(doc_id: int, markup_id: str):
    """
    Return the entity linked to a specific markup, or { entity: null }.

    Used by the properties panel on every selection to determine which of
    the three entity section states to show (unlinked / merge prompt / linked).

    Returns:
        { entity: {...} }  or  { entity: null }
    """
    if not db.get_document(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")

    entity = db.get_markup_entity(markup_id)
    return JSONResponse({"entity": entity})


@app.post("/api/documents/{doc_id}/pages/{page_number}/detect-tags")
async def detect_tags(doc_id: int, page_number: int):
    """
    Scan a page's stored text layer for equipment tag patterns.

    Reads the text_layer_{page_number} document setting (stored by the OCR/text
    extraction endpoint). Applies TAG_PATTERN to find matches, returning each
    match with its bounding box so the frontend can compute proximity to markups.

    Returns:
        { tags: [{ tag_number, x, y, width, height, confidence }] }
        (Empty array if no text layer data exists for this page.)
    """
    if not db.get_document(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")

    text_layer_json = db.get_document_setting(doc_id, f"text_layer_{page_number}")
    if not text_layer_json:
        return JSONResponse({"tags": []})

    import json as _json_entity
    try:
        text_layer = _json_entity.loads(text_layer_json)
    except Exception:
        return JSONResponse({"tags": []})

    found_tags = []
    # text_layer is a list of { text, x, y, width, height } objects from PyMuPDF spans
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
                    "confidence": 1.0,  # pattern-based match is deterministic
                })

    return JSONResponse({"tags": found_tags})


# =============================================================================
# SPRINT 1: QUICK CAPTURE — Task & Entity Photo Routes
# =============================================================================

# ---- Entity Tasks ----

@app.post("/api/entities/{entity_id}/tasks")
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


@app.get("/api/entities/{entity_id}/tasks")
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


@app.put("/api/tasks/{task_id}")
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


@app.delete("/api/tasks/{task_id}")
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


@app.get("/api/tasks")
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


# ---- Entity Photos ----

@app.post("/api/entities/{entity_id}/photos")
async def upload_entity_photo(entity_id: str, file: UploadFile = File(...)):
    """
    Upload a photo directly to an entity (not via markup).

    Accepts multipart form upload. Validates file extension.
    Stores file as UUID.ext in PHOTOS_DIR/entities/.

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
    # Add URL for frontend consumption
    photo["url"] = f"/data/photos/entities/{stored_name}"
    return JSONResponse(status_code=201, content={"photo": photo})


@app.get("/api/entities/{entity_id}/photos")
async def get_entity_photos(entity_id: str):
    """
    List all photos for an entity, with URLs.

    Returns:
        { photos: [{ id, entity_id, filename, caption, created_at, url }] }
    """
    if not db.get_entity(entity_id):
        raise HTTPException(status_code=404, detail="Entity not found")

    photos = db.get_entity_photos(entity_id)
    # Add URL for each photo
    for p in photos:
        p["url"] = f"/data/photos/entities/{p['filename']}"
    return JSONResponse({"photos": photos})


@app.delete("/api/entity-photos/{photo_id}")
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
        # Log but don't fail — DB record is already cleaned up
        print(f"[WARN] Failed to delete entity photo file {file_path}: {e}")

    return JSONResponse({"deleted": True})


# ---- Maintenance Report ----

@app.get("/api/maintenance-report")
async def get_maintenance_report():
    """
    Generate a Markdown maintenance report grouped by location.

    Each entity section shows open tasks and last 3 log entries.
    Designed for copy-paste into email or printing.

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
            if loc != bldg:  # avoid redundant header if location == building
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


# ---- Database Backup ----

@app.get("/api/backup")
async def download_backup():
    """
    Create and download a crash-consistent database backup.

    Uses SQLite's backup API for a safe snapshot even while the app is running.
    The backup file is streamed as a download with a timestamped filename.

    Returns:
        Binary .db file download (application/octet-stream)
    """
    try:
        backup_path = db.backup()
        # Read the backup into memory and stream it — file is small (typically < 50MB)
        backup_bytes = backup_path.read_bytes()
        return Response(
            content=backup_bytes,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f"attachment; filename={backup_path.name}",
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Backup failed: {str(e)}")


@app.get("/api/backups")
async def list_backups():
    """
    List available auto-backup files with size and timestamp.

    Returns:
        { backups: [{ filename, size_bytes, created_at }], total: N }
    """
    backups = db.list_backups()
    return JSONResponse({"backups": backups, "total": len(backups)})


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="PortolanCAST server")
    parser.add_argument(
        "--port", type=int, default=8000,
        help="Port to listen on (default: 8000)"
    )
    parser.add_argument(
        "--no-reload", action="store_true",
        help="Disable auto-reload (use in production / frozen builds)"
    )
    args = parser.parse_args()

    # When --no-reload is set (frozen PyInstaller builds), pass the app object
    # directly. uvicorn.run("main:app") tries to re-import "main" as a module,
    # which fails inside a PyInstaller bundle where the module system is different.
    # With reload enabled (development), the string form is required so uvicorn
    # can re-import the module on file changes.
    if args.no_reload:
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=args.port,
            log_level="info"
        )
    else:
        uvicorn.run(
            "main:app",
            host="127.0.0.1",
            port=args.port,
            reload=True,
            log_level="info"
        )
