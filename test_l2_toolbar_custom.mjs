/**
 * PortolanCAST — L2 Toolbar Customization Tests
 *
 * Verifies the three L2 additions to the existing settings system:
 *   1. Compact mode: .toolbar-compact CSS class toggle via checkbox in settings modal,
 *      persisted in localStorage, applied on startup, cleared by Reset.
 *   2. Keyboard shortcut hints: settings rows show "(P)" chips parsed from
 *      tool button title attributes.
 *   3. Escape key: closes settings modal via keyboard.
 *
 * The pre-existing show/hide per-tool functionality is already covered by
 * test_phase3b.mjs (Group 7), so those tests are not duplicated here.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_l2_toolbar_custom.mjs"
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

async function run() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);

        // Ensure localStorage is clean before starting
        await page.evaluate(() => {
            localStorage.removeItem('portolancast-toolbar-compact');
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);

        // ── Group 1: Compact mode checkbox presence ───────────────────────────
        console.log('\n  -- Group 1: Compact Mode Checkbox --');

        await page.click('#btn-toolbar-settings');
        await page.waitForTimeout(200);

        const compactCbExists = await page.evaluate(() =>
            !!document.getElementById('settings-cb-compact')
        );
        assert(compactCbExists, 'settings-cb-compact checkbox exists in settings modal');

        const compactCbUnchecked = await page.evaluate(() =>
            document.getElementById('settings-cb-compact').checked === false
        );
        assert(compactCbUnchecked, 'Compact checkbox is unchecked by default (localStorage empty)');

        // ── Group 2: Toolbar NOT compact by default ───────────────────────────
        console.log('\n  -- Group 2: Default Non-Compact State --');

        const notCompactByDefault = await page.evaluate(() =>
            !document.getElementById('toolbar').classList.contains('toolbar-compact')
        );
        assert(notCompactByDefault, '#toolbar does NOT have .toolbar-compact class by default');

        // Pen button should have text visible (font-size should not be 0)
        const penBtnFontSize = await page.evaluate(() => {
            const btn = document.querySelector('[data-tool="pen"]');
            return btn ? window.getComputedStyle(btn).fontSize : null;
        });
        assert(
            penBtnFontSize !== '0px',
            `Tool button font-size is not 0 in normal mode (got "${penBtnFontSize}")`
        );

        // ── Group 3: Toggle compact ON ────────────────────────────────────────
        console.log('\n  -- Group 3: Enable Compact Mode --');

        await page.evaluate(() => {
            document.getElementById('settings-cb-compact').click();
        });
        await page.waitForTimeout(100);

        const isCompact = await page.evaluate(() =>
            document.getElementById('toolbar').classList.contains('toolbar-compact')
        );
        assert(isCompact, '#toolbar has .toolbar-compact after checking the checkbox');

        const compactInStorage = await page.evaluate(() =>
            localStorage.getItem('portolancast-toolbar-compact') === 'true'
        );
        assert(compactInStorage, 'portolancast-toolbar-compact=true saved in localStorage');

        // Tool buttons should have font-size:0 when compact
        const penBtnFontSizeCompact = await page.evaluate(() => {
            const btn = document.querySelector('[data-tool="pen"]');
            return btn ? window.getComputedStyle(btn).fontSize : null;
        });
        assert(
            penBtnFontSizeCompact === '0px',
            `Tool button font-size is 0px in compact mode (got "${penBtnFontSizeCompact}")`
        );

        // The .icon span should still be visible (has explicit font-size)
        const iconFontSizeCompact = await page.evaluate(() => {
            const icon = document.querySelector('[data-tool="pen"] .icon');
            return icon ? window.getComputedStyle(icon).fontSize : null;
        });
        assert(
            iconFontSizeCompact !== '0px' && iconFontSizeCompact !== null,
            `Tool button .icon still has non-zero font-size in compact mode (got "${iconFontSizeCompact}")`
        );

        // ── Group 4: Compact mode persists across reload ──────────────────────
        console.log('\n  -- Group 4: Compact Mode Persistence --');

        await page.click('#settings-close');
        await page.waitForTimeout(100);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);

        const isCompactAfterReload = await page.evaluate(() =>
            document.getElementById('toolbar').classList.contains('toolbar-compact')
        );
        assert(isCompactAfterReload, '.toolbar-compact restored after page reload from localStorage');

        // ── Group 5: Toggle compact OFF via settings ──────────────────────────
        console.log('\n  -- Group 5: Disable Compact Mode --');

        await page.click('#btn-toolbar-settings');
        await page.waitForTimeout(200);

        const compactCbCheckedOnOpen = await page.evaluate(() =>
            document.getElementById('settings-cb-compact').checked
        );
        assert(compactCbCheckedOnOpen, 'Compact checkbox reflects current state (checked) when modal re-opens');

        await page.evaluate(() => {
            document.getElementById('settings-cb-compact').click();
        });
        await page.waitForTimeout(100);

        const notCompactAfterUncheck = await page.evaluate(() =>
            !document.getElementById('toolbar').classList.contains('toolbar-compact')
        );
        assert(notCompactAfterUncheck, '.toolbar-compact removed after unchecking compact checkbox');

        const notInStorageAfterUncheck = await page.evaluate(() =>
            localStorage.getItem('portolancast-toolbar-compact') === null
        );
        assert(notInStorageAfterUncheck, 'localStorage key removed after unchecking compact');

        // ── Group 6: Reset clears compact mode ───────────────────────────────
        console.log('\n  -- Group 6: Reset Clears Compact --');

        // Re-enable compact first
        await page.evaluate(() => {
            document.getElementById('settings-cb-compact').click();
        });
        await page.waitForTimeout(100);

        await page.click('#settings-reset');
        await page.waitForTimeout(100);

        const notCompactAfterReset = await page.evaluate(() =>
            !document.getElementById('toolbar').classList.contains('toolbar-compact')
        );
        assert(notCompactAfterReset, '.toolbar-compact removed after Reset button click');

        const notInStorageAfterReset = await page.evaluate(() =>
            localStorage.getItem('portolancast-toolbar-compact') === null
        );
        assert(notInStorageAfterReset, 'localStorage key removed after Reset button click');

        // ── Group 7: Escape key closes settings modal ─────────────────────────
        console.log('\n  -- Group 7: Escape Key Closes Settings --');

        // Modal should still be open after reset
        const modalOpenAfterReset = await page.evaluate(() =>
            document.getElementById('modal-toolbar-settings').style.display !== 'none'
        );
        assert(modalOpenAfterReset, 'Settings modal still open after reset');

        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);

        const modalClosedByEsc = await page.evaluate(() =>
            document.getElementById('modal-toolbar-settings').style.display === 'none'
        );
        assert(modalClosedByEsc, 'Settings modal closed by Escape key');

        // ── Group 8: Keyboard shortcut hints in settings rows ─────────────────
        console.log('\n  -- Group 8: Shortcut Hints in Settings --');

        await page.click('#btn-toolbar-settings');
        await page.waitForTimeout(200);

        // Pen button has title "Pen (P)" → hint "P" should appear
        const penHintText = await page.evaluate(() => {
            // Shortcut hint is a .settings-shortcut-hint sibling of the pen checkbox label
            const penCbLabel = document.getElementById('settings-cb-pen');
            if (!penCbLabel) return null;
            const row = penCbLabel.closest('label.settings-tool-item');
            if (!row) return null;
            const hint = row.querySelector('.settings-shortcut-hint');
            return hint ? hint.textContent.trim() : null;
        });
        assert(
            penHintText === 'P',
            `Pen settings row shows shortcut hint "P" (got "${penHintText}")`
        );

        // Distance tool has title "Distance Ruler (U)" → hint "U"
        const distHintText = await page.evaluate(() => {
            const cb = document.getElementById('settings-cb-distance');
            if (!cb) return null;
            const row = cb.closest('label.settings-tool-item');
            if (!row) return null;
            const hint = row.querySelector('.settings-shortcut-hint');
            return hint ? hint.textContent.trim() : null;
        });
        assert(
            distHintText === 'U',
            `Distance settings row shows shortcut hint "U" (got "${distHintText}")`
        );

        // Verify total number of hint chips matches tools with (X) in title
        const hintCount = await page.evaluate(() =>
            document.querySelectorAll('.settings-shortcut-hint').length
        );
        assert(hintCount > 0, `At least one shortcut hint rendered in settings (got ${hintCount})`);

        // Cleanup
        await page.click('#settings-close');
        await page.waitForTimeout(100);

    } finally {
        // Ensure localStorage is clean after tests
        await page.evaluate(() => {
            localStorage.removeItem('portolancast-toolbar-compact');
        }).catch(() => {});
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
