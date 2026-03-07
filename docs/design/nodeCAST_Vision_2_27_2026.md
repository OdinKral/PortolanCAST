# nodeCAST — Product Vision
2026-02-27 | Status: Draft | Origin: PortolanCAST user testing session

---

## The Problem Statement

> "I can't see the map of my own thinking."

PDF markup tools — including PortolanCAST — let you annotate documents.
But the annotations don't know about each other, and they're locked inside
the document they were created in.

When reading and marking up across many files, insights sit in isolated silos.
There is no view that shows how all your ideas connect to each other.

**Current tools solve document annotation.**
**nodeCAST solves thought externalization.**

This is the core problem. Every feature decision should be tested against it.

---

## Core Concept: The Semantic Graph

At the heart of nodeCAST is a graph:

- **Nodes** — units of meaning: ideas, documents, people, concepts. A node exists
  independently of any document. An idea node can be free-floating (no location anchor)
  or anchored to a place in a document.
- **Edges** — connections between nodes. There are two families:
  - *Markup edges* — visual, anchored to a location in a document (what PortolanCAST calls "markups")
  - *Semantic edges* — invisible connections between any two nodes (cites, contradicts, expands, etc.)
- **Views** — different ways to look at the same underlying graph

The graph is the engine. Views are the interfaces.

**Key decision (2026-02-27): A markup IS an edge, not a node.**
A markup bridges an idea node and a document node at a specific location on a page.
This means every annotation you draw is simultaneously a visual shape AND a semantic
connection. See `nodeCAST_DataModel_2_27_2026.md` for the full schema.

---

## PortolanCAST as One View

PortolanCAST is the **PDF view** of the graph.

When you add a markup on a PDF page, you are:
1. Creating a markup-edge between an idea node and a document node
2. Anchoring that edge to a specific location (page, coordinates)
3. Tagging the edge with type, status, color, and a note (edge metadata)

The idea node on the other end starts as a stub. You can later give it a real
name and connect it to other ideas across other documents.

The PDF canvas = one view of the graph, spatially organized by the document's
physical layout.

PortolanCAST was Phase 1: learn what markup in a PDF can mean. It proved:
- Color = intent/status
- Type = function (note, question, issue, revision)
- Tags = ad-hoc categories
- Layers = groupings
- Relationships (via callouts and links) = nascent edges

nodeCAST takes those lessons and generalizes them into a document-independent
data model. PortolanCAST's markup format becomes one serialization of a more
general node schema.

---

## Other Views (Future)

| View | Description | Status |
|------|-------------|--------|
| **PDF View** | Fixed-layout documents, spatial anchoring | PortolanCAST (existing) |
| **Graph View** | Force-directed or hierarchical, shows connections across documents | nodeCAST core |
| **EPUB / Text View** | Flowing text, same markup system | Future |
| **Outline View** | Flat list of nodes, filterable/sortable | Future |
| **Obsidian Sync** | Bidirectional: nodes as atomic notes, edges as wiki-links | First integration (via SyncAdapter) |
| **Vector Drawing View** | Engineering drawings, mechanical diagrams | Future |

---

## What Success Looks Like

You annotate a mechanical drawing in the PDF view and a corresponding spec
document in the text view. In the graph view, you can see the connection
between the markup on the drawing and the note in the spec — even though
they're in different files.

The map of your thinking is visible.

You can follow a question from a drawing to the spec, to a research note,
to a conversation summary. The trail of reasoning is navigable.

---

## Design Decisions Made (2026-02-27)

These questions are answered. They are the foundation of the data model.

**Decision 1: A markup is an edge, not a node.**
When you draw a shape on a PDF, you create an edge between an idea node and
a document node. The markup carries the visual properties (shape, color, position)
and a semantic type (question, note, issue). The idea node on the other end starts
as a stub and can be named and connected to other ideas later.
*Reason: this lets the same idea node connect to many documents. That is the
map of thinking that PortolanCAST cannot produce.*

**Decision 2: Two edge families with a typed vocabulary.**
- Markup edges (idea → document location): question | note | issue | approval | change | measure
- Semantic edges (node → node): related_to | cites | contradicts | expands | caused_by | questions
- Default for semantic edges: `related_to` (untyped, one click to create)
- Type can be set or changed after the edge is created
*Reason: typed edges make the graph queryable. Untyped default removes friction.*

