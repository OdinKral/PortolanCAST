/**
 * PortolanCAST — Measurement Tools Module
 *
 * Purpose:
 *   Phase 2 measurement and takeoff tools: distance ruler, area polygon,
 *   count markers, and scale calibration. These turn PortolanCAST into a real
 *   takeoff tool where distances and areas carry actual real-world values.
 *
 * Architecture:
 *   Each tool initializes mouse event handlers on the Fabric canvas and stores
 *   them in toolbar._shapeHandlers — the same cleanup contract as Phase 1
 *   shape tools. Switching tools triggers _cleanupShapeDrawing(), which removes
 *   all registered handlers automatically.
 *
 *   Measurement objects carry custom semantic properties:
 *     measurementType: 'distance' | 'area' | 'count'
 *     pixelLength:     Fabric natural-coord pixels (distance)
 *     pixelArea:       Fabric natural-coord square pixels (area)
 *     countIndex:      Auto-incremented integer (count)
 *     countGroup:      Group name string (count)
 *     labelText:       Human-readable value baked at creation time
 *
 *   Labels are baked at creation time. If the user changes scale after drawing,
 *   the stored pixelLength/pixelArea still enables live recalculation in the
 *   Properties panel — only the drawn label won't auto-update (Phase 3+).
 *
 * Coordinate math (verified in spike_calibration.py — 2026-02-22):
 *   RENDER_DPI = 150
 *   pixelsPerRealUnit = 150 × paperInchesPerRealUnit
 *   realDistance = pixelLength / pixelsPerRealUnit
 *   realArea = pixelArea / (pixelsPerRealUnit²)
 *
 * Calibration formula (from plan):
 *   paperInchesPerUnit = pixelLength / (RENDER_DPI × realValue)
 *   where realValue is the user-entered measurement in the chosen unit.
 *   This is equivalent to: pixelLength = 150 × paperInchesPerUnit × realValue
 *
 * Security:
 *   - Modal inputs validated before applying: value > 0, unit from allowlist
 *   - Canvas objects use Fabric's internal coordinate system — no eval/innerHTML
 *   - Count indices derived from canvas scan, not from user input
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-22
 */

// RENDER_DPI must match DEFAULT_DPI in pdf_engine.py and BASE_DPI in canvas.js
const RENDER_DPI = 150;

// Snap threshold in natural pixels — click within this of start vertex to close polygon
const SNAP_THRESHOLD = 8;

// Minimum pixel distance for distance tool to register (avoid accidental clicks)
const MIN_DISTANCE = 5;

// Measurement tool color — distinct from markup intent colors
// Cyan/teal: engineering measurement aesthetic, distinguishable from all markup types
const DISTANCE_COLOR = '#00ccff';  // Cyan — precision measurement
const AREA_COLOR     = '#00ddaa';  // Teal — area measurement
const COUNT_COLOR    = '#aa55ff';  // Purple — discrete count

// =============================================================================
// MEASURE TOOLS
// =============================================================================

/**
 * Provides distance, area, count, and calibration measurement tools.
 *
 * Designed to integrate with Toolbar via the _shapeHandlers cleanup contract:
 * each init* method stores its event handlers in toolbar._shapeHandlers so
 * _cleanupShapeDrawing() in toolbar.js removes them when the user switches tools.
 *
 * Usage:
 *   const measure = new MeasureTools();
 *   measure.initDistance(canvas, toolbar, scale);  // called from setTool('distance')
 */
export class MeasureTools {
    constructor() {
        // Global canvas and scale references — set by initForCanvas() after document load.
        // Used by _recalcDistanceGroup and _recalcAreaPolygon for live recalculation
        // when the user moves or scales measurement objects in select mode.
        /** @type {fabric.Canvas|null} */
        this._fc = null;
        /** @type {ScaleManager|null} */
        this._scale = null;
    }

    // =========================================================================
    // GLOBAL OBJECT:MODIFIED LISTENER — recalculate labels after move/scale
    // =========================================================================

    /**
     * Wire a global object:modified listener on the Fabric canvas.
     *
     * This catches moves, scales, and rotations in select mode — situations
     * that the tool-specific handlers (initDistance, initArea, etc.) do NOT
     * handle because those handlers are removed when the tool changes.
     *
     * WHY this is needed:
     *   Measurement labels are "baked" at creation time (e.g. "10.5 ft").
     *   When the user later selects and moves a distance Group, the stored
     *   pixelLength becomes stale. This listener recalculates it live so
     *   the displayed label always reflects the actual current geometry.
     *
     * Must be called AFTER canvas.init() creates a new Fabric canvas instance
     * (i.e. inside _onDocumentLoaded in app.js, after nodeEditor.initForCanvas).
     * If called again for a new document, the old listener is automatically
     * superseded by the new Fabric canvas instance.
     *
     * Args:
     *   fc:    Fabric.Canvas instance (canvas.fabricCanvas).
     *   scale: ScaleManager instance for unit-aware formatting.
     */
    initForCanvas(fc, scale) {
        this._fc = fc;
        this._scale = scale;

        fc.on('object:modified', (e) => {
            const obj = e.target;
            if (!obj) return;

            // Distance Group: measurementType='distance', contains Line + IText children
            if (obj.measurementType === 'distance' && obj._objects) {
                this._recalcDistanceGroup(obj);
            }

            // Area Polygon: measurementType='area', has .points array
            // NOTE: companion IText label (same pairedId) does NOT get recalc'd here —
            // it has no .points and its position is updated by _recalcAreaPolygon below.
            else if (obj.measurementType === 'area' && Array.isArray(obj.points)) {
                this._recalcAreaPolygon(obj);
            }
        });

        console.log('[MeasureTools] Global object:modified recalc listener attached');
    }

    /**
     * Recalculate a distance Group's label after it has been moved or scaled.
     *
     * The Group's child Line stores its endpoints in Group-local space.
     * We transform them via the Group's current transform matrix to get
     * the actual canvas-space positions, then recompute pixel length.
     *
     * Coordinate math:
     *   group.calcTransformMatrix() → 6-element affine matrix [a,b,c,d,e,f]
     *   transformPoint(local) → canvas-space point
     *   newPixelLength = Euclidean distance between the two transformed endpoints
     *
     * Args:
     *   group: Fabric.Group — the distance measurement object.
     */
    _recalcDistanceGroup(group) {
        // Find the Line child — it's the first object in the group (by construction)
        const innerLine = group._objects && group._objects[0];
        if (!innerLine || innerLine.x1 === undefined) return;

        // Transform Group-local line endpoints to canvas (natural) coordinates
        const mat = group.calcTransformMatrix();
        const p0 = fabric.util.transformPoint({ x: innerLine.x1, y: innerLine.y1 }, mat);
        const p1 = fabric.util.transformPoint({ x: innerLine.x2, y: innerLine.y2 }, mat);

        const newPixelLength = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);

        // Format with current scale (may differ from creation-time scale if user re-calibrated)
        const newLabel = this._scale
            ? this._scale.formatDistance(newPixelLength)
            : `${newPixelLength.toFixed(1)} px`;

        // Update stored metadata on the group
        group.pixelLength = newPixelLength;
        group.labelText = newLabel;

        // Update lineEndpoints (NodeEditor uses these for endpoint editing).
        // They must be relative to the group's current bounding-box origin
        // so NodeEditor can recover absolute coords as: abs = group.left + rel
        group.lineEndpoints = {
            x1: p0.x - group.left,
            y1: p0.y - group.top,
            x2: p1.x - group.left,
            y2: p1.y - group.top,
        };

        // Update the IText label (second child in the group)
        const innerLabel = group._objects && group._objects[1];
        if (innerLabel && typeof innerLabel.set === 'function') {
            innerLabel.set({ text: newLabel });
            // Mark dirty so Fabric re-renders the group's cached texture
            group.dirty = true;
        }

