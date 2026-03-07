# Stage 3 — Equipment Intelligence: Full Implementation Plan

**Date:** 2026-03-01
**Status:** PLANNING — Ready to implement
**Phases:** 3A (Foundation) → 3B (Equipment Tab + Modal) → 3C (OCR Tag Detection)
**Estimated tests added:** ~75 (25 + 30 + 20)
**Estimated sessions:** 3

---

## Why This Exists

> A markup can stop being a *note about* a piece of equipment and start *being* that equipment — with its own identity, fields, history, and presence across every drawing that references it.

Right now, if PRV-201 is flagged on the riser diagram AND the equipment schedule AND the mechanical plan, PortolanCAST sees three independent markups. Stage 3 makes them evidence for the same entity. The entity becomes the thing you manage; the markup is evidence that you saw it, in a specific place, at a specific time, with a specific observation.

This is where PortolanCAST stops competing with Bluebeam and starts doing something it can't.

---

## Key Design Decisions (From Planning Session 2026-03-01)

| Decision | Choice | Rationale |
|---|---|---|
| Entity creation trigger | All three: manual / type-driven / OCR suggestion | Layered — power users get OCR, everyone gets right-click |
| Entity fields | tag_number, equip_type, model, serial, location | Full equipment identity record |
| Cross-document | Core feature, must have | Entities are global; markups are local evidence |
| Identity key | Tag number primary + merge-on-conflict prompt | Matches real-world naming; prompts on collision |
| UI surfaces | Equipment tab (left panel) + Entity detail modal | No nodeCAST graph integration yet (Stage 5) |
| Modal sections | Fields + linked markups + photos + maintenance log | Full asset dossier in one place |

---

## Core Principle: Entity vs. Markup

```
ENTITY (global)                          MARKUP (local evidence)
───────────────────                      ────────────────────────
id: "abc-uuid"                           markupId: "xyz-uuid"
tag_number: "PRV-201"           ←──────  markupNote: "PRV-201 leaking..."
equip_type: "Pressure Valve"             markupType: "issue"
model: "Watts 174A"                      doc_id: 3 (Riser Diagram.pdf)
serial: "SN-8823741"                     page_number: 2
location: "Bldg-A / MER / HVAC-1"       markupAuthor: "Bryan"
maintenance log: [...]                   created_at: 2026-03-01
```

The entity record lives across documents. The markup is one observation at one location at one time. Multiple markups on multiple drawings can point to the same entity.

---

## Database Schema Additions

Add to `SCHEMA_SQL` in `db.py` — append after the `markup_photos` block:

```sql
-- ==========================================================================
-- STAGE 3: EQUIPMENT INTELLIGENCE
-- ==========================================================================

-- Global equipment entity registry.
-- tag_number is the natural key (PRV-201, AHU-3) — UNIQUE constraint enables
-- merge-on-conflict: INSERT raises IntegrityError, server returns 409 with
-- the existing entity so the frontend can prompt "merge or create new?".
CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY,           -- UUID hex (stable across tag renames)
    tag_number  TEXT NOT NULL UNIQUE,       -- natural key: "PRV-201", "AHU-3"
    equip_type  TEXT NOT NULL DEFAULT '',   -- "Pressure Valve", "Air Handler", etc.
    model       TEXT NOT NULL DEFAULT '',   -- manufacturer model string
    serial      TEXT NOT NULL DEFAULT '',   -- serial number (plate data)
    location    TEXT NOT NULL DEFAULT '',   -- "Bldg-A / Floor-2 / HVAC-1"
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
```

---

## db.py Methods to Add

All methods follow the existing pattern: `with self._connect() as conn:` + `conn.execute()`.
Add a new `# ENTITY OPERATIONS` section after the `# MARKUP PHOTO OPERATIONS` section.

