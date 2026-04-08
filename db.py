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
import shutil
import sqlite3
import os
from datetime import datetime
from pathlib import Path
from contextlib import contextmanager

# =============================================================================
# CONFIGURATION
# =============================================================================

# Default database location — uses PORTOLANCAST_DATA_DIR when set (Electron),
# otherwise falls back to data/ alongside the source code (development).
_data_dir = Path(os.environ.get('PORTOLANCAST_DATA_DIR',
                                 Path(__file__).parent / "data"))
DEFAULT_DB_PATH = _data_dir / "portolancast.db"


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

-- ==========================================================================
-- COMPONENT LIBRARY
-- ==========================================================================

-- Reusable visual components harvested from document regions.
-- Each component has PNG + SVG + thumbnail files on disk.
CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    source_doc_id INTEGER,
    source_page INTEGER,
    source_rect TEXT,
    png_path TEXT NOT NULL,
    svg_path TEXT NOT NULL,
    thumb_path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_doc_id) REFERENCES documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_components_name ON components(name);

-- ==========================================================================
-- STAGE 3: EQUIPMENT INTELLIGENCE
-- ==========================================================================

-- Global equipment entity registry.
-- (building, tag_number) is the composite natural key — campus-scale use
-- means many buildings each have their own AHU-1, FCU-1, etc.
-- INSERT raises IntegrityError on composite collision; server returns 409
-- with the existing entity so the frontend can prompt "merge or create new?".
CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY,           -- UUID hex (stable across tag renames)
    tag_number  TEXT NOT NULL,              -- natural key: "PRV-201", "AHU-3"
    building    TEXT NOT NULL DEFAULT '',   -- building scope: "Bldg-A", "Main Campus"
    equip_type  TEXT NOT NULL DEFAULT '',   -- "Pressure Valve", "Air Handler", etc.
    model       TEXT NOT NULL DEFAULT '',   -- manufacturer model string
    serial      TEXT NOT NULL DEFAULT '',   -- serial number (plate data)
    location    TEXT NOT NULL DEFAULT '',   -- "Floor-2 / MER / HVAC-1"
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(building, tag_number)            -- composite: same tag allowed in different buildings
);

