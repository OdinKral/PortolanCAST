/**
 * PortolanCAST — Phase 4C ExtendedCognition Plugin Browser Tests
 *
 * Tests the EC Brief plugin: panel shell, empty state, server endpoint,
 * panel after document load, and markup stats accuracy.
 *
 * Groups:
 *   1. Panel Shell (5)              — tab button, content div, narrative, refresh btn
 *   2. Empty State (3)              — placeholder before doc loads (tested on home page)
 *   3. Server Endpoint Direct (6)   — POST /api/documents/1/ai-summary, response shape
 *   4. Panel After Document Load (7)— narrative text, stats visible, badge, refresh flow
 *   5. Stats Accuracy (4)           — byType/byStatus counts, distance, area companion skip
 *
 * Total: 25 tests
 * Running total after this suite: 413 + 25 = 438
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_phase4c.mjs"
 *
 * Author: PortolanCAST
 * Version: 1.0.0
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

async function run() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // =====================================================================
        // SETUP: Load edit page, clear previous markups
        // =====================================================================
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear server-saved markups from previous test runs
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
        // TEST GROUP 1: Panel Shell
        // =====================================================================
        console.log('\n--- Test Group 1: Panel Shell ---');

        // 1.1 — EC Brief tab button exists in #right-panel-tabs
        const ecTabBtn = await page.$('#right-panel-tabs .panel-tab[data-panel="plugin-extended-cognition"]');
        assert(ecTabBtn !== null, 'EC Brief tab button exists in #right-panel-tabs');

        // 1.2 — #tab-plugin-extended-cognition content div exists
        const ecTabContent = await page.$('#tab-plugin-extended-cognition');
        assert(ecTabContent !== null, '#tab-plugin-extended-cognition content div exists');

        // 1.3 — Clicking EC Brief tab makes it .active
        await page.click('#right-panel-tabs .panel-tab[data-panel="plugin-extended-cognition"]');
        await page.waitForTimeout(200);
        const ecTabActive = await page.$eval(
            '#tab-plugin-extended-cognition',
            el => el.classList.contains('active')
        );
        assert(ecTabActive, 'Clicking EC Brief tab makes #tab-plugin-extended-cognition .active');

        // 1.4 — #ec-narrative element exists inside the plugin container
        const ecNarrative = await page.$('#tab-plugin-extended-cognition #ec-narrative');
        assert(ecNarrative !== null, '#ec-narrative element exists in EC plugin container');

        // 1.5 — #ec-refresh button exists in the plugin container
        // (May be hidden but must exist in DOM after init)
        const ecRefresh = await page.$('#tab-plugin-extended-cognition #ec-refresh');
        assert(ecRefresh !== null, '#ec-refresh button exists in EC plugin container');

        // =====================================================================
        // TEST GROUP 2: Empty State (tested on home page — no doc loaded)
        // =====================================================================
        console.log('\n--- Test Group 2: Empty State ---');

        const homePage = await context.newPage();
        await homePage.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
        await homePage.waitForTimeout(800);

        // 2.1 — #ec-narrative has placeholder text before any doc loads
        // On the home page the plugin is initialized but no doc is loaded yet,
        // so the shell renders with "Open a document" placeholder text.
        const ecNarrativeHome = await homePage.$('#ec-narrative');
        let homeNarrativeText = '';
        if (ecNarrativeHome) {
            homeNarrativeText = (await ecNarrativeHome.textContent() || '').trim();
        }
        assert(
            homeNarrativeText.toLowerCase().includes('open') ||
            homeNarrativeText.toLowerCase().includes('document'),
            `#ec-narrative shows placeholder text before doc loads (got: "${homeNarrativeText.slice(0, 60)}")`
        );

        // 2.2 — #ec-stats is hidden (display:none) before doc loads
        const statsHidden = await homePage.evaluate(() => {
            const el = document.getElementById('ec-stats');
            if (!el) return true; // not present = hidden
            return el.style.display === 'none' || getComputedStyle(el).display === 'none';
        });
        assert(statsHidden, '#ec-stats is hidden before doc loads');

        // 2.3 — #ec-footer is hidden (display:none) before doc loads
        const footerHidden = await homePage.evaluate(() => {
            const el = document.getElementById('ec-footer');
            if (!el) return true;
            return el.style.display === 'none' || getComputedStyle(el).display === 'none';
        });
        assert(footerHidden, '#ec-footer is hidden before doc loads');

        await homePage.close();

        // =====================================================================
        // TEST GROUP 3: Server Endpoint Direct
        // =====================================================================
        console.log('\n--- Test Group 3: Server Endpoint Direct ---');

        // 3.1 — POST /api/documents/1/ai-summary with empty pages → 200
        const endpointResp = await page.evaluate(async () => {
            const r = await fetch('/api/documents/1/ai-summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {} }),
            });
            return { status: r.status, data: await r.json() };
        });
        assert(endpointResp.status === 200, 'POST /api/documents/1/ai-summary returns 200');

        // 3.2 — Response has non-empty summary string
        assert(
            typeof endpointResp.data.summary === 'string' && endpointResp.data.summary.length > 0,
            'Response has non-empty summary string'
        );

        // 3.3 — Response stats.byType has all 5 markup type keys
        const byType = endpointResp.data.stats?.byType || {};
        const hasAllTypes = ['issue', 'question', 'approval', 'change', 'note']
            .every(t => t in byType);
        assert(hasAllTypes, 'stats.byType has all 5 markup type keys (issue, question, approval, change, note)');

        // 3.4 — Response stats.byStatus has both open and resolved keys
        const byStatus = endpointResp.data.stats?.byStatus || {};
        assert(
            'open' in byStatus && 'resolved' in byStatus,
            'stats.byStatus has both "open" and "resolved" keys'
        );

        // 3.5 — Response has mode = 'ai' or 'computed'
        assert(
            endpointResp.data.mode === 'ai' || endpointResp.data.mode === 'computed',
            `Response mode is 'ai' or 'computed' (got: "${endpointResp.data.mode}")`
        );

        // 3.6 — stats.total = 0 when pages = {}
        assert(
            endpointResp.data.stats?.total === 0,
            `stats.total = 0 when pages = {} (got: ${endpointResp.data.stats?.total})`
        );

        // =====================================================================
        // TEST GROUP 4: Panel After Document Load
        // =====================================================================
        console.log('\n--- Test Group 4: Panel After Document Load ---');

        // Ensure EC Brief tab is active so we can inspect its content
        await page.click('#right-panel-tabs .panel-tab[data-panel="plugin-extended-cognition"]');
        await page.waitForTimeout(200);

        // Wait for the summary fetch to complete (up to 10 seconds for Ollama)
        await page.waitForFunction(() => {
            const el = document.getElementById('ec-narrative');
            if (!el) return false;
            const text = el.textContent || '';
            // Spinner text is "Generating brief…" — wait until it changes
            return !text.includes('Generating brief') && text.trim().length > 0;
        }, { timeout: 10000 }).catch(() => null); // Don't fail test if timeout

        // 4.1 — #ec-narrative shows non-empty, non-italic text after doc load
        const narrativeText = await page.$eval(
            '#ec-narrative',
            el => ({ text: el.textContent?.trim() || '', italic: getComputedStyle(el).fontStyle })
        );
        assert(
            narrativeText.text.length > 0 && narrativeText.italic !== 'italic',
            `#ec-narrative shows non-italic text after doc load (got: "${narrativeText.text.slice(0, 60)}")`
        );

        // 4.2 — #ec-stats div is visible after doc load
        const statsVisible = await page.evaluate(() => {
            const el = document.getElementById('ec-stats');
            if (!el) return false;
            return el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
        });
        assert(statsVisible, '#ec-stats div is visible after doc load');

        // 4.3 — #ec-footer div is visible after doc load
        const footerVisible = await page.evaluate(() => {
            const el = document.getElementById('ec-footer');
            if (!el) return false;
            return el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
        });
        assert(footerVisible, '#ec-footer div is visible after doc load');

        // 4.4 — Mode badge (#ec-mode-badge) has non-empty text
        const badgeText = await page.$eval(
            '#ec-mode-badge',
            el => el.textContent?.trim() || ''
        );
        assert(badgeText.length > 0, `#ec-mode-badge has non-empty text (got: "${badgeText}")`);

        // 4.5 — Mode badge contains ⚡ (AI) or ≈ (computed)
        assert(
            badgeText.includes('⚡') || badgeText.includes('≈'),
            `Mode badge contains ⚡ or ≈ (got: "${badgeText}")`
        );

        // 4.6 — Adding 2 issue markups + clicking Refresh → stat row for Issues appears
        await page.evaluate(async () => {
            const fc = window.app.canvas.fabricCanvas;
            // Add 2 issue-type Rect objects
            for (let i = 0; i < 2; i++) {
                const rect = new fabric.Rect({
                    left: 50 + i * 80, top: 50,
                    width: 60, height: 40,
                    fill: 'transparent', stroke: '#ff4444', strokeWidth: 2,
                    markupType: 'issue', markupStatus: 'open', markupNote: '',
                });
                fc.add(rect);
            }
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        // Click Refresh
        await page.click('#ec-refresh');

        // Wait for the refresh to complete
        await page.waitForFunction(() => {
            const el = document.getElementById('ec-narrative');
            if (!el) return false;
            const text = el.textContent || '';
            return !text.includes('Generating brief') && text.trim().length > 0;
        }, { timeout: 10000 }).catch(() => null);
        await page.waitForTimeout(500);

        const issueRowExists = await page.evaluate(() => {
            const rows = document.querySelectorAll('#ec-stats .ec-stat-row');
            return Array.from(rows).some(r => r.dataset.type === 'issue');
        });
        assert(issueRowExists, 'After adding 2 issues + Refresh, stat row for Issues appears');

        // 4.7 — Panel transitions from spinner text to final content
        // (This is implicitly proven by 4.1 — narrative is not "Generating brief…")
        const notSpinner = await page.$eval('#ec-narrative', el => {
            return !(el.textContent || '').includes('Generating brief');
        });
        assert(notSpinner, 'Panel transitions from spinner text to final content');

        // =====================================================================
        // TEST GROUP 5: Stats Accuracy
        // =====================================================================
        console.log('\n--- Test Group 5: Stats Accuracy ---');

        // 5.1 — Adding 2 issue markups → endpoint returns stats.byType.issue = 2
        const statsWithIssues = await page.evaluate(async () => {
            // Use the markups already on canvas (2 issues from test 4.6)
            window.app.canvas.onPageChanging(window.app.lastPage);
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/ai-summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });
            return (await r.json()).stats;
        });
        assert(
            statsWithIssues?.byType?.issue === 2,
            `stats.byType.issue = 2 after adding 2 issues (got: ${statsWithIssues?.byType?.issue})`
        );

        // 5.2 — A resolved markup → endpoint returns stats.byStatus.resolved ≥ 1
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 250, top: 50,
                width: 60, height: 40,
                fill: 'transparent', stroke: '#44cc66', strokeWidth: 2,
                markupType: 'approval', markupStatus: 'resolved', markupNote: '',
            });
            fc.add(rect);
            fc.renderAll();
        });

        const statsWithResolved = await page.evaluate(async () => {
            window.app.canvas.onPageChanging(window.app.lastPage);
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/ai-summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });
            return (await r.json()).stats;
        });
        assert(
            (statsWithResolved?.byStatus?.resolved || 0) >= 1,
            `stats.byStatus.resolved ≥ 1 after adding resolved markup (got: ${statsWithResolved?.byStatus?.resolved})`
        );

        // 5.3 — Distance measurement → endpoint returns stats.measurements.distances ≥ 1
        // We inject a mock distance Group (matches the shape stored by MeasureTools)
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            // Minimal Distance Group — just needs measurementType to be counted
            const line = new fabric.Line([0, 0, 100, 0], { stroke: '#4a9eff', strokeWidth: 2 });
            const label = new fabric.IText('10.0 ft', { fontSize: 11, fill: '#4a9eff' });
            const grp = new fabric.Group([line, label], {
                left: 50, top: 150,
                measurementType: 'distance',
                markupType: 'note', markupStatus: 'open', markupNote: '',
            });
            // Ensure measurementType persists in Fabric JSON
            grp.toObject = (function(origToObject) {
                return function(props) {
                    const obj = origToObject.call(this, props);
                    obj.measurementType = this.measurementType;
                    return obj;
                };
            })(grp.toObject);
            fc.add(grp);
            fc.renderAll();
        });

        const statsWithDist = await page.evaluate(async () => {
            window.app.canvas.onPageChanging(window.app.lastPage);
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/ai-summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });
            return (await r.json()).stats;
        });
        assert(
            (statsWithDist?.measurements?.distances || 0) >= 1,
            `stats.measurements.distances ≥ 1 after adding distance measurement (got: ${statsWithDist?.measurements?.distances})`
        );

        // 5.4 — Area companion IText NOT double-counted
        // Add an area polygon (measurementType='area', type='Path') and a
        // companion IText (measurementType='area', type='IText').
        // stats.measurements.areas should be 1 (polygon only), not 2.
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            // Polygon representing an area measurement
            const poly = new fabric.Polygon(
                [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }],
                {
                    left: 50, top: 200, fill: 'rgba(74,158,255,0.15)',
                    stroke: '#4a9eff', strokeWidth: 2,
                    measurementType: 'area',
                    markupType: 'note', markupStatus: 'open', markupNote: '',
                }
            );
            // Companion IText label — should be SKIPPED by _extract_stats
            const label = new fabric.IText('45.0 sq ft', {
                left: 80, top: 235, fontSize: 11, fill: '#4a9eff',
                measurementType: 'area',
            });
            // Patch toObject on both to persist measurementType
            [poly, label].forEach(obj => {
                obj.toObject = (function(orig) {
                    return function(props) {
                        const o = orig.call(this, props);
                        o.measurementType = this.measurementType;
                        return o;
                    };
                })(obj.toObject);
            });
            fc.add(poly);
            fc.add(label);
            fc.renderAll();
        });

        const statsWithArea = await page.evaluate(async () => {
            window.app.canvas.onPageChanging(window.app.lastPage);
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/ai-summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });
            return (await r.json()).stats;
        });
        assert(
            statsWithArea?.measurements?.areas === 1,
            `Area companion IText not double-counted — measurements.areas = 1 (got: ${statsWithArea?.measurements?.areas})`
        );

    } finally {
        await browser.close();
    }

    // ==========================================================================
    // RESULTS SUMMARY
    // ==========================================================================
    console.log('\n');
    console.log('════════════════════════════════════════');
    console.log('  Phase 4C: ExtendedCognition Plugin');
    console.log('════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('════════════════════════════════════════');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('[Phase 4C Test] Fatal error:', err);
    process.exit(1);
});