```python
# =========================================================================
# ENTITY OPERATIONS (Stage 3 — Equipment Intelligence)
# =========================================================================

def create_entity(self, entity_id: str, tag_number: str,
                  equip_type: str = '', model: str = '',
                  serial: str = '', location: str = '') -> dict:
    """
    Create a new entity record.

    Args:
        entity_id:  Caller-generated UUID hex (stable identity).
        tag_number: Natural key — "PRV-201". UNIQUE constraint raises
                    sqlite3.IntegrityError on collision (caller handles → 409).
        equip_type, model, serial, location: Equipment metadata fields.

    Returns:
        The created entity as a dict.

    Raises:
        sqlite3.IntegrityError: If tag_number already exists (merge-on-conflict).
    """

def get_entity(self, entity_id: str) -> dict | None:
    """Return entity by UUID, or None."""

def get_entity_by_tag(self, tag_number: str) -> dict | None:
    """
    Look up an entity by its tag number.
    Used by the merge-on-conflict flow and OCR suggestion matching.
    """

def get_all_entities(self, equip_type: str = None,
                     location: str = None) -> list:
    """
    Return all entities, optionally filtered by equip_type or location prefix.
    Orders by tag_number ASC (matches real equipment schedules).
    """

def update_entity(self, entity_id: str, **fields) -> bool:
    """
    Update one or more entity fields dynamically.
    Only updates keys present in **fields to allow partial updates.
    Always sets updated_at = datetime('now').

    Returns:
        True if a row was updated, False if entity_id not found.
    """

def delete_entity(self, entity_id: str) -> bool:
    """
    Delete entity + cascade entity_log + cascade markup_entities.
    Returns True if a row was deleted.
    """

def add_entity_log(self, entity_id: str, note: str) -> int:
    """
    Append a maintenance/inspection log entry.
    Returns the new log entry id (for confirmation response).
    """

def get_entity_log(self, entity_id: str) -> list:
    """Return all log entries for entity, ordered newest-first."""

def link_markup_entity(self, markup_id: str, entity_id: str,
                        doc_id: int, page_number: int):
    """
    Link a markup UUID to an entity.
    INSERT OR IGNORE — safe to call multiple times (idempotent).
    """

def unlink_markup_entity(self, markup_id: str, entity_id: str) -> bool:
    """Remove a markup→entity link. Returns True if row existed."""

def get_entity_markups(self, entity_id: str) -> list:
    """
    Return all markups linked to an entity, across ALL documents.
    JOINs with documents table to include doc filename for display.

    Returns:
        List of dicts:
        [{ markup_id, entity_id, doc_id, doc_name, page_number }, ...]

    This is the core cross-document query — one entity, many observations.
    """

def get_markup_entity(self, markup_id: str) -> dict | None:
    """
    Return the entity linked to a specific markup UUID, or None.
    Used by properties panel to check if a markup is already promoted.
    """

def get_entity_markup_count(self, entity_id: str) -> int:
    """Fast count of linked markups — used in Equipment tab list rows."""
```

---

## API Routes

Add to `main.py` in a new `# ENTITY ROUTES` section. Follow the existing pattern: `@app.get/post/put/delete`, `db.*` calls, `JSONResponse`.

### Entity CRUD

```
POST   /api/entities
  Body: { tag_number, equip_type?, model?, serial?, location? }
  → 201: { id, tag_number, equip_type, model, serial, location, created_at }
  → 409: { detail: "tag_exists", entity: {...existing entity...} }
       ↑ frontend shows "Merge with existing PRV-201?" prompt on 409

GET    /api/entities
  Query: ?equip_type=Valve  ?location=Bldg-A  (both optional)
  → 200: { entities: [...], total: N }

GET    /api/entities/by-tag/{tag_number}
  → 200: { entity: {...} }  or  404

GET    /api/entities/{entity_id}
  → 200: { entity: {...}, log: [...], markup_count: N }

PUT    /api/entities/{entity_id}
  Body: { equip_type?, model?, serial?, location? }  (partial update)
  → 200: { entity: {...updated...} }

DELETE /api/entities/{entity_id}
  → 200: { deleted: true }
```

