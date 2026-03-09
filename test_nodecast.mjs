/**
 * PortolanCAST — nodeCAST Plugin Tests
 *
 * Verifies the nodeCAST force-directed graph plugin:
 *   1. "Graph" tab button injected into right panel.
 *   2. Clicking the tab shows the plugin container.
 *   3. Status text visible and contains markup/tag counts.
 *   4. No markups → SVG hidden, empty-state message shown.
 *   5. After placing one markup + Refresh → SVG visible, 1 markup node exists.
 *   6. Markup with #tag → both markup node and tag node appear in SVG.
 *   7. Two markups sharing the same #tag → only one tag node (shared).
 *   8. Click markup node in SVG → corresponding Fabric object becomes active.
 *   9. onObjectSelected → markup node gets highlight style (thicker stroke).
 *  10. onObjectDeselected → highlight cleared (stroke-width returns to 1.5).
 *  11. _parseTags extracts lowercase #tags from markupNote correctly.
 *  12. Graph rebuilt when the user navigates to another page (onPageChanged).
 *  13. All Pages toggle button exists, switches label and adds active CSS class.
 *  14. In All Pages mode, markups appear from serialized canvas data.
 *  15. Toggling back to This Page restores default label, removes active class.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_nodecast.mjs"
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

// =============================================================================
// COORDINATE + CANVAS HELPERS
// =============================================================================

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

// =============================================================================
// SETUP HELPERS
// =============================================================================

/** Open the markup toolbar tab. */
async function openMarkupTab(page) {
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
}

/**
 * Place a rectangular markup on the canvas at the given natural coords.
 * Returns after the object is confirmed on the canvas.
 */
