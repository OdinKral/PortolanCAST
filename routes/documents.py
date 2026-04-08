"""
PortolanCAST — Document CRUD Routes

Purpose:
    PDF/DXF/DWG upload, blank document creation, page addition, document
    info/listing, thumbnail rendering, deletion, and PDF export with annotations.

Security assumptions:
    - File uploads restricted to PDF/DXF/DWG formats with magic byte validation
    - UUID filenames prevent path traversal and collisions
    - Document IDs validated against DB before any file operation
    - DWG conversion uses subprocess with list args (no shell injection)

Author: PortolanCAST
Version: 0.2.0
Date: 2026-03-30
"""

import io
import json
import logging
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from fastapi.responses import Response, JSONResponse, StreamingResponse

from config import (
    db, pdf_engine, dxf_engine, PROJECTS_DIR, PAGE_SIZES,
    MAX_UPLOAD_SIZE, ALLOWED_EXTENSIONS,
)
from dxf_engine import convert_dwg_to_dxf

logger = logging.getLogger(__name__)

router = APIRouter()

# CAD source formats — documents whose rendering goes through dxf_engine
_CAD_FORMATS = {"dxf", "dwg"}


def _is_cad_document(doc_id: int) -> bool:
    """Check if a document was uploaded as a CAD file (DXF or DWG)."""
    fmt = db.get_document_setting(doc_id, "source_format")
    return fmt in _CAD_FORMATS


def _get_cad_filepath(doc: dict) -> str:
    """
    Get the DXF filepath for a CAD document.

    For DWG uploads, the filepath still points to the DWG original but the
    converted DXF lives alongside it (same name, .dxf extension). For DXF
    uploads, filepath already points to the DXF.
    """
    fp = Path(doc["filepath"])
    if fp.suffix.lower() == ".dwg":
        # DWG was converted to DXF at upload time — use the converted file
        dxf_path = fp.with_suffix(".dxf")
        if dxf_path.exists():
            return str(dxf_path)
    return str(fp)