-- Timestamped maintenance and inspection log entries.
-- Separate from markup notes (entity-level history, not observation-level).
-- Entries are immutable once written — append-only to preserve audit trail.
CREATE TABLE IF NOT EXISTS entity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    note        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Join table: links a markup UUID → entity (cross-document).
-- markup_id is the markupId UUID stamped on every Fabric object via stampDefaults().
-- doc_id + page_number stored here so we can display navigation info without
-- parsing the full Fabric JSON blob for every cross-doc query.
CREATE TABLE IF NOT EXISTS markup_entities (
    markup_id   TEXT NOT NULL,              -- UUID from Fabric obj.markupId
    entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    PRIMARY KEY (markup_id, entity_id)
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_markup_entities_entity
    ON markup_entities(entity_id);

CREATE INDEX IF NOT EXISTS idx_markup_entities_doc
    ON markup_entities(doc_id, markup_id);

CREATE INDEX IF NOT EXISTS idx_entity_log_entity
    ON entity_log(entity_id, created_at DESC);

-- ==========================================================================
-- SPRINT 1: QUICK CAPTURE — Tasks & Direct Entity Photos
-- ==========================================================================

-- Maintenance/work tasks tied to entities.
-- Status workflow: open → in_progress → done.
-- Priority levels: low | normal | high | urgent.
-- Separate from entity_log (append-only observations) — tasks are mutable work items.
CREATE TABLE IF NOT EXISTS entity_tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    priority    TEXT NOT NULL DEFAULT 'normal',
    due_date    TEXT,
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_tasks_entity
    ON entity_tasks(entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_tasks_status
    ON entity_tasks(status);

-- Photos attached directly to entities (not via markup observations).
-- Enables field capture: snap photo of nameplate/equipment → attach to entity
-- without requiring a PDF drawing to be open.
-- filename is a UUID.ext stored in PHOTOS_DIR/entities/ subdirectory.
CREATE TABLE IF NOT EXISTS entity_photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    caption     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_photos_entity
    ON entity_photos(entity_id);

-- ==========================================================================
-- PARTS INVENTORY — Equipment Parts & Spares Tracking
-- ==========================================================================

-- Parts/spares associated with equipment entities.
-- Tracks what parts are installed, spare inventory, and replacement info.
-- Each part belongs to one entity — campus-scale parts lists are generated
-- by querying across entities.
-- Quantity is current stock count (or installed count); updated manually.
CREATE TABLE IF NOT EXISTS entity_parts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    part_number TEXT NOT NULL,              -- SKU, OEM code, or internal part ID
    description TEXT NOT NULL,              -- "Replacement Belt Assembly", "Air Filter 20x20x2"
    quantity    INTEGER NOT NULL DEFAULT 1, -- current count (installed or in stock)
    unit        TEXT NOT NULL DEFAULT '',   -- "each", "feet", "box", "set"
    location    TEXT NOT NULL DEFAULT '',   -- where stored: "Bin A5", "MER-2 shelf", "on unit"
    notes       TEXT NOT NULL DEFAULT '',   -- compatibility, vendor, reorder threshold, etc.
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_parts_entity
    ON entity_parts(entity_id);

-- ==========================================================================
-- HAYSTACK: ENTITY CONNECTIONS — Directed Edges Between Equipment
-- ==========================================================================

-- Directed connections between entities (sensor → controller → actuator).
-- Stored in DB for graph queries (survives canvas operations, supports
-- cross-page lookups). Fabric.js visual line stored in fabric_data JSON.
-- SECURITY: source_id and target_id are FK-validated against entities table.
CREATE TABLE IF NOT EXISTS entity_connections (
    id              TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    source_port     TEXT NOT NULL DEFAULT 'output',   -- port name from pattern definition
    target_port     TEXT NOT NULL DEFAULT 'input',    -- port name from pattern definition
    connection_type TEXT NOT NULL DEFAULT 'signal',   -- 'signal' | 'physical' | 'logical'
    label           TEXT NOT NULL DEFAULT '',          -- optional midpoint label
    doc_id          INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    page_number     INTEGER,
    fabric_data     TEXT NOT NULL DEFAULT '',          -- JSON: Fabric line object for canvas rendering
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, target_id, source_port, target_port)
);

CREATE INDEX IF NOT EXISTS idx_conn_source ON entity_connections(source_id);
CREATE INDEX IF NOT EXISTS idx_conn_target ON entity_connections(target_id);
CREATE INDEX IF NOT EXISTS idx_conn_doc_page ON entity_connections(doc_id, page_number);

-- ==========================================================================
-- HAYSTACK: PATTERN SYSTEM — Structured Equipment Blueprints
-- ==========================================================================

-- Pattern blueprints — defines "kinds of equipment" with Haystack-inspired
-- tags, ISA-5.1 symbols, port definitions, and dual-view labels.
-- Seeded with HVAC patterns; users can add custom patterns later.
-- JSON columns (tags, ports, views, constraints) use SQLite's json functions.
CREATE TABLE IF NOT EXISTS patterns (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'component',  -- 'component' | 'system'
    category    TEXT NOT NULL DEFAULT '',            -- 'sensor' | 'controller' | 'actuator' | 'setpoint' | 'system'
    tags        TEXT NOT NULL DEFAULT '[]',          -- JSON array of Haystack markers
    isa_symbol  TEXT NOT NULL DEFAULT '',            -- ISA-5.1 code: "TT", "TIC", "TV"
    isa_prefix  TEXT NOT NULL DEFAULT '',            -- prefix for auto-numbering: "TT-"
    ports       TEXT NOT NULL DEFAULT '{}',          -- JSON: {"input":{...},"output":{...}}
    views       TEXT NOT NULL DEFAULT '{}',          -- JSON: {"system":{label,shape,color},"isa":{label,shape}}
    constraints TEXT NOT NULL DEFAULT '{}',          -- JSON: validation rules for instances
    is_builtin  INTEGER NOT NULL DEFAULT 1,         -- 1=shipped seed data, 0=user-created
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- System pattern members — which component patterns compose a control loop.
-- E.g., "Zone Temperature Control Loop" requires sensor + controller + actuator.
CREATE TABLE IF NOT EXISTS system_pattern_members (
    id                TEXT PRIMARY KEY,
    system_pattern_id TEXT NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
    member_pattern_id TEXT NOT NULL REFERENCES patterns(id),
    role              TEXT NOT NULL DEFAULT '',      -- 'sensor', 'controller', 'actuator'
    required          INTEGER NOT NULL DEFAULT 1,    -- 1=mandatory, 0=optional
    sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_spm_parent
    ON system_pattern_members(system_pattern_id);

-- Controlled tag vocabulary — Haystack-inspired markers.
-- Only tags listed here can be assigned to entities (no free-form tagging).
-- This prevents the "tag soup" problem from inconsistent manual tagging.
CREATE TABLE IF NOT EXISTS tag_vocab (
    tag         TEXT PRIMARY KEY,                   -- single lowercase marker: "temp", "sensor"
    category    TEXT NOT NULL DEFAULT '',            -- grouping: "medium", "measurement", "function", "equipment"
    description TEXT NOT NULL DEFAULT ''             -- human-readable definition
);

-- Structured tags assigned to entities — the many-to-many join table.
-- Tags are auto-assigned from patterns on entity creation.
-- Manual tag addition is constrained to tag_vocab entries only.
CREATE TABLE IF NOT EXISTS entity_tags (
    entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL REFERENCES tag_vocab(tag) ON DELETE CASCADE,
    source      TEXT NOT NULL DEFAULT 'pattern',    -- 'pattern' | 'manual'
    PRIMARY KEY (entity_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_entity_tags_tag
    ON entity_tags(tag);
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
        Initialize the database — create tables if they don't exist,
        then run any pending migrations.

        Called once at application startup. Safe to call multiple times
        (uses CREATE TABLE IF NOT EXISTS).
        """
        # Ensure the data directory exists
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        with self._connect() as conn:
            conn.executescript(SCHEMA_SQL)

        # Run schema migrations for existing databases
        self._migrate_entities_building_column()
        self._migrate_entities_pattern_id()

        # Seed pattern data if the patterns table is empty
        self._seed_patterns()

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
    # SCHEMA MIGRATIONS
    # =========================================================================

    def _migrate_entities_building_column(self):
        """
        Migrate entities table to add 'building' column with composite UNIQUE.

        SQLite cannot alter inline UNIQUE constraints, so we must recreate the
        table. This migration:
          1. Checks if the 'building' column already exists (skip if so)
          2. Creates entities_new with composite UNIQUE(building, tag_number)
          3. Copies all existing data (building defaults to '')
          4. Drops the old table and renames the new one
          5. Recreates indexes and re-enables foreign keys on dependent tables

        Safe to run multiple times — the column check makes it idempotent.
        """
        with self._connect() as conn:
            # Check if 'building' column already exists
            columns = [row[1] for row in conn.execute("PRAGMA table_info(entities)").fetchall()]
            if 'building' in columns:
                return  # Already migrated

            print("[DB] Migrating entities table: adding 'building' column with composite UNIQUE...")

            conn.executescript("""
                -- Create new table with building column and composite UNIQUE
                CREATE TABLE entities_new (
                    id          TEXT PRIMARY KEY,
                    tag_number  TEXT NOT NULL,
                    building    TEXT NOT NULL DEFAULT '',
                    equip_type  TEXT NOT NULL DEFAULT '',
                    model       TEXT NOT NULL DEFAULT '',
                    serial      TEXT NOT NULL DEFAULT '',
                    location    TEXT NOT NULL DEFAULT '',
                    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(building, tag_number)
                );

                -- Copy existing data — building defaults to '' for all existing entities
                INSERT INTO entities_new (id, tag_number, building, equip_type, model, serial, location, created_at, updated_at)
                    SELECT id, tag_number, '', equip_type, model, serial, location, created_at, updated_at
                    FROM entities;

                -- Drop old table (CASCADE won't auto-migrate FKs in SQLite, but
                -- entity_log, entity_tasks, entity_photos, markup_entities all
                -- reference entities(id) which is unchanged — data is preserved)
                DROP TABLE entities;

                -- Rename new table to entities
                ALTER TABLE entities_new RENAME TO entities;
            """)

            print("[DB] Migration complete: entities table now has 'building' column.")

    def _migrate_entities_pattern_id(self):
        """
        Add pattern_id column to entities table (Haystack pattern system).

        Nullable column — existing entities get NULL (untyped, same as before).
        Safe to run multiple times (checks for column existence first).
        """
        with self._connect() as conn:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(entities)").fetchall()]
            if 'pattern_id' in columns:
                return  # Already migrated

            print("[DB] Migrating entities table: adding 'pattern_id' column...")
            conn.execute(
                "ALTER TABLE entities ADD COLUMN pattern_id TEXT DEFAULT NULL"
            )
            print("[DB] Migration complete: entities table now has 'pattern_id' column.")

    def _seed_patterns(self):
        """
        Populate patterns, tag_vocab, and system_pattern_members if empty.

        Only seeds when the patterns table has zero rows — safe to call on
        every startup.  Seed data comes from seeds/patterns.py.
        """
        with self._connect() as conn:
            count = conn.execute("SELECT COUNT(*) FROM patterns").fetchone()[0]
            if count > 0:
                return  # Already seeded

        # Import here to avoid circular dependency at module level
        from seeds.patterns import ALL_PATTERNS, TAG_VOCABULARY, SYSTEM_PATTERN_MEMBERS

        print("[DB] Seeding pattern definitions and tag vocabulary...")

        with self._connect() as conn:
            # Seed tag vocabulary
            for tv in TAG_VOCABULARY:
                conn.execute(
                    "INSERT OR IGNORE INTO tag_vocab (tag, category, description) VALUES (?, ?, ?)",
                    (tv["tag"], tv["category"], tv["description"])
                )

            # Seed patterns (component + system)
            for p in ALL_PATTERNS:
                conn.execute(
                    """INSERT OR IGNORE INTO patterns
                       (id, name, type, category, tags, isa_symbol, isa_prefix,
                        ports, views, constraints, is_builtin)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (p["id"], p["name"], p["type"], p["category"], p["tags"],
                     p["isa_symbol"], p["isa_prefix"], p["ports"], p["views"],
                     p["constraints"], p["is_builtin"])
                )

            # Seed system pattern members
            for m in SYSTEM_PATTERN_MEMBERS:
                conn.execute(
                    """INSERT OR IGNORE INTO system_pattern_members
                       (id, system_pattern_id, member_pattern_id, role, required, sort_order)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (m["id"], m["system_pattern_id"], m["member_pattern_id"],
                     m["role"], m["required"], m["sort_order"])
                )

        print(f"[DB] Seeded {len(ALL_PATTERNS)} patterns, {len(TAG_VOCABULARY)} tags, "
              f"{len(SYSTEM_PATTERN_MEMBERS)} system members.")

    # =========================================================================
    # BACKUP OPERATIONS
    # =========================================================================

    def backup(self, dest_path: Path = None) -> Path:
        """
        Create a crash-consistent backup of the database using SQLite's backup API.

        Uses sqlite3.backup() which handles WAL mode correctly — safe to call
        while the application is running and serving requests.

        Args:
            dest_path: Where to write the backup. If None, writes to
                       data/backups/portolancast_backup_YYYY-MM-DD_HHMMSS.db

        Returns:
            Path to the created backup file.
        """
        if dest_path is None:
            backup_dir = self.db_path.parent / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
            dest_path = backup_dir / f"portolancast_backup_{timestamp}.db"

        dest_path = Path(dest_path)
        dest_path.parent.mkdir(parents=True, exist_ok=True)

        # Use sqlite3.backup() for a crash-consistent snapshot
        source_conn = sqlite3.connect(str(self.db_path))
        dest_conn = sqlite3.connect(str(dest_path))
        try:
            source_conn.backup(dest_conn)
        finally:
            dest_conn.close()
            source_conn.close()

        return dest_path

    def auto_backup(self, max_backups: int = 10):
        """
        Create an automatic backup on startup, rotating old backups.

        Keeps the most recent max_backups copies. Oldest are deleted first.
        Called once at application startup to protect against data loss.

        Args:
            max_backups: Maximum number of backup files to retain.
        """
        # Only backup if the database actually exists and has data
        if not self.db_path.exists():
            return

        backup_dir = self.db_path.parent / "backups"

        try:
            backup_path = self.backup()
            print(f"[DB] Auto-backup created: {backup_path.name}")
        except Exception as e:
            # Backup failure should not prevent app startup
            print(f"[DB] Auto-backup failed (non-fatal): {e}")
            return

        # Prune old backups — keep only the most recent max_backups files
        try:
            backups = sorted(
                backup_dir.glob("portolancast_backup_*.db"),
                key=lambda p: p.stat().st_mtime,
                reverse=True
            )
            for old_backup in backups[max_backups:]:
                old_backup.unlink()
                print(f"[DB] Pruned old backup: {old_backup.name}")
        except Exception as e:
            print(f"[DB] Backup pruning failed (non-fatal): {e}")

    def list_backups(self) -> list:
        """
        List available backup files with metadata.

        Returns:
            List of dicts: [{ filename, size_bytes, created_at }, ...]
            Sorted newest-first.
        """
        backup_dir = self.db_path.parent / "backups"
        if not backup_dir.exists():
            return []

        backups = []
        for f in sorted(backup_dir.glob("portolancast_backup_*.db"),
                        key=lambda p: p.stat().st_mtime, reverse=True):
            stat = f.stat()
            backups.append({
                "filename": f.name,
                "size_bytes": stat.st_size,
                "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })

        return backups

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
    # COMPONENT LIBRARY OPERATIONS
    # =========================================================================

    def create_component(self, component_id: str, name: str, tags: list,
                         source_doc_id: int | None, source_page: int | None,
                         source_rect: str | None, png_path: str,
                         svg_path: str, thumb_path: str,
                         width: int, height: int) -> dict:
        """
        Create a new component record in the library.

        Args:
            component_id:  Caller-generated UUID hex (stable identity).
            name:          Human-readable label for the component.
            tags:          List of tag strings (stored as JSON array).
            source_doc_id: Document the component was harvested from (nullable).
            source_page:   Page number within source document (nullable).
            source_rect:   JSON-encoded bounding rect {"x","y","w","h"} (nullable).
            png_path:      Absolute path to the PNG file on disk.
            svg_path:      Absolute path to the SVG file on disk.
            thumb_path:    Absolute path to the thumbnail file on disk.
            width:         Pixel width of the component.
            height:        Pixel height of the component.

        Returns:
            The newly created component as a dict.
        """
        tags_json = json.dumps(tags) if isinstance(tags, list) else tags
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO components
                   (id, name, tags, source_doc_id, source_page, source_rect,
                    png_path, svg_path, thumb_path, width, height)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (component_id, name, tags_json, source_doc_id, source_page,
                 source_rect, png_path, svg_path, thumb_path, width, height)
            )
            row = conn.execute(
                "SELECT * FROM components WHERE id = ?", (component_id,)
            ).fetchone()
        return dict(row)

    def get_component(self, component_id: str) -> dict | None:
        """
        Fetch a single component by its UUID.

        Args:
            component_id: UUID hex string.

        Returns:
            Component dict, or None if not found.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM components WHERE id = ?", (component_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_components(self, tags: list | None = None,
                        search: str | None = None) -> list[dict]:
        """
        List components with optional filtering.

        Filters are AND-combined:
        - tags:   Each tag must appear somewhere in the JSON tags column
                  (uses JSON LIKE substring matching — AND logic).
        - search: Case-insensitive substring match against the name column.

        Args:
            tags:   List of tag strings to filter by (AND logic).
            search: Substring to match against component name.

        Returns:
            List of component dicts ordered by name.
        """
        query = "SELECT * FROM components"
        conditions = []
        params: list = []

        if tags:
            for tag in tags:
                # JSON array stored as text — match the quoted tag value
                conditions.append("tags LIKE ?")
                params.append(f'%"{tag}"%')

        if search:
            conditions.append("name LIKE ?")
            params.append(f"%{search}%")

        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        query += " ORDER BY name ASC"

        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def update_component(self, component_id: str,
                         name: str | None = None,
                         tags: list | None = None) -> dict | None:
        """
        Update mutable fields on a component.

        Only name and tags are updatable — paths and dimensions are immutable
        once set (changing them would orphan or corrupt the on-disk files).

        Args:
            component_id: UUID of the component to update.
            name:         New name (omit to leave unchanged).
            tags:         New tag list (omit to leave unchanged).

        Returns:
            Updated component dict, or None if not found.
        """
        updates = []
        params: list = []

        if name is not None:
            updates.append("name = ?")
            params.append(name)

        if tags is not None:
            updates.append("tags = ?")
            params.append(json.dumps(tags) if isinstance(tags, list) else tags)

        if not updates:
            return self.get_component(component_id)

        params.append(component_id)
        with self._connect() as conn:
            conn.execute(
                f"UPDATE components SET {', '.join(updates)} WHERE id = ?",
                params
            )
            row = conn.execute(
                "SELECT * FROM components WHERE id = ?", (component_id,)
            ).fetchone()
        return dict(row) if row else None

    def delete_component(self, component_id: str) -> bool:
        """
        Remove a component record from the database.

        Does NOT delete the physical files — caller handles that AFTER
        this call so the DB record is always cleaned up even if file
        deletion fails.

        Args:
            component_id: UUID of the component to delete.

        Returns:
            True if a row was deleted, False if not found.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM components WHERE id = ?", (component_id,)
            )
        return cursor.rowcount > 0

    def list_component_tags(self) -> list[dict]:
        """
        Aggregate all tags used across the component library.

        Parses the JSON tags column for every component, counts occurrences
        of each unique tag, and returns them sorted by descending count then
        alphabetically by tag name.

        Returns:
            List of dicts: [{"tag": "piping", "count": 5}, ...]
        """
        with self._connect() as conn:
            rows = conn.execute("SELECT tags FROM components").fetchall()

        counts: dict[str, int] = {}
        for row in rows:
            try:
                tag_list = json.loads(row["tags"])
            except (json.JSONDecodeError, TypeError):
                continue
            for tag in tag_list:
                if isinstance(tag, str) and tag:
                    counts[tag] = counts.get(tag, 0) + 1

        return sorted(
            [{"tag": t, "count": c} for t, c in counts.items()],
            key=lambda x: (-x["count"], x["tag"])
        )

    # =========================================================================
    # ENTITY OPERATIONS (Stage 3 — Equipment Intelligence)
    # =========================================================================

    def create_entity(self, entity_id: str, tag_number: str,
                      building: str = '', equip_type: str = '',
                      model: str = '', serial: str = '',
                      location: str = '') -> dict:
        """
        Create a new entity record.

        Args:
            entity_id:  Caller-generated UUID hex (stable identity across renames).
            tag_number: Natural key — "PRV-201". Combined with building, the
                        UNIQUE(building, tag_number) constraint raises
                        sqlite3.IntegrityError on collision; caller handles → 409.
            building:   Building scope — "Bldg-A", "Main Campus". Allows the same
                        tag_number in different buildings (campus-scale naming).
            equip_type: Equipment category (e.g., "Pressure Valve", "Air Handler").
            model:      Manufacturer model string (e.g., "Watts 174A").
            serial:     Nameplate serial number.
            location:   Human-readable location within the building (e.g., "Floor-2 / MER").

        Returns:
            The created entity as a dict.

        Raises:
            sqlite3.IntegrityError: If (building, tag_number) already exists.
        """
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO entities (id, tag_number, building, equip_type, model, serial, location)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (entity_id, tag_number, building, equip_type, model, serial, location)
            )
            row = conn.execute(
                "SELECT * FROM entities WHERE id = ?", (entity_id,)
            ).fetchone()
            return dict(row)

    def get_entity(self, entity_id: str) -> dict | None:
        """
        Return entity by UUID, or None if not found.

        Args:
            entity_id: UUID hex string of the entity.

        Returns:
            Entity dict or None.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM entities WHERE id = ?", (entity_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_entity_by_tag(self, tag_number: str,
                          building: str = None) -> dict | None:
        """
        Look up an entity by its tag number and optional building scope.

        Used by the merge-on-conflict flow and OCR suggestion matching.
        tag_number comparison is case-sensitive (tags are authoritative as stored).

        Args:
            tag_number: Equipment tag string (e.g., "PRV-201").
            building:   Building scope filter. If None, returns the first match
                        across all buildings (backward-compatible).

        Returns:
            Entity dict or None.
        """
        with self._connect() as conn:
            if building is not None:
                row = conn.execute(
                    "SELECT * FROM entities WHERE tag_number = ? AND building = ?",
                    (tag_number, building)
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT * FROM entities WHERE tag_number = ?", (tag_number,)
                ).fetchone()
            return dict(row) if row else None

    def get_all_entities(self, equip_type: str = None,
                         location: str = None,
                         building: str = None) -> list:
        """
        Return all entities, optionally filtered by equip_type, location, or building.

        Ordered by building ASC, then tag_number ASC — groups equipment by building
        for campus-scale use.

        Args:
            equip_type: Exact match filter on equip_type (case-sensitive). None = no filter.
            location:   Prefix match on location (LIKE 'prefix%'). None = no filter.
            building:   Exact match filter on building. None = no filter.

        Returns:
            List of entity dicts (with markup_count), sorted by building then tag_number.
        """
        with self._connect() as conn:
            params = []
            conditions = []

            if equip_type is not None:
                conditions.append("e.equip_type = ?")
                params.append(equip_type)

            if location is not None:
                # Prefix match so "Floor-2" also returns "Floor-2 / MER / HVAC-1"
                conditions.append("e.location LIKE ?")
                params.append(location + '%')

            if building is not None:
                conditions.append("e.building = ?")
                params.append(building)

            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            # LEFT JOIN subquery for markup_count — avoids N+1 queries in Equipment tab
            rows = conn.execute(
                f"""SELECT e.*, COALESCE(mc.cnt, 0) AS markup_count
                    FROM entities e
                    LEFT JOIN (
                        SELECT entity_id, COUNT(*) AS cnt
                        FROM markup_entities GROUP BY entity_id
                    ) mc ON mc.entity_id = e.id
                    {where}
                    ORDER BY e.building ASC, e.tag_number ASC""",
                params
            ).fetchall()
            return [dict(row) for row in rows]

    def update_entity(self, entity_id: str, **fields) -> bool:
        """
        Update one or more entity fields dynamically.

        Only keys present in **fields are updated; omitted fields are unchanged.
        Always sets updated_at = datetime('now') to track modification time.

        Allowed field names: tag_number, building, equip_type, model, serial, location, pattern_id.
        Unknown keys are silently ignored — defensive against stale client data.

        Args:
            entity_id: UUID of the entity to update.
            **fields:  Keyword arguments matching allowed column names.

        Returns:
            True if a row was updated, False if entity_id not found.
        """
        allowed = {'tag_number', 'building', 'equip_type', 'model', 'serial', 'location', 'pattern_id'}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return False

        set_clauses = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [entity_id]

        with self._connect() as conn:
            cursor = conn.execute(
                f"""UPDATE entities SET {set_clauses}, updated_at = datetime('now')
                    WHERE id = ?""",
                values
            )
            return cursor.rowcount > 0

    def delete_entity(self, entity_id: str) -> bool:
        """
        Delete entity, cascading to entity_log and markup_entities.

        The ON DELETE CASCADE on entity_log and markup_entities ensures no
        orphaned records remain after deletion.

        Args:
            entity_id: UUID of the entity to delete.

        Returns:
            True if a row was deleted, False if not found.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM entities WHERE id = ?", (entity_id,)
            )
            return cursor.rowcount > 0

    def add_entity_log(self, entity_id: str, note: str) -> int:
        """
        Append a maintenance/inspection log entry (append-only — entries are immutable).

        Log entries preserve audit trail. They are never edited; new observations
        are always new rows. This matches real-world maintenance log practice.

        Args:
            entity_id: UUID of the parent entity.
            note:      Log entry text (e.g., "Replaced valve stem. Torqued 45 ft-lb.").

        Returns:
            The new log entry's integer id (for confirmation response).
        """
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO entity_log (entity_id, note)
                   VALUES (?, ?)""",
                (entity_id, note)
            )
            return cursor.lastrowid

    def get_entity_log(self, entity_id: str) -> list:
        """
        Return all log entries for an entity, ordered newest-first.

        Newest-first matches how field engineers read logs — most recent
        observation is always the most relevant.

        Args:
            entity_id: UUID of the entity.

        Returns:
            List of log entry dicts: [{ id, entity_id, note, created_at }, ...]
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT id, entity_id, note, created_at
                   FROM entity_log
                   WHERE entity_id = ?
                   ORDER BY created_at DESC, id DESC""",
                (entity_id,)
            ).fetchall()
            return [dict(row) for row in rows]

    def link_markup_entity(self, markup_id: str, entity_id: str,
                           doc_id: int, page_number: int):
        """
        Link a markup UUID to an entity.

        INSERT OR IGNORE — safe to call multiple times (idempotent).
        If the same markup is re-linked to the same entity, nothing changes.

        Args:
            markup_id:   UUID from Fabric obj.markupId.
            entity_id:   UUID of the entity to link to.
            doc_id:      Parent document ID (stored for navigation queries).
            page_number: Page the markup lives on (stored to avoid re-parsing Fabric blobs).
        """
        with self._connect() as conn:
            conn.execute(
                """INSERT OR IGNORE INTO markup_entities
                   (markup_id, entity_id, doc_id, page_number)
                   VALUES (?, ?, ?, ?)""",
                (markup_id, entity_id, doc_id, page_number)
            )

    def unlink_markup_entity(self, markup_id: str, entity_id: str) -> bool:
        """
        Remove a markup→entity link.

        Args:
            markup_id: UUID of the markup.
            entity_id: UUID of the entity.

        Returns:
            True if the link existed and was removed, False if not found.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                """DELETE FROM markup_entities
                   WHERE markup_id = ? AND entity_id = ?""",
                (markup_id, entity_id)
            )
            return cursor.rowcount > 0

    def get_entity_markups(self, entity_id: str) -> list:
        """
        Return all markups linked to an entity, across ALL documents.

        Joins with the documents table to include doc filename for display —
        avoids a second query per row in the entity modal.

        This is the core cross-document query: one entity, many observations.

        Args:
            entity_id: UUID of the entity.

        Returns:
            List of dicts:
            [{ markup_id, entity_id, doc_id, doc_name, page_number }, ...]
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT me.markup_id, me.entity_id, me.doc_id,
                          d.filename AS doc_name, me.page_number
                   FROM markup_entities me
                   JOIN documents d ON d.id = me.doc_id
                   WHERE me.entity_id = ?
                   ORDER BY d.filename ASC, me.page_number ASC""",
                (entity_id,)
            ).fetchall()
            return [dict(row) for row in rows]

    def get_markup_entity(self, markup_id: str) -> dict | None:
        """
        Return the entity linked to a specific markup UUID, or None.

        Used by the properties panel on selection to check whether a markup
        is already promoted to an entity — determines which of the 3 UI states to show.

        Args:
            markup_id: UUID of the markup (from Fabric obj.markupId).

        Returns:
            Entity dict or None.
        """
        with self._connect() as conn:
            row = conn.execute(
                """SELECT e.* FROM entities e
                   JOIN markup_entities me ON me.entity_id = e.id
                   WHERE me.markup_id = ?""",
                (markup_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_entity_markup_count(self, entity_id: str) -> int:
        """
        Fast count of linked markups for an entity.

        Used in the Equipment tab list rows to show "3 markups" without fetching
        the full markup list for every entity in the panel.

        Args:
            entity_id: UUID of the entity.

        Returns:
            Integer count of linked markups.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM markup_entities WHERE entity_id = ?",
                (entity_id,)
            ).fetchone()
            return row["cnt"] if row else 0

    # =========================================================================
    # ENTITY TASK OPERATIONS (Sprint 1 — Quick Capture)
    # =========================================================================

    def create_task(self, entity_id: str, title: str,
                    priority: str = 'normal', due_date: str = None,
                    notes: str = '') -> dict:
        """
        Create a maintenance/work task for an entity.

        Args:
            entity_id: UUID of the parent entity.
            title:     Task title (e.g., "Replace belt on AHU-3").
            priority:  low | normal | high | urgent.
            due_date:  ISO date string or None.
            notes:     Additional detail text.

        Returns:
            The created task as a dict.
        """
        # SECURITY: validate priority against allowed values
        allowed_priorities = {'low', 'normal', 'high', 'urgent'}
        if priority not in allowed_priorities:
            priority = 'normal'

        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO entity_tasks
                   (entity_id, title, priority, due_date, notes)
                   VALUES (?, ?, ?, ?, ?)""",
                (entity_id, title, priority, due_date, notes)
            )
            row = conn.execute(
                "SELECT * FROM entity_tasks WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            return dict(row)

    def get_tasks(self, entity_id: str, status: str = None) -> list:
        """
        List tasks for an entity, optionally filtered by status.

        Args:
            entity_id: UUID of the entity.
            status:    Optional filter: 'open', 'in_progress', or 'done'.

        Returns:
            List of task dicts, ordered by created_at DESC.
        """
        with self._connect() as conn:
            if status:
                rows = conn.execute(
                    """SELECT * FROM entity_tasks
                       WHERE entity_id = ? AND status = ?
                       ORDER BY created_at DESC, id DESC""",
                    (entity_id, status)
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM entity_tasks
                       WHERE entity_id = ?
                       ORDER BY created_at DESC, id DESC""",
                    (entity_id,)
                ).fetchall()
            return [dict(row) for row in rows]

    def update_task(self, task_id: int, **fields) -> bool:
        """
        Update one or more task fields.

        Allowed fields: title, status, priority, due_date, notes.
        Always bumps updated_at on change.

        Args:
            task_id:  Integer PK of the task.
            **fields: Keyword arguments matching allowed column names.

        Returns:
            True if a row was updated, False if task_id not found.
        """
        allowed = {'title', 'status', 'priority', 'due_date', 'notes'}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return False

        # SECURITY: validate status and priority if provided
        if 'status' in updates and updates['status'] not in ('open', 'in_progress', 'done'):
            return False
        if 'priority' in updates and updates['priority'] not in ('low', 'normal', 'high', 'urgent'):
            return False

        set_clauses = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [task_id]

        with self._connect() as conn:
            cursor = conn.execute(
                f"""UPDATE entity_tasks SET {set_clauses}, updated_at = datetime('now')
                    WHERE id = ?""",
                values
            )
            return cursor.rowcount > 0

    def delete_task(self, task_id: int) -> bool:
        """
        Delete a task by ID.

        Args:
            task_id: Integer PK of the task.

        Returns:
            True if deleted, False if not found.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM entity_tasks WHERE id = ?", (task_id,)
            )
            return cursor.rowcount > 0

    def get_all_tasks(self, status: str = None) -> list:
        """
        Cross-entity task list — used by maintenance reports.

        Joins entities to include tag_number and location for grouping.

        Args:
            status: Optional filter: 'open', 'in_progress', or 'done'.

        Returns:
            List of task dicts with entity tag_number and location.
        """
        with self._connect() as conn:
            if status:
                rows = conn.execute(
                    """SELECT t.*, e.tag_number, e.location, e.equip_type
                       FROM entity_tasks t
                       JOIN entities e ON e.id = t.entity_id
                       WHERE t.status = ?
                       ORDER BY t.created_at DESC, t.id DESC""",
                    (status,)
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT t.*, e.tag_number, e.location, e.equip_type
                       FROM entity_tasks t
                       JOIN entities e ON e.id = t.entity_id
                       ORDER BY t.created_at DESC, t.id DESC"""
                ).fetchall()
            return [dict(row) for row in rows]

    # =========================================================================
    # ENTITY PHOTO OPERATIONS (Sprint 1 — Quick Capture)
    # =========================================================================

    def add_entity_photo(self, entity_id: str, filename: str,
                         caption: str = '') -> dict:
        """
        Register a photo attached directly to an entity.

        Photos are stored in PHOTOS_DIR/entities/ — the caller saves the file
        and passes the stored filename (UUID.ext format).

        Args:
            entity_id: UUID of the parent entity.
            filename:  Stored filename (e.g., "abc123.jpg").
            caption:   Optional caption text.

        Returns:
            The created photo record as a dict.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO entity_photos (entity_id, filename, caption)
                   VALUES (?, ?, ?)""",
                (entity_id, filename, caption)
            )
            row = conn.execute(
                "SELECT * FROM entity_photos WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            return dict(row)

    def get_entity_photos(self, entity_id: str) -> list:
        """
        List all photos for an entity, ordered by creation time.

        Args:
            entity_id: UUID of the entity.

        Returns:
            List of photo record dicts.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM entity_photos
                   WHERE entity_id = ?
                   ORDER BY created_at ASC""",
                (entity_id,)
            ).fetchall()
            return [dict(row) for row in rows]

    def delete_entity_photo(self, photo_id: int) -> dict | None:
        """
        Delete a photo record and return it (so caller can delete the file).

        Args:
            photo_id: Integer PK of the photo record.

        Returns:
            The deleted photo record as a dict, or None if not found.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM entity_photos WHERE id = ?", (photo_id,)
            ).fetchone()
            if not row:
                return None
            photo = dict(row)
            conn.execute("DELETE FROM entity_photos WHERE id = ?", (photo_id,))
            return photo

    # =========================================================================
    # ENTITY PARTS OPERATIONS (Parts Inventory)
    # =========================================================================

    def add_entity_part(self, entity_id: str, part_number: str,
                        description: str, quantity: int = 1,
                        unit: str = '', location: str = '',
                        notes: str = '') -> dict:
        """
        Create a new part record for an entity.

        Args:
            entity_id:   UUID of the parent entity.
            part_number: SKU or part code (e.g., "BELT-001", "FLT-20x20x2").
            description: Human-readable part name/description.
            quantity:    Count in stock or installed (default 1).
            unit:        Unit of measure (e.g., "each", "feet", "box").
            location:    Where the part is stored (e.g., "Bin A5", "on unit").
            notes:       Compatibility info, vendor, reorder notes, etc.

        Returns:
            The created part record as a dict.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO entity_parts
                   (entity_id, part_number, description, quantity, unit, location, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (entity_id, part_number, description, quantity, unit, location, notes)
            )
            row = conn.execute(
                "SELECT * FROM entity_parts WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            return dict(row)

    def get_entity_parts(self, entity_id: str) -> list:
        """
        List all parts for an entity, ordered by creation time.

        Args:
            entity_id: UUID of the entity.

        Returns:
            List of part record dicts.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM entity_parts
                   WHERE entity_id = ?
                   ORDER BY created_at ASC, id ASC""",
                (entity_id,)
            ).fetchall()
            return [dict(row) for row in rows]

    def update_entity_part(self, part_id: int, **fields) -> bool:
        """
        Update one or more part fields.

        Allowed fields: part_number, description, quantity, unit, location, notes.
        Always bumps updated_at on change.

        Args:
            part_id:  Integer PK of the part.
            **fields: Keyword arguments matching allowed column names.

        Returns:
            True if a row was updated, False if part_id not found.
        """
        allowed = {'part_number', 'description', 'quantity', 'unit', 'location', 'notes'}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return False

        # SECURITY: validate quantity is non-negative if provided
        if 'quantity' in updates:
            try:
                updates['quantity'] = max(0, int(updates['quantity']))
            except (ValueError, TypeError):
                return False

        set_clauses = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [part_id]

        with self._connect() as conn:
            cursor = conn.execute(
                f"""UPDATE entity_parts SET {set_clauses}, updated_at = datetime('now')
                    WHERE id = ?""",
                values
            )
            return cursor.rowcount > 0

    def delete_entity_part(self, part_id: int) -> bool:
        """
        Delete a part record by ID.

        Args:
            part_id: Integer PK of the part.

        Returns:
            True if deleted, False if not found.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM entity_parts WHERE id = ?", (part_id,)
            )
            return cursor.rowcount > 0

    def get_all_parts(self, entity_id: str = None) -> list:
        """
        Get all parts across entities (for inventory reports), optionally filtered.

        Joins entities to include tag_number, building, and location for grouping
        in cross-entity inventory views and maintenance reports.

        Args:
            entity_id: Optional filter to one entity. If None, returns all parts.

        Returns:
            List of part dicts with entity tag_number, building, and location.
        """
        with self._connect() as conn:
            if entity_id:
                rows = conn.execute(
                    """SELECT p.*, e.tag_number, e.building, e.location AS entity_location
                       FROM entity_parts p
                       JOIN entities e ON e.id = p.entity_id
                       WHERE p.entity_id = ?
                       ORDER BY p.created_at DESC, p.id DESC""",
                    (entity_id,)
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT p.*, e.tag_number, e.building, e.location AS entity_location
                       FROM entity_parts p
                       JOIN entities e ON e.id = p.entity_id
                       ORDER BY e.building ASC, e.tag_number ASC, p.part_number ASC"""
                ).fetchall()
            return [dict(row) for row in rows]

    def get_maintenance_report_data(self) -> list:
        """
        Gather data for the maintenance report: entities grouped by location,
        each with open tasks and last 3 log entries.

        Returns:
            List of dicts:
            [{ entity (dict), open_tasks (list), recent_log (list) }, ...]
            Sorted by location ASC, then tag_number ASC.
        """
        with self._connect() as conn:
            # Get all entities sorted by building, location, tag
            entities = conn.execute(
                """SELECT * FROM entities
                   ORDER BY building ASC, location ASC, tag_number ASC"""
            ).fetchall()

            results = []
            for entity in entities:
                eid = entity["id"]

                # Open tasks for this entity
                tasks = conn.execute(
                    """SELECT * FROM entity_tasks
                       WHERE entity_id = ? AND status != 'done'
                       ORDER BY priority DESC, created_at DESC""",
                    (eid,)
                ).fetchall()

                # Last 3 log entries
                logs = conn.execute(
                    """SELECT * FROM entity_log
                       WHERE entity_id = ?
                       ORDER BY created_at DESC, id DESC
                       LIMIT 3""",
                    (eid,)
                ).fetchall()

                results.append({
                    "entity": dict(entity),
                    "open_tasks": [dict(t) for t in tasks],
                    "recent_log": [dict(l) for l in logs],
                })

            return results

    # =========================================================================
    # PATTERN SYSTEM (Haystack-Inspired Semantic Modeling)
    # =========================================================================

    def get_patterns(self, pattern_type: str = None,
                     category: str = None) -> list:
        """
        Return all pattern definitions, optionally filtered.

        Args:
            pattern_type: Filter by 'component' or 'system'. None returns all.
            category:     Filter by category (e.g., 'sensor', 'controller'). None returns all.

        Returns:
            List of pattern dicts with JSON fields parsed.
        """
        with self._connect() as conn:
            sql = "SELECT * FROM patterns WHERE 1=1"
            params = []
            if pattern_type:
                sql += " AND type = ?"
                params.append(pattern_type)
            if category:
                sql += " AND category = ?"
                params.append(category)
            sql += " ORDER BY category, name"
            rows = conn.execute(sql, params).fetchall()

            results = []
            for row in rows:
                d = dict(row)
                # Parse JSON fields for API consumers
                for field in ("tags", "ports", "views", "constraints"):
                    try:
                        d[field] = json.loads(d[field])
                    except (json.JSONDecodeError, TypeError):
                        pass  # keep raw string if malformed
                results.append(d)
            return results

    def get_pattern(self, pattern_id: str) -> dict | None:
        """
        Return a single pattern by ID, with JSON fields parsed.

        Args:
            pattern_id: UUID hex of the pattern.

        Returns:
            Pattern dict or None.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM patterns WHERE id = ?", (pattern_id,)
            ).fetchone()
            if not row:
                return None
            d = dict(row)
            for field in ("tags", "ports", "views", "constraints"):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
            return d

    def get_pattern_by_name(self, name: str) -> dict | None:
        """
        Look up a pattern by name (case-insensitive).

        Args:
            name: Pattern name (e.g., "Zone Air Temperature Sensor").

        Returns:
            Pattern dict or None.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM patterns WHERE LOWER(name) = LOWER(?)", (name,)
            ).fetchone()
            if not row:
                return None
            d = dict(row)
            for field in ("tags", "ports", "views", "constraints"):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
            return d

    def get_system_pattern_members(self, system_pattern_id: str) -> list:
        """
        Return the component patterns that compose a system pattern.

        Args:
            system_pattern_id: UUID hex of the system pattern.

        Returns:
            List of dicts with member pattern details and role info.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT spm.*, p.name AS member_name, p.category AS member_category,
                          p.isa_symbol AS member_isa
                   FROM system_pattern_members spm
                   JOIN patterns p ON p.id = spm.member_pattern_id
                   WHERE spm.system_pattern_id = ?
                   ORDER BY spm.sort_order""",
                (system_pattern_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def get_tag_vocab(self, category: str = None) -> list:
        """
        Return all controlled vocabulary tags, optionally filtered by category.

        Args:
            category: Filter by tag category ('medium', 'measurement', 'function', 'equipment').
                      None returns all tags.

        Returns:
            List of tag dicts.
        """
        with self._connect() as conn:
            if category:
                rows = conn.execute(
                    "SELECT * FROM tag_vocab WHERE category = ? ORDER BY tag",
                    (category,)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM tag_vocab ORDER BY category, tag"
                ).fetchall()
            return [dict(r) for r in rows]

    def assign_entity_tags(self, entity_id: str, tags: list,
                           source: str = 'pattern'):
        """
        Assign structured tags to an entity from the controlled vocabulary.

        Tags not in tag_vocab are silently skipped (FK constraint would reject them).
        Uses INSERT OR IGNORE for idempotent assignment.

        Args:
            entity_id: UUID hex of the entity.
            tags:      List of tag strings (e.g., ["zone", "air", "temp", "sensor"]).
            source:    Origin of the tag: 'pattern' (auto-assigned) or 'manual'.
        """
        with self._connect() as conn:
            for tag in tags:
                # Validate tag exists in vocabulary before attempting insert
                exists = conn.execute(
                    "SELECT 1 FROM tag_vocab WHERE tag = ?", (tag,)
                ).fetchone()
                if exists:
                    conn.execute(
                        "INSERT OR IGNORE INTO entity_tags (entity_id, tag, source) VALUES (?, ?, ?)",
                        (entity_id, tag, source)
                    )

    def get_entity_tags(self, entity_id: str) -> list:
        """
        Return all structured tags assigned to an entity.

        Args:
            entity_id: UUID hex of the entity.

        Returns:
            List of dicts with tag, category, description, and source.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT et.tag, et.source, tv.category, tv.description
                   FROM entity_tags et
                   JOIN tag_vocab tv ON tv.tag = et.tag
                   WHERE et.entity_id = ?
                   ORDER BY tv.category, et.tag""",
                (entity_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def remove_entity_tags(self, entity_id: str, tags: list = None):
        """
        Remove tags from an entity. If tags is None, remove all.

        Args:
            entity_id: UUID hex of the entity.
            tags:      List of tag strings to remove, or None for all.
        """
        with self._connect() as conn:
            if tags is None:
                conn.execute(
                    "DELETE FROM entity_tags WHERE entity_id = ?",
                    (entity_id,)
                )
            else:
                for tag in tags:
                    conn.execute(
                        "DELETE FROM entity_tags WHERE entity_id = ? AND tag = ?",
                        (entity_id, tag)
                    )

    def get_next_isa_number(self, isa_prefix: str, building: str = '') -> int:
        """
        Get the next available ISA sequence number for auto-numbering.

        Scans existing entities with the given ISA prefix in the specified building
        to find the highest number, then returns n+1.

        Args:
            isa_prefix: ISA prefix string (e.g., "TT-").
            building:   Building scope for numbering (same building gets sequential numbers).

        Returns:
            Next available integer (1-based). Returns 1 if no existing entities match.
        """
        with self._connect() as conn:
            # Find all tag_numbers that start with this ISA prefix in this building
            rows = conn.execute(
                "SELECT tag_number FROM entities WHERE tag_number LIKE ? AND building = ?",
                (f"{isa_prefix}%", building)
            ).fetchall()

            max_num = 0
            prefix_len = len(isa_prefix)
            for row in rows:
                suffix = row["tag_number"][prefix_len:]
                try:
                    num = int(suffix)
                    if num > max_num:
                        max_num = num
                except ValueError:
                    continue  # skip non-numeric suffixes (e.g., "TT-1A")
            return max_num + 1

    def find_entities_by_tags(self, tags: list,
                              match_all: bool = True) -> list:
        """
        Find entities that have specific tags assigned.

        Args:
            tags:      List of tag strings to search for.
            match_all: If True, entity must have ALL tags (intersection).
                       If False, entity must have ANY tag (union).

        Returns:
            List of entity dicts.
        """
        if not tags:
            return []

        with self._connect() as conn:
            if match_all:
                # Intersection: entity must appear in entity_tags for EVERY tag
                placeholders = ",".join("?" * len(tags))
                sql = f"""
                    SELECT e.* FROM entities e
                    WHERE e.id IN (
                        SELECT entity_id FROM entity_tags
                        WHERE tag IN ({placeholders})
                        GROUP BY entity_id
                        HAVING COUNT(DISTINCT tag) = ?
                    )
                    ORDER BY e.building, e.tag_number
                """
                rows = conn.execute(sql, (*tags, len(tags))).fetchall()
            else:
                # Union: entity must have at least one of the tags
                placeholders = ",".join("?" * len(tags))
                sql = f"""
                    SELECT DISTINCT e.* FROM entities e
                    JOIN entity_tags et ON et.entity_id = e.id
                    WHERE et.tag IN ({placeholders})
                    ORDER BY e.building, e.tag_number
                """
                rows = conn.execute(sql, tags).fetchall()

            return [dict(r) for r in rows]

    # =========================================================================
    # ENTITY CONNECTIONS (Haystack Phase 2 — Directed Equipment Edges)
    # =========================================================================
    #
    # Connections model signal/physical/logical edges between entities:
    #   sensor → controller → actuator (the Haystack control loop pattern).
    # Each connection is stored in the DB (survives canvas ops, supports
    # cross-page queries) AND rendered as a Fabric line on the canvas
    # (fabric_data column stores the visual representation).

    def create_connection(
        self,
        connection_id: str,
        source_id: str,
        target_id: str,
        connection_type: str = "signal",
        source_port: str = "output",
        target_port: str = "input",
        label: str = "",
        doc_id: int = None,
        page_number: int = None,
        fabric_data: str = "",
    ) -> dict:
        """
        Create a directed connection between two entities.

        Args:
            connection_id: Pre-generated UUID for the connection.
            source_id: UUID of the source entity (e.g., sensor).
            target_id: UUID of the target entity (e.g., controller).
            connection_type: 'signal' | 'physical' | 'logical'.
            source_port: Port name on source (default 'output').
            target_port: Port name on target (default 'input').
            label: Optional midpoint label text.
            doc_id: Document where the visual line lives (nullable).
            page_number: Page number within the document (nullable).
            fabric_data: JSON string of the Fabric.js line object.

        Returns:
            Dict of the created connection row.

        Raises:
            ValueError: If source_id == target_id (self-loop).
            sqlite3.IntegrityError: On duplicate (source, target, ports) or
                missing entity FK.
        """
        # SECURITY: prevent self-loops — a sensor cannot feed itself
        if source_id == target_id:
            raise ValueError("Cannot connect an entity to itself")

        # Validate connection_type against allowed values
        allowed_types = ("signal", "physical", "logical")
        if connection_type not in allowed_types:
            raise ValueError(
                f"connection_type must be one of {allowed_types}, got '{connection_type}'"
            )

        with self._connect() as conn:
            conn.execute(
                """INSERT INTO entity_connections
                   (id, source_id, target_id, connection_type,
                    source_port, target_port, label,
                    doc_id, page_number, fabric_data)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    connection_id, source_id, target_id, connection_type,
                    source_port, target_port, label,
                    doc_id, page_number, fabric_data,
                ),
            )
            row = conn.execute(
                "SELECT * FROM entity_connections WHERE id = ?",
                (connection_id,),
            ).fetchone()
            return dict(row)

    def get_connection(self, connection_id: str) -> dict | None:
        """
        Fetch a single connection by ID.

        Returns:
            Connection dict or None if not found.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM entity_connections WHERE id = ?",
                (connection_id,),
            ).fetchone()
            return dict(row) if row else None

    def get_entity_connections(self, entity_id: str) -> dict:
        """
        Fetch all connections where the entity is source OR target.

        Returns:
            Dict with 'outgoing' and 'incoming' lists, each enriched
            with the connected entity's tag_number and building.

        Why separate lists: UI needs to show "feeds into" (outgoing) and
        "receives from" (incoming) differently — directional semantics
        matter for control loop reasoning.
        """
        with self._connect() as conn:
            # Outgoing: this entity is the source
            outgoing = conn.execute(
                """SELECT ec.*, e.tag_number AS target_tag, e.building AS target_building,
                          e.equip_type AS target_equip_type
                   FROM entity_connections ec
                   JOIN entities e ON e.id = ec.target_id
                   WHERE ec.source_id = ?
                   ORDER BY ec.created_at""",
                (entity_id,),
            ).fetchall()

            # Incoming: this entity is the target
            incoming = conn.execute(
                """SELECT ec.*, e.tag_number AS source_tag, e.building AS source_building,
                          e.equip_type AS source_equip_type
                   FROM entity_connections ec
                   JOIN entities e ON e.id = ec.source_id
                   WHERE ec.target_id = ?
                   ORDER BY ec.created_at""",
                (entity_id,),
            ).fetchall()

            return {
                "outgoing": [dict(r) for r in outgoing],
                "incoming": [dict(r) for r in incoming],
            }

    def get_connections_for_page(
        self, doc_id: int, page_number: int
    ) -> list:
        """
        Fetch all connections drawn on a specific document page.

        Used to render connection lines when a page loads — the canvas
        needs to know which Fabric lines to draw and which entities
        they connect.

        Args:
            doc_id: Document ID.
            page_number: 1-based page number.

        Returns:
            List of connection dicts with source/target entity details.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT ec.*,
                          s.tag_number AS source_tag, s.building AS source_building,
                          t.tag_number AS target_tag, t.building AS target_building
                   FROM entity_connections ec
                   JOIN entities s ON s.id = ec.source_id
                   JOIN entities t ON t.id = ec.target_id
                   WHERE ec.doc_id = ? AND ec.page_number = ?
                   ORDER BY ec.created_at""",
                (doc_id, page_number),
            ).fetchall()
            return [dict(r) for r in rows]

    def update_connection(
        self, connection_id: str, **kwargs
    ) -> dict | None:
        """
        Update mutable fields on a connection.

        Allowed fields: connection_type, label, source_port, target_port,
        fabric_data, doc_id, page_number.

        Returns:
            Updated connection dict, or None if not found.
        """
        allowed = {
            "connection_type", "label", "source_port", "target_port",
            "fabric_data", "doc_id", "page_number",
        }
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return self.get_connection(connection_id)

        # Validate connection_type if being changed
        if "connection_type" in updates:
            allowed_types = ("signal", "physical", "logical")
            if updates["connection_type"] not in allowed_types:
                raise ValueError(
                    f"connection_type must be one of {allowed_types}"
                )

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [connection_id]

        with self._connect() as conn:
            conn.execute(
                f"UPDATE entity_connections SET {set_clause} WHERE id = ?",
                values,
            )
            return self.get_connection(connection_id)

    def delete_connection(self, connection_id: str) -> bool:
        """
        Delete a connection by ID.

        Returns:
            True if a row was deleted, False if not found.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM entity_connections WHERE id = ?",
                (connection_id,),
            )
            return cursor.rowcount > 0

    def delete_connections_for_entity(self, entity_id: str) -> int:
        """
        Delete all connections involving an entity (both directions).

        Called when an entity is deleted — CASCADE handles this at the
        DB level, but this method is useful for explicit cleanup.

        Returns:
            Number of connections deleted.
        """
        with self._connect() as conn:
            cursor = conn.execute(
                """DELETE FROM entity_connections
                   WHERE source_id = ? OR target_id = ?""",
                (entity_id, entity_id),
            )
            return cursor.rowcount

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

    # =========================================================================
    # VALIDATION — Document-scoped entity & connection queries
    # =========================================================================
    # These methods power the Haystack Phase 4 validation engine.
    # They scope queries to a single document via the markup_entities bridge
    # table, so the validator only examines equipment that appears on the
    # document being checked — not the entire campus database.
    # =========================================================================

    def get_entities_for_document(self, doc_id: int) -> list:
        """
        Return all entities linked to markups in a specific document.

        Joins through markup_entities to find equipment that appears on the
        document's pages. Each entity is returned once, with the highest
        page_number where it appears (used for navigation on click).

        Args:
            doc_id: Document ID to scope the query.

        Returns:
            List of entity dicts, each with an extra 'page_number' field.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT DISTINCT e.*, MAX(me.page_number) AS page_number
                   FROM entities e
                   JOIN markup_entities me ON me.entity_id = e.id
                   WHERE me.doc_id = ?
                   GROUP BY e.id
                   ORDER BY e.building, e.tag_number""",
                (doc_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_all_connections_for_document(self, doc_id: int) -> list:
        """
        Return all connections where source OR target appears in the document.

        This captures the full connectivity picture for a document's entities,
        including connections that might be drawn on other pages or even other
        documents (cross-document wiring).

        Args:
            doc_id: Document ID to scope the query.

        Returns:
            List of connection dicts.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT ec.*
                   FROM entity_connections ec
                   WHERE ec.source_id IN (
                       SELECT entity_id FROM markup_entities WHERE doc_id = ?
                   )
                   OR ec.target_id IN (
                       SELECT entity_id FROM markup_entities WHERE doc_id = ?
                   )""",
                (doc_id, doc_id),
            ).fetchall()
            return [dict(r) for r in rows]
