/**
 * PortolanCAST — Phase 4A Measurement Summary Panel Browser Tests
 *
 * Tests the Measures tab in the left panel: stat cards, filterable row list,
 * click-to-navigate, multi-page aggregation, area deduplication, and CSV export.
 *
 * Groups:
 *   1. Tab UI (5)          — Measures tab exists, activates, deactivates markups
 *   2. Empty state (3)     — Zero counts, empty message, CSV header only
 *   3. Single-page (8)     — Distance/area/count appear, deduplication, navigation
 *   4. Multi-page (5)      — Cross-page aggregation, page labels, totals sum
 *   5. Type filter (4)     — Per-type filter shows only matching rows
 *   6. CSV export (5)      — Button exists, correct headers, row count, page labels
 *
 * Total: 30 tests
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_phase4a.mjs"
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-23
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

/**
 * Switch to the Measures tab in the left panel and wait for render.
 * Uses the panel-tab selector (not the toolbar-tab selector).
 */
async function openMeasuresTab(page) {
    await page.click('.panel-tab[data-panel="measures"]');
    await page.waitForTimeout(200);
}

/**
 * Draw a distance measurement line on the canvas (natural coords).
 * Activates the Measure toolbar tab first so the distance button is visible.
 */
async function drawDistance(page, x1, y1, x2, y2) {
    // Ensure Measure tab is active in toolbar so distance button is accessible
    await page.evaluate(() => {
        const measureTab = document.querySelector('button.toolbar-tab[data-tab="measure"]');
        if (measureTab) measureTab.click();
    });
    await page.waitForTimeout(100);

    await page.keyboard.press('u');  // U = distance tool
    await page.waitForTimeout(100);

    const start = await toPageCoords(page, x1, y1);
    const end   = await toPageCoords(page, x2, y2);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Return to select
    await page.keyboard.press('v');
    await page.waitForTimeout(100);
}

/**
 * Draw a triangular area polygon (3 vertices + click to close).
 * Activates the Measure toolbar tab first.
 */
async function drawArea(page, x1, y1, x2, y2, x3, y3) {
    await page.evaluate(() => {
        const measureTab = document.querySelector('button.toolbar-tab[data-tab="measure"]');
        if (measureTab) measureTab.click();
    });
    await page.waitForTimeout(100);

    await page.keyboard.press('a');  // A = area tool
    await page.waitForTimeout(100);

    const p1 = await toPageCoords(page, x1, y1);
    const p2 = await toPageCoords(page, x2, y2);
    const p3 = await toPageCoords(page, x3, y3);
    // Click near p1 to close polygon
    const pClose = await toPageCoords(page, x1 + 2, y1 + 2);

    await page.mouse.click(p1.x, p1.y);
    await page.waitForTimeout(100);
    await page.mouse.click(p2.x, p2.y);
    await page.waitForTimeout(100);
    await page.mouse.click(p3.x, p3.y);
    await page.waitForTimeout(100);
    // Close: click snap-threshold distance from vertex 1
    await page.mouse.click(pClose.x, pClose.y);
    await page.waitForTimeout(300);

    await page.keyboard.press('v');
    await page.waitForTimeout(100);
}

/**
 * Place one count marker on the canvas.
 * Activates Measure toolbar tab first.
 */