@router.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    """
    Upload a PDF, DXF, or DWG file.

    Validates the file format, saves it to the projects directory,
    extracts metadata, and registers it in the database.

    DWG files are converted to DXF server-side (requires ODA File Converter
    or LibreDWG). DXF files are parsed directly by ezdxf for layer/block
    extraction and rendered to PNG via matplotlib.

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
            detail=f"Unsupported format (got {ext}). "
            f"Accepted: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    # Read the file content
    content = await file.read()

    # SECURITY: Check file size
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large (max {MAX_UPLOAD_SIZE // 1024 // 1024}MB)"
        )

    # SECURITY: Format-specific magic byte validation
    if ext == ".pdf":
        if not content[:5] == b'%PDF-':
            raise HTTPException(
                status_code=400,
                detail="File does not appear to be a valid PDF"
            )
    elif ext == ".dwg":
        # DWG magic bytes: "AC10" (AutoCAD 2.5+) at offset 0
        if not content[:4] == b'AC10' and not content[:2] == b'AC':
            raise HTTPException(
                status_code=400,
                detail="File does not appear to be a valid DWG"
            )
    elif ext == ".dxf":
        # DXF is plain text or binary. Text DXF starts with "0" or whitespace+0.
        # Binary DXF starts with "AutoCAD Binary DXF"
        header = content[:50].strip()
        if not (header.startswith(b'0') or header.startswith(b'AutoCAD')):
            raise HTTPException(
                status_code=400,
                detail="File does not appear to be a valid DXF"
            )

    # Generate unique filename to prevent collisions
    unique_name = f"{uuid.uuid4().hex}_{file.filename}"
    # SECURITY: sanitize filename — remove path separators
    safe_name = unique_name.replace("/", "_").replace("\\", "_")
    save_path = PROJECTS_DIR / safe_name

    # Write file to disk
    with open(save_path, "wb") as f:
        f.write(content)

    # -------------------------------------------------------------------------
    # Format-specific processing
    # -------------------------------------------------------------------------
    source_format = ext.lstrip(".")

    if ext == ".dwg":
        # Convert DWG → clean DXF using the repair pipeline:
        # DWG → LibreDWG → raw DXF → text parse → ezdxf rebuild → clean DXF
        from dwg_converter import convert_and_repair, is_converter_available
        if not is_converter_available():
            save_path.unlink(missing_ok=True)
            raise HTTPException(
                status_code=400,
                detail=(
                    "No DWG converter found. Install LibreDWG (dwg2dxf.exe) at "
                    "~/.local/libredwg/ or the ODA File Converter. "
                    "Alternatively, export the file as DXF from your CAD software."
                )
            )
        try:
            clean_dxf = str(save_path.with_suffix(".dxf"))
            convert_and_repair(str(save_path), clean_dxf)
            working_path = clean_dxf
            source_format = "dwg"
        except Exception as e:
            save_path.unlink(missing_ok=True)
            raise HTTPException(
                status_code=400,
                detail=f"DWG conversion failed: {e}"
            )
    elif ext == ".dxf":
        working_path = str(save_path)
    else:
        working_path = str(save_path)

    # Extract metadata based on format
    if ext in (".dxf", ".dwg"):
        try:
            info = dxf_engine.get_dxf_info(working_path)
        except Exception as e:
            save_path.unlink(missing_ok=True)
            raise HTTPException(
                status_code=400, detail=f"Invalid DXF: {e}"
            )
    else:
        # PDF path — unchanged from original
        try:
            info = pdf_engine.get_pdf_info(str(save_path))
        except (ValueError, Exception) as e:
            save_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=f"Invalid PDF: {e}")

    # Register in database
    doc_id = db.add_document(
        filename=file.filename,
        filepath=working_path if ext in (".dxf", ".dwg") else str(save_path),
        page_count=info["page_count"],
        file_size=info["file_size"]
    )

    # Store source format and CAD metadata as document settings
    if ext in (".dxf", ".dwg"):
        db.set_document_setting(doc_id, "source_format", source_format)
        if ext == ".dwg":
            # Keep reference to original DWG file
            db.set_document_setting(doc_id, "dwg_filepath", str(save_path))
        # Store layer count and block count for the UI
        db.set_document_setting(
            doc_id, "cad_layer_count", str(len(info.get("layers", [])))
        )
        db.set_document_setting(
            doc_id, "cad_block_count", str(len(info.get("blocks", [])))
        )
        db.set_document_setting(
            doc_id, "cad_entity_count", str(info.get("entity_count", 0))
        )

    response = {
        "id": doc_id,
        "filename": file.filename,
        "page_count": info["page_count"],
        "file_size": info["file_size"],
        "page_sizes": info["page_sizes"],
        "source_format": source_format,
        "redirect": f"/edit/{doc_id}"
    }

    # Include CAD-specific info in the response
    if ext in (".dxf", ".dwg"):
        response["layers"] = info.get("layers", [])
        response["blocks"] = info.get("blocks", [])
        response["entity_count"] = info.get("entity_count", 0)
        logger.info(
            "CAD upload: %s — %d layers, %d blocks, %d entities",
            file.filename, len(info.get("layers", [])),
            len(info.get("blocks", [])), info.get("entity_count", 0)
        )

    return JSONResponse(response)


@router.get("/api/cad/converter-status")
async def get_converter_status():
    """
    Check whether a DWG-to-DXF converter is available on this system.

    Used by the frontend to show/hide the DWG upload option and display
    installation instructions if needed.

    Returns:
        JSON with 'available' bool, 'converter' name, 'formats' list.
    """
    from dwg_converter import get_converter_info
    info = get_converter_info()
    return JSONResponse({
        "dwg_converter_available": info["available"],
        "converter": info["type"] or "none",
        "converter_path": info["path"],
        "supported_formats": ["pdf", "dxf"] + (["dwg"] if info["available"] else []),
    })


@router.get("/api/documents/{doc_id}/cad-info")
async def get_cad_info(doc_id: int):
    """
    Get CAD-specific metadata: text entities, block insertions, layer details.

    Returns structured data that can be used to auto-populate PortolanCAST
    entities from the CAD drawing — room names from text, equipment from blocks.

    Returns 404 if the document is not a CAD file.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not _is_cad_document(doc_id):
        raise HTTPException(status_code=400, detail="Not a CAD document")

    cad_path = _get_cad_filepath(doc)
    if not Path(cad_path).exists():
        raise HTTPException(status_code=404, detail="CAD file missing from disk")

    try:
        texts = dxf_engine.get_text_entities(cad_path)
        blocks = dxf_engine.get_block_insertions(cad_path)
        layers = dxf_engine.get_layers(cad_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"CAD parse error: {e}")

    return JSONResponse({
        "doc_id": doc_id,
        "source_format": db.get_document_setting(doc_id, "source_format"),
        "layers": layers,
        "text_entities": texts,
        "block_insertions": blocks,
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
        raise HTTPException(status_code=404, detail="Document file missing from disk")

    # Load user-defined layer aliases (if any)
    aliases_json = db.get_document_setting(doc_id, "layer_aliases")
    aliases = json.loads(aliases_json) if aliases_json else {}

    try:
        if _is_cad_document(doc_id):
            # DXF layers come from ezdxf — includes color and visibility state
            cad_path = _get_cad_filepath(doc)
            layers = dxf_engine.get_layers(cad_path)
        else:
            layers = pdf_engine.get_pdf_layers(doc["filepath"])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cannot read layers: {e}")

    # Attach user-defined aliases to each layer
    for layer in layers:
        layer["alias"] = aliases.get(layer["name"], "")

    return JSONResponse({"layers": layers})


@router.put("/api/documents/{doc_id}/pdf-layers/rename")
async def rename_pdf_layer(doc_id: int, request: Request):
    """
    Set a user-friendly alias for a PDF OCG layer.

    The original OCG name is preserved (it's needed for content stream filtering).
    The alias is stored in document_settings and returned alongside the original
    name in the layers list.

    Body JSON:
        {"layer": "MP-HOTW-SUPP-PIPE", "alias": "Hot Water Supply"}

    To clear an alias, send an empty string:
        {"layer": "MP-HOTW-SUPP-PIPE", "alias": ""}
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    layer_name = str(body.get("layer", "")).strip()
    alias = str(body.get("alias", "")).strip()

    if not layer_name:
        raise HTTPException(status_code=400, detail="'layer' is required")

    # SECURITY: Limit alias length to prevent abuse
    alias = alias[:128]

    # Load existing aliases, update, save back
    aliases_json = db.get_document_setting(doc_id, "layer_aliases")
    aliases = json.loads(aliases_json) if aliases_json else {}

    if alias:
        aliases[layer_name] = alias
    else:
        aliases.pop(layer_name, None)

    db.set_document_setting(doc_id, "layer_aliases", json.dumps(aliases))

    return JSONResponse({"layer": layer_name, "alias": alias})


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
        raise HTTPException(status_code=404, detail="Document file missing from disk")

    # Parse hidden_layers query param into a list of layer names
    # SECURITY: layer names are passed to the content stream filter, not executed
    hidden_list = [name.strip() for name in hidden_layers.split(",") if name.strip()] \
                  if hidden_layers else []

    try:
        if _is_cad_document(doc_id):
            # CAD rendering — dxf_engine handles layer visibility natively
            cad_path = _get_cad_filepath(doc)
            png_bytes = dxf_engine.render_page(
                cad_path, page_number, dpi=float(dpi),
                hidden_layers=hidden_list or None,
            )
        elif hidden_list:
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
        if _is_cad_document(doc_id):
            # CAD thumbnails — render at low DPI for sidebar preview
            cad_path = _get_cad_filepath(doc)
            png_bytes = dxf_engine.render_to_png(cad_path, dpi=36.0)
        else:
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

    # Remove the document file from disk
    filepath = Path(doc["filepath"])
    if filepath.exists():
        filepath.unlink()

    # For DWG uploads, also remove the converted DXF (or vice versa)
    if _is_cad_document(doc_id):
        dwg_setting = db.get_document_setting(doc_id, "dwg_filepath")
        if dwg_setting:
            dwg_path = Path(dwg_setting)
            if dwg_path.exists():
                dwg_path.unlink()
        # If filepath was .dwg, the .dxf conversion lives alongside it
        dxf_sibling = filepath.with_suffix(".dxf")
        if dxf_sibling != filepath and dxf_sibling.exists():
            dxf_sibling.unlink()

    # Remove from database
    db.delete_document(doc_id)

    return JSONResponse({"status": "deleted", "id": doc_id})


@router.get("/api/documents/{doc_id}/page/{page_number}/export")
async def export_page_image(
    doc_id: int,
    page_number: int,
    dpi: int = 300,
    rotate: int = 0,
    hidden_layers: str = "",
    format: str = "png",
):
    """
    Export a single PDF page as a downloadable image with layer filtering.

    Renders the page at the requested DPI with the specified OCG layers hidden.
    Designed for producing clean floor plan base layers — hide plumbing, text,
    annotations, etc. and export just the walls.

    Args:
        doc_id:        Document database ID.
        page_number:   Zero-indexed page number.
        dpi:           Export resolution (72-600, default 300 for print quality).
        rotate:        Clockwise rotation in degrees (0, 90, 180, 270).
        hidden_layers: Comma-separated OCG layer names to hide.
        format:        Output format — "png" (default) or "svg".

    Returns:
        Downloadable image file with Content-Disposition attachment header.

    Security:
        - DPI clamped to 72-600 to prevent memory exhaustion
        - Layer names are string-matched, never executed
        - Read-only operation on the original PDF
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="PDF file missing from disk")

    # SECURITY: Clamp DPI — 600 is generous for architectural prints
    dpi = min(max(dpi, 72), 600)

    # Validate format
    if format not in ("png", "svg"):
        raise HTTPException(status_code=400, detail="Format must be 'png' or 'svg'")

    # Parse hidden_layers query param into a list of layer names
    # SECURITY: layer names are passed to the content stream filter, not executed
    hidden_list = [name.strip() for name in hidden_layers.split(",") if name.strip()] \
                  if hidden_layers else []

    try:
        is_cad = _is_cad_document(doc_id)

        if is_cad and format == "svg":
            # SVG export not yet supported for CAD — DXF rendering is raster-only
            raise HTTPException(
                status_code=400,
                detail="SVG export is not supported for CAD documents"
            )

        if is_cad:
            # CAD PNG export — dxf_engine handles layer visibility natively
            cad_path = _get_cad_filepath(doc)
            content = dxf_engine.render_to_png(
                cad_path, dpi=float(dpi),
                hidden_layers=hidden_list or None,
            )
            media_type = "image/png"
            ext = "png"
        elif format == "svg":
            svg_bytes = pdf_engine.export_page_svg(
                doc["filepath"], page_number,
                hidden_layers=hidden_list, rotate=rotate
            )
            media_type = "image/svg+xml"
            ext = "svg"
            content = svg_bytes
        else:
            # PDF PNG export — reuses the same layer-aware render pipeline
            if hidden_list:
                png_bytes = pdf_engine.render_page_with_layers(
                    doc["filepath"], page_number,
                    hidden_layers=hidden_list, dpi=dpi, rotate=rotate
                )
            else:
                png_bytes = pdf_engine.render_page(
                    doc["filepath"], page_number, dpi=dpi, rotate=rotate
                )
            media_type = "image/png"
            ext = "png"
            content = png_bytes
    except HTTPException:
        raise  # Re-raise our own validation errors
    except IndexError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export error: {e}")

    # Build download filename: docname_page_N.ext
    original_name = doc["filename"]
    stem = original_name[:-4] if original_name.lower().endswith('.pdf') else original_name
    download_name = f"{stem}_page_{page_number + 1}.{ext}"

    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"',
            "Cache-Control": "no-cache",
        }
    )


