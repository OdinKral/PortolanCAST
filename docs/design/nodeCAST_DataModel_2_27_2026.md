# nodeCAST — Data Model Decision Record
2026-02-27 | Status: Decided | Type: Architecture Decision Record (ADR)

---

## What Is an ADR?

An Architecture Decision Record captures a design choice at the moment it was made,
including the context, the options considered, and the reasoning. Future-you will
forget WHY a decision was made. This document answers that.

---

## Decision Summary

| Decision | Choice | Date |
|----------|--------|------|
| What is a node? | Idea, document, person, concept — NOT a markup | 2026-02-27 |
| What is a markup? | An edge between an idea node and a document node | 2026-02-27 |
| Are edges typed? | Yes — small fixed vocabulary, untyped as default | 2026-02-27 |
| Do free-floating nodes exist? | Yes — ideas don't require a document anchor | 2026-02-27 |
| Storage engine | SQLite (revisit if query complexity demands graph DB) | 2026-02-27 |

---

## The Core Model

```
Everything in nodeCAST is either a NODE or an EDGE.

NODES  = things that exist (ideas, documents, people, concepts)
EDGES  = connections between things (markup-edges + semantic edges)

A markup drawn on a PDF is an EDGE.
It connects:
  [Idea Node]  ────── markup-edge ──────  [Document Node]
  "valve sizing concern"   at p.3, here    "P&ID Drawing 042"
```

### Why "markup = edge" and not "markup = node"

Option: markup as node (what PortolanCAST does today)
  → Every markup is isolated. It knows what document it's on,
    but it has no connection to the abstract idea behind it.
  → If the same concern appears in three drawings, you have
    three separate unconnected nodes. The map stays invisible.

Option: markup as edge (the nodeCAST decision)
  → Every markup bridges an idea to a document.
  → If the same concern appears in three drawings, three markup-edges
    all point FROM the same idea node TO three document nodes.
  → In graph view: one idea, connected to three documents. The map
    becomes visible.

This is the fundamental reason for the rebuild.

---

## The Two Edge Families

### Family 1: Markup Edges (visual, anchored to a document location)

These are what you draw on the canvas. They have shape, color, and position.

```
Markup Edge Properties:
  id           — UUID
  from_id      — idea node ID (auto-created as stub if not pre-existing)
  to_id        — document node ID
  type         — one of the markup types below
  page         — page number in the document
  x, y, w, h  — bounding box on the page (at BASE_DPI 150)
  shape        — rect | ellipse | line | path | group | itext
  color        — hex color
  visual_json  — full Fabric.js object serialization (for rendering)
  note         — the markup's text note
  status       — open | resolved | approved
  tags         — JSON array of #tag strings
  author       — who created it
  created_at   — timestamp
```

Markup edge types (what kind of annotation is this?):

| Type | Meaning | Color convention |
|------|---------|-----------------|
| `question` | Raises a question about this location | Blue |
| `note` | Records an observation | Green |
| `issue` | Flags a problem | Red |
| `approval` | Marks as reviewed/correct | Teal |
| `change` | Requests a revision | Orange |
| `measure` | Records a measurement | Purple |

---

### Family 2: Semantic Edges (invisible, connect any two nodes)

These appear in graph view. They express meaning between ideas.

```
Semantic Edge Properties:
  id         — UUID
  from_id    — any node ID
  to_id      — any node ID
  type       — one of the semantic types below (default: related_to)
  note       — optional label for nuance
  created_at — timestamp
  author     — who created it
```

Semantic edge types (how do these two things relate?):

| Type | Meaning | Example |
|------|---------|---------|
| `related_to` | Generic connection (default, untyped) | Any two linked ideas |
| `cites` | This references that as a source | Note → drawing it came from |
| `contradicts` | These two ideas conflict | Two spec claims that disagree |
| `expands` | This elaborates on that | Detail note → summary idea |
| `caused_by` | Causal relationship | Failure → root cause |
| `questions` | This raises doubt about that | Observation → assumption |

**Default behaviour:** clicking to connect two nodes creates a `related_to` edge
immediately. The type can be set or changed afterward without breaking anything.

---

## The Database Schema