### Entity Log

```
POST   /api/entities/{entity_id}/log
  Body: { note: "Replaced valve stem. Torqued to 45 ft-lb." }
  → 201: { id, entity_id, note, created_at }

GET    /api/entities/{entity_id}/log
  → 200: { log: [...entries newest-first...] }
```

### Entity Markups (Cross-Document)

```
GET    /api/entities/{entity_id}/markups
  → 200: { markups: [{ markup_id, doc_id, doc_name, page_number }] }
  ↑ This is the cross-doc query — all observations of this entity
```

### Markup↔Entity Linking

```
POST   /api/documents/{doc_id}/markup-entities
  Body: { markup_id, entity_id, page_number }
  → 201: { linked: true }

DELETE /api/documents/{doc_id}/markup-entities/{markup_id}
  → 200: { unlinked: true }

GET    /api/documents/{doc_id}/markup-entities/{markup_id}
  → 200: { entity: {...} }  or  { entity: null }
  ↑ Used by properties panel on selection to check if markup is promoted
```

### OCR Tag Detection (Stage 3C)

```
POST   /api/documents/{doc_id}/pages/{page}/detect-tags
  → 200: { tags: [{ tag_number, x, y, width, height, confidence }] }
  ↑ Scans text_layer_{page} from document_settings for tag patterns
  ↑ Returns bounding boxes so frontend can compute proximity to markups
```

---

## Frontend Architecture

### Stage 3A: Properties Panel — Entity Section

**File:** `static/js/properties.js`

Add an Entity section below the existing markup fields. It renders in three states:

```
STATE 1 — No entity linked:
┌─────────────────────────────────────┐
│  ENTITY                             │
│  Tag Number: [___________] [Promote]│
│  Type a tag # to link this markup   │
└─────────────────────────────────────┘

STATE 2 — Tag exists (merge prompt):
┌─────────────────────────────────────┐
│  ENTITY                             │
│  "PRV-201" already exists           │
│  [Link to existing] [Create new]    │
└─────────────────────────────────────┘

STATE 3 — Entity linked:
┌─────────────────────────────────────┐
│  ENTITY                 [View] [✕]  │
│  ● PRV-201 — Pressure Valve         │
│  Watts 174A · Bldg-A MER           │
└─────────────────────────────────────┘
```

**DOM IDs:**
- `#entity-section` — wrapper div (hidden when no markup selected)
- `#entity-tag-input` — tag number text input
- `#entity-promote-btn` — "Promote" button
- `#entity-merge-prompt` — div shown on 409 conflict
- `#entity-linked-view` — div shown when entity is linked
- `#entity-view-btn` — opens Entity detail modal
- `#entity-unlink-btn` — unlinks this markup from entity

**Key functions to add to `PropertiesPanel`:**
```javascript
async _loadEntitySection(markupId, docId)  // called from _showMarkupProps()
async _promoteMarkup(tagNumber, markupId, docId, pageNumber)
async _linkToExisting(entityId, markupId, docId, pageNumber)
async _unlinkMarkup(markupId)
_renderEntityLinked(entity)
_renderEntityUnlinked()
_renderEntityMergePrompt(existingEntity, tagNumber, markupId, docId, pageNumber)
```

---

### Stage 3B: entity-manager.js (Equipment Tab)

**File:** `static/js/entity-manager.js` — new module

**Class:** `EntityManager`

**Left panel Equipment tab HTML structure:**

```
#tab-equipment
├── .equip-toolbar
│   ├── #equip-filter-type    <select> filter by type
│   ├── #equip-filter-loc     <input>  filter by location prefix
│   └── #equip-search         <input>  tag number search
├── #equip-list               <div>    entity rows
│   └── .equip-row (×N)
│       ├── .equip-tag        "PRV-201"
│       ├── .equip-type       "Pressure Valve"
│       ├── .equip-location   "Bldg-A / MER"
│       └── .equip-count      "3 markups"
└── #equip-empty              shown when no entities
```

