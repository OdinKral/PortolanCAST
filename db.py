"""
PortolanCAST — Database Layer

Purpose:
    SQLite database management for PortolanCAST projects, documents, and markups.
    Handles schema creation, project CRUD, and document metadata storage.

Security assumptions:
    - Database file is local-only, no network exposure
    - All inputs validated before reaching this layer
    - File paths are sanitized by the caller

Author: PortolanCAST
Version: 0.1.0
Date: 2026-02-15
"""

import json
import sqlite3
import os
from datetime import datetime
from pathlib import Path
from contextlib import contextmanager

# =============================================================================
# CONFIGURATION
# =============================================================================

# Default database location relative to app data directory
DEFAULT_DB_PATH = Path(__file__).parent / "data" / "portolancast.db"


# =============================================================================
# DATABASE SCHEMA
# =============================================================================

SCHEMA_SQL = """
-- Projects group related PDFs together (e.g., "Building A Mechanicals")
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Documents are individual PDF files within a project
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    page_count INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

-- Markups are annotations on specific pages of a document
-- Phase 1 will populate this; Phase 0 just creates the schema
CREATE TABLE IF NOT EXISTS markups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    markup_type TEXT NOT NULL,
    fabric_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Recent files for quick access on the home screen
CREATE TABLE IF NOT EXISTS recent_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL UNIQUE,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Per-document key/value settings (e.g. drawing scale, user preferences)
-- Generic store so Phase 2+ features can persist document state without
-- requiring schema migrations for each new setting.
CREATE TABLE IF NOT EXISTS document_settings (
    document_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (document_id, key),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Per-markup photo attachments — linked by markupId UUID stamped on each Fabric object.
-- photo_id is a UUID hex string generated at upload time (not an integer autoincrement,
-- because it doubles as the filename on disk — prevents path traversal collisions).
-- markup_id is the UUID from Fabric obj.markupId (not the markups table PK, which is
-- a page-level row — there is no per-object row to FK against).
CREATE TABLE IF NOT EXISTS markup_photos (
    photo_id TEXT PRIMARY KEY,
    document_id INTEGER NOT NULL,
    markup_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Index for fast photo lookups by markup (the most common access pattern)
CREATE INDEX IF NOT EXISTS idx_markup_photos_markup_id
    ON markup_photos(document_id, markup_id);
"""


# =============================================================================
# DATABASE CONNECTION MANAGEMENT
# =============================================================================

