/**
 * PortolanCAST — L3 Persistent Mode Bar Tests
 *
 * Verifies the status-bar mode indicator introduced in L3:
 *   1. #sb-mode is hidden before a document loads and visible after.
 *   2. #sb-active-tool pill shows correct icon + name for activated tools.
 *   3. data-tab attribute on the pill drives colour coding by tab.
 *   4. #sb-btn-hand highlights for hand / null (pan) mode.
 *   5. #sb-btn-select highlights for select mode.
 *   6. Clicking the quick-switch buttons calls setTool() correctly.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_l3_mode_bar.mjs"
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

async function run() {
    const browser = await chromium.launch({ headless: true });
    const page    = await browser.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);

        // ── Group 1: Visibility ───────────────────────────────────────────────
        console.log('\n  -- Group 1: Mode Bar Visibility --');

        const sbModeVisible = await page.evaluate(() => {
            const el = document.getElementById('sb-mode');
            return el ? el.style.display !== 'none' : false;
        });
        assert(sbModeVisible, '#sb-mode is visible after document load');

        const sbToolIconExists  = await page.evaluate(() => !!document.getElementById('sb-tool-icon'));
        const sbToolNameExists  = await page.evaluate(() => !!document.getElementById('sb-tool-name'));
        const sbActivePillExists = await page.evaluate(() => !!document.getElementById('sb-active-tool'));
        assert(sbToolIconExists,   '#sb-tool-icon element exists');
        assert(sbToolNameExists,   '#sb-tool-name element exists');
        assert(sbActivePillExists, '#sb-active-tool element exists');

        const sbBtnHandExists   = await page.evaluate(() => !!document.getElementById('sb-btn-hand'));
        const sbBtnSelectExists = await page.evaluate(() => !!document.getElementById('sb-btn-select'));
        assert(sbBtnHandExists,   '#sb-btn-hand quick-switch button exists');
        assert(sbBtnSelectExists, '#sb-btn-select quick-switch button exists');

        // ── Group 2: Default state (pan mode after load) ──────────────────────
        console.log('\n  -- Group 2: Default State (Pan Mode) --');

        const defaultName = await page.evaluate(() =>
            document.getElementById('sb-tool-name')?.textContent?.trim()
        );
        // After load, activeTool should be null (pan) → shows "Pan"
        assert(
            defaultName === 'Pan' || defaultName === 'Select' || defaultName === 'Hand',
            `Default mode bar label is pan/select/hand family (got "${defaultName}")`
        );

        const defaultTab = await page.evaluate(() =>
            document.getElementById('sb-active-tool')?.dataset?.tab
        );
        assert(
            defaultTab === 'navigate',
            `Default pill data-tab is "navigate" (got "${defaultTab}")`
        );

        const handBtnActiveDefault = await page.evaluate(() =>
            document.getElementById('sb-btn-hand')?.classList?.contains('active')
        );
        assert(handBtnActiveDefault, '#sb-btn-hand has .active in default pan/hand mode');

        // ── Group 3: Markup tool updates pill ────────────────────────────────
        console.log('\n  -- Group 3: Markup Tool Updates Pill --');

        // Switch to the markup tab first so pen button is visible
        await page.evaluate(() => window.app.toolbar._setActiveTab('markup'));
        await page.waitForTimeout(100);

        await page.click('[data-tool="pen"]');
        await page.waitForTimeout(200);

        const penTabAttr = await page.evaluate(() =>
            document.getElementById('sb-active-tool')?.dataset?.tab
        );
        assert(penTabAttr === 'markup', `Pen tool sets data-tab="markup" (got "${penTabAttr}")`);

        const penName = await page.evaluate(() =>
            document.getElementById('sb-tool-name')?.textContent?.trim()
        );
        assert(
            penName && penName.toLowerCase().includes('pen'),
            `Pen tool shows "Pen" in mode bar name (got "${penName}")`
        );

        const handBtnInactiveDuringPen = await page.evaluate(() =>
            !document.getElementById('sb-btn-hand')?.classList?.contains('active')
        );
        assert(handBtnInactiveDuringPen, '#sb-btn-hand NOT active when pen tool is active');

        // ── Group 4: Measure tool updates pill ──────────────────────────────
        console.log('\n  -- Group 4: Measure Tool Updates Pill --');

        await page.evaluate(() => window.app.toolbar._setActiveTab('measure'));
        await page.waitForTimeout(100);

        await page.click('[data-tool="distance"]');
        await page.waitForTimeout(200);

        const distTabAttr = await page.evaluate(() =>
            document.getElementById('sb-active-tool')?.dataset?.tab
        );
        assert(distTabAttr === 'measure', `Distance tool sets data-tab="measure" (got "${distTabAttr}")`);

        const distName = await page.evaluate(() =>
            document.getElementById('sb-tool-name')?.textContent?.trim()
        );
        assert(distName && distName.length > 0, `Distance tool shows non-empty name (got "${distName}")`);

        // ── Group 5: Select tool quick-switch ────────────────────────────────
        console.log('\n  -- Group 5: Select Quick-Switch --');

        await page.click('#sb-btn-select');
        await page.waitForTimeout(200);

        const afterSelectTool = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(afterSelectTool === 'select', `#sb-btn-select sets activeTool='select' (got "${afterSelectTool}")`);

        const selectBtnActive = await page.evaluate(() =>
            document.getElementById('sb-btn-select')?.classList?.contains('active')
        );
        assert(selectBtnActive, '#sb-btn-select has .active when select is active');

        const selectTab = await page.evaluate(() =>
            document.getElementById('sb-active-tool')?.dataset?.tab
        );
        assert(selectTab === 'navigate', `Select tool pill data-tab="navigate" (got "${selectTab}")`);

        // ── Group 6: Hand tool quick-switch ──────────────────────────────────
        console.log('\n  -- Group 6: Hand Quick-Switch --');

        await page.click('#sb-btn-hand');
        await page.waitForTimeout(200);

        // hand → _TOOL_TAB maps it to 'navigate'; it falls through to default case
        const afterHandTab = await page.evaluate(() =>
            document.getElementById('sb-active-tool')?.dataset?.tab
        );
        assert(afterHandTab === 'navigate', `Hand tool pill data-tab="navigate" (got "${afterHandTab}")`);

        const handBtnActiveAfterClick = await page.evaluate(() =>
            document.getElementById('sb-btn-hand')?.classList?.contains('active')
        );
        assert(handBtnActiveAfterClick, '#sb-btn-hand has .active after clicking it');

        const selBtnInactiveAfterHand = await page.evaluate(() =>
            !document.getElementById('sb-btn-select')?.classList?.contains('active')
        );
        assert(selBtnInactiveAfterHand, '#sb-btn-select NOT active after switching to hand');

        // ── Group 7: Tool name strips shortcut hint ──────────────────────────
        console.log('\n  -- Group 7: Name Strips Shortcut Hint --');

        await page.evaluate(() => window.app.toolbar._setActiveTab('markup'));
        await page.waitForTimeout(100);
        await page.click('[data-tool="pen"]');
        await page.waitForTimeout(100);

        const nameNoParens = await page.evaluate(() => {
            const name = document.getElementById('sb-tool-name')?.textContent?.trim();
            // Should not contain "(P)" or any "(X)" pattern
            return name && !/\([A-Z0-9]\)/i.test(name);
        });
        assert(nameNoParens, 'Mode bar name does not contain keyboard shortcut "(X)" hint');

        // Cleanup: back to pan mode
        await page.evaluate(() => window.app.toolbar.setTool('hand'));
        await page.waitForTimeout(100);

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
