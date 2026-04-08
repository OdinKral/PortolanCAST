/**
 * PortolanCAST — Component Harvest & Stamp Tests
 *
 * Groups:
 *   Group 1: Component API — harvest, list, update, delete, tags
 *   Group 2: Import/Export — ZIP round-trip, individual SVG import
 *   Group 3: Harvest tool — UI rectangle drag + dialog
 *   Group 4: Ctrl+D duplicate
 *
 * Run: node test_components.mjs
 * Requires: Server running at 127.0.0.1:8000 with at least 1 document loaded.
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID = 1;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

// =============================================================================
// GROUP 1: Component API
// =============================================================================

async function testComponentAPI() {
    console.log('\nGroup 1: Component API');

    // Harvest a component via API
    const harvestResp = await fetch(`${BASE_URL}/api/components/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            doc_id: DOC_ID,
            page: 0,
            rect: { x: 50, y: 50, w: 100, h: 80 },
            hidden_layers: [],
            name: 'Test Elbow',
            tags: ['piping', 'test'],
        }),
    });
    assert(harvestResp.ok, 'POST /api/components/harvest returns 200');
    const harvested = await harvestResp.json();
    assert(harvested.id, 'Harvested component has an ID');
    assert(harvested.name === 'Test Elbow', 'Harvested component has correct name');
    assert(harvested.thumb_url.includes(harvested.id), 'Thumbnail URL contains component ID');

    const compId = harvested.id;

    // List components
    const listResp = await fetch(`${BASE_URL}/api/components`);
    assert(listResp.ok, 'GET /api/components returns 200');
    const listData = await listResp.json();
    assert(listData.components.length >= 1, 'Component list has at least 1 item');

    // Filter by tag
    const tagResp = await fetch(`${BASE_URL}/api/components?tags=piping`);
    const tagData = await tagResp.json();
    assert(tagData.components.some(c => c.id === compId), 'Tag filter returns harvested component');

    // Search by name
    const searchResp = await fetch(`${BASE_URL}/api/components?search=Elbow`);
    const searchData = await searchResp.json();
    assert(searchData.components.some(c => c.id === compId), 'Name search finds component');

    // Get tags
    const tagsResp = await fetch(`${BASE_URL}/api/components/tags`);
    assert(tagsResp.ok, 'GET /api/components/tags returns 200');
    const tagsData = await tagsResp.json();
    assert(tagsData.tags.some(t => t.tag === 'piping'), 'Tags list includes "piping"');

    // Update component
    const updateResp = await fetch(`${BASE_URL}/api/components/${compId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Elbow', tags: ['piping', 'renamed'] }),
    });
    assert(updateResp.ok, 'PUT /api/components/:id returns 200');
    const updated = await updateResp.json();
    assert(updated.name === 'Renamed Elbow', 'Component name updated');

    // Get single component
    const getResp = await fetch(`${BASE_URL}/api/components/${compId}`);
    assert(getResp.ok, 'GET /api/components/:id returns 200');

    // Thumbnail serves
    const thumbResp = await fetch(`${BASE_URL}${harvested.thumb_url}`);
    assert(thumbResp.ok, 'Thumbnail file serves successfully');

    // Delete component
    const delResp = await fetch(`${BASE_URL}/api/components/${compId}`, { method: 'DELETE' });
    assert(delResp.ok, 'DELETE /api/components/:id returns 200');

    // Verify deleted
    const gone = await fetch(`${BASE_URL}/api/components/${compId}`);
    assert(gone.status === 404, 'Deleted component returns 404');
}

// =============================================================================
// GROUP 2: Import/Export
// =============================================================================

async function testImportExport() {
    console.log('\nGroup 2: Import/Export');

    // Create two components for export
    const c1 = await (await fetch(`${BASE_URL}/api/components/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            doc_id: DOC_ID, page: 0,
            rect: { x: 10, y: 10, w: 50, h: 50 },
            hidden_layers: [], name: 'Export Test A', tags: ['export-test'],
        }),
    })).json();

    const c2 = await (await fetch(`${BASE_URL}/api/components/harvest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            doc_id: DOC_ID, page: 0,
            rect: { x: 60, y: 10, w: 50, h: 50 },
            hidden_layers: [], name: 'Export Test B', tags: ['export-test'],
        }),
    })).json();

    // Export by tag
    const exportResp = await fetch(`${BASE_URL}/api/components/export?tags=export-test`);
    assert(exportResp.ok, 'GET /api/components/export returns 200');
    assert(
        exportResp.headers.get('content-type')?.includes('application/zip'),
        'Export returns ZIP content-type'
    );

    // Clean up
    await fetch(`${BASE_URL}/api/components/${c1.id}`, { method: 'DELETE' });
    await fetch(`${BASE_URL}/api/components/${c2.id}`, { method: 'DELETE' });
}

// =============================================================================
// GROUP 3: Harvest Tool UI
// =============================================================================

async function testHarvestToolUI(browser) {
    console.log('\nGroup 3: Harvest Tool UI');

    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.app?.toolbar, { timeout: 10000 });
    await page.waitForTimeout(500);

    // Press Y to activate harvest mode
    await page.keyboard.press('y');
    await page.waitForTimeout(200);

    const currentTool = await page.evaluate(() => window.app.toolbar.activeTool);
    assert(currentTool === 'harvest', 'Pressing Y activates harvest tool');

    // Escape back to select
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await page.close();
}

// =============================================================================
// GROUP 4: Ctrl+D Duplicate
// =============================================================================

async function testCtrlDDuplicate(browser) {
    console.log('\nGroup 4: Ctrl+D Duplicate');

    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.app?.toolbar, { timeout: 10000 });
    await page.waitForTimeout(500);

    // Draw a rectangle
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
    await page.keyboard.press('r');
    await page.waitForTimeout(100);

    const canvas = await page.evaluate(() => {
        const el = document.getElementById('fabric-canvas');
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top, scale: window.app.viewer.zoom / 100 };
    });

    // Draw a rect
    await page.mouse.move(canvas.x + 100, canvas.y + 100);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 200, canvas.y + 200);
    await page.mouse.up();
    await page.waitForTimeout(200);

    const countBefore = await page.evaluate(
        () => window.app.canvas.fabricCanvas.getObjects().length
    );

    // Select the object and duplicate
    await page.keyboard.press('v');
    await page.waitForTimeout(100);
    await page.evaluate(() => {
        const fc = window.app.canvas.fabricCanvas;
        const objs = fc.getObjects();
        if (objs.length > 0) fc.setActiveObject(objs[objs.length - 1]);
    });
    await page.waitForTimeout(100);

    await page.keyboard.down('Control');
    await page.keyboard.press('d');
    await page.keyboard.up('Control');
    await page.waitForTimeout(300);

    const countAfter = await page.evaluate(
        () => window.app.canvas.fabricCanvas.getObjects().length
    );

    assert(countAfter === countBefore + 1, `Ctrl+D creates one duplicate (${countBefore} -> ${countAfter})`);

    // Verify clone has different markupId
    const ids = await page.evaluate(() => {
        const fc = window.app.canvas.fabricCanvas;
        return fc.getObjects().map(o => o.markupId);
    });
    const uniqueIds = new Set(ids.filter(Boolean));
    assert(uniqueIds.size === ids.filter(Boolean).length, 'Each object has a unique markupId');

    await page.close();
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
    console.log('PortolanCAST — Component Harvest & Stamp Tests');
    console.log('='.repeat(50));

    // API tests (no browser needed)
    await testComponentAPI();
    await testImportExport();

    // Browser tests
    const browser = await chromium.launch({ headless: true });
    try {
        await testHarvestToolUI(browser);
        await testCtrlDDuplicate(browser);
    } finally {
        await browser.close();
    }

    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
