"""
PortolanCAST — Text/OCR Extraction Routes

Purpose:
    PDF text extraction endpoint with two-tier strategy: native PyMuPDF text
    layer (fast, zero deps) with optional Tesseract OCR fallback for scanned docs.

Security assumptions:
    - Document IDs validated against DB before file access
    - File paths come from DB records, not user input

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from config import db, pdf_engine, dxf_engine

router = APIRouter()


@router.get("/api/documents/{doc_id}/text/{page_number}")
async def get_page_text(doc_id: int, page_number: int, ocr: bool = False):
    """
    Extract text content from a PDF page.

    Two-tier extraction:
      - Tier 1 (always): PyMuPDF native text layer — fast, zero extra deps.
      - Tier 2 (ocr=true): Tesseract OCR fallback for scanned documents.

    Query params:
        ocr (bool): If True, fall back to OCR when no native text is found.

    Returns:
        JSON with text, word_count, char_count, has_native_text, method,
        ocr_available, page.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    filepath = doc['filepath']
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Document file not found on disk")

    # Check if this is a CAD document — extract text entities from DXF
    source_format = db.get_document_setting(doc_id, "source_format")
    if source_format in ("dxf", "dwg"):
        try:
            from pathlib import Path
            fp = Path(filepath)
            # For DWG uploads, use the converted DXF
            if fp.suffix.lower() == ".dwg":
                dxf_path = fp.with_suffix(".dxf")
                fp = dxf_path if dxf_path.exists() else fp
            texts = dxf_engine.get_text_entities(str(fp))
            # Format as a plain text blob for compatibility with the viewer
            all_text = "\n".join(t["text"] for t in texts if t.get("text"))
            return JSONResponse(content={
                "text": all_text,
                "word_count": len(all_text.split()),
                "char_count": len(all_text),
                "has_native_text": bool(texts),
                "method": "dxf_text_entities",
                "ocr_available": False,
                "page": page_number,
                "entities": texts,  # bonus: structured text with coordinates
            })
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"CAD text extraction error: {e}")

    try:
        result = pdf_engine.extract_text(filepath, page_number, use_ocr=ocr)
        return JSONResponse(content=result)
    except IndexError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/documents/{doc_id}/text-words/{page_number}")
async def get_page_text_words(doc_id: int, page_number: int, rotate: int = 0):
    """
    Get word-level bounding boxes for the PDF text selection layer.

    Returns positioned word data that the frontend renders as transparent
    <span> elements over the PDF image, enabling native browser text selection.

    Coordinates are in pixels at BASE_DPI (150), matching the rendered image.

    Returns:
        JSON with words array: [{x, y, w, h, text, block, line}, ...]
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    filepath = doc['filepath']
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Document file not found on disk")

    # Text selection only works for PDF documents (not CAD)
    source_format = db.get_document_setting(doc_id, "source_format")
    if source_format in ("dxf", "dwg"):
        return JSONResponse(content={"words": [], "page": page_number})

    try:
        words = pdf_engine.get_text_words(filepath, page_number, dpi=150, rotate=rotate)
        return JSONResponse(content={"words": words, "page": page_number})
    except IndexError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=500, detail=str(e))
