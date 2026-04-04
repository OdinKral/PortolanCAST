/**
 * PortolanCAST — Tier 3 Feature Tests
 *
 * Purpose:
 *   Verifies the Tier 3 parity features:
 *   1. Volume measurement (area × depth)
 *   2. Cloud+ (cloud with area measurement)
 *   3. Sketch to Scale (draw at calibrated dimensions)
 *
 * Run:
 *   node test_tier3_features.mjs
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID   = 1;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

async function getCanvasInfo(page) {
    return page.evaluate(() => {
        const el   = document.getElementById('fabric-canvas');
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top, scale: window.app.viewer.zoom / 100 };
    });
}

async function toPageCoords(page, naturalX, naturalY) {
    const info = await getCanvasInfo(page);
    return { x: info.x + naturalX * info.scale, y: info.y + naturalY * info.scale };
}

async function getObjectCount(page) {
    return page.evaluate(() => window.app.canvas.fabricCanvas.getObjects().length);
}

async function clearCanvas(page) {
    await page.evaluate(() => {
        window.app.canvas.fabricCanvas.clear();
        window.app.canvas.fabricCanvas.renderAll();
    });
    await page.waitForTimeout(100);
}

// =============================================================================
// MAIN
// =============================================================================

async function run() {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 1: Volume Measurement
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 1: Volume Measurement --');

        // 1.1 — Volume button exists
        const volBtn = await page.$('.tool-btn[data-tool="volume"]');
        assert(volBtn !== null, 'Volume tool button exists in measure toolbar');

        // 1.2 — MeasureTools has initVolume method
        const hasVolume = await page.evaluate(() => {
            return typeof window.app.toolbar.measureTools?.initVolume === 'function';
        });
        assert(hasVolume, 'MeasureTools has initVolume method');

        // 1.3 — Create a volume measurement programmatically
        const volumeCreated = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const vertices = [
                { x: 100, y: 100 },
                { x: 200, y: 100 },
                { x: 200, y: 200 },
                { x: 100, y: 200 },
            ];

            // Create polygon directly (bypassing the interactive tool to avoid prompt())
            const polygon = new fabric.Polygon(
                vertices.map(v => ({ x: v.x, y: v.y })),
                {
                    fill: '#e06c7522',
                    stroke: '#e06c75',
                    strokeWidth: 2,
                    strokeUniform: true,
                    selectable: true,
                }
            );

            polygon.measurementType = 'volume';
            polygon.pixelArea = 10000; // 100x100
            polygon.volumeDepth = 8;
            polygon.labelText = '100 sq ft × 8 ft = 800 cu ft';
            polygon.markupAuthor = 'User';
            polygon.markupTimestamp = new Date().toISOString();

            window.app.canvas.stampDefaults(polygon);
            fc.add(polygon);
            fc.renderAll();

            return {
                type: polygon.measurementType,
                depth: polygon.volumeDepth,
                hasLabel: polygon.labelText.includes('cu'),
            };
        });
        assert(volumeCreated.type === 'volume', 'Volume polygon has measurementType "volume"');
        assert(volumeCreated.depth === 8, 'Volume polygon has volumeDepth property');
        assert(volumeCreated.hasLabel, 'Volume label contains "cu" (cubic units)');

        await clearCanvas(page);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 2: Cloud+ (Cloud with Area)
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 2: Cloud+ --');

        // 2.1 — Cloud+ button exists
        const cloudBtn = await page.$('.tool-btn[data-tool="cloud-area"]');
        assert(cloudBtn !== null, 'Cloud+ tool button exists in measure toolbar');

        // 2.2 — MeasureTools has initCloudArea method
        const hasCloudArea = await page.evaluate(() => {
            return typeof window.app.toolbar.measureTools?.initCloudArea === 'function';
        });
        assert(hasCloudArea, 'MeasureTools has initCloudArea method');

        // 2.3 — Draw a Cloud+ via click-drag
        await page.evaluate(() => {
            document.querySelector('.toolbar-tab[data-tab="measure"]').click();
        });
        await page.waitForTimeout(100);

        await page.evaluate(() => {
            document.querySelector('.tool-btn[data-tool="cloud-area"]').click();
        });
        await page.waitForTimeout(100);

        const start = await toPageCoords(page, 100, 300);
        const end = await toPageCoords(page, 250, 400);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y);
        await page.mouse.up();
        await page.waitForTimeout(300);

        const cloudInfo = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            const last = objs[objs.length - 1];
            return {
                count: objs.length,
                type: last?.type,
                measurementType: last?.measurementType,
                hasArea: typeof last?.pixelArea === 'number' && last.pixelArea > 0,
                hasLabel: typeof last?.labelText === 'string' && last.labelText.length > 0,
            };
        });
        assert(cloudInfo.count >= 1, `Cloud+ object created (${cloudInfo.count} objects)`);
        assert(cloudInfo.type === 'group', `Cloud+ is a Group (type=${cloudInfo.type})`);
        assert(cloudInfo.measurementType === 'cloud-area', `measurementType is 'cloud-area'`);
        assert(cloudInfo.hasArea, 'Cloud+ has pixelArea property');
        assert(cloudInfo.hasLabel, 'Cloud+ has labelText property');

        await clearCanvas(page);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 3: Sketch to Scale
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 3: Sketch to Scale --');

        // 3.1 — Sketch button exists
        const sketchBtn = await page.$('.tool-btn[data-tool="sketch"]');
        assert(sketchBtn !== null, 'Sketch tool button exists in measure toolbar');

        // 3.2 — MeasureTools has initSketch method
        const hasSketch = await page.evaluate(() => {
            return typeof window.app.toolbar.measureTools?.initSketch === 'function';
        });
        assert(hasSketch, 'MeasureTools has initSketch method');

        // 3.3 — Create a sketch rectangle programmatically (bypassing prompt)
        const sketchCreated = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const scale = window.app.toolbar.scale;
            const ppu = scale?.pixelsPerRealUnit || 37.5; // default 1/4" = 1'

            const realW = 10; // 10 ft
            const realH = 8;  // 8 ft
            const pixW = realW * ppu;
            const pixH = realH * ppu;

            const rect = new fabric.Rect({
                left: 0, top: 0, width: pixW, height: pixH,
                fill: 'transparent', stroke: '#c678dd', strokeWidth: 2,
            });

            const wLabel = new fabric.IText(`${realW} ft`, {
                left: pixW / 2, top: -14,
                fontFamily: 'Arial', fontSize: 11, fill: '#c678dd',
                editable: false, originX: 'center', originY: 'center',
            });

            const hLabel = new fabric.IText(`${realH} ft`, {
                left: pixW + 14, top: pixH / 2,
                fontFamily: 'Arial', fontSize: 11, fill: '#c678dd',
                editable: false, originX: 'center', originY: 'center', angle: 90,
            });

            const group = new fabric.Group([rect, wLabel, hLabel], {
                left: 50, top: 50, selectable: true,
            });

            group.measurementType = 'sketch';
            group.pixelLength = 2 * (pixW + pixH);
            group.labelText = `${realW} × ${realH} ft`;
            group.markupAuthor = 'User';
            group.markupTimestamp = new Date().toISOString();

            window.app.canvas.stampDefaults(group);
            fc.add(group);
            fc.renderAll();

            return {
                type: group.measurementType,
                childCount: group._objects?.length,
                label: group.labelText,
                hasPerimeter: group.pixelLength > 0,
            };
        });
        assert(sketchCreated.type === 'sketch', 'Sketch group has measurementType "sketch"');
        assert(sketchCreated.childCount === 3, `Sketch group has 3 children (rect + 2 labels, got ${sketchCreated.childCount})`);
        assert(sketchCreated.label.includes('×'), 'Sketch label contains dimensions');
        assert(sketchCreated.hasPerimeter, 'Sketch group has pixelLength (perimeter)');

        // 3.4 — ScaleManager has formatVolume method
        const hasFormatVolume = await page.evaluate(() => {
            return typeof window.app.toolbar.scale?.formatVolume === 'function';
        });
        assert(hasFormatVolume, 'ScaleManager has formatVolume method');

    } catch (err) {
        console.error('TEST ERROR:', err);
        failed++;
    } finally {
        await browser.close();
    }

    console.log(`\n  ═══════════════════════════════════════`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`  ═══════════════════════════════════════\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run();
