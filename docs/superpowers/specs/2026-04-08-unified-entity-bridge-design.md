# Unified Entity Bridge — PortolanCAST + Ancillary Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect PortolanCAST (spatial floor plans) and Ancillary (building automation / JACE) through a shared entity language so that the same equipment is identifiable, bindable, and queryable across both systems.

**Architecture:** Two independent programs, REST bridge via backend proxy, scoped API keys, sync-on-demand (no live polling).

**Tech Stack:** Python (FastAPI), vanilla JS, SQLite, httpx for bridge client.

---

## Architecture Decision Record

### Why two programs instead of one?

PortolanCAST handles spatial context — WHERE equipment lives on floor plans. Ancillary handles control logic and live data — HOW equipment behaves and what it's doing right now. They serve different purposes, run in different contexts (PortolanCAST may run on a laptop in the field; Ancillary may run on a server room machine connected to the BAS network), and have different users at different times. Merging them would create a monolith that's harder to deploy, harder to secure, and harder to reason about.

### Why backend bridge instead of frontend direct?

The API key must never reach the browser. PortolanCAST's Python backend proxies all Ancillary requests, keeping credentials server-side. This also allows request throttling and graceful degradation — if Ancillary is unreachable, PortolanCAST continues working as a standalone drawing tool with zero errors in the browser console.

### Why scoped API keys instead of no auth?

The moment PortolanCAST can read building data, it crosses from "drawing tool" to "BAS interface." Even read-only access to live sensor data has security implications. A scoped key means a leaked key can read points but never write to them. This follows the principle: fail closed, not open. The security model is correct from day one, not retrofitted when writes arrive in Phase 2.

### Why sync-on-demand instead of live polling?

Live value overlay creates continuous traffic between PortolanCAST and Ancillary. For Phase 1, the value is in the *binding* — knowing that TT-101 on the McConnell floor plan IS the same thing as AHU1_ZoneTemp in Ancillary. Live values are Phase 2, and the bridge architecture supports them without redesign (add cache.py + poll loop + live-data endpoint).

---

## 1. Shared Entity Language

### 1.1 New Entity Fields

Two new nullable columns on the `entities` table in PortolanCAST:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `ancillary_point_id` | TEXT | NULL | Ancillary point identifier (e.g., `"AI-1"`) |
| `ancillary_point_name` | TEXT | NULL | Human-readable cache (e.g., `"AHU1_ZoneTemp"`) |

**Binding rules:**
- If both NULL → entity is unbound (manual-only, no Ancillary connection). This is the default and the state for sites like Smith College today.
- If set → entity is bound to a specific Ancillary point. Metadata (units, tags, signal type) is fetched once at bind time and cached on the entity.
- One entity maps to one Ancillary point. An AHU with 15 points = 15 entities, grouped by system pattern. This matches ISA-5.1 and Haystack: each point is its own identity.

### 1.2 Binding UX — Two Paths

**Path 1: Ancillary Search (when bridge is configured and connected)**

The entity panel gets a "Link to Ancillary" button. Clicking it opens a search box that queries Ancillary's point list via the bridge. User types a query (e.g., "zone temp"), sees matching points with their current values and tags, selects one. The `ancillary_point_id` and `ancillary_point_name` are saved on the entity. Point metadata (units, Haystack tags) is fetched and cached.

**Path 2: Manual Entry (fallback for offline or unconnected sites)**