```sql
-- ============================================================
-- NODES TABLE
-- Every "thing" in the system — ideas, documents, people, etc.
-- Markups do NOT appear here. They are edges.
-- ============================================================
CREATE TABLE nodes (
    id          TEXT PRIMARY KEY,       -- UUID, permanent, never changes
    type        TEXT NOT NULL,          -- 'idea' | 'document' | 'person' | 'concept'
    content     TEXT,                   -- the label, title, or text of this node
    is_stub     BOOLEAN DEFAULT TRUE,   -- TRUE until the user names/edits the node
    created_at  DATETIME NOT NULL,
    author      TEXT,
    tags        TEXT DEFAULT '[]',      -- JSON array: ["#safety", "#valve"]
    metadata    TEXT DEFAULT '{}'       -- JSON for type-specific extra fields
);

-- Index for fast lookup by type (common query: "show all documents")
CREATE INDEX idx_nodes_type ON nodes(type);


-- ============================================================
-- EDGES TABLE
-- Every connection between two nodes.
-- Markup edges AND semantic edges live here.
-- ============================================================
CREATE TABLE edges (
    id          TEXT PRIMARY KEY,       -- UUID
    from_id     TEXT NOT NULL REFERENCES nodes(id),
    to_id       TEXT NOT NULL REFERENCES nodes(id),
    edge_family TEXT NOT NULL,          -- 'markup' | 'semantic'
    type        TEXT NOT NULL,          -- markup type OR semantic type (see vocabularies above)

    -- Markup-only fields (NULL for semantic edges)
    page        INTEGER,                -- page number in the document
    x           REAL,                   -- bounding box: left edge, in pixels at BASE_DPI 150
    y           REAL,                   -- bounding box: top edge
    w           REAL,                   -- bounding box: width
    h           REAL,                   -- bounding box: height
    shape       TEXT,                   -- 'rect' | 'ellipse' | 'line' | 'path' | 'group' | 'itext'
    color       TEXT,                   -- hex color string
    visual_json TEXT,                   -- full Fabric.js object JSON for rendering
    status      TEXT DEFAULT 'open',    -- 'open' | 'resolved' | 'approved'

    -- Both families
    note        TEXT,                   -- markup note OR edge label
    tags        TEXT DEFAULT '[]',      -- JSON array
    author      TEXT,
    created_at  DATETIME NOT NULL
);

-- Indexes for graph traversal (follow edges FROM or TO a node)
CREATE INDEX idx_edges_from ON edges(from_id);
CREATE INDEX idx_edges_to   ON edges(to_id);
CREATE INDEX idx_edges_type ON edges(edge_family, type);
```

---

## What the Idea Node Stub Looks Like

When you draw a markup on a PDF page, the system auto-creates:

```json
// Node (the idea end of the edge) — starts as a stub
{
  "id": "node-abc-123",
  "type": "idea",
  "content": "",
  "is_stub": true,
  "created_at": "2026-02-27T16:00:00",
  "author": "User",
  "tags": []
}

// Edge (the markup itself)
{
  "id": "edge-xyz-456",
  "from_id": "node-abc-123",       ← points to the stub idea node
  "to_id":   "node-pdf-042",       ← points to the document node
  "edge_family": "markup",
  "type": "question",
  "page": 3,
  "x": 120, "y": 340, "w": 80, "h": 40,
  "shape": "rect",
  "color": "#4A90D9",
  "visual_json": "{ ... Fabric.js rect ... }",
  "status": "open",
  "note": "Does this valve fail open or closed?",
  "tags": ["#safety"],
  "author": "User",
  "created_at": "2026-02-27T16:00:00"
}
```

Later, the user names the stub: `content = "Valve fail-safe direction — open question"`.
Now it can be linked to other nodes (spec documents, related questions, resolved answers).

---

## What Gets Rebuilt vs. What Survives

### Survives (view layer — keep it)

```
static/js/canvas.js         — Fabric.js canvas, rendering, zoom/pan
static/js/toolbar.js        — all the drawing tools and keyboard shortcuts
static/js/pdf-viewer.js     — PDF rendering (PyMuPDF → PNG)
static/js/measure.js        — measurement tools (become measure-type markup edges)
static/js/properties.js     — properties panel (reads edge fields instead of markup fields)
static/js/node-editor.js    — vertex editing (reusable)
static/js/plugins.js        — plugin loader architecture
```

### Rebuilt (domain layer — new schema, new API contract)

```
main.py                     — new routes: /nodes, /edges instead of /documents/markups
database schema             — nodes + edges tables replace markups table
static/js/app.js            — wiring (calls new API)
static/js/markup-list.js    — queries edges (markup family) instead of markups table
static/js/layers.js         — layers become a tag or metadata field on edges
bundle format (.portolan)   — exports nodes.json + edges.json instead of markups.json
```

### New (graph layer — doesn't exist yet)

```
graph view canvas           — force-directed graph visualization
node editor panel           — create/edit free-floating idea nodes
semantic edge creator       — connect two nodes with a typed edge
cross-document search       — find all nodes/edges matching a query across all documents
migration script            — convert PortolanCAST markups → nodeCAST edges + stub nodes
```

---

## Migration Path from PortolanCAST

