/**
 * PortolanCAST — Panel Collapse/Expand Browser Tests
 *
 * Tests the collapsible side panel behavior for both left (#panel-left)
 * and right (#panel-properties) panels.
 *
 * What is tested:
 *   - Buttons exist and are visible
 *   - Clicking collapse button adds .panel-collapsed class
 *   - Panel width shrinks to 28px on collapse
 *   - Panel tab content is hidden when collapsed
 *   - Arrow icon direction flips on collapse/expand
 *   - Clicking the strip expands the panel back to 200px
 *   - .panel-collapsed class is removed on expand
 *   - Collapsed label becomes visible when panel is collapsed
 *   - No JavaScript errors during toggle
 *
 * Run:
 *   node test_panel_collapse.mjs
 *
 * Requires: PortolanCAST server running at http://127.0.0.1:8000
 *
 * Author: PortolanCAST test suite
 * Version: 1.0.0
 * Date: 2026-03-23
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID   = 1;

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
    const browser = await chromium.launch({ headless: true });
    const page    = await browser.newPage();

    // Collect console errors so we can assert "no errors during collapse"
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    try {
        // ---------------------------------------------------------------
        // Setup: load editor page
        // ---------------------------------------------------------------
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // =================================================================
        // TEST GROUP 1: Collapse buttons exist and are reachable
        // =================================================================
        console.log('\n--- Test Group 1: Button Presence ---');

        const btnLeft  = await page.$('#btn-collapse-left');
        const btnRight = await page.$('#btn-collapse-right');

        assert(btnLeft  !== null, 'Left collapse button exists (#btn-collapse-left)');
        assert(btnRight !== null, 'Right collapse button exists (#btn-collapse-right)');

        const leftVisible  = await page.isVisible('#btn-collapse-left');
        const rightVisible = await page.isVisible('#btn-collapse-right');

        assert(leftVisible,  'Left collapse button is visible');
        assert(rightVisible, 'Right collapse button is visible');

        // =================================================================
        // TEST GROUP 2: Initial panel state (expanded)
        // =================================================================
        console.log('\n--- Test Group 2: Initial Panel State ---');

        const initial = await page.evaluate(() => {
            const left  = document.getElementById('panel-left');
            const right = document.getElementById('panel-properties');
            return {
                leftCollapsed:  left  ? left.classList.contains('panel-collapsed')  : null,
                rightCollapsed: right ? right.classList.contains('panel-collapsed') : null,
                leftWidth:      left  ? left.offsetWidth  : 0,
                rightWidth:     right ? right.offsetWidth : 0,
            };
        });

        assert(initial.leftCollapsed  === false, 'Left panel starts expanded (no .panel-collapsed)');
        assert(initial.rightCollapsed === false, 'Right panel starts expanded (no .panel-collapsed)');
        assert(initial.leftWidth  >= 160, `Left panel starts at full width (${initial.leftWidth}px >= 160px)`);
        assert(initial.rightWidth >= 160, `Right panel starts at full width (${initial.rightWidth}px >= 160px)`);

        // =================================================================
        // TEST GROUP 3: Left panel — collapse
        // =================================================================
        console.log('\n--- Test Group 3: Left Panel Collapse ---');

        await page.click('#btn-collapse-left');
        // Allow CSS transition (0.2s) to complete
        await page.waitForTimeout(400);

        const afterLeftCollapse = await page.evaluate(() => {
            const panel = document.getElementById('panel-left');
            const tabs  = document.getElementById('panel-left')
                              ?.querySelector('.panel-tabs');
            const btn   = document.getElementById('btn-collapse-left');
            return {
                hasClass:    panel ? panel.classList.contains('panel-collapsed') : false,
                width:       panel ? panel.offsetWidth : 0,
                tabsVisible: tabs  ? tabs.offsetParent !== null : true, // null = hidden
                btnText:     btn   ? btn.innerHTML.trim() : '',
            };
        });

        assert(afterLeftCollapse.hasClass,   'Left panel has .panel-collapsed after click');
        assert(afterLeftCollapse.width <= 30, `Left panel width shrinks to ≤30px (got ${afterLeftCollapse.width}px)`);
        assert(!afterLeftCollapse.tabsVisible, 'Left panel tab bar is hidden when collapsed');
        assert(
            afterLeftCollapse.btnText === '&#9654;' || afterLeftCollapse.btnText === '▶',
            `Left button arrow flips to ▶ when collapsed (got "${afterLeftCollapse.btnText}")`
        );

        // =================================================================
        // TEST GROUP 4: Left panel — expand
        // =================================================================
        console.log('\n--- Test Group 4: Left Panel Expand ---');

        await page.click('#btn-collapse-left');
        await page.waitForTimeout(400);

        const afterLeftExpand = await page.evaluate(() => {
            const panel = document.getElementById('panel-left');
            const btn   = document.getElementById('btn-collapse-left');
            return {
                hasClass: panel ? panel.classList.contains('panel-collapsed') : true,
                width:    panel ? panel.offsetWidth : 0,
                btnText:  btn   ? btn.innerHTML.trim() : '',
            };
        });

        assert(!afterLeftExpand.hasClass,   'Left panel loses .panel-collapsed after expand click');
        assert(afterLeftExpand.width >= 160, `Left panel width restores to ≥160px (got ${afterLeftExpand.width}px)`);
        assert(
            afterLeftExpand.btnText === '&#9664;' || afterLeftExpand.btnText === '◀',
            `Left button arrow flips back to ◀ when expanded (got "${afterLeftExpand.btnText}")`
        );

        // =================================================================
        // TEST GROUP 5: Right panel — collapse
        // =================================================================
        console.log('\n--- Test Group 5: Right Panel Collapse ---');

        await page.click('#btn-collapse-right');
        await page.waitForTimeout(400);

        const afterRightCollapse = await page.evaluate(() => {
            const panel = document.getElementById('panel-properties');
            const tabs  = document.getElementById('right-panel-tabs');
            const btn   = document.getElementById('btn-collapse-right');
            return {
                hasClass:    panel ? panel.classList.contains('panel-collapsed') : false,
                width:       panel ? panel.offsetWidth : 0,
                tabsVisible: tabs  ? tabs.offsetParent !== null : true,
                btnText:     btn   ? btn.innerHTML.trim() : '',
            };
        });

        assert(afterRightCollapse.hasClass,   'Right panel has .panel-collapsed after click');
        assert(afterRightCollapse.width <= 30, `Right panel width shrinks to ≤30px (got ${afterRightCollapse.width}px)`);
        assert(!afterRightCollapse.tabsVisible, 'Right panel tab bar is hidden when collapsed');
        assert(
            afterRightCollapse.btnText === '&#9664;' || afterRightCollapse.btnText === '◀',
            `Right button arrow flips to ◀ when collapsed (got "${afterRightCollapse.btnText}")`
        );

        // =================================================================
        // TEST GROUP 6: Right panel — expand
        // =================================================================
        console.log('\n--- Test Group 6: Right Panel Expand ---');

        await page.click('#btn-collapse-right');
        await page.waitForTimeout(400);

        const afterRightExpand = await page.evaluate(() => {
            const panel = document.getElementById('panel-properties');
            const btn   = document.getElementById('btn-collapse-right');
            return {
                hasClass: panel ? panel.classList.contains('panel-collapsed') : true,
                width:    panel ? panel.offsetWidth : 0,
                btnText:  btn   ? btn.innerHTML.trim() : '',
            };
        });

        assert(!afterRightExpand.hasClass,   'Right panel loses .panel-collapsed after expand click');
        assert(afterRightExpand.width >= 160, `Right panel width restores to ≥160px (got ${afterRightExpand.width}px)`);
        assert(
            afterRightExpand.btnText === '&#9654;' || afterRightExpand.btnText === '▶',
            `Right button arrow flips back to ▶ when expanded (got "${afterRightExpand.btnText}")`
        );

        // =================================================================
        // TEST GROUP 7: Collapsed label visibility
        // =================================================================
        console.log('\n--- Test Group 7: Collapsed Labels ---');

        // Collapse left panel and check that the "Pages" label becomes visible
        await page.click('#btn-collapse-left');
        await page.waitForTimeout(400);

        const labelVisible = await page.evaluate(() => {
            const label = document.querySelector('#panel-left .panel-collapsed-label');
            if (!label) return { found: false };
            const style = window.getComputedStyle(label);
            return {
                found:   true,
                display: style.display,
                visible: style.display !== 'none',
            };
        });

        assert(labelVisible.found,   'Collapsed label element exists on left panel');
        assert(labelVisible.visible, `Collapsed label is visible when panel collapsed (display: ${labelVisible.display})`);

        // Restore
        await page.click('#btn-collapse-left');
        await page.waitForTimeout(400);

        const labelHidden = await page.evaluate(() => {
            const label = document.querySelector('#panel-left .panel-collapsed-label');
            if (!label) return { found: false };
            return { display: window.getComputedStyle(label).display };
        });

        assert(labelHidden.display === 'none', `Collapsed label hidden when panel expanded (display: ${labelHidden.display})`);

        // =================================================================
        // TEST GROUP 8: Both panels collapsed simultaneously
        // =================================================================
        console.log('\n--- Test Group 8: Both Panels Collapsed ---');

        await page.click('#btn-collapse-left');
        await page.click('#btn-collapse-right');
        await page.waitForTimeout(400);

        const bothCollapsed = await page.evaluate(() => {
            const left  = document.getElementById('panel-left');
            const right = document.getElementById('panel-properties');
            return {
                leftCollapsed:  left  ? left.classList.contains('panel-collapsed')  : false,
                rightCollapsed: right ? right.classList.contains('panel-collapsed') : false,
                leftWidth:      left  ? left.offsetWidth  : 0,
                rightWidth:     right ? right.offsetWidth : 0,
            };
        });

        assert(bothCollapsed.leftCollapsed,   'Left panel collapses independently');
        assert(bothCollapsed.rightCollapsed,  'Right panel collapses independently');
        assert(bothCollapsed.leftWidth  <= 30, `Both collapsed: left ≤30px (${bothCollapsed.leftWidth}px)`);
        assert(bothCollapsed.rightWidth <= 30, `Both collapsed: right ≤30px (${bothCollapsed.rightWidth}px)`);

        // Restore both
        await page.click('#btn-collapse-left');
        await page.click('#btn-collapse-right');
        await page.waitForTimeout(400);

        // =================================================================
        // TEST GROUP 9: No JavaScript errors during all toggle operations
        // =================================================================
        console.log('\n--- Test Group 9: No Console Errors ---');

        assert(
            consoleErrors.length === 0,
            consoleErrors.length === 0
                ? 'No JavaScript errors during collapse/expand operations'
                : `${consoleErrors.length} JS error(s): ${consoleErrors.join(' | ')}`
        );

    } catch (err) {
        console.error('Test runner error:', err);
        failed++;
    } finally {
        await browser.close();
    }

    // =================================================================
    // Summary
    // =================================================================
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`${'='.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
