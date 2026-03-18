"""
PortolanCAST — Bundle Export/Import Routes (.portolan)

Purpose:
    Export and import portable .portolan bundles — ZIP archives containing
    PDF, markups, layers, scale, and photos. Recipients can restore the
    full session on any PortolanCAST installation.

Security assumptions:
    - In-memory ZIP — no temp files written to disk during export
    - Import validates: extension, size, ZIP integrity, PDF magic bytes
    - Photo extensions validated against allowlist on import
    - Always creates NEW documents — never overwrites existing

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import io
import json
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import Response, JSONResponse

from config import (
    db, pdf_engine, PROJECTS_DIR, PHOTOS_DIR,
    MAX_UPLOAD_SIZE, MAX_PHOTO_SIZE, ALLOWED_PHOTO_EXTENSIONS,
)
from routes.settings import _default_scale, _default_layers

router = APIRouter()


@router.get("/api/documents/{doc_id}/export-bundle")
async def export_bundle(doc_id: int):
    """
    Export a portable .portolan bundle for a document.

    Bundle contents:
        metadata.json, original.pdf, markups.json, layers.json, scale.json,
        photos.json + photos/ (if attachments exist)

    Security:
        - Validates document + PDF file exist before building
        - In-memory ZIP — no temp files on disk
        - Data read from DB, never from request body
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
            layers_obj = json.loads(raw_layers)
        except Exception:
            layers_obj = _default_layers()
    else:
        layers_obj = _default_layers()

    raw_scale = db.get_document_setting(doc_id, "scale")
    if raw_scale:
        try:
            scale_obj = json.loads(raw_scale)
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

    # Collect photo attachments
    all_photos = db.get_all_document_photos(doc_id)
    photos_manifest = []
    photo_file_data = []
    for p in all_photos:
        photo_path = Path(p["file_path"])
        if not photo_path.exists():
            continue
        filename = photo_path.name
        photos_manifest.append({
            "photo_id":   p["photo_id"],
            "markup_id":  p["markup_id"],
            "filename":   filename,
            "description": p["description"],
            "created_at": p["created_at"],
        })
        photo_file_data.append((f"photos/{filename}", photo_path.read_bytes()))

    # Build ZIP in memory
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.json", json.dumps(metadata, indent=2))
        zf.write(str(pdf_path), "original.pdf")
        zf.writestr("markups.json", json.dumps({"pages": pages_str}, indent=2))
        zf.writestr("layers.json", json.dumps(layers_obj, indent=2))
        zf.writestr("scale.json", json.dumps(scale_obj, indent=2))
        if photos_manifest:
            zf.writestr("photos.json", json.dumps(photos_manifest, indent=2))
            for entry_name, photo_bytes in photo_file_data:
                zf.writestr(entry_name, photo_bytes)

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


@router.post("/api/documents/import-bundle")
async def import_bundle(file: UploadFile = File(...)):
    """
    Import a .portolan bundle and restore the document + all markup state.

    Always creates a NEW document — never overwrites an existing one.

    Security:
        - Extension must be .portolan
        - Size limited by MAX_UPLOAD_SIZE
        - zipfile.BadZipFile caught for corrupt/spoofed ZIPs
        - PDF magic bytes validated before saving
    """
    # SECURITY: extension check
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

            if "metadata.json" not in namelist:
                raise HTTPException(status_code=400, detail="Bundle missing metadata.json")
            if "original.pdf" not in namelist:
                raise HTTPException(status_code=400, detail="Bundle missing original.pdf")

            pdf_bytes = zf.read("original.pdf")

            # SECURITY: validate PDF magic bytes
            if not pdf_bytes.startswith(b"%PDF-"):
                raise HTTPException(status_code=400, detail="Bundle contains invalid PDF")

            try:
                meta = json.loads(zf.read("metadata.json"))
            except Exception:
                meta = {}
            original_filename = str(meta.get("filename", file.filename))

            # Read optional members
            markups_pages = {}
            if "markups.json" in namelist:
                try:
                    markups_data = json.loads(zf.read("markups.json"))
                    markups_pages = markups_data.get("pages", {})
                    if not isinstance(markups_pages, dict):
                        markups_pages = {}
                except Exception:
                    markups_pages = {}

            layers_raw = None
            if "layers.json" in namelist:
                try:
                    layers_obj = json.loads(zf.read("layers.json"))
                    if isinstance(layers_obj, dict) and "layers" in layers_obj:
                        layers_raw = json.dumps(layers_obj)
                except Exception:
                    pass

            scale_raw = None
            if "scale.json" in namelist:
                try:
                    scale_obj = json.loads(zf.read("scale.json"))
                    if isinstance(scale_obj, dict) and "preset" in scale_obj:
                        scale_raw = json.dumps(scale_obj)
                except Exception:
                    pass

            # Read photo manifest and collect image bytes
            photos_to_restore = []
            if "photos.json" in namelist:
                try:
                    photos_meta = json.loads(zf.read("photos.json"))
                    if isinstance(photos_meta, list):
                        for entry in photos_meta:
                            filename = str(entry.get("filename", ""))
                            ext = Path(filename).suffix.lower()
                            if ext not in ALLOWED_PHOTO_EXTENSIONS:
                                continue
                            zip_entry = f"photos/{filename}"
                            if zip_entry not in namelist:
                                continue
                            photo_bytes = zf.read(zip_entry)
                            if len(photo_bytes) > MAX_PHOTO_SIZE:
                                continue
                            photos_to_restore.append({
                                "markup_id":   str(entry.get("markup_id", ""))[:128],
                                "description": str(entry.get("description", ""))[:500],
                                "ext":         ext,
                                "bytes":       photo_bytes,
                            })
                except Exception:
                    photos_to_restore = []

    except HTTPException:
        raise
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="File is not a valid ZIP/portolan bundle")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bundle read error: {e}")

    # Save PDF to projects directory
    pdf_filename = uuid.uuid4().hex + ".pdf"
    pdf_dest = PROJECTS_DIR / pdf_filename
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    pdf_dest.write_bytes(pdf_bytes)

    try:
        pdf_info = pdf_engine.get_pdf_info(str(pdf_dest))
    except Exception as e:
        pdf_dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"PDF validation failed: {e}")

    file_size = len(pdf_bytes)
    page_count = pdf_info.get("page_count", 1)

    new_doc_id = db.add_document(original_filename, str(pdf_dest), page_count, file_size)

    # Restore optional state
    if markups_pages:
        db.save_markups(new_doc_id, markups_pages)
    if layers_raw:
        db.set_document_setting(new_doc_id, "layers", layers_raw)
    if scale_raw:
        db.set_document_setting(new_doc_id, "scale", scale_raw)

    # Restore photo attachments
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
            save_path.unlink(missing_ok=True)
            print(f"[WARN] Could not restore photo during import: {e}")

    return JSONResponse({
        "id": new_doc_id,
        "filename": original_filename,
        "page_count": page_count,
        "redirect": f"/edit/{new_doc_id}",
    })
