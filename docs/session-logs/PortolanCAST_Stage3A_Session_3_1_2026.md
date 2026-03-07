# PortolanCAST — Stage 3A Session Log
*Date: 2026-03-01 (Session 2 of the day)*
*Status at close: 40/42 tests passing — 2 failures pending server restart*

---

## What Was Built

Stage 3A is the **Equipment Intelligence Foundation**: the ability for a markup to represent a real-world piece of equipment (a valve, AHU, sensor) with a persistent identity that spans documents and pages.

### New Tables (db.py)

Three tables appended to SCHEMA_SQL:

| Table | Purpose |
|-------|---------|
| `entities` | One record per real-world tagged object (PRV-201, AHU-3). `tag_number TEXT UNIQUE` is the natural key — uniqueness enforced at DB level → sqlite3.IntegrityError → HTTP 409. |
| `entity_log` | Append-only maintenance log per entity. Entries are immutable. `id INTEGER PRIMARY KEY AUTOINCREMENT` used as stable sort key. |
| `markup_entities` | Junction: many markups → one entity (cross-doc observations). `PRIMARY KEY (markup_id, entity_id)` — natural composite PK, idempotent linking. |

### New API Routes (main.py — 12 routes)

```
POST   /api/entities                                     — create (201) or conflict (409 + existing entity)
GET    /api/entities                                     — list all (filter by ?type=, ?q=)
GET    /api/entities/by-tag/{tag_number:path}            — lookup by natural key
GET    /api/entities/{entity_id}                         — single entity
PUT    /api/entities/{entity_id}                         — partial update
DELETE /api/entities/{entity_id}                         — cascade-deletes log + markup links

POST   /api/entities/{entity_id}/log                     — append log entry (immutable)
GET    /api/entities/{entity_id}/log                     — list (newest-first, ORDER BY id DESC)

GET    /api/entities/{entity_id}/markups                 — all markups linked to entity (cross-doc)
POST   /api/documents/{doc_id}/markup-entities           — link markup → entity
DELETE /api/documents/{doc_id}/markup-entities/{mkp_id} — unlink
GET    /api/documents/{doc_id}/markup-entities/{mkp_id} — get entity linked to markup

POST   /api/documents/{doc_id}/pages/{page}/detect-tags — regex scan of text layer for tags
```

**Key design:**
- Route `by-tag` must be declared **before** `/{entity_id}` in FastAPI or it gets consumed as an entity ID
- 409 response body includes `{"detail": "tag_exists", "entity": {...}}` — frontend uses existing entity data for merge prompt without a second round-trip
- `detect-tags` uses `_TAG_PATTERN = re.compile(r'\b([A-Z]{2,5}-\d{1,4}[A-Z]?)\b')` — barcode-scanner-friendly pattern

### Properties Panel Entity Section (properties.js)

Three UI states wired into `_showMarkupProps()`:

| State | DOM ID | When Shown |
|-------|--------|-----------|
| **Unlinked** | `#entity-unlinked` | Markup has no linked entity. Shows tag input + Promote button. |
| **Merge Prompt** | `#entity-merge-prompt` | Promote hit 409 — tag exists. Shows conflict message + "Link to existing" button. |
| **Linked** | `#entity-linked-view` | Markup is linked. Shows tag chip + Unlink button. |

**Key methods:**
- `_promoteMarkup(tagNumber)` — POST to /api/entities, handles 201/409
- `_linkMarkupToEntity(entityId)` — POST to /api/documents/{docId}/markup-entities
- `_unlinkMarkup(markupId)` — DELETE + return to unlinked state

### Infrastructure Issues Encountered & Resolved

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| PowerShell venv fail | `venv/bin/` is Linux-only (WSL venv) | Use WSL terminal + PYTHONPATH shim |
| Stale shebang | venv created as `OpenRevu/`, shebang still points there | `PYTHONPATH=...site-packages /usr/bin/python3 -m uvicorn` |
| `node: command not found` | Node.js not installed in WSL | Installed Node v24.14.0 on Windows |
| Chrome path in tests | Windows Chrome path inaccessible from WSL bash | Run tests via `cmd.exe /c "node test_stage3a.mjs"` |
| 30s networkidle timeout | `/api/ai-summary` made 60s `requests.post()` to offline ClaudeProxy | Added 2s pre-flight `GET /health` — fails fast |
| Log ordering non-deterministic | `datetime('now')` second-res — rapid inserts get identical timestamps | `ORDER BY created_at DESC, id DESC` in `get_entity_log` |

### Log Ordering Fix (Pending Server Restart)

`db.py` `get_entity_log()` changed from:
```sql
ORDER BY created_at DESC
```
to:
```sql
ORDER BY created_at DESC, id DESC
```

The `AUTOINCREMENT` id is monotonically increasing — a reliable insertion-order proxy regardless of clock resolution. Server needs restart to pick this up (running without `--reload`).

---

## Test Suite

`test_stage3a.mjs` — 42 tests across 4 groups:

| Group | Tests | Coverage |
|-------|-------|---------|
| 1 — Entity API | 14 | POST 201/409, GET list/by-tag, PUT, log POST/GET ordering |
| 2 — Markup Linking API | 11 | link, GET by markup, GET by entity (cross-doc), idempotent, unlink |
| 3 — Properties Panel | 12 | 3 UI states, Promote flow, merge prompt, Link-to-existing, Unlink |
| 4 — Data Integrity | 5 | UUID stability, CASCADE delete, UNIQUE enforcement, FK constraints, log ordering |

**Current score:** 40/42 (2 log ordering tests fail — resolved in db.py, pending restart)

---

## Files Modified

| File | Change |
|------|--------|
| `db.py` | +3 tables to SCHEMA_SQL, +13 entity CRUD methods |
| `main.py` | +12 entity/markup-entity routes + detect-tags + ai-summary pre-flight fix |
| `static/js/properties.js` | +entity section methods (3-state), wired into _showMarkupProps/_onDeselect |
| `templates/editor.html` | +entity section DOM, +Equipment tab button+content, +entity modal overlay |
| `static/css/style.css` | +Stage 3 CSS: .entity-* .equip-* .entity-modal-* |
| `run_tests.mjs` | +test_stage3a.mjs to suite list |

**New file:** `test_stage3a.mjs`

---

## Key Design Principles Applied

- **Entity vs Markup distinction**: Entity = real-world object (global, stable). Markup = local observation at a location. N markups → 1 entity.
- **Natural key as merge-conflict detector**: UNIQUE constraint → IntegrityError → 409 → frontend merge prompt. No custom conflict detection logic needed.
- **Append-only maintenance log**: Mirrors real maintenance practice — no editing history, new entries only. Enforced by API design (no PUT on log entries).
- **markupId is the join key**: Uses existing UUID stamped by `stampDefaults()` — no new identifier concept introduced.
- **Barcode scanner friendly**: Tag input is plain text `<input>` — keyboard-wedge scanners (HID mode) just type into it.

---

*Related notes:*
- Plan: `PKM/Inbox/Stage3_EquipmentIntelligence_Plan_3_1_2026.md`
- Next: Stage 3B (entity-manager.js + entity-modal.js)
- Pipeline: `~/.claude/PIPELINES/Engineering_OpenRevu/PIPELINE.md`