        if (this._fc) this._fc.requestRenderAll();
    }

    /**
     * Recalculate an area polygon's label and companion IText position
     * after it has been moved, scaled, or rotated.
     *
     * Area calculation:
     *   polygon.points are stored in creation space (before any transform).
     *   The effective area = rawArea × |scaleX| × |scaleY|.
     *   We do NOT use the transform matrix for area — the Shoelace formula
     *   gives creation-space area, and the scale factors give the multiplier.
     *
     * Companion label repositioning:
     *   We recompute the centroid in creation space, then transform it to
     *   canvas space via calcTransformMatrix() to get the new label position.
     *
     * Args:
     *   polygon: Fabric.Polygon — the area measurement object.
     */
    _recalcAreaPolygon(polygon) {
        if (!polygon.points || polygon.points.length < 3) return;

        // Shoelace area in creation space, then apply current scale factors.
        // pathOffset centers Fabric's internal coord system on the polygon —
        // we don't need to subtract it for the Shoelace area calculation because
        // the formula is translation-invariant; only scale matters.
        const rawArea = Math.abs(this._polygonArea(polygon.points));
        const effectiveArea = rawArea
            * Math.abs(polygon.scaleX || 1)
            * Math.abs(polygon.scaleY || 1);

        const newLabel = this._scale
            ? this._scale.formatArea(effectiveArea)
            : `${effectiveArea.toFixed(0)} sq px`;

        // Update stored metadata on the polygon
        polygon.pixelArea = effectiveArea;
        polygon.labelText = newLabel;

        if (!polygon.pairedId || !this._fc) return;

        // Find the companion IText label by shared pairedId.
        // The label is a separate Fabric object (not grouped), so we scan all objects.
        const label = this._fc.getObjects().find(
            o => o.pairedId === polygon.pairedId && o !== polygon
        );
        if (!label) return;

        // Update label text and metadata
        label.set({ text: newLabel });
        label.pixelArea = effectiveArea;
        label.labelText = newLabel;

        // Reposition label to the polygon's new centroid in canvas space.
        // Centroid in creation space (relative to pathOffset):
        const n = polygon.points.length;
        const localCx = polygon.points.reduce((s, p) => s + p.x, 0) / n - polygon.pathOffset.x;
        const localCy = polygon.points.reduce((s, p) => s + p.y, 0) / n - polygon.pathOffset.y;

        // Transform creation-space centroid to canvas space
        const mat = polygon.calcTransformMatrix();
        const c = fabric.util.transformPoint({ x: localCx, y: localCy }, mat);

        label.set({ left: c.x, top: c.y });
        label.setCoords();

        this._fc.requestRenderAll();
    }

    // =========================================================================
    // DISTANCE TOOL — click start → drag → click/release end
    // =========================================================================

    /**
     * Initialize the distance measurement tool.
     *
     * Interaction:
     *   mousedown on empty canvas → record start point, show preview line
     *   mousemove → stretch preview line to cursor
     *   mouseup → compute pixel length, create Group(Line + IText label), stamp metadata
     *
     * The resulting Group has:
     *   measurementType: 'distance'
     *   pixelLength: Euclidean distance in natural Fabric coords
     *   labelText: formatted distance string at creation time (e.g. "10.5 ft")
     *
     * Args:
     *   canvas: CanvasOverlay instance.
     *   toolbar: Toolbar instance (handlers stored in toolbar._shapeHandlers).
     *   scale: ScaleManager instance for unit conversion.
     */
    initDistance(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;

        let isDrawing = false;
        let startX = 0;
        let startY = 0;
        let previewLine = null;

        const onMouseDown = (opt) => {
            // Ignore clicks on existing objects — let selection work normally
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);
            isDrawing = true;
            startX = pointer.x;
            startY = pointer.y;

            // Create preview line — not selectable, just for visual feedback
            previewLine = new fabric.Line([startX, startY, startX, startY], {
                stroke: DISTANCE_COLOR,
                strokeWidth: 2,
                strokeUniform: true,
                strokeDashArray: [6, 3],  // dashed = "in progress"
                selectable: false,
                evented: false,
            });
            fc.add(previewLine);
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (!isDrawing || !previewLine) return;
            const pointer = fc.getPointer(opt.e);
            previewLine.set({ x2: pointer.x, y2: pointer.y });
            fc.renderAll();
        };

        const onMouseUp = (opt) => {
            if (!isDrawing) return;
            isDrawing = false;

            // Remove preview line regardless of whether we create a measurement
            if (previewLine) {
                fc.remove(previewLine);
                previewLine = null;
            }

            const pointer = fc.getPointer(opt.e);
            const dx = pointer.x - startX;
            const dy = pointer.y - startY;
            const pixelLength = Math.sqrt(dx * dx + dy * dy);

            // Discard accidental micro-clicks
            if (pixelLength < MIN_DISTANCE) {
                fc.renderAll();
                return;
            }

            // Format the label using current scale (baked at creation time)
            const labelText = scale
                ? scale.formatDistance(pixelLength)
                : `${pixelLength.toFixed(1)} px`;

            // Build the permanent measurement Group
            const group = this._buildDistanceGroup(
                startX, startY, pointer.x, pointer.y,
                pixelLength, labelText
            );

            // Stamp measurement metadata — NOT markupType/Status/Note (separate category)
            group.measurementType = 'distance';
            group.pixelLength = pixelLength;
            group.labelText = labelText;
            group.markupAuthor = 'User';
            group.markupTimestamp = new Date().toISOString();

            fc.add(group);
            fc.setActiveObject(group);
            fc.renderAll();
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up', onMouseUp);

        // Register in toolbar's cleanup contract
        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up': onMouseUp,
        };
    }

    // =========================================================================
    // AREA TOOL — multi-click polygon, double-click or snap to close
    // =========================================================================

    /**
     * Initialize the area measurement tool.
     *
     * Interaction:
     *   First click → place first vertex
     *   Subsequent clicks → add vertices, show in-progress polyline
     *   Mousemove → rubber-band line from last vertex to cursor
     *               + snap indicator when cursor is within SNAP_THRESHOLD of start
     *   Double-click OR click within SNAP_THRESHOLD of start → close polygon
     *     → creates Polygon + IText label at centroid
     *     → stamped with measurementType='area', pixelArea (Shoelace formula)
     *
     * Args:
     *   canvas: CanvasOverlay instance.
     *   toolbar: Toolbar instance.
     *   scale: ScaleManager instance.
     */
    initArea(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;

        // Accumulated vertex positions in natural Fabric coords
        let vertices = [];

        // Temporary preview objects on canvas (polyline, rubber-band, vertex dots)
        let tempObjects = [];

        // Live rubber-band line from last vertex to cursor
        let rubberBand = null;

        // Snap indicator circle — shown when cursor is near the start vertex
        let snapIndicator = null;

        /**
         * Add a temp object to the canvas and track it for cleanup.
         * Temp objects are non-selectable, non-evented preview aids.
         */
        const addTemp = (obj) => {
            obj.selectable = false;
            obj.evented = false;
            fc.add(obj);
            tempObjects.push(obj);
        };

        /**
         * Remove all temporary preview objects from the canvas.
         */
        const clearTemp = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];
            if (rubberBand) { fc.remove(rubberBand); rubberBand = null; }
            if (snapIndicator) { fc.remove(snapIndicator); snapIndicator = null; }
        };

        /**
         * Rebuild the visible in-progress polyline from current vertices.
         * Called after each new vertex is added.
         */
        const updatePolyline = () => {
            // Remove old temp objects except the rubber band (handled separately)
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];

            if (vertices.length === 0) return;

            // Vertex dots — small circles at each placed vertex
            for (const v of vertices) {
                const dot = new fabric.Circle({
                    left: v.x - 4,
                    top: v.y - 4,
                    radius: 4,
                    fill: AREA_COLOR,
                    stroke: null,
                    strokeWidth: 0,
                });
                addTemp(dot);
            }

            // Polyline connecting vertices so far
            if (vertices.length > 1) {
                const points = vertices.map(v => ({ x: v.x, y: v.y }));
                const line = new fabric.Polyline(points, {
                    fill: 'transparent',
                    stroke: AREA_COLOR,
                    strokeWidth: 2,
                    strokeUniform: true,
                });
                addTemp(line);
            }
        };

        /**
         * Close the polygon: compute area and centroid, create permanent objects,
         * clear all temp objects, and switch to select tool.
         */
        const closePolygon = () => {
            if (vertices.length < 3) {
                // Can't form a polygon — clean up and bail
                clearTemp();
                vertices = [];
                fc.renderAll();
                return;
            }

            clearTemp();

            // Create the permanent Polygon
            const polygon = new fabric.Polygon(
                vertices.map(v => ({ x: v.x, y: v.y })),
                {
                    fill: AREA_COLOR + '22',  // Very subtle fill to show enclosed area
                    stroke: AREA_COLOR,
                    strokeWidth: 2,
                    strokeUniform: true,
                    selectable: true,
                    objectCaching: false,
                }
            );

            // Compute area (Shoelace formula) and centroid
            const pixelArea = Math.abs(this._polygonArea(vertices));
            const centroid = this._centroid(vertices);

            const labelText = scale
                ? scale.formatArea(pixelArea)
                : `${pixelArea.toFixed(0)} sq px`;

            // Create centroid label as a separate IText (not grouped — polygon is big)
            const label = new fabric.IText(labelText, {
                left: centroid.x,
                top: centroid.y,
                fontFamily: 'Arial, sans-serif',
                fontSize: 13,
                fill: AREA_COLOR,
                stroke: null,
                strokeWidth: 0,
                selectable: true,
                editable: false,
                textAlign: 'center',
                originX: 'center',
                originY: 'center',
            });

            // pairedId links the polygon to its centroid label so NodeEditor can find
            // the label when recalculating area after vertex drags.
            const pairedId = crypto.randomUUID();

            // Stamp measurement metadata on the polygon (primary object for selection)
            polygon.measurementType = 'area';
            polygon.pixelArea = pixelArea;
            polygon.labelText = labelText;
            polygon.markupAuthor = 'User';
            polygon.markupTimestamp = new Date().toISOString();
            polygon.pairedId = pairedId;

            // The label is a companion — mark it so we can detect it in the list
            label.measurementType = 'area';
            label.pixelArea = pixelArea;
            label.labelText = labelText;
            label.markupAuthor = 'User';
            label.markupTimestamp = new Date().toISOString();
            label.pairedId = pairedId;  // same UUID — NodeEditor scans for this match

            fc.add(polygon);
            fc.add(label);
            fc.setActiveObject(polygon);
            fc.renderAll();

            vertices = [];
        };

        const onMouseDown = (opt) => {
            // Ignore clicks on existing objects
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);

            // Check snap-to-start: if we have vertices and cursor is near the first,
            // treat this click as polygon close
            if (vertices.length >= 3) {
                if (this._snapToStart(pointer.x, pointer.y, vertices[0].x, vertices[0].y)) {
                    closePolygon();
                    // Clean up tool handlers via toolbar's mechanism
                    toolbar._cleanupShapeDrawing();
                    toolbar.activeTool = 'select';
                    document.querySelectorAll('.tool-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.tool === 'select');
                    });
                    return;
                }
            }

            // Add new vertex
            vertices.push({ x: pointer.x, y: pointer.y });
            updatePolyline();
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (vertices.length === 0) return;

            const pointer = fc.getPointer(opt.e);
            const last = vertices[vertices.length - 1];

            // Update rubber-band line from last vertex to cursor
            if (rubberBand) {
                rubberBand.set({ x2: pointer.x, y2: pointer.y });
            } else {
                rubberBand = new fabric.Line(
                    [last.x, last.y, pointer.x, pointer.y],
                    {
                        stroke: AREA_COLOR,
                        strokeWidth: 1,
                        strokeDashArray: [4, 3],
                        selectable: false,
                        evented: false,
                        opacity: 0.7,
                    }
                );
                fc.add(rubberBand);
            }

            // Update rubber-band start to always be the latest vertex
            rubberBand.set({ x1: last.x, y1: last.y });

            // Snap indicator: show/hide circle at start vertex
            const nearStart = vertices.length >= 3 &&
                this._snapToStart(pointer.x, pointer.y, vertices[0].x, vertices[0].y);

            if (nearStart && !snapIndicator) {
                snapIndicator = new fabric.Circle({
                    left: vertices[0].x - 8,
                    top: vertices[0].y - 8,
                    radius: 8,
                    fill: 'transparent',
                    stroke: '#ffffff',
                    strokeWidth: 2,
                    selectable: false,
                    evented: false,
                });
                fc.add(snapIndicator);
            } else if (!nearStart && snapIndicator) {
                fc.remove(snapIndicator);
                snapIndicator = null;
            }

            fc.renderAll();
        };

        const onDblClick = () => {
            // Double-click closes the polygon (regardless of snap position)
            if (vertices.length >= 3) {
                // Remove the last vertex — double-click fires mousedown + dblclick,
                // so the last vertex was added by the second mousedown of the dblclick.
                // We want to close with the vertex BEFORE the double-click point.
                vertices.pop();
                closePolygon();

                // Return to select mode
                toolbar._cleanupShapeDrawing();
                toolbar.activeTool = 'select';
                document.querySelectorAll('.tool-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tool === 'select');
                });
            }
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:dblclick', onDblClick);

        // Store in toolbar's cleanup contract
        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:dblclick': onDblClick,
        };

        // Also register a cleanup hook to remove temp objects when tool changes
        // We override the _shapeHandlers object but add a cleanup side effect
        const origCleanup = toolbar._cleanupShapeDrawing.bind(toolbar);
        toolbar._cleanupShapeDrawing = function () {
            clearTemp();
            vertices = [];
            origCleanup();
            // Restore original cleanup method for next tool
            toolbar._cleanupShapeDrawing = origCleanup;
        };
    }

    // =========================================================================
    // POLYLENGTH TOOL — multi-segment distance measurement
    // =========================================================================

    /**
     * Initialize the polylength measurement tool.
     *
     * Interaction:
     *   Click to add vertices (like area tool), double-click or snap-to-start to finish.
     *   Creates an open polyline with per-segment labels and a total distance label.
     *   Unlike area, this does NOT close the polygon — it measures a path.
     *
     * The resulting Polyline has:
     *   measurementType: 'polylength'
     *   pixelLength: total path length in natural Fabric coords
     *   segmentLengths: array of per-segment pixel lengths
     *   labelText: formatted total distance string
     *
     * Args:
     *   canvas: CanvasOverlay instance.
     *   toolbar: Toolbar instance.
     *   scale: ScaleManager instance for unit conversion.
     */
    initPolylength(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;

        let vertices = [];
        let tempObjects = [];
        let rubberBand = null;

        /** Add a temp preview object to the canvas. */
        const addTemp = (obj) => {
            obj.selectable = false;
            obj.evented = false;
            fc.add(obj);
            tempObjects.push(obj);
        };

        /** Remove all temporary preview objects. */
        const clearTemp = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];
            if (rubberBand) { fc.remove(rubberBand); rubberBand = null; }
        };

        /** Euclidean distance between two points. */
        const segDist = (a, b) => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

        /** Rebuild the visible in-progress polyline + per-segment labels. */
        const updatePreview = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];

            if (vertices.length === 0) return;

            // Vertex dots
            for (const v of vertices) {
                const dot = new fabric.Circle({
                    left: v.x - 4,
                    top: v.y - 4,
                    radius: 4,
                    fill: DISTANCE_COLOR,
                    stroke: null,
                    strokeWidth: 0,
                });
                addTemp(dot);
            }

            // Polyline connecting vertices so far
            if (vertices.length > 1) {
                const line = new fabric.Polyline(
                    vertices.map(v => ({ x: v.x, y: v.y })),
                    {
                        fill: 'transparent',
                        stroke: DISTANCE_COLOR,
                        strokeWidth: 2,
                        strokeUniform: true,
                    }
                );
                addTemp(line);

                // Per-segment distance labels
                let runningTotal = 0;
                for (let i = 0; i < vertices.length - 1; i++) {
                    const d = segDist(vertices[i], vertices[i + 1]);
                    runningTotal += d;
                    const midX = (vertices[i].x + vertices[i + 1].x) / 2;
                    const midY = (vertices[i].y + vertices[i + 1].y) / 2;

                    const segLabel = scale
                        ? scale.formatDistance(d)
                        : `${d.toFixed(1)} px`;

                    const txt = new fabric.IText(segLabel, {
                        left: midX,
                        top: midY - 10,
                        fontFamily: 'Arial, sans-serif',
                        fontSize: 10,
                        fill: DISTANCE_COLOR,
                        originX: 'center',
                        originY: 'center',
                        opacity: 0.7,
                    });
                    addTemp(txt);
                }

                // Running total label at the last vertex
                const last = vertices[vertices.length - 1];
                const totalLabel = scale
                    ? scale.formatDistance(runningTotal)
                    : `${runningTotal.toFixed(1)} px`;

                const totalTxt = new fabric.IText(`Σ ${totalLabel}`, {
                    left: last.x + 12,
                    top: last.y - 12,
                    fontFamily: 'Arial, sans-serif',
                    fontSize: 12,
                    fontWeight: 'bold',
                    fill: DISTANCE_COLOR,
                    originX: 'left',
                    originY: 'center',
                });
                addTemp(totalTxt);
            }
        };

        /** Finalize the polylength measurement. */
        const finalize = () => {
            if (vertices.length < 2) {
                clearTemp();
                vertices = [];
                fc.renderAll();
                return;
            }

            clearTemp();

            // Calculate segment lengths and total
            const segmentLengths = [];
            let totalPixelLength = 0;
            for (let i = 0; i < vertices.length - 1; i++) {
                const d = segDist(vertices[i], vertices[i + 1]);
                segmentLengths.push(d);
                totalPixelLength += d;
            }

            const totalLabel = scale
                ? scale.formatDistance(totalPixelLength)
                : `${totalPixelLength.toFixed(1)} px`;

            // Build the permanent polyline
            const polyline = new fabric.Polyline(
                vertices.map(v => ({ x: v.x, y: v.y })),
                {
                    fill: 'transparent',
                    stroke: DISTANCE_COLOR,
                    strokeWidth: 2,
                    strokeUniform: true,
                    selectable: true,
                    objectCaching: false,
                }
            );

            // Total label near the midpoint of the path
            const midIdx = Math.floor(vertices.length / 2);
            const labelPos = vertices[midIdx];
            const label = new fabric.IText(`Σ ${totalLabel}`, {
                left: labelPos.x,
                top: labelPos.y - 16,
                fontFamily: 'Arial, sans-serif',
                fontSize: 13,
                fontWeight: 'bold',
                fill: DISTANCE_COLOR,
                stroke: null,
                strokeWidth: 0,
                selectable: true,
                editable: false,
                originX: 'center',
                originY: 'center',
            });

            // Link polyline and label with shared pairedId
            const pairedId = crypto.randomUUID();

            polyline.measurementType = 'polylength';
            polyline.pixelLength = totalPixelLength;
            polyline.segmentLengths = segmentLengths;
            polyline.labelText = totalLabel;
            polyline.markupAuthor = 'User';
            polyline.markupTimestamp = new Date().toISOString();
            polyline.pairedId = pairedId;

            label.measurementType = 'polylength';
            label.pixelLength = totalPixelLength;
            label.labelText = totalLabel;
            label.markupAuthor = 'User';
            label.markupTimestamp = new Date().toISOString();
            label.pairedId = pairedId;

            fc.add(polyline);
            fc.add(label);
            fc.setActiveObject(polyline);
            fc.renderAll();

            vertices = [];
        };

        const onMouseDown = (opt) => {
            if (opt.target) return;
            const pointer = fc.getPointer(opt.e);

            vertices.push({ x: pointer.x, y: pointer.y });
            updatePreview();
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (vertices.length === 0) return;

            const pointer = fc.getPointer(opt.e);
            const last = vertices[vertices.length - 1];

            // Update rubber-band line
            if (rubberBand) {
                rubberBand.set({ x1: last.x, y1: last.y, x2: pointer.x, y2: pointer.y });
            } else {
                rubberBand = new fabric.Line(
                    [last.x, last.y, pointer.x, pointer.y],
                    {
                        stroke: DISTANCE_COLOR,
                        strokeWidth: 1,
                        strokeDashArray: [4, 3],
                        selectable: false,
                        evented: false,
                        opacity: 0.7,
                    }
                );
                fc.add(rubberBand);
            }

            fc.renderAll();
        };

        const onDblClick = () => {
            // Double-click fires mousedown first — pop the duplicate vertex
            if (vertices.length > 0) vertices.pop();
            finalize();

            toolbar._cleanupShapeDrawing();
            toolbar.activeTool = 'select';
            document.querySelectorAll('.tool-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tool === 'select');
            });
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:dblclick', onDblClick);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:dblclick': onDblClick,
        };

        const origCleanup = toolbar._cleanupShapeDrawing.bind(toolbar);
        toolbar._cleanupShapeDrawing = function () {
            clearTemp();
            vertices = [];
            origCleanup();
            toolbar._cleanupShapeDrawing = origCleanup;
        };
    }

    // =========================================================================
    // PERIMETER TOOL — closed polygon perimeter measurement
    // =========================================================================

    /**
     * Initialize the perimeter measurement tool.
     *
     * Like area tool but measures perimeter instead of enclosed area.
     * Click to add vertices, double-click or snap-to-start to close.
     * Creates a closed polygon outline (no fill) with total perimeter label.
     *
     * The resulting Polygon has:
     *   measurementType: 'perimeter'
     *   pixelLength: total perimeter in natural Fabric coords
     *   labelText: formatted perimeter distance string
     *
     * Args:
     *   canvas: CanvasOverlay instance.
     *   toolbar: Toolbar instance.
     *   scale: ScaleManager instance for unit conversion.
     */
    initPerimeter(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;

        let vertices = [];
        let tempObjects = [];
        let rubberBand = null;
        let snapIndicator = null;

        const addTemp = (obj) => {
            obj.selectable = false;
            obj.evented = false;
            fc.add(obj);
            tempObjects.push(obj);
        };

        const clearTemp = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];
            if (rubberBand) { fc.remove(rubberBand); rubberBand = null; }
            if (snapIndicator) { fc.remove(snapIndicator); snapIndicator = null; }
        };

        const segDist = (a, b) => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

        const updatePreview = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];

            if (vertices.length === 0) return;

            for (const v of vertices) {
                const dot = new fabric.Circle({
                    left: v.x - 4, top: v.y - 4, radius: 4,
                    fill: AREA_COLOR, stroke: null, strokeWidth: 0,
                });
                addTemp(dot);
            }

            if (vertices.length > 1) {
                const line = new fabric.Polyline(
                    vertices.map(v => ({ x: v.x, y: v.y })),
                    { fill: 'transparent', stroke: AREA_COLOR, strokeWidth: 2, strokeUniform: true }
                );
                addTemp(line);
            }
        };

        const finalize = () => {
            if (vertices.length < 3) {
                clearTemp();
                vertices = [];
                fc.renderAll();
                return;
            }

            clearTemp();

            // Sum all edges including the closing edge (last → first)
            let totalPixelLength = 0;
            for (let i = 0; i < vertices.length; i++) {
                const next = (i + 1) % vertices.length;
                totalPixelLength += segDist(vertices[i], vertices[next]);
            }

            const totalLabel = scale
                ? scale.formatDistance(totalPixelLength)
                : `${totalPixelLength.toFixed(1)} px`;

            // Closed polygon outline — no fill
            const polygon = new fabric.Polygon(
                vertices.map(v => ({ x: v.x, y: v.y })),
                {
                    fill: 'transparent',
                    stroke: AREA_COLOR,
                    strokeWidth: 2,
                    strokeUniform: true,
                    selectable: true,
                    objectCaching: false,
                }
            );

            // Label at centroid
            const centroid = this._centroid(vertices);
            const label = new fabric.IText(`⊡ ${totalLabel}`, {
                left: centroid.x,
                top: centroid.y,
                fontFamily: 'Arial, sans-serif',
                fontSize: 13,
                fontWeight: 'bold',
                fill: AREA_COLOR,
                stroke: null,
                strokeWidth: 0,
                selectable: true,
                editable: false,
                originX: 'center',
                originY: 'center',
            });

            const pairedId = crypto.randomUUID();

            polygon.measurementType = 'perimeter';
            polygon.pixelLength = totalPixelLength;
            polygon.labelText = totalLabel;
            polygon.markupAuthor = 'User';
            polygon.markupTimestamp = new Date().toISOString();
            polygon.pairedId = pairedId;

            label.measurementType = 'perimeter';
            label.pixelLength = totalPixelLength;
            label.labelText = totalLabel;
            label.markupAuthor = 'User';
            label.markupTimestamp = new Date().toISOString();
            label.pairedId = pairedId;

            fc.add(polygon);
            fc.add(label);
            fc.setActiveObject(polygon);
            fc.renderAll();

            vertices = [];
        };

        const onMouseDown = (opt) => {
            if (opt.target) return;
            const pointer = fc.getPointer(opt.e);

            // Snap-to-start close
            if (vertices.length >= 3) {
                if (this._snapToStart(pointer.x, pointer.y, vertices[0].x, vertices[0].y)) {
                    finalize();
                    toolbar._cleanupShapeDrawing();
                    toolbar.activeTool = 'select';
                    document.querySelectorAll('.tool-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.tool === 'select');
                    });
                    return;
                }
            }

            vertices.push({ x: pointer.x, y: pointer.y });
            updatePreview();
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (vertices.length === 0) return;
            const pointer = fc.getPointer(opt.e);
            const last = vertices[vertices.length - 1];

            if (rubberBand) {
                rubberBand.set({ x1: last.x, y1: last.y, x2: pointer.x, y2: pointer.y });
            } else {
                rubberBand = new fabric.Line(
                    [last.x, last.y, pointer.x, pointer.y],
                    { stroke: AREA_COLOR, strokeWidth: 1, strokeDashArray: [4, 3],
                      selectable: false, evented: false, opacity: 0.7 }
                );
                fc.add(rubberBand);
            }

            // Snap indicator
            const nearStart = vertices.length >= 3 &&
                this._snapToStart(pointer.x, pointer.y, vertices[0].x, vertices[0].y);

            if (nearStart && !snapIndicator) {
                snapIndicator = new fabric.Circle({
                    left: vertices[0].x - 8, top: vertices[0].y - 8, radius: 8,
                    fill: 'transparent', stroke: '#ffffff', strokeWidth: 2,
                    selectable: false, evented: false,
                });
                fc.add(snapIndicator);
            } else if (!nearStart && snapIndicator) {
                fc.remove(snapIndicator);
                snapIndicator = null;
            }

            fc.renderAll();
        };

        const onDblClick = () => {
            if (vertices.length >= 3) {
                vertices.pop();
                finalize();
                toolbar._cleanupShapeDrawing();
                toolbar.activeTool = 'select';
                document.querySelectorAll('.tool-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tool === 'select');
                });
            }
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:dblclick', onDblClick);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:dblclick': onDblClick,
        };

        const origCleanup = toolbar._cleanupShapeDrawing.bind(toolbar);
        toolbar._cleanupShapeDrawing = function () {
            clearTemp();
            vertices = [];
            origCleanup();
            toolbar._cleanupShapeDrawing = origCleanup;
        };
    }

    // =========================================================================
    // ANGLE TOOL — 3-point angle measurement
    // =========================================================================

    /**
     * Initialize the angle measurement tool.
     *
     * Interaction:
     *   Click 1: first ray endpoint
     *   Click 2: vertex (angle origin)
     *   Click 3: second ray endpoint → creates angle measurement
     *
     * Creates a Group with two ray lines, an arc indicator, and an angle label.
     *
     * Args:
     *   canvas: CanvasOverlay instance.
     *   toolbar: Toolbar instance.
     */
    initAngle(canvas, toolbar) {
        const fc = canvas.fabricCanvas;
        const ANGLE_COLOR = '#ff8800'; // Orange — distinct from other measurement colors

        let clicks = []; // Array of {x, y} — accumulates 3 points
        let tempObjects = [];
        let rubberBand = null;

        const addTemp = (obj) => {
            obj.selectable = false;
            obj.evented = false;
            fc.add(obj);
            tempObjects.push(obj);
        };

        const clearTemp = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];
            if (rubberBand) { fc.remove(rubberBand); rubberBand = null; }
        };

        const updatePreview = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];

            // Dots at each placed point
            for (const pt of clicks) {
                const dot = new fabric.Circle({
                    left: pt.x - 4, top: pt.y - 4, radius: 4,
                    fill: ANGLE_COLOR, stroke: null, strokeWidth: 0,
                });
                addTemp(dot);
            }

            // Line from first click to second (vertex)
            if (clicks.length >= 2) {
                const line = new fabric.Line(
                    [clicks[0].x, clicks[0].y, clicks[1].x, clicks[1].y],
                    { stroke: ANGLE_COLOR, strokeWidth: 2, strokeUniform: true }
                );
                addTemp(line);
            }
        };

        const finalize = () => {
            clearTemp();

            const [p1, vertex, p2] = clicks;

            // Calculate angle using atan2
            const angle1 = Math.atan2(p1.y - vertex.y, p1.x - vertex.x);
            const angle2 = Math.atan2(p2.y - vertex.y, p2.x - vertex.x);

            let angleDeg = ((angle2 - angle1) * 180 / Math.PI);
            // Normalize to 0-360
            if (angleDeg < 0) angleDeg += 360;
            // Always show the smaller angle (0-180) unless reflex
            const displayAngle = angleDeg > 180 ? 360 - angleDeg : angleDeg;

            // Ray lengths (for drawing)
            const ray1Len = Math.sqrt((p1.x - vertex.x) ** 2 + (p1.y - vertex.y) ** 2);
            const ray2Len = Math.sqrt((p2.x - vertex.x) ** 2 + (p2.y - vertex.y) ** 2);
            const rayLen = Math.min(ray1Len, ray2Len, 60); // Cap arc radius

            // Build the two ray lines
            const line1 = new fabric.Line(
                [vertex.x, vertex.y, p1.x, p1.y],
                { stroke: ANGLE_COLOR, strokeWidth: 2, strokeUniform: true,
                  selectable: false, evented: false }
            );
            const line2 = new fabric.Line(
                [vertex.x, vertex.y, p2.x, p2.y],
                { stroke: ANGLE_COLOR, strokeWidth: 2, strokeUniform: true,
                  selectable: false, evented: false }
            );

            // Arc indicator — approximate with a polyline of small segments
            const arcRadius = rayLen * 0.4;
            const arcPoints = [];
            const startAngle = angleDeg > 180 ? angle2 : angle1;
            const sweep = angleDeg > 180 ? (360 - angleDeg) : angleDeg;
            const steps = Math.max(12, Math.round(sweep / 5));
            for (let i = 0; i <= steps; i++) {
                const t = startAngle + (sweep * Math.PI / 180) * (i / steps);
                arcPoints.push({
                    x: vertex.x + arcRadius * Math.cos(t),
                    y: vertex.y + arcRadius * Math.sin(t),
                });
            }

            const arc = new fabric.Polyline(arcPoints, {
                fill: 'transparent',
                stroke: ANGLE_COLOR,
                strokeWidth: 1.5,
                strokeUniform: true,
                selectable: false,
                evented: false,
            });

            // Label at the midpoint of the arc
            const midT = startAngle + (sweep * Math.PI / 180) * 0.5;
            const labelR = arcRadius + 14;
            const label = new fabric.IText(`${displayAngle.toFixed(1)}°`, {
                left: vertex.x + labelR * Math.cos(midT),
                top: vertex.y + labelR * Math.sin(midT),
                fontFamily: 'Arial, sans-serif',
                fontSize: 12,
                fontWeight: 'bold',
                fill: ANGLE_COLOR,
                originX: 'center',
                originY: 'center',
                selectable: false,
                editable: false,
            });

            const group = new fabric.Group([line1, line2, arc, label], {
                selectable: true,
                subTargetCheck: false,
            });

            group.measurementType = 'angle';
            group.angleDegrees = displayAngle;
            group.labelText = `${displayAngle.toFixed(1)}°`;
            group.markupAuthor = 'User';
            group.markupTimestamp = new Date().toISOString();

            fc.add(group);
            fc.setActiveObject(group);
            fc.renderAll();

            clicks = [];

            // Switch to select
            toolbar.setTool('select');
        };

        const onMouseDown = (opt) => {
            if (opt.target) return;
            const pointer = fc.getPointer(opt.e);

            clicks.push({ x: pointer.x, y: pointer.y });
            updatePreview();
            fc.renderAll();

            if (clicks.length === 3) {
                finalize();
            }
        };

        const onMouseMove = (opt) => {
            if (clicks.length === 0) return;
            const pointer = fc.getPointer(opt.e);
            const last = clicks[clicks.length - 1];

            if (rubberBand) {
                rubberBand.set({ x1: last.x, y1: last.y, x2: pointer.x, y2: pointer.y });
            } else {
                rubberBand = new fabric.Line(
                    [last.x, last.y, pointer.x, pointer.y],
                    { stroke: ANGLE_COLOR, strokeWidth: 1, strokeDashArray: [4, 3],
                      selectable: false, evented: false, opacity: 0.7 }
                );
                fc.add(rubberBand);
            }

            fc.renderAll();
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
        };

        const origCleanup = toolbar._cleanupShapeDrawing.bind(toolbar);
        toolbar._cleanupShapeDrawing = function () {
            clearTemp();
            clicks = [];
            origCleanup();
            toolbar._cleanupShapeDrawing = origCleanup;
        };
    }

    // =========================================================================
    // COUNT TOOL — click to place numbered markers
    // =========================================================================

    /**
     * Initialize the count measurement tool.
     *
     * Each click places a numbered circular marker at the click position.
     * The count index auto-increments by scanning existing count objects on canvas.
     * Uses the active markup type's color (from toolbar.activeMarkupType) so users
     * can color-code different count categories.
     *
     * Args:
     *   canvas: CanvasOverlay instance.
     *   toolbar: Toolbar instance.
     */
    initCount(canvas, toolbar) {
        const fc = canvas.fabricCanvas;

        const onMouseDown = (opt) => {
            // Ignore clicks on existing objects
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);

            // Compute next count index by scanning existing count objects on the page
            const existing = fc.getObjects().filter(o => o.measurementType === 'count');
            const nextIndex = existing.length + 1;

            // Build the numbered marker Group
            const marker = this._buildCountMarker(pointer.x, pointer.y, nextIndex, COUNT_COLOR);

            // Stamp measurement metadata
            marker.measurementType = 'count';
            marker.countIndex = nextIndex;
            marker.countGroup = 'default';
            marker.labelText = `#${nextIndex}`;
            marker.markupAuthor = 'User';
            marker.markupTimestamp = new Date().toISOString();

            fc.add(marker);
            fc.renderAll();
        };

        fc.on('mouse:down', onMouseDown);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
        };
    }

    // =========================================================================
    // CALIBRATION TOOL — draw reference line → enter real length → set custom scale
    // =========================================================================

    /**
     * Initialize the scale calibration tool.
     *
     * Flow:
     *   1. User draws a line over a known dimension on the drawing
     *   2. On mouseup, the calibration modal opens with pixel length pre-filled
     *   3. User enters real-world length + unit
     *   4. "Apply Scale" computes paperInchesPerUnit and calls scale.setPreset('custom')
     *   5. Tool reverts to select mode
     *
     * The ephemeral line is NOT added to the canvas as a permanent object —
     * calibration is a configuration action, not an annotation.
     *
     * Formula:
     *   paperInchesPerUnit = pixelLength / (RENDER_DPI × realValue)
     *   This is derived from: pixelLength = RENDER_DPI × paperInchesPerUnit × realValue
     *
     * Args:
     *   canvas: CanvasOverlay instance.
     *   toolbar: Toolbar instance.
     *   scale: ScaleManager instance.
     */
    initCalibration(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;

        let isDrawing = false;
        let startX = 0, startY = 0;
        let previewLine = null;

        // Update status message to guide the user
        const statusMsg = document.getElementById('status-message');
        if (statusMsg) statusMsg.textContent = 'Draw a line over a known dimension';

        const onMouseDown = (opt) => {
            if (opt.target) return;
            const pointer = fc.getPointer(opt.e);
            isDrawing = true;
            startX = pointer.x;
            startY = pointer.y;

            previewLine = new fabric.Line([startX, startY, startX, startY], {
                stroke: '#ffdd00',  // Bright yellow — distinct from all measurement colors
                strokeWidth: 2,
                strokeUniform: true,
                strokeDashArray: [8, 4],
                selectable: false,
                evented: false,
            });
            fc.add(previewLine);
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (!isDrawing || !previewLine) return;
            const pointer = fc.getPointer(opt.e);
            previewLine.set({ x2: pointer.x, y2: pointer.y });
            fc.renderAll();
        };

        const onMouseUp = (opt) => {
            if (!isDrawing) return;
            isDrawing = false;

            if (previewLine) {
                fc.remove(previewLine);
                previewLine = null;
            }

            const pointer = fc.getPointer(opt.e);
            const dx = pointer.x - startX;
            const dy = pointer.y - startY;
            const pixelLength = Math.sqrt(dx * dx + dy * dy);

            if (pixelLength < MIN_DISTANCE) {
                fc.renderAll();
                if (statusMsg) statusMsg.textContent = 'Line too short — try again';
                return;
            }

            fc.renderAll();
            if (statusMsg) statusMsg.textContent = '';

            // Clean up drawing handlers before showing modal
            toolbar._cleanupShapeDrawing();
            toolbar.activeTool = 'select';
            document.querySelectorAll('.tool-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tool === 'select');
            });
            toolbar.canvas.setDrawingMode(false);

            // Show calibration modal with the pixel length pre-filled
            this._showCalibrationModal(pixelLength, scale, fc);
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up', onMouseUp);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up': onMouseUp,
        };
    }

    // =========================================================================
    // CALIBRATION MODAL — enter real dimension, apply custom scale
    // =========================================================================

    /**
     * Show the calibration modal and wire up Apply/Cancel handlers.
     *
     * Args:
     *   pixelLength: Measured pixel distance for the reference line.
     *   scale: ScaleManager instance to update.
     *   fc: Fabric canvas (for re-render after modal closes).
     */
    _showCalibrationModal(pixelLength, scale, fc) {
        const modal = document.getElementById('modal-calibrate');
        if (!modal) {
            console.error('[MeasureTools] #modal-calibrate not found in DOM');
            return;
        }

        // Pre-fill the readonly pixel length field
        const pixelsInput = document.getElementById('calib-pixels');
        if (pixelsInput) pixelsInput.value = pixelLength.toFixed(1);

        // Show the modal
        modal.style.display = 'flex';

        // Wire up the cancel button — close without changing scale
        const cancelBtn = document.getElementById('calib-cancel');
        const applyBtn = document.getElementById('calib-apply');
        const overlay = document.getElementById('modal-calibrate-overlay');

        const closeModal = () => {
            modal.style.display = 'none';
            // Remove listeners to avoid stacking multiple event handlers
            cancelBtn?.removeEventListener('click', closeModal);
            applyBtn?.removeEventListener('click', applyScale);
            overlay?.removeEventListener('click', closeModal);
        };

        const applyScale = async () => {
            const valueInput = document.getElementById('calib-value');
            const unitSelect = document.getElementById('calib-unit');

            // SECURITY: Validate inputs before computing scale
            const realValue = parseFloat(valueInput?.value || '0');
            const unit = unitSelect?.value || 'ft';

            // Allowed unit values — reject anything else
            const ALLOWED_UNITS = ['ft', 'in', 'm', 'cm'];
            if (!ALLOWED_UNITS.includes(unit)) {
                alert('Invalid unit selected.');
                return;
            }

            if (!isFinite(realValue) || realValue <= 0) {
                alert('Please enter a positive real-world length.');
                return;
            }

            // Formula: pixelLength = RENDER_DPI × paperInchesPerRealUnit × realValue
            // Solving for paperInchesPerRealUnit:
            //   paperInchesPerUnit = pixelLength / (RENDER_DPI × realValue)
            // This works for any unit — the unit label is stored alongside.
            const paperInchesPerUnit = pixelLength / (RENDER_DPI * realValue);

            if (!isFinite(paperInchesPerUnit) || paperInchesPerUnit <= 0) {
                alert('Invalid scale result — check your inputs.');
                return;
            }

            closeModal();

            // Apply the custom scale to the ScaleManager
            if (scale) {
                await scale.setPreset('custom', paperInchesPerUnit, unit);
            }

            fc.renderAll();
        };

        cancelBtn?.addEventListener('click', closeModal);
        applyBtn?.addEventListener('click', applyScale);
        overlay?.addEventListener('click', closeModal);

        // Focus the value input for immediate typing
        const valueInput = document.getElementById('calib-value');
        if (valueInput) {
            valueInput.value = '';
            valueInput.focus();
        }

        // Enter key in value field triggers apply
        const valueInputEl = document.getElementById('calib-value');
        valueInputEl?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') applyScale();
        }, { once: true });
    }

    // =========================================================================
    // FABRIC OBJECT BUILDERS
    // =========================================================================

    /**
     * Build a Fabric.js Group representing a distance measurement.
     *
     * Contains a solid Line and a centered IText label above the midpoint.
     * The group moves as a single unit and serializes with all child coords.
     *
     * Note on Fabric.js Group coordinates:
     *   When objects are added to a Group, their coordinates become relative
     *   to the group's center. Fabric handles this automatically during
     *   Group construction — we just pass absolute coords to Line/IText.
     *
     * Args:
     *   x1, y1: Start point in natural Fabric coords.
     *   x2, y2: End point in natural Fabric coords.
     *   pixelLength: Euclidean distance (for metadata storage).
     *   labelText: Formatted distance string to display (e.g. "10.5 ft").
     *
     * Returns:
     *   fabric.Group — selectable group with line + label.
     */
    _buildDistanceGroup(x1, y1, x2, y2, pixelLength, labelText) {
        // Solid measurement line (not dashed — this is the permanent version)
        const line = new fabric.Line([x1, y1, x2, y2], {
            stroke: DISTANCE_COLOR,
            strokeWidth: 2,
            strokeUniform: true,
            selectable: false,
            evented: false,
        });

        // Label at midpoint, slightly above the line
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;

        const label = new fabric.IText(labelText, {
            left: midX,
            top: midY - 12,  // 12px above midpoint for readability
            fontFamily: 'Arial, sans-serif',
            fontSize: 12,
            fontWeight: 'bold',
            fill: DISTANCE_COLOR,
            stroke: null,
            strokeWidth: 0,
            selectable: false,
            editable: false,
            originX: 'center',
            originY: 'center',
        });

        const group = new fabric.Group([line, label], {
            selectable: true,
            subTargetCheck: false,
        });

        // pairedId for consistency with area polygons (not strictly required for
        // the distance tool but keeps the data model uniform).
        group.pairedId = crypto.randomUUID();

        // Store line endpoints relative to the group's bounding-box origin (left/top).
        // NodeEditor uses these to recover the absolute canvas endpoints when editing,
        // even after the group has been moved from its original position:
        //   abs_x1 = group.left + lineEndpoints.x1
        //   abs_y1 = group.top  + lineEndpoints.y1
        // This works because group.left/top change when the group is dragged, and
        // the relative offsets stay constant (children don't move within the group).
        group.lineEndpoints = {
            x1: x1 - group.left,
            y1: y1 - group.top,
            x2: x2 - group.left,
            y2: y2 - group.top,
        };

        return group;
    }

    /**
     * Build a Fabric.js Group for a count marker: numbered circle.
     *
     * The marker is a filled circle with the count index as a centered
     * white number, all grouped for single-unit movement.
     *
     * Args:
     *   x: Center X in natural Fabric coords.
     *   y: Center Y in natural Fabric coords.
     *   index: Count index integer (1, 2, 3...).
     *   color: CSS color string for the circle fill.
     *
     * Returns:
     *   fabric.Group — selectable group with circle + text.
     */
    _buildCountMarker(x, y, index, color) {
        const RADIUS = 14;  // Pixel radius in natural coords

        const circle = new fabric.Circle({
            left: x - RADIUS,
            top: y - RADIUS,
            radius: RADIUS,
            fill: color,
            stroke: '#ffffff',
            strokeWidth: 1.5,
            selectable: false,
            evented: false,
        });

        const text = new fabric.IText(String(index), {
            left: x,
            top: y,
            fontFamily: 'Arial, sans-serif',
            fontSize: 11,
            fontWeight: 'bold',
            fill: '#ffffff',
            stroke: null,
            strokeWidth: 0,
            selectable: false,
            editable: false,
            originX: 'center',
            originY: 'center',
        });

        const group = new fabric.Group([circle, text], {
            selectable: true,
            subTargetCheck: false,
        });

        return group;
    }

    // =========================================================================
    // GEOMETRY HELPERS
    // =========================================================================

    /**
     * Compute the signed area of a polygon using the Shoelace formula.
     *
     * The Shoelace formula (Gauss's area formula) computes the signed area
     * from vertex coordinates: A = ½ |Σ(x_i × y_{i+1} − x_{i+1} × y_i)|
     *
     * Returns a positive value when vertices are clockwise, negative when
     * counter-clockwise. Callers should use Math.abs().
     *
     * References:
     *   https://en.wikipedia.org/wiki/Shoelace_formula
     *
     * Args:
     *   points: Array of {x, y} objects representing polygon vertices.
     *
     * Returns:
     *   number — Signed area in the same units as the input coords (square pixels).
     */
    _polygonArea(points) {
        const n = points.length;
        if (n < 3) return 0;

        let area = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;  // next vertex (wraps around)
            area += points[i].x * points[j].y;
            area -= points[j].x * points[i].y;
        }
        return area / 2;
    }

    /**
     * Compute the centroid (geometric center) of a polygon.
     *
     * Uses the simple average of all vertex coordinates.
     * This is an approximation suitable for label placement; the true
     * centroid formula weights by edge length, but for typical convex/nearly-
     * convex measurement polygons this is visually accurate enough.
     *
     * Args:
     *   points: Array of {x, y} objects representing polygon vertices.
     *
     * Returns:
     *   {x, y} — Centroid position in natural Fabric coords.
     */
    _centroid(points) {
        const n = points.length;
        if (n === 0) return { x: 0, y: 0 };
        const sum = points.reduce(
            (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
            { x: 0, y: 0 }
        );
        return { x: sum.x / n, y: sum.y / n };
    }

    /**
     * Check if the cursor is close enough to the polygon start vertex to snap.
     *
     * Used by the Area tool to detect when the user wants to close the polygon
     * by clicking near the first vertex (Bluebeam/Revu-style snapping behavior).
     *
     * Args:
     *   curX, curY: Current cursor position in natural Fabric coords.
     *   startX, startY: First vertex position.
     *
     * Returns:
     *   boolean — true if within SNAP_THRESHOLD pixels of the start.
     */
    _snapToStart(curX, curY, startX, startY) {
        const dx = curX - startX;
        const dy = curY - startY;
        return Math.sqrt(dx * dx + dy * dy) <= SNAP_THRESHOLD;
    }

    // =========================================================================
    // RADIUS / DIAMETER TOOL — click center → drag to edge
    // =========================================================================

    /**
     * Initialize the radius/diameter measurement tool.
     *
     * Interaction:
     *   mousedown → mark circle center
     *   mousemove → preview circle outline growing from center
     *   mouseup → compute radius, create Group(Circle + diameter Line + label)
     *
     * The resulting Group has:
     *   measurementType: 'radius'
     *   pixelLength: radius in natural Fabric coords
     *   labelText: formatted diameter string (shows both radius and diameter)
     *
     * Args:
     *   canvas: CanvasOverlay instance.
     *   toolbar: Toolbar instance.
     *   scale: ScaleManager instance for unit conversion.
     */
    initRadius(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;

        let isDrawing = false;
        let centerX = 0;
        let centerY = 0;
        let previewCircle = null;

        const onMouseDown = (opt) => {
            if (opt.target) return;

            const pointer = fc.getPointer(opt.e);
            isDrawing = true;
            centerX = pointer.x;
            centerY = pointer.y;

            previewCircle = new fabric.Circle({
                left: centerX,
                top: centerY,
                radius: 1,
                originX: 'center',
                originY: 'center',
                fill: 'transparent',
                stroke: DISTANCE_COLOR,
                strokeWidth: 2,
                strokeUniform: true,
                strokeDashArray: [6, 3],
                selectable: false,
                evented: false,
            });
            fc.add(previewCircle);
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (!isDrawing || !previewCircle) return;
            const pointer = fc.getPointer(opt.e);
            const dx = pointer.x - centerX;
            const dy = pointer.y - centerY;
            const radius = Math.sqrt(dx * dx + dy * dy);
            previewCircle.set({ radius: Math.max(radius, 1) });
            fc.renderAll();
        };

        const onMouseUp = (opt) => {
            if (!isDrawing) return;
            isDrawing = false;

            if (previewCircle) {
                fc.remove(previewCircle);
                previewCircle = null;
            }

            const pointer = fc.getPointer(opt.e);
            const dx = pointer.x - centerX;
            const dy = pointer.y - centerY;
            const radius = Math.sqrt(dx * dx + dy * dy);

            if (radius < MIN_DISTANCE) {
                fc.renderAll();
                return;
            }

            const diameter = radius * 2;

            // Format using scale — show diameter with symbol prefix
            const radiusText = scale
                ? scale.formatDistance(radius)
                : `${radius.toFixed(1)} px`;
            const diameterText = scale
                ? scale.formatDistance(diameter)
                : `${diameter.toFixed(1)} px`;
            const labelText = `\u2300 ${diameterText} (r=${radiusText})`;

            // Build the measurement group
            const group = this._buildRadiusGroup(
                centerX, centerY, radius, pointer.x, pointer.y, labelText
            );

            group.measurementType = 'radius';
            group.pixelLength = radius;
            group.labelText = labelText;
            group.markupAuthor = 'User';
            group.markupTimestamp = new Date().toISOString();

            fc.add(group);
            fc.setActiveObject(group);
            fc.renderAll();
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up', onMouseUp);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up': onMouseUp,
        };
    }

    /**
     * Build a Fabric Group for a radius/diameter measurement.
     *
     * Components: circle outline + diameter line (center to edge) + label.
     *
     * Args:
     *   cx, cy: Circle center in natural Fabric coords.
     *   radius: Circle radius in natural pixels.
     *   edgeX, edgeY: Edge point where the user released (for diameter line direction).
     *   labelText: Pre-formatted measurement string.
     *
     * Returns:
     *   fabric.Group — selectable group.
     */
    _buildRadiusGroup(cx, cy, radius, edgeX, edgeY, labelText) {
        // Circle outline
        const circle = new fabric.Circle({
            left: cx,
            top: cy,
            radius: radius,
            originX: 'center',
            originY: 'center',
            fill: 'transparent',
            stroke: DISTANCE_COLOR,
            strokeWidth: 2,
            strokeUniform: true,
            selectable: false,
            evented: false,
        });

        // Diameter line — from the edge point through center to the opposite side
        const dx = edgeX - cx;
        const dy = edgeY - cy;
        const len = Math.sqrt(dx * dx + dy * dy);
        const ux = dx / len;
        const uy = dy / len;
        const x1 = cx - ux * radius;
        const y1 = cy - uy * radius;
        const x2 = cx + ux * radius;
        const y2 = cy + uy * radius;

        const dLine = new fabric.Line([x1, y1, x2, y2], {
            stroke: DISTANCE_COLOR,
            strokeWidth: 1.5,
            strokeUniform: true,
            selectable: false,
            evented: false,
        });

        // Center cross-hair (small +)
        const crossSize = 4;
        const crossH = new fabric.Line([cx - crossSize, cy, cx + crossSize, cy], {
            stroke: DISTANCE_COLOR, strokeWidth: 1, strokeUniform: true,
            selectable: false, evented: false,
        });
        const crossV = new fabric.Line([cx, cy - crossSize, cx, cy + crossSize], {
            stroke: DISTANCE_COLOR, strokeWidth: 1, strokeUniform: true,
            selectable: false, evented: false,
        });

        // Label above center
        const label = new fabric.IText(labelText, {
            left: cx,
            top: cy - radius - 14,
            fontFamily: 'Arial, sans-serif',
            fontSize: 12,
            fontWeight: 'bold',
            fill: DISTANCE_COLOR,
            stroke: null,
            strokeWidth: 0,
            selectable: false,
            editable: false,
            originX: 'center',
            originY: 'center',
        });

        const group = new fabric.Group([circle, dLine, crossH, crossV, label], {
            selectable: true,
            subTargetCheck: false,
        });

        group.pairedId = crypto.randomUUID();
        return group;
    }

    // =========================================================================
    // VOLUME MEASUREMENT
    // =========================================================================

    /**
     * Volume = Area polygon × user-entered depth.
     *
     * Workflow: identical to Area (click-accumulate-close polygon), then a
     * prompt asks for depth in real-world units. The label shows:
     *   "150.32 sq ft × 8 ft = 1202.56 cu ft"
     *
     * Measurement metadata:
     *   measurementType: 'volume'
     *   pixelArea: Shoelace-computed area in natural pixels
     *   volumeDepth: user-entered depth in real units
     *   labelText: formatted volume string
     */
    initVolume(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;

        let vertices = [];
        let tempObjects = [];
        let rubberBand = null;
        let snapIndicator = null;

        const VOLUME_COLOR = '#e06c75'; // distinct from area green

        const addTemp = (obj) => {
            obj.selectable = false;
            obj.evented = false;
            fc.add(obj);
            tempObjects.push(obj);
        };

        const clearTemp = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];
            if (rubberBand) { fc.remove(rubberBand); rubberBand = null; }
            if (snapIndicator) { fc.remove(snapIndicator); snapIndicator = null; }
        };

        const updatePolyline = () => {
            tempObjects.forEach(o => fc.remove(o));
            tempObjects = [];
            if (vertices.length === 0) return;

            for (const v of vertices) {
                const dot = new fabric.Circle({
                    left: v.x - 4, top: v.y - 4, radius: 4,
                    fill: VOLUME_COLOR, stroke: null, strokeWidth: 0,
                });
                addTemp(dot);
            }

            if (vertices.length > 1) {
                const points = vertices.map(v => ({ x: v.x, y: v.y }));
                const line = new fabric.Polyline(points, {
                    fill: 'transparent', stroke: VOLUME_COLOR,
                    strokeWidth: 2, strokeUniform: true,
                });
                addTemp(line);
            }
        };

        const closePolygon = () => {
            if (vertices.length < 3) {
                clearTemp();
                vertices = [];
                fc.renderAll();
                return;
            }

            clearTemp();

            const pixelArea = Math.abs(this._polygonArea(vertices));
            const centroid = this._centroid(vertices);

            // Prompt for depth
            const unitLabel = scale ? scale.unitLabel : 'units';
            const depthStr = prompt(`Enter depth in ${unitLabel}:`);
            if (!depthStr || isNaN(parseFloat(depthStr))) {
                // Cancelled or invalid — still create as area measurement
                vertices = [];
                fc.renderAll();
                return;
            }
            const depth = parseFloat(depthStr);

            const areaText = scale
                ? scale.formatArea(pixelArea)
                : `${pixelArea.toFixed(0)} sq px`;
            const volumeText = scale
                ? scale.formatVolume(pixelArea, depth)
                : `${(pixelArea * depth).toFixed(0)} cu px`;
            const labelText = `${areaText} × ${depth} ${unitLabel} = ${volumeText}`;

            // Create polygon
            const polygon = new fabric.Polygon(
                vertices.map(v => ({ x: v.x, y: v.y })),
                {
                    fill: VOLUME_COLOR + '22',
                    stroke: VOLUME_COLOR,
                    strokeWidth: 2,
                    strokeUniform: true,
                    selectable: true,
                    objectCaching: false,
                }
            );

            const label = new fabric.IText(labelText, {
                left: centroid.x,
                top: centroid.y,
                fontFamily: 'Arial, sans-serif',
                fontSize: 13,
                fill: VOLUME_COLOR,
                stroke: null,
                strokeWidth: 0,
                selectable: true,
                editable: false,
                textAlign: 'center',
                originX: 'center',
                originY: 'center',
            });

            const pairedId = crypto.randomUUID();

            polygon.measurementType = 'volume';
            polygon.pixelArea = pixelArea;
            polygon.volumeDepth = depth;
            polygon.labelText = labelText;
            polygon.markupAuthor = 'User';
            polygon.markupTimestamp = new Date().toISOString();
            polygon.pairedId = pairedId;

            label.measurementType = 'volume';
            label.pixelArea = pixelArea;
            label.volumeDepth = depth;
            label.labelText = labelText;
            label.markupAuthor = 'User';
            label.markupTimestamp = new Date().toISOString();
            label.pairedId = pairedId;

            fc.add(polygon);
            fc.add(label);
            fc.setActiveObject(polygon);
            fc.renderAll();

            vertices = [];
        };

        const onMouseDown = (opt) => {
            if (opt.target) return;
            const pointer = fc.getPointer(opt.e);

            if (vertices.length >= 3) {
                if (this._snapToStart(pointer.x, pointer.y, vertices[0].x, vertices[0].y)) {
                    closePolygon();
                    toolbar._cleanupShapeDrawing();
                    toolbar.activeTool = 'select';
                    document.querySelectorAll('.tool-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.tool === 'select');
                    });
                    return;
                }
            }

            vertices.push({ x: pointer.x, y: pointer.y });
            updatePolyline();
            fc.renderAll();
        };

        const onMouseMove = (opt) => {
            if (vertices.length === 0) return;
            const pointer = fc.getPointer(opt.e);
            const last = vertices[vertices.length - 1];

            if (rubberBand) {
                rubberBand.set({ x2: pointer.x, y2: pointer.y });
            } else {
                rubberBand = new fabric.Line(
                    [last.x, last.y, pointer.x, pointer.y],
                    { stroke: VOLUME_COLOR, strokeWidth: 1, strokeDashArray: [6, 3],
                      selectable: false, evented: false, strokeUniform: true }
                );
                fc.add(rubberBand);
            }

            // Snap indicator near start vertex
            if (vertices.length >= 3) {
                const isNear = this._snapToStart(pointer.x, pointer.y, vertices[0].x, vertices[0].y);
                if (isNear && !snapIndicator) {
                    snapIndicator = new fabric.Circle({
                        left: vertices[0].x - 8, top: vertices[0].y - 8, radius: 8,
                        fill: 'transparent', stroke: VOLUME_COLOR, strokeWidth: 2,
                        selectable: false, evented: false,
                    });
                    fc.add(snapIndicator);
                } else if (!isNear && snapIndicator) {
                    fc.remove(snapIndicator);
                    snapIndicator = null;
                }
            }

            fc.renderAll();
        };

        const onDblClick = () => {
            if (vertices.length >= 3) {
                vertices.pop();
                closePolygon();
                toolbar._cleanupShapeDrawing();
                toolbar.activeTool = 'select';
                document.querySelectorAll('.tool-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tool === 'select');
                });
            }
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:dblclick', onDblClick);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:dblclick': onDblClick,
        };
    }

    // =========================================================================
    // CLOUD+ (CLOUD WITH AREA MEASUREMENT)
    // =========================================================================

    /**
     * Cloud+ = cloud shape with enclosed area measurement.
     *
     * Click-drag to draw a cloud rectangle. On release, the cloud is created
     * as a Group containing the cloud Path + area label at centroid.
     * Uses the bounding rect area (w × h) since the cloud is rectangular.
     *
     * Measurement metadata:
     *   measurementType: 'cloud-area'
     *   pixelArea: w × h in natural pixels
     *   labelText: formatted area string
     */
    initCloudArea(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;
        const CLOUD_COLOR = '#56b6c2';

        let isDrawing = false;
        let startX = 0, startY = 0;
        let activeShape = null;
        let previewLabel = null;

        const onMouseDown = (opt) => {
            if (opt.target) return;
            const pointer = fc.getPointer(opt.e);
            isDrawing = true;
            startX = pointer.x;
            startY = pointer.y;
        };

        const onMouseMove = (opt) => {
            if (!isDrawing) return;
            const pointer = fc.getPointer(opt.e);

            const left = Math.min(startX, pointer.x);
            const top = Math.min(startY, pointer.y);
            const w = Math.abs(pointer.x - startX);
            const h = Math.abs(pointer.y - startY);

            if (w < 3 || h < 3) return;

            // Remove old preview
            if (activeShape) fc.remove(activeShape);
            if (previewLabel) fc.remove(previewLabel);

            // Generate cloud path
            const pathStr = toolbar._generateCloudPath(0, 0, w, h);
            activeShape = new fabric.Path(pathStr, {
                left, top,
                fill: CLOUD_COLOR + '18',
                stroke: CLOUD_COLOR,
                strokeWidth: 2,
                strokeUniform: true,
                selectable: false,
                evented: false,
            });
            fc.add(activeShape);

            // Live area label
            const pixelArea = w * h;
            const areaText = scale
                ? scale.formatArea(pixelArea)
                : `${pixelArea.toFixed(0)} sq px`;
            previewLabel = new fabric.IText(areaText, {
                left: left + w / 2,
                top: top + h / 2,
                fontFamily: 'Arial, sans-serif',
                fontSize: 13,
                fill: CLOUD_COLOR,
                stroke: null,
                strokeWidth: 0,
                selectable: false,
                evented: false,
                originX: 'center',
                originY: 'center',
            });
            fc.add(previewLabel);
            fc.renderAll();
        };

        const onMouseUp = (opt) => {
            if (!isDrawing || !activeShape) return;
            isDrawing = false;

            // Capture dimensions from the preview shape before removing
            const savedLeft = activeShape.left;
            const savedTop = activeShape.top;
            const bounds = activeShape.getBoundingRect(true);
            const w = bounds.width;
            const h = bounds.height;

            // Remove previews
            fc.remove(activeShape);
            if (previewLabel) fc.remove(previewLabel);

            if (w < 5 || h < 5) {
                activeShape = null;
                previewLabel = null;
                fc.renderAll();
                return;
            }

            const pixelArea = w * h;

            const areaText = scale
                ? scale.formatArea(pixelArea)
                : `${pixelArea.toFixed(0)} sq px`;

            // Cloud path (relative coords 0,0)
            const pathStr = toolbar._generateCloudPath(0, 0, w, h);
            const cloudPath = new fabric.Path(pathStr, {
                fill: CLOUD_COLOR + '18',
                stroke: CLOUD_COLOR,
                strokeWidth: 2,
                strokeUniform: true,
            });

            // Area label at center
            const label = new fabric.IText(areaText, {
                left: w / 2,
                top: h / 2,
                fontFamily: 'Arial, sans-serif',
                fontSize: 13,
                fontWeight: 'bold',
                fill: CLOUD_COLOR,
                stroke: null,
                strokeWidth: 0,
                editable: false,
                originX: 'center',
                originY: 'center',
            });

            const group = new fabric.Group([cloudPath, label], {
                left: savedLeft,
                top: savedTop,
                selectable: true,
                subTargetCheck: false,
            });

            group.measurementType = 'cloud-area';
            group.pixelArea = pixelArea;
            group.labelText = areaText;
            group.markupAuthor = 'User';
            group.markupTimestamp = new Date().toISOString();

            canvas.stampDefaults(group, {
                markupType: toolbar.activeMarkupType,
                preserveColor: true,
            });

            fc.add(group);
            fc.setActiveObject(group);
            fc.renderAll();

            canvas.onContentChange?.();
            activeShape = null;
            previewLabel = null;
        };

        fc.on('mouse:down', onMouseDown);
        fc.on('mouse:move', onMouseMove);
        fc.on('mouse:up', onMouseUp);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
            'mouse:move': onMouseMove,
            'mouse:up': onMouseUp,
        };
    }

    // =========================================================================
    // SKETCH TO SCALE
    // =========================================================================

    /**
     * Draw a rectangle at calibrated scale dimensions.
     *
     * Workflow:
     *   1. Click canvas to set placement origin
     *   2. Prompt asks for width and height in real-world units
     *   3. Rectangle drawn at exact pixel dimensions matching the calibrated scale
     *   4. Dimension labels auto-applied on each edge
     *
     * Produces a Group containing:
     *   - Rectangle outline
     *   - Width label (top edge)
     *   - Height label (right edge)
     *
     * Measurement metadata:
     *   measurementType: 'sketch'
     *   pixelLength: perimeter in natural pixels
     *   labelText: "W × H" formatted string
     */
    initSketch(canvas, toolbar, scale) {
        const fc = canvas.fabricCanvas;
        const SKETCH_COLOR = '#c678dd'; // purple — distinct from other tools

        const onMouseDown = (opt) => {
            if (opt.target) return;
            const pointer = fc.getPointer(opt.e);

            if (!scale || scale.pixelsPerRealUnit <= 0) {
                alert('Please calibrate the scale first (K key).');
                return;
            }

            const unitLabel = scale.unitLabel;

            // Prompt for dimensions
            const widthStr = prompt(`Width in ${unitLabel}:`);
            if (!widthStr || isNaN(parseFloat(widthStr))) return;
            const realWidth = parseFloat(widthStr);

            const heightStr = prompt(`Height in ${unitLabel}:`);
            if (!heightStr || isNaN(parseFloat(heightStr))) return;
            const realHeight = parseFloat(heightStr);

            // Convert real-world dimensions to pixel dimensions
            const pixW = realWidth * scale.pixelsPerRealUnit;
            const pixH = realHeight * scale.pixelsPerRealUnit;

            if (pixW < 2 || pixH < 2) return;

            // Build the rectangle
            const rect = new fabric.Rect({
                left: 0, top: 0, width: pixW, height: pixH,
                fill: 'transparent',
                stroke: SKETCH_COLOR,
                strokeWidth: 2,
                strokeUniform: true,
            });

            // Width label (centered on top edge)
            const wLabel = new fabric.IText(
                `${realWidth} ${unitLabel}`,
                {
                    left: pixW / 2, top: -14,
                    fontFamily: 'Arial, sans-serif', fontSize: 11, fontWeight: 'bold',
                    fill: SKETCH_COLOR, stroke: null, strokeWidth: 0,
                    editable: false, originX: 'center', originY: 'center',
                }
            );

            // Height label (centered on right edge, rotated 90°)
            const hLabel = new fabric.IText(
                `${realHeight} ${unitLabel}`,
                {
                    left: pixW + 14, top: pixH / 2,
                    fontFamily: 'Arial, sans-serif', fontSize: 11, fontWeight: 'bold',
                    fill: SKETCH_COLOR, stroke: null, strokeWidth: 0,
                    editable: false, originX: 'center', originY: 'center',
                    angle: 90,
                }
            );

            const labelText = `${realWidth} × ${realHeight} ${unitLabel}`;
            const pixelPerimeter = 2 * (pixW + pixH);

            const group = new fabric.Group([rect, wLabel, hLabel], {
                left: pointer.x,
                top: pointer.y,
                selectable: true,
                subTargetCheck: false,
            });

            group.measurementType = 'sketch';
            group.pixelLength = pixelPerimeter;
            group.labelText = labelText;
            group.markupAuthor = 'User';
            group.markupTimestamp = new Date().toISOString();

            canvas.stampDefaults(group, {
                markupType: toolbar.activeMarkupType,
                preserveColor: true,
            });

            fc.add(group);
            fc.setActiveObject(group);
            fc.renderAll();

            canvas.onContentChange?.();
        };

        fc.on('mouse:down', onMouseDown);

        toolbar._shapeHandlers = {
            'mouse:down': onMouseDown,
        };
    }
}
