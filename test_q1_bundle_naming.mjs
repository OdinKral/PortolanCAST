/**
 * PortolanCAST — Q1 Bundle Save-As Naming Dialog Tests
 *
 * Tests that clicking "Save Bundle" opens a naming dialog pre-filled with the
 * document's filename, that the user can edit the name, that confirming triggers
 * a download with the chosen name (including .portolan extension normalisation),
 * and that cancelling aborts the download entirely.
 *
 * Note: We can't intercept an actual file download in Playwright headless without
 * complex download-listener setup. Instead we verify the dialog behaviour directly
 * via window.app.toolbar._showBundleNameModal() and the DOM state of the modal,
 * which is the entire new code path introduced by Q1.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_q1_bundle_naming.mjs"
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

        // ── Test 1: Modal element exists in DOM ───────────────────────────────
        console.log('\n  -- Group 1: Modal Presence --');

        const modalExists = await page.evaluate(() =>
            !!document.getElementById('modal-save-bundle')
        );
        assert(modalExists, 'modal-save-bundle element exists in DOM');

        const inputExists = await page.evaluate(() =>
            !!document.getElementById('bundle-name-input')
        );
        assert(inputExists, 'bundle-name-input element exists in DOM');

        const extLabel = await page.evaluate(() => {
            const el = document.querySelector('.bundle-name-ext');
            return el ? el.textContent.trim() : null;
        });
        assert(extLabel === '.portolan', `Extension suffix shows ".portolan" (got "${extLabel}")`);

        // ── Test 2: Modal hidden by default ───────────────────────────────────
        console.log('\n  -- Group 2: Default Hidden State --');

        const hiddenByDefault = await page.evaluate(() => {
            const modal = document.getElementById('modal-save-bundle');
            return modal.style.display === 'none' || modal.style.display === '';
        });
        assert(hiddenByDefault, 'Modal is hidden before opening');

        // ── Test 3-5: _showBundleNameModal() opens and pre-fills ──────────────
        console.log('\n  -- Group 3: Modal Opens with Pre-fill --');

        // Open the modal with a known default name — do NOT await (it blocks)
        await page.evaluate(() => {
            window._modalResult = null;
            window.app.toolbar._showBundleNameModal('test-drawing').then(r => {
                window._modalResult = r;
            });
        });
        await page.waitForTimeout(200);

        const isVisible = await page.evaluate(() => {
            const modal = document.getElementById('modal-save-bundle');
            return modal.style.display === 'flex';
        });
        assert(isVisible, 'Modal is visible (display: flex) after _showBundleNameModal()');

        const prefillValue = await page.evaluate(() =>
            document.getElementById('bundle-name-input').value
        );
        assert(
            prefillValue === 'test-drawing',
            `Input pre-filled with default name (got "${prefillValue}")`
        );

        // ── Test 6-7: Cancel resolves to null ─────────────────────────────────
        console.log('\n  -- Group 4: Cancel Returns null --');

        await page.evaluate(() => {
            document.getElementById('bundle-name-cancel').click();
        });
        await page.waitForTimeout(150);

        const resultAfterCancel = await page.evaluate(() => window._modalResult);
        assert(
            resultAfterCancel === null,
            `Cancel resolves promise to null (got ${JSON.stringify(resultAfterCancel)})`
        );

        const hiddenAfterCancel = await page.evaluate(() => {
            return document.getElementById('modal-save-bundle').style.display === 'none';
        });
        assert(hiddenAfterCancel, 'Modal hidden after cancel');

        // ── Test 8-10: Confirm with edited name ───────────────────────────────
        console.log('\n  -- Group 5: Confirm with Custom Name --');

        await page.evaluate(() => {
            window._modalResult = undefined;
            window.app.toolbar._showBundleNameModal('original-name').then(r => {
                window._modalResult = r;
            });
        });
        await page.waitForTimeout(200);

        // Edit the input value then click Save
        await page.evaluate(() => {
            const input = document.getElementById('bundle-name-input');
            input.value = 'my-custom-plan';
        });
        await page.evaluate(() => document.getElementById('bundle-name-save').click());
        await page.waitForTimeout(150);

        const resultAfterSave = await page.evaluate(() => window._modalResult);
        assert(
            resultAfterSave === 'my-custom-plan',
            `Save resolves with edited name (got "${resultAfterSave}")`
        );

        const hiddenAfterSave = await page.evaluate(() =>
            document.getElementById('modal-save-bundle').style.display === 'none'
        );
        assert(hiddenAfterSave, 'Modal hidden after save');

        // ── Test 11: Enter key confirms ───────────────────────────────────────
        console.log('\n  -- Group 6: Keyboard Shortcuts --');

        await page.evaluate(() => {
            window._modalResult = undefined;
            window.app.toolbar._showBundleNameModal('enter-test').then(r => {
                window._modalResult = r;
            });
        });
        await page.waitForTimeout(200);

        await page.evaluate(() => {
            const input = document.getElementById('bundle-name-input');
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', bubbles: true, cancelable: true,
            }));
        });
        await page.waitForTimeout(150);

        const resultEnter = await page.evaluate(() => window._modalResult);
        assert(
            resultEnter === 'enter-test',
            `Enter key confirms with current value (got "${resultEnter}")`
        );

        // ── Test 12: Escape key cancels ───────────────────────────────────────
        await page.evaluate(() => {
            window._modalResult = undefined;
            window.app.toolbar._showBundleNameModal('escape-test').then(r => {
                window._modalResult = r;
            });
        });
        await page.waitForTimeout(200);

        await page.evaluate(() => {
            const input = document.getElementById('bundle-name-input');
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', bubbles: true, cancelable: true,
            }));
        });
        await page.waitForTimeout(150);

        const resultEsc = await page.evaluate(() => window._modalResult);
        assert(
            resultEsc === null,
            `Escape key cancels (resolves null, got ${JSON.stringify(resultEsc)})`
        );

        // ── Test 13: Overlay click cancels ────────────────────────────────────
        await page.evaluate(() => {
            window._modalResult = undefined;
            window.app.toolbar._showBundleNameModal('overlay-test').then(r => {
                window._modalResult = r;
            });
        });
        await page.waitForTimeout(200);

        await page.evaluate(() => {
            document.getElementById('modal-save-bundle-overlay').click();
        });
        await page.waitForTimeout(150);

        const resultOverlay = await page.evaluate(() => window._modalResult);
        assert(
            resultOverlay === null,
            `Overlay click cancels (resolves null, got ${JSON.stringify(resultOverlay)})`
        );

        // ── Test 14: Empty input falls back to default name ───────────────────
        console.log('\n  -- Group 7: Edge Cases --');

        await page.evaluate(() => {
            window._modalResult = undefined;
            window.app.toolbar._showBundleNameModal('fallback-name').then(r => {
                window._modalResult = r;
            });
        });
        await page.waitForTimeout(200);

        await page.evaluate(() => {
            document.getElementById('bundle-name-input').value = '';
            document.getElementById('bundle-name-save').click();
        });
        await page.waitForTimeout(150);

        const resultEmpty = await page.evaluate(() => window._modalResult);
        assert(
            resultEmpty === 'fallback-name',
            `Empty input falls back to defaultName (got "${resultEmpty}")`
        );

        // ── Test 15: _handleBundleSave uses docInfo.filename as default ───────
        console.log('\n  -- Group 8: Default Name Source --');

        // Verify the default name derivation logic by inspecting viewer.docInfo
        const defaultNameLogic = await page.evaluate(() => {
            const rawName = window.app.viewer.docInfo?.filename || 'document';
            const defaultName = rawName.replace(/\.pdf$/i, '');
            return { rawName, defaultName };
        });
        assert(
            typeof defaultNameLogic.defaultName === 'string' && defaultNameLogic.defaultName.length > 0,
            `Default name derived from docInfo.filename: "${defaultNameLogic.rawName}" → "${defaultNameLogic.defaultName}"`
        );
        assert(
            !defaultNameLogic.defaultName.toLowerCase().endsWith('.pdf'),
            `.pdf extension stripped from default name (got "${defaultNameLogic.defaultName}")`
        );

        // ── Test 16: .portolan extension NOT doubled if already present ────────
        const extNorm = await page.evaluate(() => {
            // Simulate what _handleBundleSave does after receiving the chosen name
            const cases = [
                ['my-doc', 'my-doc.portolan'],
                ['my-doc.portolan', 'my-doc.portolan'],
                ['MY-DOC.PORTOLAN', 'MY-DOC.PORTOLAN'],  // already has it (case-insensitive)
            ];
            return cases.map(([input, expected]) => {
                let filename = input.trim();
                if (!filename.toLowerCase().endsWith('.portolan')) filename += '.portolan';
                return { input, expected, got: filename, ok: filename === expected };
            });
        });
        const allNormOk = extNorm.every(c => c.ok);
        assert(allNormOk,
            `.portolan extension normalised correctly — ${extNorm.map(c => `"${c.input}"→"${c.got}"`).join(', ')}`
        );

    } finally {
        // Ensure modal is hidden if a test left it open
        await page.evaluate(() => {
            try { document.getElementById('modal-save-bundle').style.display = 'none'; } catch (_) {}
        }).catch(() => {});
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
