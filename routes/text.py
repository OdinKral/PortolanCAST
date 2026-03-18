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

from config import db, pdf_engine

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
        raise HTTPException(status_code=404, detail="PDF file not found on disk")

    try:
        result = pdf_engine.extract_text(filepath, page_number, use_ocr=ocr)
        return JSONResponse(content=result)
    except IndexError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=500, detail=str(e))
