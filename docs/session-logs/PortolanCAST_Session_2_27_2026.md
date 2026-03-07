# PortolanCAST — Session Log 2026-02-27
Status: Complete | Next: B3 scroll navigation → Q3 right-click layer

---

## What We Did

### 1. nodeCAST Vision Planning
Started from user test notes (`PortolanCAST User Test Notes 2_26_2026.md`).
Used structured questions to move from feature requests to a problem statement.

**Documents created:**
- `PKM/Inbox/nodeCAST_Vision_2_27_2026.md` — product vision, problem statement, views
- `PKM/Inbox/nodeCAST_DataModel_2_27_2026.md` — architecture decision record, full schema

**Key decisions made:**
- Core problem: "I can't see the map of my own thinking"
- A markup is an EDGE (not a node) — bridges an idea node to a document node
- Two edge families: markup-edges (visual) + semantic edges (typed connections)
- Edge vocabulary: typed but `related_to` as untyped default
- Free-floating idea nodes exist (no document anchor required)
- Obsidian is the first graph view, via a SyncAdapter pattern (open to future tools)
- PortolanCAST becomes one view in nodeCAST (PDF canvas view)

---

### 2. PortolanCAST Bug Fixes

#### B1 — Photos lost in bundle export/import ✅ FIXED
**Root cause:** Bundle ZIP format was defined before photos feature existed.
Neither photo files nor DB records were included in the bundle.

**Changes:**
- `db.py`: added `get_all_document_photos(document_id)` method
- `main.py export_bundle`: collects photos → writes `photos/` folder + `photos.json` to ZIP
- `main.py import_bundle`: reads `photos.json` → extracts files → writes to PHOTOS_DIR → inserts DB records with new UUIDs under new doc_id
- `test_bundle.mjs`: 11 → 15 tests (photo upload, photos.json in ZIP, photo in imported doc, photo URL reachable)

**Test result:** 15/15 ✅

#### B2 — Highlight color shows gray regardless of type change ✅ FIXED
**Root cause (two failures compounding):**
1. The `note` intent type color is `#aaaaaa` (gray) — this is the default. User didn't know about intent modes.
2. The properties panel type-change handler and color picker only update `stroke`. Highlighter stores its color in `fill`. They talked past each other.

**Changes:**
- `static/js/properties.js`: in both the `markupType` change handler AND the `strokeColor` picker handler, added:
  ```js
  if (this._selectedObject.fill && this._selectedObject.fill !== 'transparent') {
      this._selectedObject.set('fill', newColor);
  }
  ```
- `test_highlight_color.mjs`: new file, 7 tests (initial state, type change, picker, regression)

**Test result:** 7/7 ✅

---

## What's Next (In Order)

| # | Item | Notes |
|---|------|-------|
| B3 | Scroll navigation needs panel click | Canvas likely capturing wheel events before container |
| Q3 | Right-click to assign layer | Context menu + layer picker |
| Q1 | Bundle save-as naming | Name dialog before download |
| Q2 | Callout label editable | IText in Group |
| L1 | Landscape canvas view | Viewer rotate/resize toggle |
| L2 | Toolbar customization | Large — significant UI restructure |
| L3 | Persistent mode bar at bottom | Fixed bottom strip for select/hand |

---

## Test File Inventory (Updated)

New files added this session:
- `test_highlight_color.mjs` — 7 tests (B2 fix verification)
- `test_bundle.mjs` — updated to 15 tests (was 11, added photo round-trip)

Run all tests: `cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node run_tests.mjs"`

---

## Planning Principles Practiced This Session

1. **Problem-first planning** — "What problem does this solve?" before features
2. **ADR format** — Architecture Decision Records capture the WHY, not just the WHAT
3. **Adapter pattern** — define an interface, implement for Obsidian first, keep path open
4. **Regression tests** — always test that your fix doesn't break adjacent behavior
5. **Read before edit** — understand the code before changing it

---

*Tags: #portolancast #nodecast #session-log #bugs-fixed #planning*