class Database:
    """
    SQLite database manager for PortolanCAST.

    Manages connection lifecycle, schema initialization, and provides
    CRUD operations for projects and documents.

    Attributes:
        db_path: Path to the SQLite database file.

    Usage:
        db = Database()
        db.init()
        doc_id = db.add_document("plan.pdf", "/path/to/plan.pdf", 42, 1024000)
    """

    def __init__(self, db_path: str = None):
        """
        Args:
            db_path: Absolute path to database file. Uses default if None.
        """
        self.db_path = Path(db_path) if db_path else DEFAULT_DB_PATH

    def init(self):
        """
        Initialize the database — create tables if they don't exist.

        Called once at application startup. Safe to call multiple times
        (uses CREATE TABLE IF NOT EXISTS).
        """
        # Ensure the data directory exists
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        with self._connect() as conn:
            conn.executescript(SCHEMA_SQL)

    @contextmanager
    def _connect(self):
        """
        Context manager for database connections.

        Enables WAL mode for better concurrent read performance and
        foreign key enforcement.

        Yields:
            sqlite3.Connection with row_factory set to sqlite3.Row
        """
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # =========================================================================
    # DOCUMENT OPERATIONS
    # =========================================================================

    def add_document(self, filename: str, filepath: str,
                     page_count: int, file_size: int,
                     project_id: int = None) -> int:
        """
        Register a new PDF document in the database.

        Args:
            filename: Display name of the file (e.g., "M-101 Floor Plan.pdf")
            filepath: Absolute path to the stored PDF file
            page_count: Number of pages in the PDF
            file_size: File size in bytes
            project_id: Optional project to associate with

        Returns:
            The new document's database ID.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO documents (project_id, filename, filepath,
                   page_count, file_size)
                   VALUES (?, ?, ?, ?, ?)""",
                (project_id, filename, filepath, page_count, file_size)
            )
            doc_id = cursor.lastrowid

            # Track in recent files
            conn.execute(
                """INSERT OR REPLACE INTO recent_files (document_id, opened_at)
                   VALUES (?, datetime('now'))""",
                (doc_id,)
            )
            return doc_id

    def get_document(self, doc_id: int) -> dict:
        """
        Retrieve a document by ID.

        Args:
            doc_id: Document database ID.

        Returns:
            Document row as dict, or None if not found.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE id = ?", (doc_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_recent_documents(self, limit: int = 10) -> list:
        """
        Get recently opened documents for the home screen.

        Args:
            limit: Maximum number of results (default 10).

        Returns:
            List of document dicts ordered by most recently opened.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT d.* FROM documents d
                   JOIN recent_files r ON d.id = r.document_id
                   ORDER BY r.opened_at DESC
                   LIMIT ?""",
                (limit,)
            ).fetchall()
            return [dict(row) for row in rows]

    def get_all_documents(self) -> list:
        """
        Return all documents ordered by id, used by the list API endpoint.

        Returns:
            List of all document dicts.
        """
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM documents ORDER BY id"
            ).fetchall()
            return [dict(row) for row in rows]

    def touch_document(self, doc_id: int):
        """
        Update the last-opened timestamp for a document.

        Args:
            doc_id: Document database ID.
        """
        with self._connect() as conn:
            conn.execute(
                "UPDATE documents SET last_opened = datetime('now') WHERE id = ?",
                (doc_id,)
            )
            conn.execute(
                """INSERT OR REPLACE INTO recent_files (document_id, opened_at)
                   VALUES (?, datetime('now'))""",
                (doc_id,)
            )

    def update_document_page_count(self, doc_id: int, page_count: int):
        """
        Update the stored page count for a document.

        Called after adding or removing pages from the underlying PDF file.
        Keeps the DB in sync with the actual file state.

        Args:
            doc_id: Document database ID.
            page_count: New total page count.
        """
        with self._connect() as conn:
            conn.execute(
                "UPDATE documents SET page_count = ? WHERE id = ?",
                (page_count, doc_id)
            )

    def delete_document(self, doc_id: int):
        """
        Remove a document record from the database.

        Does NOT delete the physical PDF file — caller handles that.

        Args:
            doc_id: Document database ID.
        """
        with self._connect() as conn:
            conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))

    # =========================================================================
    # DOCUMENT SETTINGS
    # =========================================================================

    def get_document_setting(self, doc_id: int, key: str) -> str | None:
        """
        Retrieve a single setting for a document.

        Args:
            doc_id: Document database ID.
            key: Setting key (e.g. 'scale').

        Returns:
            Setting value as string, or None if not set.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM document_settings WHERE document_id = ? AND key = ?",
                (doc_id, key)
            ).fetchone()
            return row["value"] if row else None

    def set_document_setting(self, doc_id: int, key: str, value: str):
        """
        Store or replace a single setting for a document.

        Uses INSERT OR REPLACE (upsert) so callers don't need to check
        whether the setting already exists.

        Args:
            doc_id: Document database ID.
            key: Setting key (max 64 chars recommended).
            value: Setting value (stored as text; callers serialize complex values as JSON).
        """
        with self._connect() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO document_settings (document_id, key, value)
                   VALUES (?, ?, ?)""",
                (doc_id, key, value)
            )

    # =========================================================================
    # MARKUP OPERATIONS
    # =========================================================================

    def save_markups(self, doc_id: int, markups: dict):
        """
        Save all page markups for a document, replacing any existing data.

        Uses UPSERT (INSERT OR REPLACE) semantics — each page gets one row
        with markup_type='fabric_page'. Pages not in the input are deleted
        so removed markups don't persist as ghosts.

        Args:
            doc_id: Document database ID.
            markups: Dict of {page_number (str or int): fabric_json_object}.
                     Page numbers are stringified keys from JSON transport.

        Security:
            - doc_id must be validated by caller (exists in documents table)
            - fabric_json is stored as-is; no eval or code execution
        """
        with self._connect() as conn:
            # Clear existing markups for this document, then insert fresh
            # This is simpler than per-page diffing and avoids ghost data
            conn.execute(
                "DELETE FROM markups WHERE document_id = ?", (doc_id,)
            )

            for page_str, fabric_json in markups.items():
                # SECURITY: validate page number is an integer
                try:
                    page_num = int(page_str)
                except (ValueError, TypeError):
                    continue  # skip invalid page keys silently

                json_text = json.dumps(fabric_json) if isinstance(fabric_json, dict) else str(fabric_json)

                conn.execute(
                    """INSERT INTO markups
                       (document_id, page_number, markup_type, fabric_json)
                       VALUES (?, ?, 'fabric_page', ?)""",
                    (doc_id, page_num, json_text)
                )

    def get_markups(self, doc_id: int) -> dict:
        """
        Load all page markups for a document.

        Returns:
            Dict of {page_number (int): fabric_json_object} for all pages
            that have markups. Empty dict if none exist.

        Args:
            doc_id: Document database ID.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT page_number, fabric_json FROM markups
                   WHERE document_id = ? AND markup_type = 'fabric_page'
                   ORDER BY page_number""",
                (doc_id,)
            ).fetchall()

        result = {}
        for row in rows:
            try:
                result[row["page_number"]] = json.loads(row["fabric_json"])
            except (json.JSONDecodeError, KeyError):
                # SECURITY: skip corrupt entries rather than crashing
                continue

        return result

    # =========================================================================
    # MARKUP PHOTO OPERATIONS
    # =========================================================================

    def add_markup_photo(self, photo_id: str, document_id: int,
                         markup_id: str, file_path: str,
                         description: str = '') -> str:
        """
        Register a new photo attachment for a markup object.

        The photo_id is caller-generated (UUID hex) so it can double as the
        on-disk filename, preventing name collisions and path traversal.

        Args:
            photo_id:    UUID hex string (also the filename stem on disk).
            document_id: Parent document (FK — ensures photo is scoped to doc).
            markup_id:   The markupId UUID stamped on the Fabric canvas object.
            file_path:   Absolute path to the saved image file.
            description: Optional caption text (max 500 chars, enforced by caller).

        Returns:
            photo_id — the same string passed in, for chaining.
        """
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO markup_photos
                   (photo_id, document_id, markup_id, file_path, description)
                   VALUES (?, ?, ?, ?, ?)""",
                (photo_id, document_id, markup_id, file_path, description)
            )
        return photo_id

    def get_markup_photos(self, document_id: int, markup_id: str) -> list:
        """
        Return all photos for a specific markup, ordered by creation time.

        The document_id scope prevents cross-document access even if a
        markup_id UUID happens to collide (astronomically unlikely but safe).

        Args:
            document_id: Document database ID (security scope).
            markup_id:   The markupId UUID on the Fabric object.

        Returns:
            List of dicts: [{ photo_id, markup_id, file_path,
                               description, created_at }, ...]
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT photo_id, markup_id, file_path, description, created_at
                   FROM markup_photos
                   WHERE document_id = ? AND markup_id = ?
                   ORDER BY created_at ASC""",
                (document_id, markup_id)
            ).fetchall()
        return [dict(row) for row in rows]

    def get_all_document_photos(self, document_id: int) -> list:
        """
        Return every photo attached to any markup in a document, ordered by
        creation time. Used by bundle export to gather all photos in one query
        rather than iterating per-markup.

        Args:
            document_id: Document database ID.

        Returns:
            List of dicts: [{ photo_id, markup_id, file_path,
                               description, created_at }, ...]
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT photo_id, markup_id, file_path, description, created_at
                   FROM markup_photos
                   WHERE document_id = ?
                   ORDER BY created_at ASC""",
                (document_id,)
            ).fetchall()
        return [dict(row) for row in rows]

    def get_markup_photo_path(self, document_id: int, photo_id: str) -> str | None:
        """
        Return the on-disk file_path for a photo (used by DELETE route before
        removing the DB record, so the file can be unlinked after).

        Args:
            document_id: Security scope — scopes the lookup to this document.
            photo_id:    UUID of the photo.

        Returns:
            Absolute file path string, or None if not found.
        """
        with self._connect() as conn:
            row = conn.execute(
                """SELECT file_path FROM markup_photos
                   WHERE document_id = ? AND photo_id = ?""",
                (document_id, photo_id)
            ).fetchone()
        return row["file_path"] if row else None

    def delete_markup_photo(self, document_id: int, photo_id: str) -> bool:
        """
        Remove a photo record from the database.

        Does NOT delete the physical image file — caller handles that AFTER
        this call so the DB record is always cleaned up even if file deletion
        fails (avoids zombie DB entries pointing to missing files).

        Args:
            document_id: Security scope — prevents cross-document deletion.
            photo_id:    UUID of the photo to delete.

        Returns:
            True if a row was deleted, False if the record wasn't found.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                """DELETE FROM markup_photos
                   WHERE document_id = ? AND photo_id = ?""",
                (document_id, photo_id)
            )
        return cursor.rowcount > 0

    # =========================================================================
    # GLOBAL SEARCH
    # =========================================================================

    def search_all(self, query: str) -> list:
        """
        Search across documents (by filename) and markup content.

        Markup data is stored as page-level Fabric.js canvas JSON blobs —
        SQL LIKE on the raw blob is unreliable for structured field matching.
        Instead we load all markup rows and parse them in Python, then filter
        individual Fabric objects by markupNote, markupType, and markupAuthor.

        One result row is emitted per matching object (first matching field
        wins — we don't emit duplicate rows for the same object matching
        multiple fields).

        Args:
            query: Search string (stripped, case-insensitive).

        Returns:
            List of dicts:
            [{ entity_type, doc_id, doc_name, page_number,
               match_field, match_text, context }, ...]

            entity_type: 'document' | 'markup'
            page_number: None for document hits, 0-indexed int for markup hits
            context:     Short excerpt for display (max 80 chars for notes)
        """
        if not query or not query.strip():
            return []

        q = query.strip().lower()
        results = []

        with self._connect() as conn:
            # --- Document filename search ---
            doc_rows = conn.execute(
                "SELECT id, filename FROM documents WHERE LOWER(filename) LIKE ?",
                (f"%{q}%",)
            ).fetchall()

            for row in doc_rows:
                results.append({
                    "entity_type": "document",
                    "doc_id": row["id"],
                    "doc_name": row["filename"],
                    "page_number": None,
                    "match_field": "filename",
                    "match_text": row["filename"],
                    "context": row["filename"],
                })

            # --- Markup content search ---
            # Load all page-level markup blobs with their parent document names.
            # Connection stays open only for this SELECT; parsing happens outside.
            markup_rows = conn.execute(
                """SELECT m.document_id, m.page_number, m.fabric_json, d.filename
                   FROM markups m
                   JOIN documents d ON d.id = m.document_id
                   WHERE m.markup_type = 'fabric_page'"""
            ).fetchall()

        # Parse blobs OUTSIDE the connection context — connection is already
        # closed by the 'with' block above, so we're not holding a lock
        # during the O(n×m) scan loop.
        for row in markup_rows:
            try:
                fabric_json = json.loads(row["fabric_json"])
            except (json.JSONDecodeError, TypeError):
                continue  # skip corrupt blobs silently

            objects = fabric_json.get("objects", [])
            if not isinstance(objects, list):
                continue

            for obj in objects:
                if not isinstance(obj, dict):
                    continue

                # Skip area-companion IText labels — they're visual artifacts,
                # not user-authored markups (same guard as measure-summary)
                if (obj.get("measurementType") == "area" and
                        obj.get("type", "").lower() in ("itext", "i-text")):
                    continue

                # Search these three semantic fields (order matters — first hit wins)
                for field in ("markupNote", "markupType", "markupAuthor"):
                    val = obj.get(field, "") or ""
                    if q in val.lower():
                        if field == "markupNote":
                            # Excerpt: first 80 chars of the note text
                            context = val[:80] + ("..." if len(val) > 80 else "")
                        else:
                            context = f"{field}: {val}"

                        results.append({
                            "entity_type": "markup",
                            "doc_id": row["document_id"],
                            "doc_name": row["filename"],
                            "page_number": row["page_number"],
                            "match_field": field,
                            "match_text": val,
                            "context": context,
                        })
                        break  # one result per object — avoid duplicate rows

        return results
