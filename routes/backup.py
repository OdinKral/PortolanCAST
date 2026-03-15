"""
PortolanCAST — Backup Routes

Purpose:
    Database backup download and listing endpoints. Uses SQLite's backup API
    for crash-consistent snapshots even while the app is running.

Security assumptions:
    - Localhost-only access (no auth needed)
    - Backup files are read-only snapshots

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, JSONResponse

from config import db

router = APIRouter()


@router.get("/api/backup")
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


@router.get("/api/backups")
async def list_backups():
    """
    List available auto-backup files with size and timestamp.

    Returns:
        { backups: [{ filename, size_bytes, created_at }], total: N }
    """
    backups = db.list_backups()
    return JSONResponse({"backups": backups, "total": len(backups)})