async function placeRect(page, x1, y1, x2, y2) {
    await page.keyboard.press('v');
    await page.waitForTimeout(50);
    await openMarkupTab(page);
    await page.click('.tool-btn[data-tool="rect"]');
    await page.waitForTimeout(50);

    const start = await toPageCoords(page, x1, y1);
    const end   = await toPageCoords(page, x2, y2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
}

/**
 * Open the Graph (nodeCAST) tab in the right panel.
 * The panel-tab button text is "Graph".
 */
async function openGraphTab(page) {
    await page.evaluate(() => {
        const tabs = document.querySelectorAll('#right-panel-tabs .panel-tab');
        for (const t of tabs) {
            if (t.textContent.trim() === 'Graph') { t.click(); return; }
        }
    });
    await page.waitForTimeout(100);
}

/**
 * Click the Refresh button inside the nodeCAST panel.
 */
async function clickRefresh(page) {
    await page.evaluate(() => {
        document.querySelector('#nc-refresh')?.click();
    });
    await page.waitForTimeout(200);
}

// =============================================================================
// MAIN TEST RUNNER
// =============================================================================

async function run() {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear any markups left by previous test runs
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

        // ── Group 1: Tab injection ─────────────────────────────────────────────
        console.log('\n  -- Group 1: Graph Tab Injection --');

        const graphTabExists = await page.evaluate(() => {
            const tabs = document.querySelectorAll('#right-panel-tabs .panel-tab');
            return [...tabs].some(t => t.textContent.trim() === 'Graph');
        });
        assert(graphTabExists, 'Graph tab button injected into right panel');

        const containerExists = await page.evaluate(() =>
            !!document.getElementById('tab-plugin-nodecast')
        );
        assert(containerExists, '#tab-plugin-nodecast container div exists');

        // ── Group 2: Tab switching ─────────────────────────────────────────────
        console.log('\n  -- Group 2: Tab Switching --');

        await openGraphTab(page);

        const containerActive = await page.evaluate(() =>
            document.getElementById('tab-plugin-nodecast')?.classList.contains('active')
        );
        assert(containerActive, 'Clicking Graph tab activates plugin container');

        const svgExists = await page.evaluate(() =>
            !!document.getElementById('nc-svg')
        );
        assert(svgExists, '<svg id="nc-svg"> rendered inside plugin container');

        const statusExists = await page.evaluate(() =>
            !!document.getElementById('nc-status')
        );
        assert(statusExists, 'Status text element #nc-status exists');

        // ── Group 3: Empty state (no markups) ─────────────────────────────────
        console.log('\n  -- Group 3: Empty State --');

        // Trigger a graph rebuild with zero markups
        await clickRefresh(page);

        const svgHidden = await page.evaluate(() =>
            document.getElementById('nc-svg')?.style.display === 'none'
        );
        assert(svgHidden, 'SVG is hidden when no markups exist');

        const emptyVisible = await page.evaluate(() => {
            const el = document.getElementById('nc-empty');
            return el && el.style.display !== 'none';
        });
        assert(emptyVisible, 'Empty-state div shown when no markups exist');

        const emptyText = await page.evaluate(() =>
            document.getElementById('nc-empty')?.textContent?.trim() || ''
        );
        assert(emptyText.toLowerCase().includes('markup'),
            `Empty state mentions "markup" (got "${emptyText}")`);

        // ── Group 4: Single markup node ────────────────────────────────────────
        console.log('\n  -- Group 4: Single Markup Node --');

        // Place one rectangle (no note, no tags)
        await placeRect(page, 100, 100, 200, 160);

        await clickRefresh(page);

        const svgVisible = await page.evaluate(() =>
            document.getElementById('nc-svg')?.style.display !== 'none'
        );
        assert(svgVisible, 'SVG visible after placing one markup + Refresh');

        const markupNodeCount = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-markup-id]').length
        );
        assert(markupNodeCount === 1,
            `Exactly 1 markup node in SVG (got ${markupNodeCount})`);

        const tagNodeCount0 = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-tag-id]').length
        );
        assert(tagNodeCount0 === 0,
            `0 tag nodes when markup has no #tags (got ${tagNodeCount0})`);

        const statusText4 = await page.evaluate(() =>
            document.getElementById('nc-status')?.textContent?.trim() || ''
        );
        assert(statusText4.includes('1 markup'),
            `Status shows "1 markup" (got "${statusText4}")`);
        assert(statusText4.includes('0 tags'),
            `Status shows "0 tags" (got "${statusText4}")`);

        // ── Group 5: Markup with #tag produces both node types ─────────────────
        console.log('\n  -- Group 5: Markup with #tag --');

        // Set markupNote on the existing rect to include a tag
        await page.evaluate(() => {
            const fc   = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects().filter(o => !!o.markupType);
            if (objs[0]) {
                objs[0].set('markupNote', 'Needs review #electrical');
                fc.renderAll();
            }
        });

        await clickRefresh(page);

        const markupNodes5 = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-markup-id]').length
        );
        assert(markupNodes5 === 1,
            `Still 1 markup node after adding #tag (got ${markupNodes5})`);

        const tagNodes5 = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-tag-id]').length
        );
        assert(tagNodes5 === 1,
            `1 tag node for #electrical (got ${tagNodes5})`);

        const edgeCount5 = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg line').length
        );
        assert(edgeCount5 === 1,
            `1 edge line connecting markup to tag (got ${edgeCount5})`);

        const statusText5 = await page.evaluate(() =>
            document.getElementById('nc-status')?.textContent?.trim() || ''
        );
        assert(statusText5.includes('1 tag'),
            `Status shows "1 tag" (got "${statusText5}")`);

        // ── Group 6: Two markups sharing one tag → single shared tag node ──────
        console.log('\n  -- Group 6: Shared Tag Node --');

        // Place a second rect and give it the same tag
        await placeRect(page, 250, 100, 350, 160);
        await page.evaluate(() => {
            const fc   = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects().filter(o => !!o.markupType);
            if (objs[1]) {
                objs[1].set('markupNote', 'Check load path #electrical');
                fc.renderAll();
            }
        });

        await clickRefresh(page);

        const markupNodes6 = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-markup-id]').length
        );
        assert(markupNodes6 === 2,
            `2 markup nodes for 2 markups (got ${markupNodes6})`);

        const tagNodes6 = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-tag-id]').length
        );
        assert(tagNodes6 === 1,
            `Still 1 tag node — shared between both markups (got ${tagNodes6})`);

        const edgeCount6 = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg line').length
        );
        assert(edgeCount6 === 2,
            `2 edges — each markup connected to shared #electrical (got ${edgeCount6})`);

        // ── Group 7: Click markup node selects Fabric object ───────────────────
        console.log('\n  -- Group 7: Click Node Selects Fabric Object --');

        // Collect both markup node IDs from the SVG
        const markupIds = await page.evaluate(() =>
            [...document.querySelectorAll('#nc-svg circle[data-markup-id]')]
                .map(c => c.getAttribute('data-markup-id'))
        );
        assert(markupIds.length === 2, `Two markup-id circles found (got ${markupIds.length})`);

        const firstMarkupId  = markupIds[0];
        const secondMarkupId = markupIds[1];

        // Establish a known baseline: select the SECOND markup on canvas.
        // Then clicking the FIRST markup's SVG node must change the selection.
        // This avoids relying on discardActiveObject() for pre-condition setup.
        await page.evaluate((id) => {
            const fc  = window.app.canvas.fabricCanvas;
            const obj = fc.getObjects().find(o => o.markupId === id);
            if (obj) { fc.setActiveObject(obj); fc.renderAll(); }
        }, secondMarkupId);
        await page.waitForTimeout(100);

        const baselineId = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getActiveObject()?.markupId || null
        );
        assert(baselineId === secondMarkupId,
            `Baseline: second markup selected on canvas (got "${baselineId}")`);

        // Now click the FIRST markup's SVG node — should change selection.
        // SVGCircleElement does not inherit HTMLElement.click(), so we dispatch
        // a MouseEvent manually (the same as a real user mouse click).
        await page.evaluate((id) => {
            const circle = document.querySelector(`#nc-svg circle[data-markup-id="${id}"]`);
            if (circle) circle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }, firstMarkupId);
        await page.waitForTimeout(200);

        const selectedId = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getActiveObject()?.markupId || null
        );
        assert(selectedId === firstMarkupId,
            `Clicking first node switches selection from second → first (got "${selectedId}")`);

        // ── Group 8: onObjectSelected → node highlight ─────────────────────────
        console.log('\n  -- Group 8: onObjectSelected → Node Highlight --');

        // The selection:created event fires → plugins.emit → onObjectSelected
        // The click in Group 7 should have already triggered highlighting.
        const highlightStroke = await page.evaluate((id) => {
            const c = document.querySelector(`#nc-svg circle[data-markup-id="${id}"]`);
            return c ? c.getAttribute('stroke-width') : null;
        }, firstMarkupId);
        assert(highlightStroke === '3',
            `Selected markup node has stroke-width="3" (got "${highlightStroke}")`);

        const hasGlow = await page.evaluate((id) => {
            const c = document.querySelector(`#nc-svg circle[data-markup-id="${id}"]`);
            return c ? c.style.filter.includes('drop-shadow') : false;
        }, firstMarkupId);
        assert(hasGlow, 'Selected markup node has drop-shadow filter applied');

        // ── Group 9: onObjectDeselected → highlight cleared ────────────────────
        console.log('\n  -- Group 9: onObjectDeselected → Highlight Cleared --');

        // Deselect by pressing Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        const afterDeselect = await page.evaluate((id) => {
            const c = document.querySelector(`#nc-svg circle[data-markup-id="${id}"]`);
            if (!c) return null;
            return {
                strokeWidth: c.getAttribute('stroke-width'),
                filter:      c.style.filter,
            };
        }, firstMarkupId);
        assert(afterDeselect?.strokeWidth === '1.5',
            `Deselected node stroke-width returns to 1.5 (got "${afterDeselect?.strokeWidth}")`);
        assert(!afterDeselect?.filter,
            `Deselected node filter cleared (got "${afterDeselect?.filter}")`);

        // ── Group 10: _parseTags extracts tags correctly ───────────────────────
        console.log('\n  -- Group 10: _parseTags Logic --');

        const parsedTags = await page.evaluate(() => {
            const plugin = window.app.plugins.plugins.get('nodecast');
            if (!plugin) return null;
            return {
                basic:     plugin._parseTags('Check the beam #structural'),
                multi:     plugin._parseTags('#urgent fix this #safety issue'),
                noTags:    plugin._parseTags('No tags here'),
                caseNorm:  plugin._parseTags('#UPPERCASE #MixedCase'),
                empty:     plugin._parseTags(''),
                nullSafe:  plugin._parseTags(null),
            };
        });

        assert(parsedTags !== null, 'nodeCAST plugin accessible via window.app.plugins');
        assert(JSON.stringify(parsedTags?.basic) === JSON.stringify(['#structural']),
            `Single tag extracted (got ${JSON.stringify(parsedTags?.basic)})`);
        assert(JSON.stringify(parsedTags?.multi) === JSON.stringify(['#urgent', '#safety']),
            `Two tags extracted (got ${JSON.stringify(parsedTags?.multi)})`);
        assert(parsedTags?.noTags?.length === 0,
            `No tags returns empty array (got ${JSON.stringify(parsedTags?.noTags)})`);
        assert(
            JSON.stringify(parsedTags?.caseNorm) === JSON.stringify(['#uppercase', '#mixedcase']),
            `Tags lowercased (got ${JSON.stringify(parsedTags?.caseNorm)})`
        );
        assert(parsedTags?.empty?.length === 0, 'Empty string returns []');
        assert(parsedTags?.nullSafe?.length === 0, 'null input returns []');

        // ── Group 11: Status text reflects correct counts ──────────────────────
        console.log('\n  -- Group 11: Status Text Accuracy --');

        // We have 2 markups, each with #electrical
        const statusFinal = await page.evaluate(() =>
            document.getElementById('nc-status')?.textContent?.trim() || ''
        );
        assert(statusFinal.includes('2 markups'),
            `Status shows "2 markups" (got "${statusFinal}")`);
        assert(statusFinal.includes('1 tag'),
            `Status shows "1 tag" (got "${statusFinal}")`);

        // ── Group 12: Graph rebuilds on page change ────────────────────────────
        console.log('\n  -- Group 12: Rebuild on Page Change --');

        // Emit page-changed to trigger onPageChanged (if doc has 1+ pages)
        // Even on a 1-page doc, the event fires; graph should be rebuilt
        const pageCount = await page.evaluate(() => window.app?.viewer?.pageCount ?? 1);

        await page.evaluate(() => {
            window.app.plugins.emit('page-changed', 1, window.app?.viewer?.pageCount ?? 1);
        });
        await page.waitForTimeout(500);  // 200ms delay + render time

        // After page-change, graph should still show (same page — same markups)
        const svgAfterPageChange = await page.evaluate(() =>
            document.getElementById('nc-svg')?.style.display !== 'none'
        );
        assert(svgAfterPageChange,
            `Graph still visible after page-changed event (page count: ${pageCount})`);

        const nodesAfterPageChange = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-markup-id]').length
        );
        assert(nodesAfterPageChange === 2,
            `Graph shows 2 markup nodes after page-changed (got ${nodesAfterPageChange})`);

        // ── Group 13: All Pages toggle button exists and works ────────────────
        console.log('\n  -- Group 13: All Pages Toggle Button --');

        // Button must have been injected into the panel header by _renderShell()
        const pagesBtnExists = await page.evaluate(() =>
            !!document.getElementById('nc-pages-btn')
        );
        assert(pagesBtnExists, '#nc-pages-btn toggle button exists in nodeCAST header');

        // Default label is "This Page"
        const defaultLabel = await page.evaluate(() =>
            document.getElementById('nc-pages-btn')?.textContent?.trim() || ''
        );
        assert(defaultLabel === 'This Page',
            `Default button label is "This Page" (got "${defaultLabel}")`);

        // Default: no active class
        const noActiveClass = await page.evaluate(() =>
            !document.getElementById('nc-pages-btn')?.classList.contains('nc-pages-btn--active')
        );
        assert(noActiveClass, 'Default state has no --active class on toggle button');

        // Click to switch to All Pages mode
        await page.evaluate(() => document.getElementById('nc-pages-btn')?.click());
        await page.waitForTimeout(300);

        const allPagesLabel = await page.evaluate(() =>
            document.getElementById('nc-pages-btn')?.textContent?.trim() || ''
        );
        assert(allPagesLabel === 'All Pages',
            `After toggle, button label is "All Pages" (got "${allPagesLabel}")`);

        const hasActiveClass = await page.evaluate(() =>
            document.getElementById('nc-pages-btn')?.classList.contains('nc-pages-btn--active')
        );
        assert(hasActiveClass, 'All Pages mode adds --active class to toggle button');

        // ── Group 14: All Pages mode shows markups from serialized data ────────
        console.log('\n  -- Group 14: All Pages Mode Graph Data --');

        // In all-pages mode, the graph should read from getAllPageMarkups()
        // which includes the serialized markups we placed earlier (2 rects).
        // On a single-page doc, the counts should match current-page mode.
        const svgVisibleAllPages = await page.evaluate(() =>
            document.getElementById('nc-svg')?.style.display !== 'none'
        );
        assert(svgVisibleAllPages, 'SVG visible in All Pages mode');

        const markupNodesAllPages = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-markup-id]').length
        );
        assert(markupNodesAllPages >= 2,
            `All Pages mode shows >= 2 markup nodes (got ${markupNodesAllPages})`);

        // Status bar should mention "page(s)" in all-pages mode
        const statusAllPages = await page.evaluate(() =>
            document.getElementById('nc-status')?.textContent?.trim() || ''
        );
        assert(statusAllPages.includes('page'),
            `All Pages status includes "page" (got "${statusAllPages}")`);

        // Plugin internal state reflects all-pages mode
        const allPagesFlagSet = await page.evaluate(() =>
            window.app.plugins.plugins.get('nodecast')?._allPages === true
        );
        assert(allPagesFlagSet, 'Plugin._allPages is true in all-pages mode');

        // ── Group 15: Toggle back to This Page mode ────────────────────────────
        console.log('\n  -- Group 15: Toggle Back to This Page Mode --');

        await page.evaluate(() => document.getElementById('nc-pages-btn')?.click());
        await page.waitForTimeout(300);

        const restoredLabel = await page.evaluate(() =>
            document.getElementById('nc-pages-btn')?.textContent?.trim() || ''
        );
        assert(restoredLabel === 'This Page',
            `Label restored to "This Page" after toggle back (got "${restoredLabel}")`);

        const activeClassGone = await page.evaluate(() =>
            !document.getElementById('nc-pages-btn')?.classList.contains('nc-pages-btn--active')
        );
        assert(activeClassGone, '--active class removed after toggle back to This Page');

        const allPagesFlagClear = await page.evaluate(() =>
            window.app.plugins.plugins.get('nodecast')?._allPages === false
        );
        assert(allPagesFlagClear, 'Plugin._allPages is false after toggle back');

        // Graph should still show the same 2 markup nodes on current page
        const markupNodesRestored = await page.evaluate(() =>
            document.querySelectorAll('#nc-svg circle[data-markup-id]').length
        );
        assert(markupNodesRestored === 2,
            `This Page mode shows 2 markup nodes after toggle back (got ${markupNodesRestored})`);

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
