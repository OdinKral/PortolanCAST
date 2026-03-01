/**
 * PortolanCAST — Node Editor Module (Phase 3A)
 *
 * Purpose:
 *   Inkscape-style vertex and endpoint editing for measurement objects.
 *   Double-clicking an area polygon enters vertex-edit mode: each vertex
 *   becomes a draggable handle. Double-clicking a distance ruler Group
 *   decomposes it into a standalone Line with draggable endpoint handles,
 *   then recomposes back into a Group when editing ends.
 *
 * Architecture:
 *   NodeEditor attaches to the Fabric canvas after initialization and
 *   listens for 'mouse:dblclick' events. It maintains up to one active edit
 *   at a time (polygon OR line, never both). Exiting edit mode is triggered
 *   by tool change, selection cleared, or Escape key (via setTool(null)).
 *
 *   Polygon vertex edit:
 *     - Replaces Fabric's default controls with per-vertex fabric.Controls
 *     - positionHandler maps vertex coords (local space) to screen pixels
 *     - actionHandler maps drag (canvas natural coords) back to vertex array
 *     - After each drag, recalculates area + repositions companion label
 *
 *   Line endpoint edit:
 *     - Removes the distance Group from canvas
 *     - Creates a standalone fabric.Line + floating IText label
 *     - Two fabric.Controls (p0, p1) act as endpoint handles
 *     - On end: rebuilds the Group with updated endpoints + copies metadata
 *
 * Coordinate notes:
 *   Polygon.points[] are in the ABSOLUTE canvas natural-coord space (as
 *   originally placed). polygon.pathOffset is the center of the points'
 *   bounding box. To go from canvas drag position to polygon point:
 *     local = poly.toLocalPoint(dragPoint, 'center', 'center')
 *     poly.points[i] = { x: local.x + pathOffset.x, y: local.y + pathOffset.y }
 *
 *   For standalone Lines, x1/y1/x2/y2 ARE canvas natural-coords (no transform
 *   applied on a newly created standalone line). The actionHandler's x,y
 *   parameters are also in canvas natural-coords — so they can be set directly.
 *
 * Security:
 *   - No external data ingestion
 *   - All coordinate math uses Fabric.js APIs (no eval, no innerHTML)
 *   - Custom properties are from a hardcoded list only
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-22
 */

// Color constants — must match measure.js for visual consistency
const DISTANCE_COLOR = '#00ccff';  // Cyan — matches distance tool
const AREA_COLOR     = '#00ddaa';  // Teal — matches area tool

// Properties to copy from the original Group to the recomposed Group in endLineEdit.
// This ensures metadata survives the decompose/recompose cycle.
const GROUP_PROPS_TO_COPY = [
    'measurementType', 'pixelLength', 'pixelArea',
    'countIndex', 'countGroup', 'labelText',
    'markupType', 'markupStatus', 'markupNote',
    'markupAuthor', 'markupTimestamp', 'pairedId',
];

// =============================================================================
// NODE EDITOR CLASS
// =============================================================================

/**
 * Vertex and endpoint editing for measurement objects.
 *
 * Usage (from app.js):
 *   this.nodeEditor = new NodeEditor();
 *   // after canvas and toolbar are initialized:
 *   this.nodeEditor.initForCanvas(this.canvas, this.toolbar, this.scale);
 *   this.nodeEditor.measureTools = this.measureTools;
 */