**Key methods:**
```javascript
init(app)                        // called from app.js
initForDocument(docInfo)         // refresh list on doc load
refresh()                        // re-fetch and re-render
_renderRows(entities)
_openModal(entityId)             // delegates to EntityModal
_bindFilters()
```

---

### Stage 3B: entity-modal.js (Entity Detail Modal)

**File:** `static/js/entity-modal.js` — new module

**Class:** `EntityModal`

This is a **full-panel overlay**, not a small popup. It covers the editor area entirely, with a close button. Think of it as the entity's dossier.

```
┌──────────────────────────────────────────────────────────────┐
│  ◄ Back    PRV-201 — Pressure Valve                    [Edit]│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  EQUIPMENT RECORD                                            │
│  ┌──────────────┬──────────────────────────────────────┐   │
│  │ Tag Number   │ PRV-201                               │   │
│  │ Type         │ Pressure Valve                        │   │
│  │ Model        │ Watts 174A                            │   │
│  │ Serial       │ SN-8823741                            │   │
│  │ Location     │ Bldg-A / Floor-2 / HVAC-1             │   │
│  └──────────────┴──────────────────────────────────────┘   │
│                                                              │
│  OBSERVATIONS (3 markups across 2 documents)                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ● Issue  Riser Diagram.pdf  Page 2  "PRV leaking..." │   │
│  │ ● Note   M-101 Mech Plan.pdf  Page 4  "Verify size"  │   │
│  │ ✓ Appr   Equipment Schedule.pdf  Page 1  "OK to ship" │  │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  PHOTOS (5 total)                                            │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                        │
│  │    │ │    │ │    │ │    │ │    │                        │
│  └────┘ └────┘ └────┘ └────┘ └────┘                        │
│                                                              │
│  MAINTENANCE LOG                              [+ Add Entry]  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 2026-03-01  Replaced valve stem. Torqued 45 ft-lb.   │   │
│  │ 2026-02-14  Inspection — no leaks. Seat worn.        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**DOM IDs:**
- `#entity-modal` — full overlay (position: fixed, z-index high)
- `#entity-modal-title` — "PRV-201 — Pressure Valve"
- `#entity-modal-fields` — the equipment record table (editable in edit mode)
- `#entity-modal-edit-btn` — toggle edit/save
- `#entity-modal-markups` — linked markups list
- `#entity-modal-photos` — photo grid (reuses existing photo grid CSS)
- `#entity-modal-log` — maintenance log entries
- `#entity-modal-log-input` — textarea for new log entry
- `#entity-modal-log-btn` — "Add Entry" button
- `#entity-modal-close` — "◄ Back"

**Markup row in Observations:** clicking navigates to that doc+page+markup (same pattern as search panel: `app.viewer.goToPage()` + `markupId` find).

**Key methods:**
```javascript
init(app)
open(entityId)                   // fetch entity + log + markups + photos, show overlay
close()
_renderFields(entity)
_renderMarkups(markups)
_renderPhotos(photos)            // aggregated across all linked markups
_renderLog(entries)
_enterEditMode()
_saveEdits(entityId)
async _addLogEntry(entityId, note)
_navigateToMarkup(docId, pageNumber, markupId)
```

---

### Stage 3C: OCR Tag Detection

**File:** `static/js/properties.js` (additions) + `main.py` (detect-tags route)

**Server-side tag pattern** (configurable, starts with common HVAC/MEP conventions):
```python
import re
TAG_PATTERN = re.compile(r'\b([A-Z]{2,5}-\d{1,4}[A-Z]?)\b')
# Matches: PRV-201, AHU-3, VFD-12A, VAV-102, FCU-1, PUMP-3B
# Does NOT match: A-1 (too short prefix), ABCDEF-1 (too long prefix)
```

