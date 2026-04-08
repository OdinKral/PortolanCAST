"""
PortolanCAST — Shared Configuration & Singletons

Purpose:
    Central location for constants, path configuration, and singleton objects
    shared across all route modules. Route files import from here instead of
    main.py, which prevents circular imports and keeps the dependency graph clean.

    Dependency flow:
        db.py, pdf_engine.py   (standalone — no app imports)
                ↓
           config.py           (imports db/pdf_engine; holds constants + singletons)
                ↓
           routes/*.py          (import from config.py only)
                ↓
           main.py              (imports config + all routers, creates FastAPI app)

Security assumptions:
    - Same as main.py: localhost-only, single-user, PDF-only uploads
    - No secrets stored here — all values are non-sensitive configuration

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import os
import time
from pathlib import Path

from fastapi.templating import Jinja2Templates

from db import Database
from pdf_engine import PDFEngine
from dxf_engine import DXFEngine

# =============================================================================
# PATH CONFIGURATION
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
# requires the directory to exist at import time.
PHOTOS_DIR = DATA_DIR / "photos"
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

# Entity photos subdirectory — direct photo attachments to entities (Sprint 1).
# Under PHOTOS_DIR so the existing StaticFiles mount at /data/photos/ serves them.
ENTITY_PHOTOS_DIR = PHOTOS_DIR / "entities"
ENTITY_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

# Component library files (PNG, SVG, thumbnails for harvested components)
COMPONENTS_DIR = DATA_DIR / "components"
COMPONENTS_DIR.mkdir(parents=True, exist_ok=True)

# =============================================================================
# UPLOAD LIMITS & VALIDATION
# =============================================================================

# Maximum upload size: 200MB (large-format construction drawings can be big)
MAX_UPLOAD_SIZE = 200 * 1024 * 1024

# Maximum photo upload size: 20MB
MAX_PHOTO_SIZE = 20 * 1024 * 1024

# Allowed upload extensions — PDF, DXF, and DWG
ALLOWED_EXTENSIONS = {".pdf", ".dxf", ".dwg"}

# Allowed photo extensions for markup attachments
ALLOWED_PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}

# =============================================================================
# PAGE SIZE PRESETS
# =============================================================================

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

# Rendering DPI — must match BASE_DPI in canvas.js
RENDER_DPI = 150.0

# =============================================================================
# SINGLETONS
# =============================================================================

# HTML templates
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Database and rendering engines — initialized on startup via db.init()
db = Database()
pdf_engine = PDFEngine()
dxf_engine = DXFEngine()

# Tracks server start time; exposed by GET /api/health for uptime reporting
app_start_time: float = time.time()