Each existing PortolanCAST markup becomes:
1. One stub idea node (auto-generated, `is_stub = true`, content = empty)
2. One markup edge from that stub to the document node

```python
# Pseudocode — migration script shape
for markup in portolancast_markups:
    # Create the document node if it doesn't already exist
    doc_node = get_or_create_node(type='document', source=markup.document_id)

    # Create a stub idea node
    idea_node = create_node(
        type='idea',
        content='',           # stub — user fills this in later
        is_stub=True,
        tags=markup.tags,
        author=markup.author,
        created_at=markup.created_at
    )

    # Create the markup edge
    create_edge(
        from_id=idea_node.id,
        to_id=doc_node.id,
        edge_family='markup',
        type=markup.markupType,        # question | note | issue | etc.
        page=markup.page,
        x=markup.x, y=markup.y,
        w=markup.w, h=markup.h,
        shape=markup.shape,
        color=markup.color,
        visual_json=markup.visual_json,
        status=markup.status,
        note=markup.markupNote,
        tags=markup.tags,
        author=markup.author,
        created_at=markup.created_at
    )
```

All existing markups become valid edges. No data is lost. The user can then
name the stub nodes over time, connecting their ideas across documents.

---

## Open Questions That Remain

1. ~~**Obsidian sync**~~ — **DECIDED**: Obsidian is the first graph view.
   See Integration Layer section below.

2. **Granularity floor**: Can a node be smaller than a markup region?
   *(For now: no. The markup region is the smallest addressable unit.)*

3. **Graph DB threshold**: At what scale does SQLite become too slow for
   graph traversal? *(SQLite handles millions of rows fine. Only revisit
   if multi-hop queries across the whole graph become slow.)*

---

## Integration Layer (Sync Adapter Pattern)

**Decision (2026-02-27):** nodeCAST uses an adapter layer for all external
integrations. The graph data always lives in nodeCAST (SQLite). External tools
are views and editors of that data — not the source of truth.

This keeps the path open for future in-house graph views or other third-party
tools without changing the core data model.

### The SyncAdapter Interface

Every integration implements the same contract:

```python
class SyncAdapter:
    name:   str      # display name shown in UI ("Obsidian", "Graph View")
    format: str      # data format used ("markdown", "json", "graphql", "api")

    def push(self, nodes: list, edges: list) -> None:
        """Write nodeCAST graph data to the external system."""
        raise NotImplementedError

    def pull(self) -> dict:
        """Read changes back from the external system.
        Returns: {"nodes": [...], "edges": [...]}
        """
        raise NotImplementedError

    def sync(self) -> None:
        """Convenience: push then pull (bidirectional)."""
        self.push(...)
        return self.pull()
```

Adding a new integration = writing a new class that implements this interface.
Nothing else in nodeCAST changes.

### The Obsidian Adapter (First Implementation)

**Source of truth rules:**
- nodeCAST owns: markup edges (visual, coordinate data Obsidian can't use)
- Obsidian owns: idea node *content* (the user's written notes and thinking)
- Both own: semantic edges (wiki-links in Obsidian ↔ semantic edges in nodeCAST)

**Node → .md file mapping:**
```
Idea node "Valve sizing concern"
→  {vault}/nodeCAST/Valve sizing concern.md

Frontmatter:
  nodeCAST_id: abc-123
  type: idea
  tags: [safety, valve]
  created: 2026-02-27

Body: (blank — user writes here in Obsidian)
```

**Semantic edge → wiki-link mapping:**
```
related_to edge  →  [[Target Node Name]]
cites edge       →  [[Target Node Name]]   (type stored in frontmatter)
```

**Markup edge → reference line (not a real edge in Obsidian):**
```
> Marked on [[P&ID Drawing 042]] p.3 — question
```
Obsidian sees this as text, not a link to follow for sync.
It gives context without creating a spurious semantic edge.

**Bidirectional sync:**
- New wiki-links created in Obsidian → imported as `related_to` semantic edges
- Edits to node body in Obsidian → synced back to node `content` field
- New markups in nodeCAST → new reference lines added to the .md file

### Future Adapters (Placeholders)

| Adapter | Format | When |
|---------|--------|------|
| `ObsidianAdapter` | Markdown + wiki-links | Now (first implementation) |
| `InHouseGraphAdapter` | JSON via internal API | When we build the graph canvas |
| `JsonExportAdapter` | `graph.json` flat export | Always available, trivial to write |
| `LogSeqAdapter` | Markdown (LogSeq dialect) | If user wants LogSeq instead |
| *(any tool that reads JSON or Markdown)* | — | Open-ended |

---

*Tags: #nodeCAST #data-model #architecture #decision-record #graph #nodes #edges*