@router.get("/api/documents/{doc_id}/export-pages")
async def export_all_pages(
    doc_id: int,
    dpi: int = 300,
    rotate: int = 0,
    hidden_layers: str = "",
    format: str = "svg",
):
    """
    Export all pages of a document as image files in a ZIP archive.

    Renders every page with the specified OCG layers hidden. Returns a
    downloadable ZIP containing one file per page. Designed for batch
    export of stripped-back floor plans.

    Args:
        doc_id:        Document database ID.
        dpi:           Export resolution for PNG (72-600, default 300). Ignored for SVG.
        rotate:        Clockwise rotation in degrees (0, 90, 180, 270).
        hidden_layers: Comma-separated OCG layer names to hide (applied to all pages).
        format:        Output format — "svg" (default, vector) or "png" (raster).

    Returns:
        Downloadable ZIP file containing page_001.svg, page_002.svg, etc.

    Security:
        - DPI clamped to 72-600 to prevent memory exhaustion
        - Layer names are string-matched, never executed
        - Read-only operation on the original PDF
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not Path(doc["filepath"]).exists():
        raise HTTPException(status_code=404, detail="File missing from disk")

    if format not in ("png", "svg"):
        raise HTTPException(status_code=400, detail="Format must be 'png' or 'svg'")

    dpi = min(max(dpi, 72), 600)

    hidden_list = [name.strip() for name in hidden_layers.split(",") if name.strip()] \
                  if hidden_layers else []

    try:
        is_cad = _is_cad_document(doc_id)

        if is_cad and format == "svg":
            raise HTTPException(
                status_code=400,
                detail="SVG export is not supported for CAD documents"
            )

        info = pdf_engine.get_pdf_info(doc["filepath"]) if not is_cad else None
        page_count = 1 if is_cad else info["page_count"]

        ext = format
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for page_num in range(page_count):
                if is_cad:
                    cad_path = _get_cad_filepath(doc)
                    page_bytes = dxf_engine.render_to_png(
                        cad_path, dpi=float(dpi),
                        hidden_layers=hidden_list or None,
                    )
                elif format == "svg":
                    page_bytes = pdf_engine.export_page_svg(
                        doc["filepath"], page_num,
                        hidden_layers=hidden_list or None,
                        rotate=rotate,
                    )
                elif hidden_list:
                    page_bytes = pdf_engine.render_page_with_layers(
                        doc["filepath"], page_num,
                        hidden_layers=hidden_list, dpi=dpi, rotate=rotate,
                    )
                else:
                    page_bytes = pdf_engine.render_page(
                        doc["filepath"], page_num, dpi=dpi, rotate=rotate,
                    )
                zf.writestr(f"page_{page_num + 1:03d}.{ext}", page_bytes)

        buf.seek(0)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batch export error: {e}")

    original_name = doc["filename"]
    stem = original_name.rsplit(".", 1)[0] if "." in original_name else original_name
    download_name = f"{stem}_pages.zip"

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"',
            "Cache-Control": "no-cache",
        },
    )


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