**Detection flow:**
1. Properties panel, on markup placement near a tag: call `GET /api/entities/by-tag/{tag}` to check if entity exists
2. If text layer data exists for this page, call `POST /api/documents/{doc_id}/pages/{page}/detect-tags`
3. Server scans stored `text_layer_{page}` JSON for objects matching TAG_PATTERN
4. Returns bounding boxes → frontend checks distance to placed markup centroid (< 200px natural coords = "near")
5. If nearby tag found → show suggestion chip in properties panel

**Suggestion chip UI (in properties panel, below markupNote):**
```
┌─────────────────────────────────────────┐
│  💡 Tag detected nearby: PRV-201        │
│  [Link to PRV-201]  [Dismiss]           │
└─────────────────────────────────────────┘
```

**Type-driven auto-prompt:**
- Count markups (`markupType === 'note'` + placed via Count tool) auto-open the entity tag input on placement
- Configurable in settings modal (gear icon): "Auto-prompt entity for:" checkboxes per markupType

---

## app.js Integration

```javascript
// New imports:
import { EntityManager } from './entity-manager.js';
import { EntityModal } from './entity-modal.js';

// In App constructor:
this.entityManager = new EntityManager();
this.entityModal = new EntityModal();

// In init(), after markupList init:
this.entityManager.init(this);
this.entityModal.init(this);

// In _onDocumentLoaded():
this.entityManager.initForDocument(this.docInfo);
```

---

## editor.html Changes

Add Equipment tab button to left panel tabs (after RFI):
```html
<button class="panel-tab" data-panel="equipment" title="Equipment Registry">
    Equipment
</button>
<div id="tab-equipment" class="tab-content"></div>
```

Add entity modal overlay (before closing `</body>`):
```html
<div id="entity-modal" class="entity-modal-overlay" style="display:none;">
    <!-- Rendered by EntityModal.open() -->
</div>
```

---

## CSS to Append (style.css)

Key classes needed (full implementation will add more):

```css
/* Entity section in properties panel */
.entity-section { margin-top: 12px; padding-top: 10px; border-top: 1px solid #2a2a3d; }
.entity-section-header { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 6px; }
.entity-tag-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; background: #1e3a5f; border: 1px solid #4a7fc1; border-radius: 12px; font-size: 12px; color: #90b8f0; }
.entity-promote-btn { font-size: 11px; }
.entity-suggestion-chip { background: #2a3a1e; border: 1px solid #5a8a30; border-radius: 4px; padding: 6px 8px; font-size: 11px; color: #a0c878; margin-top: 6px; }

/* Equipment tab list */
.equip-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.equip-row:hover { background: #2a2a3d; }
.equip-tag { font-weight: 700; color: #90b8f0; min-width: 70px; }
.equip-type { flex: 1; color: #c0c0d0; }
.equip-count { font-size: 11px; color: #666; }

/* Entity modal overlay */
.entity-modal-overlay { position: fixed; inset: 0; background: #12121e; z-index: 1000; overflow-y: auto; display: flex; flex-direction: column; }
.entity-modal-header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #2a2a3d; }
.entity-modal-title { font-size: 16px; font-weight: 700; flex: 1; }
.entity-modal-body { padding: 20px; display: flex; flex-direction: column; gap: 24px; max-width: 900px; }
.entity-fields-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.entity-fields-table td { padding: 6px 10px; border-bottom: 1px solid #2a2a3d; }
.entity-fields-table td:first-child { color: #888; width: 120px; }
.entity-markup-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.entity-markup-row:hover { background: #2a2a3d; }
.entity-log-entry { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid #1a1a2e; font-size: 12px; }
.entity-log-date { color: #666; min-width: 80px; font-size: 11px; }
```

---

## File Summary