The entity panel shows a text field for `ancillary_point_id`. User types the point ID/name directly. No validation against Ancillary (it's not connected). When Ancillary is eventually connected, the binding is already in place — the bridge can resolve it.

### 1.3 Sync Behavior

Sync is explicit, never automatic:

- **On bind** — metadata fetched once from Ancillary, stored on entity.
- **On demand** — "Refresh from Ancillary" button on entity detail re-fetches metadata (handles point renames, tag changes).
- **Bulk sync** — "Sync All Bindings" action refreshes metadata for every bound entity in the database. Run manually when needed.

No background polling. No WebSocket. No live data feed. Zero traffic when idle.

---

## 2. Bridge Module

### 2.1 File Structure

```
bridge/
├── __init__.py
├── config.py      — connection settings + API key management
└── client.py      — HTTP client that talks to Ancillary's REST API
```

### 2.2 Configuration (`bridge/config.py`)

Reads from `data/bridge.json`. This file is NOT committed to git (added to `.gitignore`).

```json
{
  "ancillary_url": "http://localhost:8080",
  "api_key": "pcast_read_abc123...",
  "enabled": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ancillary_url` | string | yes | Base URL of the Ancillary server |
| `api_key` | string | yes | Scoped read-only API key |
| `enabled` | boolean | yes | Master switch — if false, bridge is dormant |

If `data/bridge.json` is missing or `enabled: false`, the bridge is dormant. No errors, no warnings in the UI. PortolanCAST works as a standalone drawing tool. Bridge status endpoint returns `{ "enabled": false }` and the frontend hides all bridge-related UI.

### 2.3 HTTP Client (`bridge/client.py`)

Uses `httpx` (already available in most FastAPI projects) for async HTTP requests.

**Methods:**

| Method | Purpose | Returns on failure |
|--------|---------|-------------------|
| `is_connected()` | Test reachability (GET /api/status or similar) | `False` |
| `search_points(query: str)` | Search Ancillary point list | `[]` |
| `fetch_point_metadata(point_id: str)` | Get point name, units, tags, signal type | `None` |
| `fetch_points_metadata(point_ids: list)` | Batch metadata fetch | `{}` |

**Failure handling:**
- All calls have a 3-second timeout
- Connection errors return the documented fallback (None, [], False) — never raise to the caller
- Errors logged at WARNING level with the Ancillary URL (not the API key)
- The bridge never crashes PortolanCAST

**Security:**
- API key sent as `Authorization: Bearer <key>` header on every request
- Key is read-only scoped — even if intercepted, cannot write to the BAS
- Key loaded once at startup from `data/bridge.json`, held in memory, never logged

---

## 3. API Endpoints

Four new endpoints on PortolanCAST:

### 3.1 Bridge Status

```
GET /api/bridge/status
```

Response:
```json
{
  "enabled": true,
  "connected": true,
  "bound_entities": 12
}
```

- `enabled`: bridge config exists and `enabled: true`
- `connected`: Ancillary is reachable right now (tested on request)
- `bound_entities`: count of entities with non-null `ancillary_point_id`

Frontend uses this to decide whether to show bridge UI elements.

### 3.2 Point Search

```
GET /api/bridge/search-points?q=zone+temp
```

Response:
```json
{
  "points": [
    {
      "id": "AI-1",
      "name": "AHU1_ZoneTemp",
      "value": 72.3,
      "units": "°F",
      "tags": { "zone": "", "air": "", "temp": "", "sensor": "" }
    }
  ]
}
```

Proxies to Ancillary's REST API point search (the web dashboard's `/api/points` endpoint with query parameter, NOT the MCP tools). Returns empty array if bridge is disabled or Ancillary unreachable. Used by the entity panel binding UX.

### 3.3 Bind Entity to Ancillary Point

```
PUT /api/entities/{entity_id}/ancillary-binding
Content-Type: application/json

{
  "point_id": "AI-1",
  "point_name": "AHU1_ZoneTemp"
}
```

Response: updated entity JSON.

Sets `ancillary_point_id` and `ancillary_point_name` on the entity. If the bridge is connected, also fetches and caches point metadata (units, tags). If not connected, stores the binding anyway for future resolution.

### 3.4 Unbind Entity

```
DELETE /api/entities/{entity_id}/ancillary-binding
```

Response: updated entity JSON.

Clears `ancillary_point_id` and `ancillary_point_name`. The entity reverts to unbound/manual.

### 3.5 Bulk Sync

```
POST /api/bridge/sync
```

Response:
```json
{
  "synced": 10,
  "failed": 2,
  "errors": ["AI-99: point not found"]
}
```

Re-fetches metadata from Ancillary for every entity with an `ancillary_point_id`. Updates cached names, units, tags. Reports failures without aborting. Manual trigger only.

---

## 4. Auto-Pattern Matching (Stencil → Pattern Pipeline)

### 4.1 New Component Field

The `components` table gains one new column:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `isa_symbol` | TEXT | `''` | ISA-5.1 code from stencil manifest (e.g., `"TT"`) |

Populated during stencil import from `manifest.json`. For non-stencil components (harvested from documents), this remains empty.

### 4.2 Auto-Match Flow

When the entity panel opens after placing a stamp with `prompt_entity: true`:

1. Panel reads `componentId` from the placed Fabric object
2. Fetches component metadata → gets `isa_symbol`
3. If `isa_symbol` is non-empty: queries `SELECT * FROM patterns WHERE isa_symbol = ?`
4. **Single match** (e.g., `TT` → Zone Air Temperature Sensor): auto-selects the pattern, auto-fills equip_type and tag hint
5. **Multiple matches** (e.g., `TV` → Damper Command OR Valve Command): shows both in the pattern dropdown, user picks one
6. **No match** (e.g., electrical symbols with no ISA code): panel opens normally, no auto-selection

### 4.3 Stencil Import Update

The `POST /api/components/import-stencils` endpoint is updated to populate `isa_symbol` from the manifest's `isa_symbol` field on each symbol entry. Existing stencil components are updated on re-import (idempotent).

---

## 5. Security Model

### 5.1 API Key Scoping

| Scope | Can do | Cannot do |
|-------|--------|-----------|
| `read` | Search points, read values, read metadata, read alarms | Write points, override, change schedules |
| `write` (Phase 2) | Everything in `read` + write points, override | Change config, manage users |

Phase 1 issues only `read` scope keys. The bridge client sends the key; Ancillary validates the scope on every request.

### 5.2 Key Management

- Key stored in `data/bridge.json` (not in git, added to `.gitignore`)
- Key generated on the Ancillary side (Ancillary is the authority)
- No key rotation mechanism in Phase 1 — change the key in the JSON file and restart PortolanCAST
- Key never appears in: browser responses, log files, error messages, git history

### 5.3 PortolanCAST Auth (Deferred)

PortolanCAST currently has no user authentication. This is acceptable for Phase 1 because:
- The bridge is read-only
- PortolanCAST runs on localhost or private network
- The API key authenticates the *application*, not the *user*

When PortolanCAST gains user auth (future work), the bridge endpoints should require authentication. The API surface is designed so adding `@require_auth` decorators is a one-line change per endpoint.

---

## 6. Documentation Deliverables

### 6.1 Bridge Setup Guide (`docs/bridge.md`)

- What the bridge is and why it exists (2 paragraphs)
- Prerequisites: Ancillary running, API key generated
- Step-by-step: create `data/bridge.json`, verify with `/api/bridge/status`
- Binding workflow: how to link entities to Ancillary points
- Troubleshooting: disconnected, stale, search empty, key rejected
- Security notes: where the key lives, what read-only scope means

### 6.2 API Reference Updates

- Four new `/api/bridge/` endpoints with request/response examples
- Two new entity fields documented
- Updated entity creation flow showing Ancillary binding option

### 6.3 This Document

This spec serves as the architecture decision record. It documents what was decided, why, and what was explicitly deferred.

---

## 7. Explicitly Deferred (Phase 2+)

These features are NOT in scope for Phase 1. The architecture supports them without redesign.

| Feature | Phase | Prerequisite |
|---------|-------|-------------|
| Live value overlay (polling) | 2 | Add `bridge/cache.py`, poll loop, `/api/bridge/live-data` endpoint |
| Write commands from PortolanCAST | 2 | Write-scoped API key, user auth on PortolanCAST, confirmation UI |
| Bidirectional context (Ancillary queries PortolanCAST) | 3 | PortolanCAST exposes spatial API, Ancillary gains bridge client |
| Alarm-driven navigation | 2 | Live data + alarm status in overlay |
| User authentication on PortolanCAST | 2 | Required before write scope or multi-user deployment |
| Key rotation | 2 | Admin UI or CLI tool for generating new keys |

---

## 8. File Changes Summary

### New files:
- `bridge/__init__.py`
- `bridge/config.py`
- `bridge/client.py`
- `routes/bridge.py` (API endpoints)
- `docs/bridge.md` (setup guide)
- `data/bridge.json.example` (committed template, no real key)

### Modified files:
- `db.py` — add `ancillary_point_id`, `ancillary_point_name` to entities table; add `isa_symbol` to components table; update entity CRUD methods
- `routes/components.py` — update stencil import to populate `isa_symbol`
- `static/js/equipment-marker.js` — add "Link to Ancillary" button, point search UI, auto-pattern matching
- `static/js/toolbar.js` — pass `isa_symbol` to entity panel when stamping
- `main.py` — register bridge router
- `.gitignore` — add `data/bridge.json`
- `docs/api.md` (or equivalent) — new endpoints and fields