export class NodeEditor {
    constructor() {
        /** @type {fabric.Polygon|null} Polygon currently in vertex edit mode */
        this._editingPolygon = null;

        /** @type {{group, line, label}|null} State for active line endpoint edit */
        this._editState = null;

        /** @type {Function|null} object:modified handler ref for cleanup */
        this._modHandler = null;

        /** @type {CanvasOverlay|null} */
        this._canvas = null;

        /** @type {Toolbar|null} */
        this._toolbar = null;

        /** @type {ScaleManager|null} */
        this._scale = null;

        /** @type {MeasureTools|null} Set by app.js after construction */
        this.measureTools = null;
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Attach to the Fabric canvas and toolbar.
     *
     * Args:
     *   canvas: CanvasOverlay instance (has .fabricCanvas, ._pushUndoSnapshot, etc.)
     *   toolbar: Toolbar instance (will receive onToolChange hook)
     *   scale: ScaleManager instance for formatting distances and areas
     */
    initForCanvas(canvas, toolbar, scale) {
        this._canvas = canvas;
        this._toolbar = toolbar;
        this._scale = scale;

        const fc = canvas.fabricCanvas;

        // Double-click on a measurement object → enter edit mode
        fc.on('mouse:dblclick', (e) => this._onDblClick(e));

        // Selection cleared → exit edit mode (user clicked empty space or deselected)
        fc.on('selection:cleared', () => this.endAnyEdit());

        // Tool change → exit edit mode (NodeEditor installs this callback)
        // onToolChange is called by setTool() before cleanup
        toolbar.onToolChange = () => this.endAnyEdit();
    }

    // =========================================================================
    // EXPLICIT ACTIVATION (button / keyboard shortcut)
    // =========================================================================

    /**
     * Enter edit mode for the currently selected measurement object.
     *
     * Called by toolbar when the 'node-edit' tool is activated (button click
     * or keyboard shortcut). Checks the active Fabric object and dispatches
     * to the appropriate edit mode. Safe to call with no selection (no-op).
     */
    enterEditModeOnSelection() {
        if (!this._canvas) return;
        const fc = this._canvas.fabricCanvas;
        const active = fc.getActiveObject();
        if (!active) return;

        if (active.measurementType === 'area' && Array.isArray(active.points)) {
            this.startPolygonEdit(active);
        } else if (active.measurementType === 'distance' && active._objects) {
            this.startLineEdit(active);
        }
        // Other objects (regular markup) are ignored — no-op
    }

    // =========================================================================
    // DISPATCH
    // =========================================================================

    /**
     * Route double-click events to the appropriate edit mode.
     *
     * Args:
     *   event: Fabric mouse:dblclick event { target: FabricObject|null }
     */
    _onDblClick(event) {
        const target = event.target;
        if (!target) return;

        // Use duck-typing instead of type-string comparison: Fabric.js has
        // inconsistent casing across versions (Polygon is 'polygon' lowercase,
        // while Rect is 'Rect' uppercase). Checking .points (polygon only)
        // and ._objects (group only) is safer and version-independent.
        if (target.measurementType === 'area' && Array.isArray(target.points)) {
            this.startPolygonEdit(target);
        } else if (target.measurementType === 'distance' && target._objects) {
            this.startLineEdit(target);
        }
        // Other object types: let Fabric handle default dblclick (e.g. IText entering edit)
    }

    // =========================================================================
    // SHARED EDIT CONTROL
    // =========================================================================

    /**
     * Exit whichever edit mode is currently active (if any).
     * Safe to call when nothing is being edited.
     */
    endAnyEdit() {
        if (this._editingPolygon) this.endPolygonEdit();
        if (this._editState) this.endLineEdit();
    }

    // =========================================================================
    // POLYGON VERTEX EDIT
    // =========================================================================

    /**
     * Enter vertex edit mode for an area polygon.
     *
     * Replaces the polygon's default Fabric controls with per-vertex handles.
     * The user can drag any vertex to reshape the polygon. Area and label text
     * update live via the object:modified listener.
     *
     * Args:
     *   polygon: fabric.Polygon with measurementType='area'
     */
    startPolygonEdit(polygon) {
        // Exit any previous edit first
        this.endAnyEdit();

        this._editingPolygon = polygon;

        // Disable border handles — we show vertex dots instead
        polygon.set({ hasBorders: false, objectCaching: false });

        // Create one fabric.Control per vertex
        const controls = {};
        for (let i = 0; i < polygon.points.length; i++) {
            controls['p' + i] = this._makeVertexControl(polygon, i);
        }
        polygon.controls = controls;
        polygon.setCoords();

        // Listen for modifications to recalculate area + update label
        this._modHandler = () => this._recalcPolygon(polygon);
        this._canvas.fabricCanvas.on('object:modified', this._modHandler);

        this._canvas.fabricCanvas.requestRenderAll();
    }

    /**
     * Exit polygon vertex edit mode.
     * Restores default Fabric controls and saves an undo snapshot.
     */
    endPolygonEdit() {
        if (!this._editingPolygon) return;

        const fc = this._canvas.fabricCanvas;

        if (this._modHandler) {
            fc.off('object:modified', this._modHandler);
            this._modHandler = null;
        }

        // Restore default Fabric selection handles
        this._editingPolygon.controls = fabric.Object.prototype.controls;
        this._editingPolygon.set({ hasBorders: true });
        this._editingPolygon.setCoords();

        // Save a single undo snapshot for the entire vertex edit session
        this._canvas._pushUndoSnapshot();
        if (this._canvas.onContentChange) this._canvas.onContentChange();

        this._editingPolygon = null;
        fc.requestRenderAll();
    }

    /**
     * Build a fabric.Control for a single polygon vertex.
     *
     * positionHandler:
     *   Converts polygon.points[index] from polygon-local space to screen pixels.
     *   polygon.pathOffset is the center of the original points' bounding box.
     *   The polygon's calcTransformMatrix() maps local → canvas → screen.
     *
     * actionHandler:
     *   Receives drag position in canvas natural-coord space (pre-zoom).
     *   toLocalPoint converts to polygon-local coords (relative to poly center).
     *   Adding pathOffset gives the absolute point position back.
     *
     * Args:
     *   polygon: The polygon this control belongs to (needed for closure).
     *   index: Index into polygon.points[].
     *
     * Returns:
     *   fabric.Control
     */
    _makeVertexControl(polygon, index) {
        // Visual: small cyan circle with white border — distinguishable from selection handles
        const renderVertexDot = (ctx, left, top) => {
            ctx.save();
            ctx.fillStyle = AREA_COLOR;
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(left, top, 5, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        };

        return new fabric.Control({
            /**
             * Returns screen-pixel position of this vertex for handle rendering.
             * Transforms: polygon-local (point - pathOffset) → canvas → screen
             */
            positionHandler(dim, finalMatrix, obj) {
                // polygon.points are in absolute canvas coords.
                // pathOffset is the center of the points' bounding box.
                // Subtracting it gives position relative to the polygon's local center.
                const x = obj.points[index].x - obj.pathOffset.x;
                const y = obj.points[index].y - obj.pathOffset.y;
                // calcTransformMatrix maps polygon-local to canvas. finalMatrix
                // is provided by Fabric and maps to screen — use it for correct
                // rendering under zoom/scroll.
                return fabric.util.transformPoint({ x, y }, obj.calcTransformMatrix());
            },

            /**
             * Updates the vertex position when the user drags the handle.
             * x, y are canvas natural-coord position (from Fabric's event processing).
             */
            actionHandler(eventData, transform, x, y) {
                const poly = transform.target;
                // Fabric.js 6: toLocalPoint() was removed. Use invertTransform instead.
                // calcTransformMatrix() maps polygon-local → canvas (forward transform).
                // Inverting it gives canvas → polygon-local (the transform we need here).
                const invMat = fabric.util.invertTransform(poly.calcTransformMatrix());
                const local = fabric.util.transformPoint({ x, y }, invMat);
                // local is relative to the polygon's local center (pathOffset already
                // baked into the transform). Re-add pathOffset to get absolute polygon-
                // point coordinate space (same basis as polygon.points[i].x/y).
                poly.points[index] = {
                    x: local.x + poly.pathOffset.x,
                    y: local.y + poly.pathOffset.y,
                };
                return true;  // Fabric calls setCoords() and re-renders
            },

            render: renderVertexDot,
            actionName: 'modifyPolygon',
            // Cursor: indicate this is a move handle
            cursorStyle: 'crosshair',
        });
    }

    /**
     * Recalculate area and update companion label after a vertex drag.
     *
     * Uses the Shoelace formula (same as MeasureTools._polygonArea).
     * Finds the companion IText label via the shared pairedId property.
     * Updates both the polygon's stored pixelArea and the label's text + position.
     *
     * Args:
     *   polygon: The polygon that was just modified.
     */
    _recalcPolygon(polygon) {
        if (!polygon || !polygon.points || polygon.points.length < 3) return;

        const points = polygon.points;
        const n = points.length;

        // Shoelace formula for signed area
        let area = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            area += points[i].x * points[j].y;
            area -= points[j].x * points[i].y;
        }
        const pixelArea = Math.abs(area / 2);

        const labelText = this._scale
            ? this._scale.formatArea(pixelArea)
            : `${pixelArea.toFixed(0)} sq px`;

        // Update measurement metadata on the polygon itself
        polygon.pixelArea = pixelArea;
        polygon.labelText = labelText;

        // Find the companion centroid label (shares pairedId with the polygon)
        const fc = this._canvas.fabricCanvas;
        if (polygon.pairedId) {
            const label = fc.getObjects().find(
                o => o.pairedId === polygon.pairedId && o !== polygon
            );

            if (label) {
                label.set({ text: labelText });
                label.labelText = labelText;
                label.pixelArea = pixelArea;

                // Reposition label at the new centroid (simple average of vertices).
                // We need CANVAS coords for the centroid, not polygon-local coords.
                // The polygon's points are absolute (they include pathOffset in their coords),
                // so we must transform from that space to canvas space.
                const sumX = points.reduce((s, p) => s + p.x, 0);
                const sumY = points.reduce((s, p) => s + p.y, 0);
                const centroidX = sumX / n;
                const centroidY = sumY / n;

                // Convert centroid from absolute polygon-point space to canvas space:
                // polygon-local coords = point - pathOffset, then apply transform matrix
                const localX = centroidX - polygon.pathOffset.x;
                const localY = centroidY - polygon.pathOffset.y;
                const canvasCentroid = fabric.util.transformPoint(
                    { x: localX, y: localY },
                    polygon.calcTransformMatrix()
                );

                label.set({ left: canvasCentroid.x, top: canvasCentroid.y });
                label.setCoords();
            }
        }

        fc.requestRenderAll();
    }

    // =========================================================================
    // LINE ENDPOINT EDIT
    // =========================================================================

    /**
     * Enter endpoint edit mode for a distance ruler Group.
     *
     * Removes the Group from the canvas, creates a standalone fabric.Line at
     * the Group's endpoint positions, and attaches P0/P1 endpoint controls.
     * A floating IText label updates live during drag.
     *
     * Args:
     *   group: fabric.Group with measurementType='distance' and lineEndpoints set.
     */
    startLineEdit(group) {
        this.endAnyEdit();

        const fc = this._canvas.fabricCanvas;

        // lineEndpoints stores endpoint coords RELATIVE to the Group's bounding-box origin.
        // Recover absolute canvas coords: abs = group.left + relativeOffset
        const eps = group.lineEndpoints;
        if (!eps) {
            console.warn('[NodeEditor] Group missing lineEndpoints — cannot edit');
            return;
        }

        const abs_p0 = { x: group.left + eps.x1, y: group.top + eps.y1 };
        const abs_p1 = { x: group.left + eps.x2, y: group.top + eps.y2 };

        // ── Remove the original Group ──────────────────────────────────────────
        // Suppress undo snapshot from this remove — endLineEdit saves a single snapshot
        this._canvas._undoRedoInProgress = true;
        fc.remove(group);

        // ── Create standalone Line ─────────────────────────────────────────────
        const standaloneLine = new fabric.Line(
            [abs_p0.x, abs_p0.y, abs_p1.x, abs_p1.y],
            {
                stroke: DISTANCE_COLOR,
                strokeWidth: 2,
                strokeUniform: true,
                selectable: true,
                evented: true,
                // No border handles — only our P0/P1 endpoint controls
                hasBorders: false,
            }
        );

        // Attach P0 (x1/y1) and P1 (x2/y2) endpoint controls
        standaloneLine.controls = {
            p0: this._makeEndpointControl(0),
            p1: this._makeEndpointControl(1),
        };

        // ── Create floating label ──────────────────────────────────────────────
        const midX = (abs_p0.x + abs_p1.x) / 2;
        const midY = (abs_p0.y + abs_p1.y) / 2;
        const initPixelLength = Math.sqrt(
            (abs_p1.x - abs_p0.x) ** 2 + (abs_p1.y - abs_p0.y) ** 2
        );
        const initLabelText = this._scale
            ? this._scale.formatDistance(initPixelLength)
            : `${initPixelLength.toFixed(1)} px`;

        const floatingLabel = new fabric.IText(initLabelText, {
            left: midX,
            top: midY - 12,
            fontFamily: 'Arial, sans-serif',
            fontSize: 12,
            fontWeight: 'bold',
            fill: DISTANCE_COLOR,
            selectable: false,
            evented: false,
            originX: 'center',
            originY: 'center',
        });

        // ── Add both to canvas, restore undo guard ─────────────────────────────
        fc.add(standaloneLine);
        fc.add(floatingLabel);
        this._canvas._undoRedoInProgress = false;

        // ── Store edit state ───────────────────────────────────────────────────
        this._editState = { group, line: standaloneLine, label: floatingLabel };

        // Listen for modifications to update the floating label live
        this._modHandler = () => this._recalcLine();
        fc.on('object:modified', this._modHandler);

        fc.setActiveObject(standaloneLine);
        fc.requestRenderAll();
    }

    /**
     * Exit line endpoint edit mode.
     *
     * Removes the standalone Line + floating label, rebuilds the distance Group
     * with updated endpoint coordinates and metadata, and saves one undo snapshot.
     */
    endLineEdit() {
        if (!this._editState) return;

        const fc = this._canvas.fabricCanvas;
        const { group: origGroup, line: standaloneLine, label: floatingLabel } = this._editState;

        if (this._modHandler) {
            fc.off('object:modified', this._modHandler);
            this._modHandler = null;
        }

        // Current endpoint canvas coords — these are directly in the line's natural coords
        // since the standalone line was created with absolute canvas positions and
        // the actionHandler updates x1/y1/x2/y2 directly.
        const x1 = standaloneLine.x1;
        const y1 = standaloneLine.y1;
        const x2 = standaloneLine.x2;
        const y2 = standaloneLine.y2;

        const pixelLength = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        const labelText = this._scale
            ? this._scale.formatDistance(pixelLength)
            : `${pixelLength.toFixed(1)} px`;

        // ── Suppress individual undo events during recomposition ───────────────
        this._canvas._undoRedoInProgress = true;

        fc.remove(standaloneLine);
        fc.remove(floatingLabel);

        // ── Rebuild the Group with updated coordinates ─────────────────────────
        if (!this.measureTools) {
            console.error('[NodeEditor] measureTools not set — cannot rebuild distance group');
            this._canvas._undoRedoInProgress = false;
            this._editState = null;
            return;
        }

        const newGroup = this.measureTools._buildDistanceGroup(
            x1, y1, x2, y2, pixelLength, labelText
        );

        // Copy all custom properties from the original Group to preserve semantics.
        // Override measurement values with the updated ones.
        for (const prop of GROUP_PROPS_TO_COPY) {
            if (origGroup[prop] !== undefined) {
                newGroup[prop] = origGroup[prop];
            }
        }
        newGroup.pixelLength = pixelLength;
        newGroup.labelText = labelText;
        // lineEndpoints is re-computed by _buildDistanceGroup (it uses the new coords)

        fc.add(newGroup);
        this._canvas._undoRedoInProgress = false;

        // ── Save single undo snapshot for the whole edit ───────────────────────
        this._canvas._pushUndoSnapshot();
        if (this._canvas.onContentChange) this._canvas.onContentChange();

        fc.setActiveObject(newGroup);
        fc.requestRenderAll();

        this._editState = null;
    }

    /**
     * Build a fabric.Control for a line endpoint (P0 or P1).
     *
     * positionHandler:
     *   For a standalone Line with no rotation/scale, x1/y1 (or x2/y2) are
     *   in canvas natural-coord space. We convert to screen pixels using the
     *   line's calcTransformMatrix() combined with the viewport transform.
     *
     *   The Fabric line's bounding box spans [min(x1,x2), min(y1,y2)] to
     *   [max(x1,x2), max(y1,y2)]. The local (0,0) is at the center.
     *   P0 relative to center = { x: (x1-x2)/2, y: (y1-y2)/2 }.
     *
     * actionHandler:
     *   Receives canvas natural-coord position (x, y). Sets x1/y1 or x2/y2
     *   directly on the line (valid since standalone line is in canvas space).
     *
     * Args:
     *   pointIndex: 0 for P0 (x1/y1), 1 for P1 (x2/y2)
     *
     * Returns:
     *   fabric.Control
     */
    _makeEndpointControl(pointIndex) {
        const xProp = pointIndex === 0 ? 'x1' : 'x2';
        const yProp = pointIndex === 0 ? 'y1' : 'y2';

        // Visual: slightly larger cyan dot — distinguishable as endpoint (not vertex)
        const renderEndpointDot = (ctx, left, top) => {
            ctx.save();
            ctx.fillStyle = DISTANCE_COLOR;
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(left, top, 6, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        };

        return new fabric.Control({
            /**
             * Returns screen-pixel position of the endpoint handle.
             *
             * In Fabric.js, a Line's local space has (0,0) at the center of its
             * bounding box. The endpoint relative to the center is:
             *   relX = line[xProp] - (line.x1 + line.x2) / 2
             * This is in natural-coord space. The finalMatrix maps local natural
             * coords → screen pixels, accounting for zoom/viewport transform.
             */
            positionHandler(dim, finalMatrix, line) {
                const relX = line[xProp] - (line.x1 + line.x2) / 2;
                const relY = line[yProp] - (line.y1 + line.y2) / 2;
                return fabric.util.transformPoint({ x: relX, y: relY }, finalMatrix);
            },

            /**
             * Update the endpoint to the dragged canvas position.
             *
             * CRITICAL: After updating x1/y1, we must also recalculate the Line's
             * left/top/width/height (its bounding box), otherwise the position
             * properties go stale and subsequent rendering/setCoords() use the old
             * bounding box. Fabric does NOT auto-recalculate these when x1/y1 change.
             *
             * x, y from Fabric's control system are in canvas natural-coord space
             * (same space as getPointer() and our stored x1/y1 values).
             */
            actionHandler(eventData, transform, x, y) {
                const line = transform.target;
                // Update the dragged endpoint coordinate
                line[xProp] = x;
                line[yProp] = y;
                // Recalculate bounding-box properties to match new endpoint positions
                const minX = Math.min(line.x1, line.x2);
                const minY = Math.min(line.y1, line.y2);
                const maxX = Math.max(line.x1, line.x2);
                const maxY = Math.max(line.y1, line.y2);
                line.left = minX;
                line.top = minY;
                line.width = maxX - minX;
                line.height = maxY - minY;
                // Fabric calls setCoords() after actionHandler returns true
                return true;
            },

            render: renderEndpointDot,
            actionName: 'modifyLine',
            cursorStyle: 'crosshair',
        });
    }

    /**
     * Update the floating label during live endpoint drag.
     *
     * Called by the object:modified handler while the user is dragging an
     * endpoint control. Reads the current x1/y1/x2/y2 from the standalone line,
     * computes pixel length and formatted distance, and repositions the label.
     */
    _recalcLine() {
        if (!this._editState) return;
        const { line: standaloneLine, label: floatingLabel } = this._editState;

        const x1 = standaloneLine.x1;
        const y1 = standaloneLine.y1;
        const x2 = standaloneLine.x2;
        const y2 = standaloneLine.y2;

        const pixelLength = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        const labelText = this._scale
            ? this._scale.formatDistance(pixelLength)
            : `${pixelLength.toFixed(1)} px`;

        // Update floating label text and reposition to midpoint of updated endpoints
        floatingLabel.set({
            text: labelText,
            left: (x1 + x2) / 2,
            top: (y1 + y2) / 2 - 12,
        });
        floatingLabel.setCoords();

        this._canvas.fabricCanvas.requestRenderAll();
    }
}
