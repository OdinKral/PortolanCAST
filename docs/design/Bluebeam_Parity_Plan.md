---
title: "Bluebeam Parity Plan"
date: 2026-04-01
source: "Bluebeam support.bluebeam.com + bluebeam.com product pages"
---

# Bluebeam Revu Feature Parity Plan

## Bluebeam Revu 21 — Complete Tool Inventory

### Markup Menu
- Text Box, Typewriter, Note, Callout
- Pen (freehand), Highlight, Eraser
- Line, Arrow, Arc, Polyline, Dimension
- Rectangle, Ellipse, Polygon, Cloud, Cloud+

### Image Menu
- From File, From Camera, From Scanner, Crop Image, Flag

### PDF Content Menu
- Review Text, Underline, Squiggly, Strikethrough
- Create Hyperlinks from URLs

### Stamp Menu
- Pre-loaded stamps, custom stamps

### Measure Menu
- Set Scale, Length, Polylength, Area, Perimeter
- Diameter, Center Radius, 3-Point Radius, Angle
- Volume, Polygon Cutout, Ellipse Cutout
- Count, Dynamic Fill

### Sketch to Scale Menu
- Polygon, Rectangle, Ellipse, Polyline — all drawn to scale

### Form Menu
- Auto-create form fields, Text Box, Radio Button, Check Box
- List Box, Dropdown, Button, Digital Signature
- Import/Export/Merge Data, JavaScript

### Signature Menu
- Sign Document, Certify Document, Validate Signatures, Digital IDs

### Tool Chest
- Save custom markups for reuse
- Tool Sets (.btx files) — import/export/share
- Pre-loaded collections, user-created sets
- Right-click markup → "Add to Tool Chest"

### Collaboration (Studio)
- Real-time document collaboration
- Check-in/check-out document control
- Markup assignment to team members
- Activity logging, status reporting

### AI Features (Bluebeam Max, launching 2026)
- Claude (Anthropic) integration for natural-language automation
- VisualSearch — AI-powered quantity takeoffs
- MagicWand markup tools (Convert to, Duplicate as, Offset)
- Stitching — auto-combine multiple sheets

---

## Feature Comparison Matrix

### HAVE (PortolanCAST already matches or exceeds)
| Feature | Bluebeam | PortolanCAST | Notes |
|---------|----------|-------------|-------|
| Freehand Pen | Pen tool | Pen (P key) | PencilBrush in Fabric.js |
| Rectangle | Rectangle | Rect (R key) | |
| Ellipse | Ellipse | Ellipse (E key) | |
| Line | Line | Line (L key) | |
| Arrow | Arrow | Arrow (Shift+A) | Group(shaft+arrowhead) |
| Highlight | Highlighter | Highlighter (H key) | Color bug exists |
| Text | Text Box | IText (T key) | |
| Cloud | Cloud | Cloud (C key) | Arc-bump path |
| Callout | Callout | Callout (O key) | Group(Line+IText) |
| Polyline | Polyline | Polyline (W key) | Click-accumulate-dblclick |
| Sticky Note | Note | Sticky Note (S key) | Yellow Textbox |
| Image overlay | From File | Image Overlay (I key) | Upload + place |
| Photo attach | From Camera | Markup Photos | Server-stored |
| Set Scale | Set Scale | Calibrate (K key) | |
| Length | Length | Distance (U key) | |
| Area | Area | Area (A key) | Polygon-based |
| Count | Count | Count (N key) | |
| Bundle save/load | — | .portolan ZIP | Exceeds — portable |
| PDF export | PDF export | Export with shapes | |
| Review Brief | — | Review Brief | |
| RFI generation | — | RFI export | |
| OCR | OCR | Text extraction API | |
| AI integration | Claude (upcoming) | ClaudeProxy + Ollama | Already live |
| OCG layers | Layer view | PDF layer toggle | Content stream filter |
| Obsidian export | — | Export to .md | Unique to us |

### AHEAD (PortolanCAST features Bluebeam doesn't have)
| Feature | Description |
|---------|-------------|
| Equipment Markers | Entity-linked pins on floor plans |
| Haystack Patterns | ISA-5.1 auto-numbering, structured HVAC patterns |
| Entity Connections | sensor→controller→actuator wiring on canvas |
| ISA View Toggle | SYS/ISA label swap |
| Validation Engine | Incomplete control loop detection |
| Entity Modal | Log, tasks, photos, parts, connections per entity |
| Obsidian Export | Markups → wikilink markdown files |
| Local AI (Ollama) | On-device LLM for analysis |

### MISSING (prioritized by field use frequency)

#### Tier 1 — Daily field use at Smith (build first) — ✅ COMPLETE
| Feature | Effort | Status | Description |
|---------|--------|--------|-------------|
| Highlight color fix | Small | ✅ Done | Gray overrides selected color — bug |
| Polygon tool | Small | ✅ Done | Click-accumulate closed shape (like polyline but fills) |
| Dimension lines | Medium | ✅ Done | Line with measurement text auto-calculated from scale |
| Eraser tool | Small | ✅ Done | Remove freehand pen strokes |
| Polylength measure | Small | ✅ Done | Multi-segment distance (polyline + sum lengths) |

#### Tier 2 — Weekly use, professional polish
| Feature | Effort | Description |
|---------|--------|-------------|
| Custom Tool Chest | Large | Save/load/share custom markup presets |
| Multi-row toolbar | Medium | 1-4 rows, configurable |
| Editable hotkeys | Medium | User-configurable keyboard shortcuts |
| Save-as naming | Small | Rename on bundle export |
| Layer assignment | Medium | Right-click → assign markup to layer |
| Landscape default | Small | Auto-detect page orientation |

#### Tier 3 — Advanced / next version
| Feature | Effort | Status | Description |
|---------|--------|--------|-------------|
| Text selection in PDF | Large | | Requires PDF text layer interaction |
| Review Text (edit marks) | Large | | Underline/strikethrough on PDF text |
| Hyperlinks | Medium | | Clickable links in markups |
| Stamps | Medium | | Pre-made stamp library |
| Form fields | Large | | Interactive PDF forms |
| Digital signatures | Large | | PKI signing |
| Arc tool | Small | | Single arc segment |
| Perimeter measure | Small | ✅ Done | Polygon perimeter (no fill) |
| Radius/Diameter | Small | | Circle-based measurements |
| Angle measure | Medium | ✅ Done | 3-point angle |
| Volume | Medium | | Area × depth calculation |
| Dynamic Fill | Large | | Flood-fill counting |
| Sketch to Scale | Medium | | Draw shapes at calibrated scale |
| Batch processing | Large | | Multi-document operations |
| Real-time collab | Large | | Studio equivalent |
| VisualSearch AI | Large | | AI quantity takeoffs |
