/**
 * nodeCAST Plugin — Tag-Connected Markup Graph (Phase 1 Experiment)
 *
 * Purpose:
 *   Renders a force-directed SVG graph of all markup objects on the current
 *   canvas page. Markups with shared #tags are connected through a shared tag
 *   node, making cross-cutting concerns visible at a glance.
 *
 *   This is the founding experiment of the nodeCAST vision: treating markups
 *   as nodes in a knowledge graph rather than flat annotations on paper.
 *   The hypothesis: "if two markups share a tag, they are related — show it."
 *
 * Architecture:
 *   1. init(container, app)    — renders SVG shell into right-panel tab
 *   2. onDocumentLoaded(info)  — triggers _buildGraph() for initial page
 *   3. onPageChanged(page, N)  — triggers _buildGraph() after page switch
 *   4. onObjectSelected(obj)   — highlights the corresponding node in graph
 *   5. onObjectDeselected()    — clears graph highlighting
 *   6. Refresh button          — re-runs _buildGraph() on demand
 *
 * Graph data model:
 *   Two node kinds:
 *     kind='markup' — one per Fabric object with markupType set
 *     kind='tag'    — one per unique #tag string across all markupNotes
 *   Edges:
 *     markup node → tag node for each #tag in that markup's markupNote
 *
 * Force simulation:
 *   Synchronous Verlet integration (ITERATIONS ticks pre-computed):
 *     1. Coulomb repulsion   — all-pairs, F ∝ REPULSION / d²
 *     2. Spring attraction   — edges, Hooke toward SPRING_LENGTH
 *     3. Center gravity      — weak pull toward canvas center
 *     4. Velocity damping    — exponential decay (DAMPING per tick)
 *     5. Boundary clamping   — nodes stay within SVG viewport
 *
 * Interaction:
 *   - Click markup node → fc.setActiveObject(fabricObj) + fc.renderAll()
 *   - Hover markup node → SVG title tooltip shows note text
 *   - onObjectSelected → highlights selected node with drop-shadow + bold stroke
 *   - Refresh button   → _buildGraph() re-reads live canvas state
 *
 * Security assumptions:
 *   - All user content (note text, tag labels) uses textContent — no innerHTML
 *   - No remote network calls; all data comes from local Fabric canvas
 *   - Tag parsing uses a safe regex — no eval, no dynamic code execution
 *
 * Author: PortolanCAST
 * Version: 0.1.0  (Phase 1 nodeCAST experiment)
 * Date: 2026-02-28
 */

// =============================================================================
// VISUAL CONSTANTS
// =============================================================================

// Markup type → fill color. Must stay in sync with MARKUP_COLORS in canvas.js.
const NODE_COLORS = {
    issue:    '#ff4444',
    question: '#ff9800',
    approval: '#4caf50',
    change:   '#2196f3',
    note:     '#9c27b0',
};

// Node geometry
const MARKUP_RADIUS = 10;   // px — markup node circle radius (internal coords)
const TAG_RADIUS    =  6;   // px — tag node circle radius
const FONT_SIZE     =  8;   // px — node label font size

// SVG internal coordinate space (independent of CSS display size)
const SVG_W = 260;
const SVG_H = 280;

// =============================================================================
// FORCE SIMULATION CONSTANTS
// =============================================================================

// Spring: target separation between a markup node and its tag node
const SPRING_LENGTH   = 70;    // px (internal coords)
// Spring stiffness: larger = stiffer springs, stronger pull toward target length
const SPRING_STRENGTH = 0.04;
// Repulsion charge: larger = nodes push each other away more forcefully
const REPULSION       = 1200;
// Center gravity: weak pull toward (SVG_W/2, SVG_H/2) — prevents cluster drift
const GRAVITY         = 0.015;
// Damping: velocity multiplier per tick (0 = instant freeze, 1 = frictionless)
const DAMPING         = 0.82;
// Pre-computation ticks: run this many simulation steps before rendering.
// 350 is enough for <20 nodes to reach a visually stable layout.
const ITERATIONS      = 350;

// =============================================================================
// PLUGIN MANIFEST
// =============================================================================

/**
 * NodeCastPlugin — plain object manifest (same pattern as ExtendedCognitionPlugin).
 * State lives directly on the object; PluginLoader calls hooks as methods.
 * init() is called once; onDocumentLoaded/onPageChanged called on each event.
 */
