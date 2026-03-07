# -*- mode: python ; coding: utf-8 -*-
"""
PortolanCAST — PyInstaller Build Specification

Purpose:
    Freezes the FastAPI backend into a standalone directory that Electron
    can spawn without requiring a Python installation on the user's machine.

Architecture:
    One-directory mode (COLLECT) is used instead of one-file mode because:
    - Faster startup (no temporary extraction needed)
    - Easier to debug (files visible on disk)
    - Smaller delta updates (only changed files re-downloaded)

    The output directory 'portolan-server/' is referenced by electron-builder's
    extraResources config and placed alongside the Electron app.

    Data files included:
    - templates/ — Jinja2 HTML templates (read-only app assets)
    - static/    — CSS, JS, images (read-only app assets)

    User data (projects, DB, photos) is NOT bundled — it lives in
    PORTOLANCAST_DATA_DIR, set by Electron to the user's app data folder.

Hidden imports:
    uvicorn uses lazy imports internally. PyInstaller's static analysis
    misses these, causing "ModuleNotFoundError" at runtime. The list below
    covers the standard uvicorn modules that must be explicitly included.

Usage:
    pyinstaller electron/pyinstaller.spec --distpath electron/portolan-server --clean

Author: PortolanCAST
Version: 1.0.0
Date: 2026-03-07
"""

import os
import sys

# Ensure the project root is on the path for Analysis
project_root = os.path.join(os.path.dirname(SPECPATH), '..')

a = Analysis(
    [os.path.join(project_root, 'main.py')],
    pathex=[project_root],
    binaries=[],
    datas=[
        # Read-only app assets — templates and static files
        (os.path.join(project_root, 'templates'), 'templates'),
        (os.path.join(project_root, 'static'), 'static'),
    ],
    hiddenimports=[
        # uvicorn lazy imports — well-documented PyInstaller issue
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.wsproto_impl',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        # FastAPI / Starlette internals
        'multipart',
        'multipart.multipart',
        # Database and PDF engine (imported by main.py)
        'db',
        'pdf_engine',
        # PyMuPDF (used for PDF rendering)
        'fitz',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Reduce bundle size — these are not needed at runtime
        'tkinter',
        'matplotlib',
        'numpy',
        'pandas',
        'scipy',
        'pytest',
        'IPython',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='main',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    # console=True so stdout/stderr visible for debugging
    # Can be changed to False once the app is stable
    console=True,
)

# One-directory mode — all files collected into portolan-server/
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='portolan-server',
)