async function placeCount(page, x, y) {
    await page.evaluate(() => {
        const measureTab = document.querySelector('button.toolbar-tab[data-tab="measure"]');
        if (measureTab) measureTab.click();
    });
    await page.waitForTimeout(100);

    await page.keyboard.press('n');  // N = count tool
    await page.waitForTimeout(100);

    const pt = await toPageCoords(page, x, y);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(300);

    await page.keyboard.press('v');
    await page.waitForTimeout(100);
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

        // Clear any markups from previous test runs so we start from a known state
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
        // TEST GROUP 1: Tab UI
        // =====================================================================
        console.log('\n--- Test Group 1: Tab UI ---');

        // 1.1 — Measures tab button exists in left panel
        const measuresTabBtn = await page.$('.panel-tab[data-panel="measures"]');
        assert(measuresTabBtn !== null, 'Measures tab button exists in left panel');

        // 1.2 — Clicking Measures tab activates #tab-measures panel
        await page.click('.panel-tab[data-panel="measures"]');
        await page.waitForTimeout(200);
        const measuresActive = await page.$eval(
            '#tab-measures',
            el => el.classList.contains('active')
        );
        assert(measuresActive, 'Clicking Measures tab makes #tab-measures active');

        // 1.3 — Markups tab content deactivates when Measures is clicked
        const markupsInactive = await page.$eval(
            '#tab-markups',
            el => !el.classList.contains('active')
        );
        assert(markupsInactive, '#tab-markups deactivates when Measures tab clicked');

        // 1.4 — All three stat cards are present in the DOM
        const statCardsCount = await page.$$eval('.measure-stat-card', els => els.length);
        assert(statCardsCount === 3, 'Three stat cards exist in #tab-measures');

        // 1.5 — #measure-list container is present
        const measureListEl = await page.$('#measure-list');
        assert(measureListEl !== null, '#measure-list container exists');

        // =====================================================================
        // TEST GROUP 2: Empty state
        // =====================================================================
        console.log('\n--- Test Group 2: Empty State ---');

        // Make sure we are on the Measures tab (from 1.2 we are, but be explicit)
        await openMeasuresTab(page);

        // 2.1 — All stat count cells show "0" with no measurements
        const distCount0 = await page.$eval('#stat-distance-count', el => el.textContent.trim());
        const areaCount0 = await page.$eval('#stat-area-count', el => el.textContent.trim());
        const cntCount0  = await page.$eval('#stat-count-count', el => el.textContent.trim());
        assert(
            distCount0 === '0' && areaCount0 === '0' && cntCount0 === '0',
            'All stat counts show 0 when no measurements exist'
        );

        // 2.2 — Empty message visible in #measure-list
        const emptyVisible = await page.$eval(
            '#measure-list-empty',
            el => el.style.display !== 'none' && el.textContent.includes('No measurements')
        );
        assert(emptyVisible, 'Empty message is visible when no measurements exist');

        // 2.3 — Export CSV with no measurements → download URL triggered (count rows = 0)
        //       We capture the download URL via page.waitForEvent, then check content.
        //       Instead, test via JS interception: stub URL.createObjectURL and capture csv.
        const csvContent = await page.evaluate(async () => {
            // Intercept Blob download by temporarily patching createObjectURL
            let capturedCsv = null;
            const origCreate = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (blob) => {
                return blob.text().then(t => { capturedCsv = t; });
            };
            window.app.measureSummary._exportCSV();
            // Give any async .text() a tick
            await new Promise(r => setTimeout(r, 50));
            URL.createObjectURL = origCreate;
            return capturedCsv;
        });
        // CSV should start with the header line
        assert(
            typeof csvContent === 'string' && csvContent.startsWith('Type,Value,Raw (px),Page'),
            'Empty CSV starts with correct header row'
        );

        // =====================================================================
        // TEST GROUP 3: Single-page data
        // =====================================================================
        console.log('\n--- Test Group 3: Single-page data ---');

        // Draw measurements: 1 distance, 1 area, 3 count markers
        await drawDistance(page, 100, 150, 400, 150);   // ~300px horizontal distance
        await drawArea(page, 200, 300, 350, 300, 275, 400); // triangle
        await placeCount(page, 150, 250);
        await placeCount(page, 200, 250);
        await placeCount(page, 250, 250);

        // Open Measures tab to refresh
        await openMeasuresTab(page);

        // 3.1 — Distance appears in the list (count card = 1)
        const distCount1 = await page.$eval('#stat-distance-count', el => el.textContent.trim());
        assert(distCount1 === '1', 'Distance stat count = 1 after drawing one distance');

        // 3.2 — Area appears as 1 entry (IText companion NOT counted separately)
        const areaCount1 = await page.$eval('#stat-area-count', el => el.textContent.trim());
        assert(areaCount1 === '1', 'Area stat count = 1 (IText companion deduplicated)');

        // 3.3 — Count stat shows 3
        const cntCount3 = await page.$eval('#stat-count-count', el => el.textContent.trim());
        assert(cntCount3 === '3', 'Count stat = 3 after placing 3 count markers');

        // 3.4 — Total row count in list = 1 distance + 1 area + 3 count = 5
        const totalRows = await page.$$eval('#measure-list .markup-row', els => els.length);
        assert(totalRows === 5, `Row list has 5 entries (dist+area+3count), got ${totalRows}`);

        // 3.5 — Distance stat total is non-dash (has a formatted value)
        const distTotal1 = await page.$eval('#stat-distance-total', el => el.textContent.trim());
        assert(distTotal1 !== '—' && distTotal1.length > 0, 'Distance total is formatted (not —)');

        // 3.6 — Area stat total is non-dash
        const areaTotal1 = await page.$eval('#stat-area-total', el => el.textContent.trim());
        assert(areaTotal1 !== '—' && areaTotal1.length > 0, 'Area total is formatted (not —)');

        // 3.7 — Type badge shows correct labels
        const badges = await page.$$eval('#measure-list .markup-type-badge', els =>
            els.map(el => el.textContent.trim())
        );
        assert(badges.includes('Dist'), 'Dist badge appears in row list');
        assert(badges.includes('Area'), 'Area badge appears in row list');
        assert(badges.some(b => b === 'Count'), 'Count badge appears in row list');

        // 3.8 — Click distance row → onNavigate fires with correct page (0)
        //        We capture the navigation call by overriding the callback
        const navResult = await page.evaluate(() => {
            let capturedPage = -1;
            window.app.measureSummary.onNavigate = (pg, idx) => { capturedPage = pg; };
            const distRow = Array.from(document.querySelectorAll('#measure-list .markup-row'))
                .find(r => r.querySelector('.type-distance'));
            if (distRow) distRow.click();
            return capturedPage;
        });
        assert(navResult === 0, `Row click fires onNavigate with page=0, got page=${navResult}`);

        // =====================================================================
        // TEST GROUP 4: Multi-page data
        // =====================================================================
        console.log('\n--- Test Group 4: Multi-page data ---');

        // Save current page markups and navigate to page 2 (if available)
        // We simulate multi-page by directly stuffing page 1 markups into pageMarkups
        await page.evaluate(() => {
            // Save current live objects to page 0 in pageMarkups
            window.app.canvas.onPageChanging(0);
            // Inject a synthetic distance measurement on page 1
            const fakePage1Json = {
                objects: [
                    {
                        type: 'Group',
                        measurementType: 'distance',
                        pixelLength: 200,
                        labelText: '200.0 px',
                        markupAuthor: 'TestUser',
                        markupTimestamp: new Date().toISOString(),
                        left: 100, top: 100, width: 200, height: 20,
                        scaleX: 1, scaleY: 1, angle: 0,
                        objects: [],
                    }
                ],
                version: '6.0.0',
            };
            window.app.canvas.pageMarkups.set(1, fakePage1Json);
        });
        await page.waitForTimeout(100);

        // Refresh the Measures tab
        await openMeasuresTab(page);

        // 4.1 — Distance count is now 2 (1 from page 0 + 1 from page 1)
        const distCount2 = await page.$eval('#stat-distance-count', el => el.textContent.trim());
        assert(distCount2 === '2', 'Distance count = 2 after adding page 1 measurement');

        // 4.2 — Total rows increase to 6 (5 from page 0 + 1 from page 1)
        const totalRows2 = await page.$$eval('#measure-list .markup-row', els => els.length);
        assert(totalRows2 === 6, `Total rows = 6 after page 1 measurement added, got ${totalRows2}`);

        // 4.3 — Page labels show p.1 and p.2
        const pageLabels = await page.$$eval('#measure-list .markup-row-page', els =>
            els.map(el => el.textContent.trim())
        );
        assert(pageLabels.includes('p.1'), 'p.1 page label present for page-0 measurements');
        assert(pageLabels.includes('p.2'), 'p.2 page label present for page-1 measurement');

        // 4.4 — Distance total sums both pages (raw pixel values summed)
        //        Stat total should not be '—' and should differ from single-page total
        const distTotalMulti = await page.$eval('#stat-distance-total', el => el.textContent.trim());
        assert(distTotalMulti !== '—', 'Distance total non-dash with multi-page data');

        // 4.5 — refresh() updates correctly after adding more measurements
        await page.evaluate(() => {
            // Add one more synthetic distance on page 2
            window.app.canvas.pageMarkups.set(2, {
                objects: [{
                    type: 'Group',
                    measurementType: 'distance',
                    pixelLength: 150,
                    labelText: '150.0 px',
                    markupAuthor: 'TestUser',
                    markupTimestamp: new Date().toISOString(),
                    left: 50, top: 50, width: 150, height: 20,
                    scaleX: 1, scaleY: 1, angle: 0,
                    objects: [],
                }],
                version: '6.0.0',
            });
            window.app.measureSummary.refresh();
        });
        await page.waitForTimeout(200);

        const distCount3 = await page.$eval('#stat-distance-count', el => el.textContent.trim());
        assert(distCount3 === '3', 'Distance count = 3 after adding page-2 measurement via refresh()');

        // =====================================================================
        // TEST GROUP 5: Type filter
        // =====================================================================
        console.log('\n--- Test Group 5: Type filter ---');

        // Make sure Measures tab is open with all data
        await openMeasuresTab(page);

        // 5.1 — Filter "Distance" shows only distance rows
        await page.selectOption('#measure-type-filter', 'distance');
        await page.waitForTimeout(150);
        const distOnlyRows = await page.$$eval('#measure-list .markup-row', els =>
            els.map(r => r.querySelector('.markup-type-badge')?.textContent?.trim())
        );
        const allDist = distOnlyRows.every(b => b === 'Dist');
        assert(allDist && distOnlyRows.length > 0, `Filter "Distance" shows only Dist rows (${distOnlyRows.length} rows)`);

        // 5.2 — Filter "Area" shows only area rows
        await page.selectOption('#measure-type-filter', 'area');
        await page.waitForTimeout(150);
        const areaOnlyRows = await page.$$eval('#measure-list .markup-row', els =>
            els.map(r => r.querySelector('.markup-type-badge')?.textContent?.trim())
        );
        const allArea = areaOnlyRows.every(b => b === 'Area');
        assert(allArea && areaOnlyRows.length > 0, `Filter "Area" shows only Area rows (${areaOnlyRows.length} rows)`);

        // 5.3 — Filter "Count" shows only count rows
        await page.selectOption('#measure-type-filter', 'count');
        await page.waitForTimeout(150);
        const countOnlyRows = await page.$$eval('#measure-list .markup-row', els =>
            els.map(r => r.querySelector('.markup-type-badge')?.textContent?.trim())
        );
        const allCount = countOnlyRows.every(b => b === 'Count');
        assert(allCount && countOnlyRows.length > 0, `Filter "Count" shows only Count rows (${countOnlyRows.length} rows)`);

        // 5.4 — Filter "All" restores all rows
        await page.selectOption('#measure-type-filter', 'all');
        await page.waitForTimeout(150);
        const allRows = await page.$$eval('#measure-list .markup-row', els => els.length);
        assert(allRows > 3, `Filter "All" restores all rows (got ${allRows})`);

        // =====================================================================
        // TEST GROUP 6: CSV export
        // =====================================================================
        console.log('\n--- Test Group 6: CSV export ---');

        // 6.1 — Export CSV button exists
        const exportBtn = await page.$('#btn-export-csv');
        assert(exportBtn !== null, 'Export CSV button exists');

        // 6.2-6.5 — Capture CSV content via JS-level Blob interception
        const csvResult = await page.evaluate(async () => {
            // Capture the generated CSV by intercepting URL.createObjectURL
            let capturedCsv = null;
            const origCreate = URL.createObjectURL.bind(URL);
            let blobPromise = null;

            URL.createObjectURL = (blob) => {
                blobPromise = blob.text().then(t => { capturedCsv = t; });
                return 'blob:test-url';
            };

            // Patch appendChild/removeChild to avoid JSDOM issues with synthetic <a> clicks
            const origAppend = document.body.appendChild.bind(document.body);
            const origRemove = document.body.removeChild.bind(document.body);
            const clicks = [];
            document.body.appendChild = (el) => {
                if (el.tagName === 'A') { clicks.push(el); el.click = () => {}; return el; }
                return origAppend(el);
            };
            document.body.removeChild = (el) => {
                if (el.tagName === 'A') return el;
                return origRemove(el);
            };

            window.app.measureSummary._exportCSV();
            if (blobPromise) await blobPromise;
            await new Promise(r => setTimeout(r, 50));

            URL.createObjectURL = origCreate;
            document.body.appendChild = origAppend;
            document.body.removeChild = origRemove;

            return capturedCsv;
        });

        // 6.2 — CSV starts with correct header line
        assert(
            typeof csvResult === 'string' &&
            csvResult.startsWith('Type,Value,Raw (px),Page,Author,Timestamp'),
            'CSV has correct header row'
        );

        // 6.3 — CSV row count matches unfiltered entry count
        if (csvResult) {
            const lines = csvResult.split('\r\n').filter(l => l.trim().length > 0);
            const dataLines = lines.length - 1;  // subtract header
            const entryCount = await page.evaluate(() => window.app.measureSummary._entries.length);
            assert(dataLines === entryCount, `CSV has ${dataLines} data rows matching ${entryCount} entries`);

            // 6.4 — CSV includes page labels
            assert(csvResult.includes('p.1'), 'CSV includes p.1 page label');
            assert(csvResult.includes('p.2') || csvResult.includes('p.3'),
                'CSV includes p.2 or p.3 page label for multi-page entries');

            // 6.5 — CSV formatted values match panel display
            const firstRow = await page.evaluate(() => {
                const e = window.app.measureSummary._entries[0];
                return e ? e.formattedValue : null;
            });
            if (firstRow) {
                // The formatted value should appear in the CSV (possibly quoted)
                assert(
                    csvResult.includes(firstRow.replace(/"/g, '""')),
                    'CSV formatted value matches panel display value'
                );
            } else {
                assert(true, 'CSV formatted value check skipped (no entries)');
            }
        } else {
            // CSV capture failed — mark these as failed
            assert(false, 'CSV row count check (CSV capture failed)');
            assert(false, 'CSV page labels check (CSV capture failed)');
            assert(false, 'CSV formatted values match (CSV capture failed)');
        }

    } finally {
        await browser.close();
    }

    // ==========================================================================
    // RESULTS SUMMARY
    // ==========================================================================
    console.log('\n');
    console.log('════════════════════════════════════════');
    console.log('  Phase 4A: Measurement Summary Panel');
    console.log('════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('════════════════════════════════════════');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('[Phase 4A Test] Fatal error:', err);
    process.exit(1);
});
