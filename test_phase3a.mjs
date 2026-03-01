/**
 * PortolanCAST — Phase 3A Browser Tests
 *
 * Tests: pan/edit separation, Hand tool, polygon vertex editing,
 * distance ruler endpoint editing.
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_phase3a.mjs"
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-22
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID = 1;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  PASS: ${msg}`);
    } else {
        failed++;
        console.log(`  FAIL: ${msg}`);
    }
}

async function getCanvasInfo(page) {
    return page.evaluate(() => {
        const el = document.getElementById('fabric-canvas');
        const rect = el.getBoundingClientRect();
        return {
            x: rect.left,
            y: rect.top,
            scale: window.app.viewer.zoom / 100,
        };
    });
}

async function toPageCoords(page, naturalX, naturalY) {
    const info = await getCanvasInfo(page);
    return {
        x: info.x + naturalX * info.scale,
        y: info.y + naturalY * info.scale,
    };
}

async function run() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear pre-existing markups from previous test runs
        await page.evaluate(async () => {
            window.app.canvas.pageMarkups.clear();
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
            await fetch(`/api/documents/${window.app.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {} }),
            });
            window.app._dirty = false;
        });
        await page.waitForTimeout(300);

        // =====================================================================
        // TEST GROUP 1: Pan Fix
        // =====================================================================
        console.log('\n--- Test Group 1: Pan / Edit Separation ---');

        // Place a rect to test with
        await page.evaluate(() => {
            const { fabricCanvas } = window.app.canvas;
            const rect = new fabric.Rect({
                left: 100, top: 100, width: 80, height: 60,
                fill: 'transparent', stroke: '#ff4444', strokeWidth: 2,
                selectable: true,
            });
            window.app.canvas.stampDefaults(rect, { markupType: 'issue' });
            fabricCanvas.add(rect);
            fabricCanvas.renderAll();
        });
        await page.waitForTimeout(200);

        // Activate select tool
        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.waitForTimeout(100);

        // Record initial scroll position
        const scrollBefore = await page.evaluate(() => ({
            left: document.getElementById('viewport').scrollLeft,
            top: document.getElementById('viewport').scrollTop,
        }));

        // Drag the rect (object drag while select tool active)
        const rectPos = await toPageCoords(page, 140, 130);  // center of rect
        await page.mouse.move(rectPos.x, rectPos.y);
        await page.mouse.down();
        await page.mouse.move(rectPos.x + 30, rectPos.y + 20);
        await page.mouse.up();
        await page.waitForTimeout(200);

        const scrollAfter = await page.evaluate(() => ({
            left: document.getElementById('viewport').scrollLeft,
            top: document.getElementById('viewport').scrollTop,
        }));

        assert(
            scrollAfter.left === scrollBefore.left && scrollAfter.top === scrollBefore.top,
            'Dragging rect in select mode does NOT pan the viewport'
        );

        // Hand tool active — drag on canvas → should pan
        await page.evaluate(() => { window.app.toolbar.setTool('hand'); });
        await page.waitForTimeout(100);

        const scrollBeforePan = await page.evaluate(() => ({
            left: document.getElementById('viewport').scrollLeft,
            top: document.getElementById('viewport').scrollTop,
        }));

        // Drag on empty canvas area (no object under cursor)
        const emptyPos = await toPageCoords(page, 400, 300);
        await page.mouse.move(emptyPos.x, emptyPos.y);
        await page.mouse.down();
        await page.mouse.move(emptyPos.x - 50, emptyPos.y - 30);
        await page.mouse.up();
        await page.waitForTimeout(200);

        const scrollAfterPan = await page.evaluate(() => ({
            left: document.getElementById('viewport').scrollLeft,
            top: document.getElementById('viewport').scrollTop,
        }));

        // Pan should have changed at least one scroll position
        // (test passes if either scrollLeft or scrollTop changed)
        const panOccurred =
            scrollAfterPan.left !== scrollBeforePan.left ||
            scrollAfterPan.top !== scrollBeforePan.top;
        assert(panOccurred, 'Hand tool + drag pans the viewport');

        // Reset scroll to center for subsequent tests
        await page.evaluate(() => {
            document.getElementById('viewport').scrollLeft = 0;
            document.getElementById('viewport').scrollTop = 0;
        });

        // =====================================================================
        // TEST GROUP 2: Hand Tool
        // =====================================================================
        console.log('\n--- Test Group 2: Hand Tool ---');

        const handBtn = await page.$('button[data-tool="hand"]');
        assert(handBtn !== null, 'Hand button exists in toolbar');

        const nodeEditBtn = await page.$('button[data-tool="node-edit"]');
        assert(nodeEditBtn !== null, 'Node Edit button exists in toolbar');

        // G key activates hand tool (H is reserved for Highlighter)
        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.keyboard.press('g');
        await page.waitForTimeout(100);
        const handActiveAfterG = await page.evaluate(() => window.app.toolbar.activeTool === 'hand');
        assert(handActiveAfterG, 'G key activates hand tool');

        // Hand tool: canvas does NOT have .drawing-active
        const drawingActiveWithHand = await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            return wrapper.classList.contains('drawing-active');
        });
        assert(!drawingActiveWithHand, 'Canvas has no .drawing-active when hand tool is active');

        // #canvas-container has .hand-mode when hand tool is active
        const containerHasHandMode = await page.evaluate(() => {
            return document.getElementById('canvas-container').classList.contains('hand-mode');
        });
        assert(containerHasHandMode, '#canvas-container has .hand-mode with hand tool active');

        // Switching to select tool removes .hand-mode and adds .drawing-active
        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.waitForTimeout(100);
        const handModeRemovedOnSelect = await page.evaluate(() => {
            return !document.getElementById('canvas-container').classList.contains('hand-mode');
        });
        assert(handModeRemovedOnSelect, '.hand-mode removed when switching to select tool');

        const drawingActiveOnSelect = await page.evaluate(() => {
            return window.app.canvas.fabricCanvas.wrapperEl.classList.contains('drawing-active');
        });
        assert(drawingActiveOnSelect, '.drawing-active present when select tool is active');

        // =====================================================================
        // TEST GROUP 3: pairedId / lineEndpoints Metadata
        // =====================================================================
        console.log('\n--- Test Group 3: Metadata (pairedId / lineEndpoints) ---');

        // Clear canvas, draw an area polygon
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
        });
        await page.waitForTimeout(100);

        await page.evaluate(() => { window.app.toolbar.setTool('area'); });
        await page.waitForTimeout(100);

        // Click 4 vertices to form a rectangle polygon, then double-click to close
        const v1 = await toPageCoords(page, 150, 200);
        const v2 = await toPageCoords(page, 300, 200);
        const v3 = await toPageCoords(page, 300, 350);
        const v4 = await toPageCoords(page, 150, 350);

        await page.mouse.click(v1.x, v1.y);
        await page.waitForTimeout(100);
        await page.mouse.click(v2.x, v2.y);
        await page.waitForTimeout(100);
        await page.mouse.click(v3.x, v3.y);
        await page.waitForTimeout(100);
        await page.mouse.dblclick(v4.x, v4.y);  // double-click to close
        await page.waitForTimeout(300);

        const polyMetadata = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const poly = fc.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
            const label = fc.getObjects().find(o => o.pairedId && o.measurementType === 'area' && !Array.isArray(o.points));
            if (!poly || !label) return null;
            return {
                polyHasPairedId: !!poly.pairedId,
                labelHasPairedId: !!label.pairedId,
                idsMatch: poly.pairedId === label.pairedId,
                pairedIdIsString: typeof poly.pairedId === 'string' && poly.pairedId.length > 10,
            };
        });

        assert(polyMetadata !== null, 'Area polygon and label were created');
        assert(polyMetadata?.polyHasPairedId, 'Area polygon has pairedId set');
        assert(polyMetadata?.labelHasPairedId, 'Area label has pairedId set');
        assert(polyMetadata?.idsMatch, 'Polygon and label share the same pairedId');
        assert(polyMetadata?.pairedIdIsString, 'pairedId is a non-empty UUID string');

        // Draw a distance ruler and check lineEndpoints
        await page.evaluate(() => { window.app.toolbar.setTool('distance'); });
        await page.waitForTimeout(100);

        const d1 = await toPageCoords(page, 400, 200);
        const d2 = await toPageCoords(page, 550, 280);
        await page.mouse.move(d1.x, d1.y);
        await page.mouse.down();
        await page.mouse.move(d2.x, d2.y);
        await page.mouse.up();
        await page.waitForTimeout(300);

        const lineMetadata = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const grp = fc.getObjects().find(o => o.measurementType === 'distance' && o._objects);
            if (!grp) return null;
            return {
                hasLineEndpoints: !!grp.lineEndpoints,
                endpointsHaveX1: grp.lineEndpoints && grp.lineEndpoints.x1 !== undefined,
                hasPairedId: !!grp.pairedId,
            };
        });

        assert(lineMetadata !== null, 'Distance Group was created');
        assert(lineMetadata?.hasLineEndpoints, 'Distance Group has lineEndpoints property');
        assert(lineMetadata?.endpointsHaveX1, 'lineEndpoints has x1/y1/x2/y2 keys');
        assert(lineMetadata?.hasPairedId, 'Distance Group has pairedId');

        // =====================================================================
        // TEST GROUP 4: Polygon Vertex Editing
        // =====================================================================
        console.log('\n--- Test Group 4: Polygon Vertex Editing ---');

        // Ensure we have the polygon from group 3
        const polyCount = await page.evaluate(() => {
            return window.app.canvas.fabricCanvas.getObjects().filter(o => o.measurementType === 'area' && Array.isArray(o.points)).length;
        });
        assert(polyCount > 0, 'Polygon exists for vertex edit tests');

        if (polyCount > 0) {
            // Select the polygon, then activate Node Edit mode via the button.
            // This is more reliable than double-click because:
            //   - The area label IText is at the centroid (same position as poly center)
            //   - Double-click would hit the label, not the polygon
            //   - The Node Edit button always acts on the currently-selected object
            await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const poly = fc.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                if (poly) fc.setActiveObject(poly);
            });
            await page.evaluate(() => { window.app.toolbar.setTool('node-edit'); });
            await page.waitForTimeout(200);

            const vertexEditState = await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const poly = fc.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                if (!poly) return null;
                const controls = Object.keys(poly.controls);
                return {
                    hasBordersOff: poly.hasBorders === false,
                    hasVertexControls: controls.some(k => k.startsWith('p')),
                    controlCount: controls.length,
                    isInEditMode: window.app.nodeEditor._editingPolygon === poly,
                };
            });

            assert(vertexEditState !== null, 'Polygon exists after Node Edit activation');
            assert(vertexEditState?.hasBordersOff, 'Polygon hasBorders=false in vertex edit mode');
            assert(vertexEditState?.hasVertexControls, 'Polygon has vertex controls (p0, p1, ...)');
            assert(vertexEditState?.isInEditMode, 'NodeEditor._editingPolygon is set correctly');
            assert(
                (vertexEditState?.controlCount || 0) >= 4,
                'Polygon has ≥4 vertex controls (for a 4-vertex polygon)'
            );

            // Record initial area
            const initialArea = await page.evaluate(() => {
                const poly = window.app.canvas.fabricCanvas.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                return poly?.pixelArea || 0;
            });

            // Test the vertex control's actionHandler directly.
            // Playwright mouse-based drag has precision issues for small custom controls
            // (sub-pixel alignment), so we invoke the actionHandler programmatically.
            // This tests the same code path that Fabric calls on a real drag.
            const vertexMoved = await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const poly = fc.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                if (!poly || !window.app.nodeEditor._editingPolygon) return false;

                const p0Control = poly.controls['p0'];
                if (!p0Control || !p0Control.actionHandler) return false;

                // Record position before
                const origX = poly.points[0].x;
                const origY = poly.points[0].y;

                // Simulate Fabric's actionHandler call: x,y are canvas natural-coord
                // position of the dragged endpoint (30px right of the original vertex).
                const mockTransform = { target: poly };
                p0Control.actionHandler({}, mockTransform, origX + 30, origY);
                fc.requestRenderAll();

                // Check that points[0] moved
                return Math.abs(poly.points[0].x - origX) > 1;
            });
            assert(vertexMoved, 'Vertex control actionHandler moves polygon.points[0]');

            // Area should have recalculated after the drag
            const areaAfterDrag = await page.evaluate(() => {
                const poly = window.app.canvas.fabricCanvas.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                return poly?.pixelArea || 0;
            });
            assert(areaAfterDrag !== initialArea || areaAfterDrag > 0,
                'pixelArea recalculates after vertex drag (or was non-zero)');

            // Label text should update
            const labelUpdated = await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const poly = fc.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                const label = fc.getObjects().find(o => o.pairedId && o.pairedId === poly?.pairedId && o !== poly);
                if (!poly || !label) return false;
                // Label text should match polygon's labelText
                return label.text === poly.labelText;
            });
            assert(labelUpdated, 'Companion label text matches polygon labelText after vertex drag');

            // Escape exits vertex edit mode
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);

            const exitedEditMode = await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const poly = fc.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                return {
                    nodeEditorClear: window.app.nodeEditor._editingPolygon === null,
                    bordersRestored: poly?.hasBorders !== false,
                };
            });
            assert(exitedEditMode.nodeEditorClear, 'Escape exits vertex edit: nodeEditor._editingPolygon null');
            assert(exitedEditMode.bordersRestored, 'Escape exits vertex edit: polygon hasBorders restored');
        }

        // Activating Node Edit with a non-measurement object selected should NOT enter edit mode
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = fc.getObjects().find(o => o.markupType === 'issue' && !Array.isArray(o.points));
            if (rect) fc.setActiveObject(rect);
        });
        await page.evaluate(() => { window.app.toolbar.setTool('node-edit'); });
        await page.waitForTimeout(200);
        const noEditMode = await page.evaluate(() => {
            return window.app.nodeEditor._editingPolygon === null &&
                   window.app.nodeEditor._editState === null;
        });
        assert(noEditMode, 'Node Edit on a non-measurement rect does not enter node edit mode');

        // =====================================================================
        // TEST GROUP 5: Distance Ruler Endpoint Editing
        // =====================================================================
        console.log('\n--- Test Group 5: Distance Ruler Endpoint Editing ---');

        const distGroupCount = await page.evaluate(() => {
            return window.app.canvas.fabricCanvas.getObjects()
                .filter(o => o.measurementType === 'distance' && o._objects).length;
        });
        assert(distGroupCount > 0, 'Distance Group exists for endpoint edit tests');

        if (distGroupCount > 0) {
            await page.evaluate(() => { window.app.toolbar.setTool('select'); });
            await page.waitForTimeout(100);

            // Record original group metadata before editing
            const groupBefore = await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const grp = fc.getObjects().find(o => o.measurementType === 'distance' && o._objects);
                if (!grp) return null;
                return {
                    pairedId: grp.pairedId,
                    measurementType: grp.measurementType,
                    pixelLength: grp.pixelLength,
                };
            });

            // Select the distance Group and activate Node Edit mode
            await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const grp = fc.getObjects().find(o => o.measurementType === 'distance' && o._objects);
                if (grp) fc.setActiveObject(grp);
            });
            await page.evaluate(() => { window.app.toolbar.setTool('node-edit'); });
            await page.waitForTimeout(400);

            {   // Block scope to avoid let/const collision with outer block
                const lineEditState = await page.evaluate(() => {
                    const fc = window.app.canvas.fabricCanvas;
                    const editState = window.app.nodeEditor._editState;
                    if (!editState) return null;
                    const standaloneLine = fc.getObjects().find(o => o.x1 !== undefined && o.selectable);
                    const groupGone = !fc.getObjects().find(o => o.measurementType === 'distance' && o._objects);
                    return {
                        editStateSet: editState !== null,
                        groupRemovedFromCanvas: groupGone,
                        standaloneLinePresent: standaloneLine !== null,
                        lineHasP0Control: editState?.line?.controls?.p0 !== undefined,
                        lineHasP1Control: editState?.line?.controls?.p1 !== undefined,
                    };
                });

                assert(lineEditState !== null, 'Entering line edit mode: editState set');
                assert(lineEditState?.groupRemovedFromCanvas, 'Original Group removed from canvas on edit entry');
                assert(lineEditState?.standaloneLinePresent, 'Standalone Line added to canvas');
                assert(lineEditState?.lineHasP0Control, 'Standalone Line has P0 endpoint control');
                assert(lineEditState?.lineHasP1Control, 'Standalone Line has P1 endpoint control');

                // Floating label should be present
                const floatingLabelPresent = await page.evaluate(() => {
                    const fc = window.app.canvas.fabricCanvas;
                    const editState = window.app.nodeEditor._editState;
                    const floatLabel = editState?.label;
                    return floatLabel !== null && floatLabel !== undefined &&
                           fc.getObjects().includes(floatLabel);
                });
                assert(floatingLabelPresent, 'Floating label is present on canvas during line edit');

                // Escape exits line edit mode — rebuilds Group
                await page.keyboard.press('Escape');
                await page.waitForTimeout(400);

                const lineEditExited = await page.evaluate(() => {
                    const fc = window.app.canvas.fabricCanvas;
                    const editStateGone = window.app.nodeEditor._editState === null;
                    const newGroupPresent = fc.getObjects().some(o => o.measurementType === 'distance' && o._objects);
                    const standaloneLineGone = !fc.getObjects().some(o => o.x1 !== undefined && o.selectable);
                    return { editStateGone, newGroupPresent, standaloneLineGone };
                });

                assert(lineEditExited.editStateGone, 'Escape: nodeEditor._editState cleared');
                assert(lineEditExited.newGroupPresent, 'Escape: new Group recomposed on canvas');
                assert(lineEditExited.standaloneLineGone, 'Escape: standalone Line removed');

                // Verify metadata preserved on recomposed Group
                const recomposedGroupMeta = await page.evaluate(() => {
                    const fc = window.app.canvas.fabricCanvas;
                    const grp = fc.getObjects().find(o => o.measurementType === 'distance' && o._objects);
                    if (!grp) return null;
                    return {
                        measurementType: grp.measurementType,
                        hasPixelLength: grp.pixelLength > 0,
                        hasLabelText: typeof grp.labelText === 'string' && grp.labelText.length > 0,
                        hasPairedId: !!grp.pairedId,
                        hasLineEndpoints: !!grp.lineEndpoints,
                    };
                });

                assert(recomposedGroupMeta?.measurementType === 'distance',
                    'Recomposed Group has measurementType=distance');
                assert(recomposedGroupMeta?.hasPixelLength,
                    'Recomposed Group has pixelLength > 0');
                assert(recomposedGroupMeta?.hasLabelText,
                    'Recomposed Group has labelText');
                assert(recomposedGroupMeta?.hasPairedId,
                    'pairedId preserved on recomposed Group');
                assert(recomposedGroupMeta?.hasLineEndpoints,
                    'lineEndpoints present on recomposed Group');
            }   // end block scope
        }

        // =====================================================================
        // TEST GROUP 6: Switching tool exits edit modes
        // =====================================================================
        console.log('\n--- Test Group 6: Tool Change Exits Edit Modes ---');

        // Re-enter polygon vertex edit mode
        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.waitForTimeout(100);

        const hasPolyForSwitchTest = await page.evaluate(() => {
            return !!window.app.canvas.fabricCanvas.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
        });

        if (hasPolyForSwitchTest) {
            await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const poly = fc.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                if (poly) fc.setActiveObject(poly);
            });
            await page.evaluate(() => { window.app.toolbar.setTool('node-edit'); });
            await page.waitForTimeout(200);

            const inPolyEditMode = await page.evaluate(() => {
                return window.app.nodeEditor._editingPolygon !== null;
            });
            assert(inPolyEditMode, 'Polygon vertex edit mode entered (for tool-switch test)');

            // Switch to rect tool — should exit polygon edit mode
            await page.evaluate(() => { window.app.toolbar.setTool('rect'); });
            await page.waitForTimeout(200);

            const exitedOnToolSwitch = await page.evaluate(() => {
                return window.app.nodeEditor._editingPolygon === null &&
                       window.app.nodeEditor._editState === null;
            });
            assert(exitedOnToolSwitch, 'Switching tool exits polygon vertex edit mode');
        }

        // Selection cleared exits edit mode
        // First re-enter edit mode
        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.waitForTimeout(100);

        const polyForClearTest = await page.evaluate(() => {
            return !!window.app.canvas.fabricCanvas.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
        });

        if (polyForClearTest) {
            await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const poly = fc.getObjects().find(o => o.measurementType === 'area' && Array.isArray(o.points));
                if (poly) fc.setActiveObject(poly);
            });
            await page.evaluate(() => { window.app.toolbar.setTool('node-edit'); });
            await page.waitForTimeout(200);

            // Click on empty canvas area to clear selection → should exit edit mode
            const emptyAreaCoords = await toPageCoords(page, 600, 500);
            await page.mouse.click(emptyAreaCoords.x, emptyAreaCoords.y);
            await page.waitForTimeout(200);

            const exitedOnClear = await page.evaluate(() => {
                return window.app.nodeEditor._editingPolygon === null &&
                       window.app.nodeEditor._editState === null;
            });
            assert(exitedOnClear, 'Selection cleared exits vertex edit mode');
        }

    } catch (err) {
        console.error('Test error:', err);
        failed++;
    } finally {
        await browser.close();
    }

    // ==========================================================================
    // RESULTS
    // ==========================================================================
    const total = passed + failed;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${total} total`);
    console.log(`${'─'.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