| File | Action | Key additions |
|---|---|---|
| `db.py` | Modify | Append 3 tables to SCHEMA_SQL + entity CRUD methods |
| `main.py` | Modify | ~12 new routes in `# ENTITY ROUTES` section |
| `static/js/properties.js` | Modify | Entity section: `_loadEntitySection()`, `_promoteMarkup()`, suggestion chips |
| `static/js/entity-manager.js` | **New** | EntityManager class — Equipment tab + entity list |
| `static/js/entity-modal.js` | **New** | EntityModal class — full overlay with 4 sections |
| `static/js/app.js` | Modify | Import + init EntityManager + EntityModal |
| `static/css/style.css` | Modify | Append `.entity-*` + `.equip-*` CSS |
| `templates/editor.html` | Modify | Equipment tab button + entity modal div |
| `test_stage3a.mjs` | **New** | ~25 tests: DB API, promote flow, 409 merge prompt |
| `test_stage3b.mjs` | **New** | ~30 tests: Equipment tab, modal sections, cross-doc nav |
| `test_stage3c.mjs` | **New** | ~20 tests: tag detection, suggestion chips, auto-prompt |
| `run_tests.mjs` | Modify | Add 3 new suites |

---

## Test Plan

### test_stage3a.mjs — Foundation (25 tests)

```
Group 1: Entity API (7 tests)
  - POST /api/entities creates entity, returns 201
  - POST /api/entities with existing tag returns 409 + existing entity data
  - GET /api/entities returns list
  - GET /api/entities/by-tag/{tag} returns entity
  - PUT /api/entities/{id} partial update works
  - DELETE /api/entities/{id} cascades to log + links
  - POST /api/entities/{id}/log creates entry; GET returns it newest-first

Group 2: Markup linking API (5 tests)
  - POST /api/documents/{id}/markup-entities links markup → entity
  - GET /api/documents/{id}/markup-entities/{markup_id} returns linked entity
  - GET /api/entities/{id}/markups returns cross-doc observations
  - DELETE .../markup-entities/{markup_id} unlinks
  - Idempotent: linking same markup twice doesn't error

Group 3: Properties panel Entity section (8 tests)
  - Entity section hidden when no markup selected
  - Entity section visible with tag input when markup selected, no entity linked
  - Typing PRV-201 + clicking Promote creates entity, shows linked view
  - 409 conflict shows merge prompt with existing entity info
  - "Link to existing" button links and shows linked view
  - "View" button opens entity modal
  - "✕" unlink button returns panel to unlinked state
  - Entity section persists across page navigation (markup still linked)

Group 4: Data integrity (5 tests)
  - Entity UUID stable after field update
  - Deleting entity clears entity section in properties panel
  - markup_entities CASCADE: delete doc removes links
  - entities UNIQUE: cannot create two PRV-201 entities
  - entity_log append-only: entries ordered newest-first
```

### test_stage3b.mjs — Equipment Tab + Modal (30 tests)

```
Group 1: Equipment tab (7 tests)
  - "Equipment" tab button exists in left panel
  - Clicking tab shows #tab-equipment
  - Entity list populates after entities created
  - Each row shows tag + type + markup count
  - Type filter narrows list
  - Location search narrows list
  - Empty state shown when no entities

Group 2: Entity modal — fields (6 tests)
  - Clicking entity row opens modal overlay
  - Modal title shows tag_number + equip_type
  - Fields table shows all 5 field values
  - Edit mode makes fields editable
  - Save updates fields and exits edit mode
  - Back button closes modal

Group 3: Entity modal — linked markups (6 tests)
  - Observations section shows all linked markups with doc name + page
  - Markups from different documents are grouped/labeled by doc
  - Clicking a markup row navigates to that doc + page
  - markupId highlighted in canvas after navigation
  - Count shows "N markups across M documents"
  - Empty state shown when no markups linked

Group 4: Entity modal — photos (5 tests)
  - Photos section shows all photos from all linked markups (aggregated)
  - Photo count correct across docs
  - Photos grid renders img elements
  - "No photos" empty state when none attached

Group 5: Entity modal — maintenance log (6 tests)
  - Log section shows existing entries newest-first
  - Add Entry textarea exists
  - Clicking "Add Entry" posts to /api/entities/{id}/log
  - New entry appears immediately in log
  - Entry shows timestamp
  - Empty log shows placeholder text
```

