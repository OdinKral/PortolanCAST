"""
PortolanCAST — Main Application Entry Point

Purpose:
    FastAPI web server for PortolanCAST, an open-source PDF markup and
    measurement tool for construction professionals. Serves the web UI
    and provides API endpoints for PDF operations.

    This file is the thin orchestration layer: creates the FastAPI app,
    mounts static files, includes all route modules, and handles startup.
    All route handlers live in routes/*.py; shared state lives in config.py.

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

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from config import BASE_DIR, PHOTOS_DIR, PROJECTS_DIR, TEMP_DIR, db

# Route modules — each provides an APIRouter with full path decorators
from routes import (
    health, pages, documents, markups, settings, ai,
    bundles, photos, search, reports, text, entities,
    entity_tasks, entity_photos, parts, backup,
)

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

# =============================================================================
# INCLUDE ROUTERS
# =============================================================================

app.include_router(health.router)
app.include_router(pages.router)
app.include_router(documents.router)
app.include_router(markups.router)
app.include_router(settings.router)
app.include_router(ai.router)
app.include_router(bundles.router)
app.include_router(photos.router)
app.include_router(search.router)
app.include_router(reports.router)
app.include_router(text.router)
app.include_router(entities.router)
app.include_router(entity_tasks.router)
app.include_router(entity_photos.router)
app.include_router(parts.router)
app.include_router(backup.router)


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