export const NodeCastPlugin = {
    name:    'nodecast',
    label:   'Graph',
    version: '0.1.0',

    // Injected by PluginLoader.register()
    _container: null,
    _app:       null,

    // Graph data built by _buildGraph() — reset on each call
    _nodes:   [],   // [{ id, kind, type?, label, note?, fabricObj?, x, y, vx, vy }]
    _edges:   [],   // [{ source: id, target: id }]
    _nodeMap: null, // Map<id → node> — used by simulation + SVG rendering

    // DOM element references (set in _renderShell)
    _svg:      null,    // <svg> element
    _emptyEl:  null,    // "No markups" div
    _statusEl: null,    // status text span

    // =========================================================================
    // LIFECYCLE HOOKS (called by PluginLoader.emit)
    // =========================================================================

    /**
     * Called once by PluginLoader when the plugin is registered.
     * Renders the SVG shell into the injected right-panel container div.
     *
     * Args:
     *   container: #tab-plugin-nodecast div element
     *   app:       App instance (window.app)
     */
    init(container, app) {
        this._container = container;
        this._app = app;
        this._renderShell();
    },

    /**
     * Called when a new document finishes loading.
     * Builds the graph for the document's first (current) page.
     *
     * Args:
     *   info: Server document info { id, filename, page_count, ... }
     */
    onDocumentLoaded(info) {
        this._buildGraph();
    },

    /**
     * Called when the user navigates to a different page.
     * Delays slightly so the canvas finishes loading the new page's markups
     * before we read them — avoids building a graph with stale data.
     *
     * Args:
     *   page:  New page number (1-based)
     *   total: Total page count in the document
     */
    onPageChanged(page, total) {
        // 200ms delay matches the canvas page-load settle time
        setTimeout(() => this._buildGraph(), 200);
    },

    /**
     * Called when a Fabric object is selected on the canvas.
     * Highlights the corresponding markup node in the graph (if visible).
     *
     * Args:
     *   obj: The selected Fabric object
     */
    onObjectSelected(obj) {
        if (!this._svg || !obj?.markupId) return;
        this._highlightNode(obj.markupId);
    },

    /**
     * Called when the canvas selection is cleared.
     * Removes any active node highlight from the graph.
     */
    onObjectDeselected() {
        this._clearHighlight();
    },

    // =========================================================================
    // PRIVATE — SHELL RENDERING
    // =========================================================================

    /**
     * Build the static panel shell.
     * Creates: header (status + refresh button) + SVG viewport + empty-state div.
     * Called once in init(); subsequent updates mutate inner SVG contents only.
     *
     * HTML structure injected into container:
     *   .nc-header    — flex row with status text + Refresh button
     *   .nc-graph-area — contains the <svg> and the empty-state div
     */
    _renderShell() {
        if (!this._container) return;

        // SECURITY: static literal template — no user data interpolated here.
        // All dynamic content is written later via textContent (see _buildGraph).
        this._container.innerHTML = `
            <div class="nc-header">
                <span class="nc-status" id="nc-status">No document loaded.</span>
                <button class="toolbar-btn nc-refresh-btn" id="nc-refresh" title="Rebuild graph">↺</button>
            </div>
            <div class="nc-graph-area" id="nc-graph-area">
                <svg id="nc-svg"
                     viewBox="0 0 ${SVG_W} ${SVG_H}"
                     style="width:100%;height:300px;display:block">
                </svg>
                <div class="nc-empty" id="nc-empty" style="display:none">
                    No markups on this page.
                </div>
            </div>
            <div class="nc-legend" id="nc-legend">
                <span class="nc-legend-item">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                        <circle cx="5" cy="5" r="4" fill="#888"/>
                    </svg>
                    tag node
                </span>
                <span class="nc-legend-item">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                        <circle cx="5" cy="5" r="4" fill="#9c27b0"/>
                    </svg>
                    markup (click to select)
                </span>
            </div>
        `;

        this._svg      = this._container.querySelector('#nc-svg');
        this._statusEl = this._container.querySelector('#nc-status');
        this._emptyEl  = this._container.querySelector('#nc-empty');

        const refreshBtn = this._container.querySelector('#nc-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this._buildGraph());
        }
    },

    // =========================================================================
    // PRIVATE — GRAPH DATA CONSTRUCTION
    // =========================================================================

    /**
     * Collect markup objects from the current Fabric canvas, extract their
     * #tags from markupNote, and build the _nodes/_edges/_nodeMap for
     * the force simulation.
     *
     * Skips objects without markupType (measurement companions, temp shapes, etc.).
     * Each unique #tag becomes a shared tag node — two markups with the same
     * tag share one tag node and are thus connected through it.
     */
    _buildGraph() {
        const fc = this._app?.canvas?.fabricCanvas;
        if (!fc) return;

        // Only markup objects participate — filter out measurement companions
        // (area IText labels, etc.) and temp drawing objects.
        const objs = fc.getObjects().filter(o => !!o.markupType);

        // ── Build node + edge data ────────────────────────────────────────────

        const nodeMap = new Map();  // id → node
        const edges   = [];

        for (const obj of objs) {
            // Use markupId UUID if available; fall back to generated ID.
            // Generated IDs are stable within one _buildGraph() call but
            // will differ across calls — click-to-select uses fabricObj ref,
            // not the id, so this is acceptable.
            const id   = obj.markupId || `__mu_${Math.random().toString(36).slice(2)}`;
            const note = obj.markupNote || '';
            const tags = this._parseTags(note);

            // Markup node — starts near center with small random scatter
            // so the simulation has different positions to work from
            const mNode = {
                id,
                kind:      'markup',
                type:      obj.markupType,
                label:     obj.markupType,
                note,
                fabricObj: obj,
                x:  SVG_W / 2 + (Math.random() - 0.5) * 80,
                y:  SVG_H / 2 + (Math.random() - 0.5) * 80,
                vx: 0,
                vy: 0,
            };
            nodeMap.set(id, mNode);

            // Tag nodes — shared across all markups that use the same tag
            for (const tag of tags) {
                if (!nodeMap.has(tag)) {
                    nodeMap.set(tag, {
                        id:    tag,
                        kind:  'tag',
                        label: tag,
                        x:  SVG_W / 2 + (Math.random() - 0.5) * 120,
                        y:  SVG_H / 2 + (Math.random() - 0.5) * 120,
                        vx: 0,
                        vy: 0,
                    });
                }
                edges.push({ source: id, target: tag });
            }
        }

        this._nodes   = [...nodeMap.values()];
        this._edges   = edges;
        this._nodeMap = nodeMap;

        // ── Update status bar ─────────────────────────────────────────────────

        const markupCount = objs.length;
        const tagCount    = [...nodeMap.values()].filter(n => n.kind === 'tag').length;
        if (this._statusEl) {
            // SECURITY: textContent — counts are numbers, not user strings
            this._statusEl.textContent =
                `${markupCount} markup${markupCount !== 1 ? 's' : ''}, ` +
                `${tagCount} tag${tagCount !== 1 ? 's' : ''}`;
        }

        // ── Handle empty state ────────────────────────────────────────────────

        if (this._nodes.length === 0) {
            if (this._svg)     this._svg.style.display    = 'none';
            if (this._emptyEl) this._emptyEl.style.display = '';
            return;
        }

        if (this._svg)     this._svg.style.display    = '';
        if (this._emptyEl) this._emptyEl.style.display = 'none';

        // ── Run simulation + render ───────────────────────────────────────────

        this._runSimulation();
        this._renderSVG();
    },

    /**
     * Extract #tag strings from a markup note string.
     * Returns lowercase '#tagname' strings (including the leading #).
     * Tag regex: #([a-zA-Z0-9_-]+) — same as the existing server-side tag parser.
     *
     * Args:
     *   text: The markupNote string to parse.
     *
     * Returns:
     *   Array of '#tagname' strings in lowercase (may be empty).
     */
    _parseTags(text) {
        const matches = (text || '').match(/#([a-zA-Z0-9_-]+)/g) || [];
        return matches.map(t => t.toLowerCase());
    },

    // =========================================================================
    // PRIVATE — FORCE SIMULATION
    // =========================================================================

    /**
     * Run the force-directed layout simulation synchronously.
     *
     * Each of ITERATIONS ticks applies:
     *   1. Coulomb repulsion: every node-pair repels; F = REPULSION / d²
     *      — prevents nodes from stacking on top of each other
     *   2. Spring attraction: each edge pulls its two endpoints toward
     *      SPRING_LENGTH apart; F = (d − SPRING_LENGTH) × SPRING_STRENGTH
     *      — clusters connected components together
     *   3. Center gravity: gentle pull toward (SVG_W/2, SVG_H/2)
     *      — prevents the whole graph from drifting to a corner
     *   4. Velocity damping: vx/vy multiplied by DAMPING each tick
     *      — simulates friction; system reaches equilibrium
     *   5. Boundary clamping: x/y kept within [pad, SVG_W-pad] × [pad, SVG_H-pad]
     *      — nodes never leave the visible viewport
     *
     * Modifies node.x, node.y in place. After this returns, _renderSVG() reads
     * the final positions.
     */
    _runSimulation() {
        const nodes   = this._nodes;
        const edges   = this._edges;
        const nodeMap = this._nodeMap;
        const cx      = SVG_W / 2;
        const cy      = SVG_H / 2;
        // Padding: keep node centers at least one radius from the SVG edge
        const pad = MARKUP_RADIUS + 4;

        for (let iter = 0; iter < ITERATIONS; iter++) {

            // ── 1. Pair-wise Coulomb repulsion ────────────────────────────────
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a  = nodes[i];
                    const b  = nodes[j];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    // Clamp d² to avoid divide-by-zero when nodes overlap exactly
                    const d2 = (dx * dx + dy * dy) || 0.01;
                    const d  = Math.sqrt(d2);
                    const f  = REPULSION / d2;
                    const fx = (dx / d) * f;
                    const fy = (dy / d) * f;
                    a.vx -= fx;  a.vy -= fy;
                    b.vx += fx;  b.vy += fy;
                }
            }

            // ── 2. Spring attraction along edges (Hooke's law) ────────────────
            for (const edge of edges) {
                const a = nodeMap.get(edge.source);
                const b = nodeMap.get(edge.target);
                if (!a || !b) continue;
                const dx      = b.x - a.x;
                const dy      = b.y - a.y;
                const d       = Math.sqrt(dx * dx + dy * dy) || 1;
                const stretch = (d - SPRING_LENGTH) * SPRING_STRENGTH;
                const fx      = (dx / d) * stretch;
                const fy      = (dy / d) * stretch;
                a.vx += fx;  a.vy += fy;
                b.vx -= fx;  b.vy -= fy;
            }

            // ── 3. Center gravity ─────────────────────────────────────────────
            for (const n of nodes) {
                n.vx += (cx - n.x) * GRAVITY;
                n.vy += (cy - n.y) * GRAVITY;
            }

            // ── 4. Integrate velocity + damping + 5. Boundary clamping ────────
            for (const n of nodes) {
                n.vx *= DAMPING;
                n.vy *= DAMPING;
                n.x = Math.max(pad, Math.min(SVG_W - pad, n.x + n.vx));
                n.y = Math.max(pad, Math.min(SVG_H - pad, n.y + n.vy));
            }
        }
    },

    // =========================================================================
    // PRIVATE — SVG RENDERING
    // =========================================================================

    /**
     * Clear the SVG and write all edges and nodes from their final simulated
     * positions. Edges are drawn first so they appear behind node circles.
     *
     * Markup nodes: filled colored circle + type label + SVG title tooltip.
     * Tag nodes:    smaller gray circle + '#tag' label.
     * Edges:        dashed gray lines connecting markup nodes to tag nodes.
     */
    _renderSVG() {
        if (!this._svg) return;

        // Remove all previous children (avoid innerHTML = '' to preserve SVG namespace)
        while (this._svg.firstChild) {
            this._svg.removeChild(this._svg.firstChild);
        }

        // ── Edges (drawn behind nodes) ────────────────────────────────────────

        for (const edge of this._edges) {
            const a = this._nodeMap.get(edge.source);
            const b = this._nodeMap.get(edge.target);
            if (!a || !b) continue;

            const line = this._svgEl('line', {
                x1:                  a.x.toFixed(1),
                y1:                  a.y.toFixed(1),
                x2:                  b.x.toFixed(1),
                y2:                  b.y.toFixed(1),
                stroke:              '#b8b8c8',
                'stroke-width':      1.5,
                'stroke-dasharray':  '3,2',
            });
            this._svg.appendChild(line);
        }

        // ── Nodes ─────────────────────────────────────────────────────────────

        for (const node of this._nodes) {
            const g = this._svgEl('g', {
                transform:        `translate(${node.x.toFixed(1)},${node.y.toFixed(1)})`,
                'data-node-id':   node.id,
                'data-node-kind': node.kind,
            });

            if (node.kind === 'markup') {
                // ── Markup node: colored filled circle ─────────────────────────

                const circle = this._svgEl('circle', {
                    r:               MARKUP_RADIUS,
                    fill:            NODE_COLORS[node.type] || '#888888',
                    stroke:          '#ffffff',
                    'stroke-width':  1.5,
                    style:           'cursor:pointer',
                    'data-markup-id': node.id,
                });

                // SVG native title element provides browser tooltip on hover —
                // shows up to 80 chars of the note text (safe: set via textContent)
                const title = this._svgEl('title', {});
                title.textContent = node.note
                    ? `[${node.type}] ${node.note.slice(0, 80)}`
                    : `[${node.type}]`;
                circle.appendChild(title);

                // Click: select the corresponding Fabric object on the canvas
                circle.addEventListener('click', () => this._onNodeClick(node));

                // Type label: drawn below circle, never wider than the node
                const label = this._svgEl('text', {
                    y:                MARKUP_RADIUS + FONT_SIZE + 2,
                    'text-anchor':    'middle',
                    'font-size':      FONT_SIZE,
                    fill:             '#aaaabc',
                    'pointer-events': 'none',   // prevent label stealing click events
                });
                // SECURITY: textContent — type string comes from our own schema
                label.textContent = node.type.slice(0, 9);

                g.appendChild(circle);
                g.appendChild(label);

            } else {
                // ── Tag node: smaller gray circle ──────────────────────────────

                const circle = this._svgEl('circle', {
                    r:               TAG_RADIUS,
                    fill:            '#888888',
                    stroke:          '#ffffff',
                    'stroke-width':  1,
                    'data-tag-id':   node.id,
                });

                const label = this._svgEl('text', {
                    y:                TAG_RADIUS + FONT_SIZE,
                    'text-anchor':    'middle',
                    'font-size':      FONT_SIZE - 1,
                    fill:             '#999999',
                    'pointer-events': 'none',
                });
                // Truncate long tags — keep graph readable in narrow panel
                // SECURITY: textContent — tag names come from parsed markupNote
                label.textContent = node.label.length > 12
                    ? node.label.slice(0, 11) + '…'
                    : node.label;

                g.appendChild(circle);
                g.appendChild(label);
            }

            this._svg.appendChild(g);
        }
    },

    /**
     * Create an SVG element in the SVG namespace with the given attributes.
     * Helper to avoid repeating createElementNS and setAttribute boilerplate.
     *
     * Args:
     *   tag:   SVG element tag name ('circle', 'line', 'g', 'text', etc.)
     *   attrs: Plain object of attribute name → value pairs.
     *
     * Returns:
     *   SVGElement with all attrs set.
     */
    _svgEl(tag, attrs) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [k, v] of Object.entries(attrs)) {
            el.setAttribute(k, String(v));
        }
        return el;
    },

    // =========================================================================
    // PRIVATE — INTERACTION
    // =========================================================================

    /**
     * Handle a click on a markup node in the SVG graph.
     * Selects the corresponding Fabric object on the canvas, which also
     * triggers the canvas selection:created event → onObjectSelected feedback loop.
     *
     * Args:
     *   node: The markup node object with a fabricObj reference.
     */
    _onNodeClick(node) {
        if (node.kind !== 'markup' || !node.fabricObj) return;
        const fc = this._app?.canvas?.fabricCanvas;
        if (!fc) return;
        fc.setActiveObject(node.fabricObj);
        fc.renderAll();
    },

    /**
     * Highlight a specific markup node in the SVG graph by its markupId.
     * Applies a drop-shadow filter + thicker stroke to the selected node.
     * Other nodes are returned to their default appearance.
     *
     * Args:
     *   markupId: The markupId string to highlight.
     */
    _highlightNode(markupId) {
        if (!this._svg) return;
        this._svg.querySelectorAll('circle[data-markup-id]').forEach(c => {
            const isActive = c.getAttribute('data-markup-id') === markupId;
            // drop-shadow filter provides a visible glow on dark backgrounds
            c.style.filter      = isActive ? 'drop-shadow(0 0 4px rgba(255,255,255,0.7))' : '';
            c.setAttribute('stroke-width', isActive ? '3' : '1.5');
        });
    },

    /**
     * Remove all node highlights from the SVG graph.
     * Called when the canvas selection is cleared.
     */
    _clearHighlight() {
        if (!this._svg) return;
        this._svg.querySelectorAll('circle[data-markup-id]').forEach(c => {
            c.style.filter = '';
            c.setAttribute('stroke-width', '1.5');
        });
    },
};