### test_stage3c.mjs — OCR Tag Detection (20 tests)

```
Group 1: detect-tags API (5 tests)
  - POST /api/documents/{id}/pages/{page}/detect-tags returns 200
  - Response has { tags: [...] } array
  - Tags match pattern PRV-201 format
  - Bounding box coords returned for each tag
  - Returns empty array if no text layer data

Group 2: Suggestion chips in properties panel (8 tests)
  - After markup placed near a tag: suggestion chip appears
  - Chip shows "💡 Tag detected nearby: PRV-201"
  - "Link to PRV-201" creates entity if new + links markup
  - "Link to PRV-201" links to existing entity if tag exists
  - "Dismiss" hides chip without linking
  - Chip only appears if text layer data exists for the page
  - Chip does NOT appear if no tags within 200px natural coords
  - Chip disappears after linking

Group 3: Type-driven auto-prompt (4 tests)
  - Count markup placement triggers entity tag input focus
  - Settings modal has auto-prompt checkboxes per markupType
  - Unchecking markupType disables auto-prompt for that type
  - Setting persists in localStorage across reload

Group 4: Tag pattern correctness (3 tests)
  - PRV-201, AHU-3, VFD-12A all detected (valid patterns)
  - A-1, ABCDEFG-1 not detected (invalid patterns — too short/long prefix)
  - Case-insensitive: prv-201 treated as PRV-201
```

---

## Session Resumption Prompt

```
Continue PortolanCAST Stage 3 (Equipment Intelligence).
Read plan: PKM/Inbox/Stage3_EquipmentIntelligence_Plan_3_1_2026.md
Pipeline:  ~/.claude/PIPELINES/Engineering_OpenRevu/PIPELINE.md
Project:   /mnt/c/Users/User1/ClaudeProjects/PortolanCAST/

Stage 3A implementation order:
1. db.py — append 3 tables to SCHEMA_SQL + add entity CRUD methods
2. main.py — add ENTITY ROUTES section (~12 routes)
3. properties.js — add _loadEntitySection() + _promoteMarkup() + entity DOM
4. test_stage3a.mjs — 25 tests
5. run_tests.mjs — add test_stage3a.mjs

Key constraint: tag_number UNIQUE → 409 conflict → frontend merge prompt.
Key constraint: markup_id comes from Fabric obj.markupId (already exists on all objects via stampDefaults()).
Key constraint: GET /api/entities/{id}/markups JOINs documents table for doc_name.

Current test baseline: 968 tests, 34 suites. Target after Stage 3A: ~993.
```

---

## Field Use Notes

This system is designed for use on construction sites and in facilities management. A few design principles that flow from that:

**Quick entry first.** The tag input in the properties panel is the primary entry point — type a tag number, hit Enter. Full fields come later in the modal. A field engineer needs to link a markup to PRV-201 in 3 seconds, not fill a form.

**Tag scanning friendly.** tag_number is a plain text field. A Bluetooth barcode/QR scanner will emit the tag number as keyboard input — the tag input field catches it naturally.

**Cross-doc is the payoff.** The moment a field engineer opens the entity modal and sees "3 markups across 2 documents" — that's when the system earns its keep. The riser diagram issue, the equipment schedule note, and the maintenance log entry are all in one place.

**Maintenance log is append-only.** Immutable entries. If a field engineer writes "No leak visible," that stays on record even if the situation changes. This is how real maintenance logs work — you don't edit history, you add to it.

**Offline resilience note (future).** The current architecture is local-first (SQLite, no network). The entity system inherits this. When Stage 4 (Collaboration Layer) adds multi-party support, entity records will need a merge strategy — the tag_number natural key makes this tractable.

---

*Plan authored: 2026-03-01 — PortolanCAST Stage 3 planning session*