**Decision 3: Free-floating idea nodes exist.**
Nodes do not need a document anchor. Pure ideas, concepts, and standing questions
can exist in the graph independently of any specific document.
*Reason: thinking happens outside documents. The system must model that.*

See `nodeCAST_DataModel_2_27_2026.md` for the full schema and migration plan.

---

## Relationship to PortolanCAST

| | PortolanCAST | nodeCAST |
|---|---|---|
| Core metaphor | Document with markup | Graph with views |
| Unit of meaning | Markup (tied to PDF page) | Node (idea, document, concept) |
| A markup is... | A record in the markups table | An edge between idea and document |
| Relationships | Implicit (layers, tags) | Explicit typed edges (two families) |
| Primary view | PDF canvas | Graph canvas |
| Secondary views | Markup list, measures, layers | PDF, EPUB, outline, etc. |
| Data format | SQLite (document-scoped) | SQLite (nodes + edges tables, global) |

The PortolanCAST code provides:
- Proven UI patterns for markup tools
- The bundle format (.portolan) as a starting point for node serialization
- The measurement system as a specialized node type
- The plugin architecture for view injection

---

## Open Questions (Things Not Decided Yet)

These are the hard questions. Don't design around them — answer them first.

1. **Migration**: How does PortolanCAST's existing markup data migrate into nodeCAST's graph schema?
   *(Each markup becomes an edge. The idea node on its "from" end is auto-created as a stub.
   Migration script needed. Shape sketched in `nodeCAST_DataModel_2_27_2026.md`.)*
2. ~~**Relationship types**~~ — **DECIDED**: typed vocabulary, untyped default. See decisions above.
3. **Storage**: SQLite (simple, proven) or a graph database (Neo4j, Memgraph)?
   *(SQLite is the likely first choice — revisit only if multi-hop queries become slow.)*
4. ~~**Obsidian boundary**~~ — **DECIDED**: Obsidian is the first graph view, via a SyncAdapter
   layer that keeps the architecture open to future tools. See `nodeCAST_DataModel_2_27_2026.md`.
5. ~~**Identity**~~ — **DECIDED**: free-floating idea nodes exist. See decisions above.
6. **Granularity**: What is the smallest node — a markup region, a sentence, a concept?
   *(Currently: markup region. This may stay as-is for the PDF view.)*

---

## Naming

- Working title: **nodeCAST**
- Alternative: tree metaphor — the roots are the hidden communication network
  between trees (the "secret life of trees" reference)
- The "CAST" suffix could stay — "casting" meaning to project or broadcast meaning
- Other candidates: RootCAST, WeftCAST (weft = the threads that hold a weave together)

---

## What to Do Next

1. ~~Answer the open questions~~ — **DONE**: node = idea/document/concept, markup = edge, typed vocabulary
2. ~~Sketch the core data model~~ — **DONE**: see `nodeCAST_DataModel_2_27_2026.md`
3. **Fix PortolanCAST's photo-in-bundle bug** — photos are lost on bundle reload (data loss, fix soon)
4. **Answer remaining open questions** — migration path details, storage choice (SQLite likely)
5. **Start nodeCAST in GitHub** — version control from day one, unlike PortolanCAST
6. **Design the migration script** — convert PortolanCAST markups → nodeCAST edges + stub nodes

---

## Learning Notes

*What this planning session taught:*

Problem-first planning changes what you build. Without asking "what problem
does this solve," the work on PortolanCAST would have continued adding features
(toolbar customization, scroll behavior) instead of recognizing that the real
product is a different architecture entirely.

The key questions that unlocked this:
1. What is the ONE frustration this solves that PortolanCAST can't?
2. What is the relationship between the two products?

These two questions took 5 minutes and produced more design clarity than hours
of feature-listing would have.

Second session (2026-02-27 — nodes/edges design):
The decision to make "markup = edge" came from asking: "what are the two things
a markup connects?" This is a data modeling question, not a feature question.
Asking it before writing any code means we don't have to rebuild the foundation
later. Sometimes you have to start over to build something correctly — the key
skill is recognizing that moment early instead of late.

---

*Tags: #nodeCAST #vision #systems-thinking #knowledge-graph #planning #data-model*
