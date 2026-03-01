/**
 * PortolanCAST — B3 Scroll Navigation Fix Verification
 *
 * Tests that wheel events over the Fabric canvas area correctly forward to
 * #viewport for natural page scrolling, rather than being swallowed by
 * Fabric.js internal event handling.
 *
 * Root cause (B3): Fabric.js calls preventDefault() on wheel events on its
 * canvas layers, cancelling the browser's native scroll before the event
 * reaches #viewport. Fix: a capture-phase wheel listener on the Fabric
 * wrapper intercepts non-Ctrl events and manually applies scroll deltas to
 * #viewport, bypassing Fabric's handlers entirely.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_b3_scroll.mjs"
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

        // ── Test 1: Infrastructure — wrapper and canvas are ready ────────────
        console.log('\n  -- Group 1: Infrastructure --');

        const hasWrapper = await page.evaluate(() => {
            return !!(
                window.app &&
                window.app.canvas &&
                window.app.canvas.fabricCanvas &&
                window.app.canvas.fabricCanvas.wrapperEl
            );
        });
        assert(hasWrapper, 'Fabric canvas wrapperEl is accessible via window.app.canvas');

        // ── Test 2-3: Downward scroll over canvas moves viewport.scrollTop ───
        console.log('\n  -- Group 2: Vertical Scroll Forwarding --');

        // Zoom in so content overflows the viewport (makes it scrollable)
        await page.evaluate(() => {
            window.app.viewer.setZoom(300);
            window.app.viewer.viewport.scrollTop = 0;   // start from top
        });
        await page.waitForTimeout(300);

        const scrollTopBefore = await page.evaluate(() => window.app.viewer.viewport.scrollTop);
        assert(scrollTopBefore === 0, `Viewport starts at scrollTop=0 (got ${scrollTopBefore})`);

        // Dispatch a plain (non-Ctrl) wheel event on the Fabric wrapper.
        // In a real browser, this originates on upper-canvas but bubbles up.
        // Dispatching on the wrapper exercises the same capture listener.
        await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            wrapper.dispatchEvent(new WheelEvent('wheel', {
                deltaX: 0,
                deltaY: 120,    // 120 pixels down
                deltaMode: 0,   // DOM_DELTA_PIXEL
                bubbles: true,
                cancelable: true,
            }));
        });
        await page.waitForTimeout(100);

        const scrollTopAfter = await page.evaluate(() => window.app.viewer.viewport.scrollTop);
        assert(
            scrollTopAfter >= 120,
            `Viewport scrollTop increased by deltaY after wheel-down (before=${scrollTopBefore}, after=${scrollTopAfter})`
        );

        // ── Test 4: Horizontal scroll over canvas moves viewport.scrollLeft ──
        console.log('\n  -- Group 3: Horizontal Scroll Forwarding --');

        await page.evaluate(() => {
            window.app.viewer.viewport.scrollLeft = 0;
        });
        const scrollLeftBefore = await page.evaluate(() => window.app.viewer.viewport.scrollLeft);

        await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            wrapper.dispatchEvent(new WheelEvent('wheel', {
                deltaX: 80,
                deltaY: 0,
                deltaMode: 0,
                bubbles: true,
                cancelable: true,
            }));
        });
        await page.waitForTimeout(100);

        const scrollLeftAfter = await page.evaluate(() => window.app.viewer.viewport.scrollLeft);
        assert(
            scrollLeftAfter >= 80,
            `Viewport scrollLeft increased by deltaX after horizontal wheel (before=${scrollLeftBefore}, after=${scrollLeftAfter})`
        );

        // ── Test 5: Ctrl+wheel zooms (does not scroll) ───────────────────────
        console.log('\n  -- Group 4: Ctrl+Wheel Triggers Zoom, Not Scroll --');

        await page.evaluate(() => {
            window.app.viewer.setZoom(100);
            window.app.viewer.viewport.scrollTop = 0;
        });
        await page.waitForTimeout(200);

        const zoomBefore = await page.evaluate(() => window.app.viewer.zoom);

        // Ctrl+wheel — our capture listener returns early, event bubbles to #viewport
        await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            wrapper.dispatchEvent(new WheelEvent('wheel', {
                deltaX: 0,
                deltaY: -60,    // negative = scroll up = zoom-in direction
                deltaMode: 0,
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }));
        });
        await page.waitForTimeout(200);

        const [zoomAfter, scrollAfterCtrl] = await page.evaluate(() => [
            window.app.viewer.zoom,
            window.app.viewer.viewport.scrollTop,
        ]);
        assert(
            zoomAfter > zoomBefore,
            `Ctrl+wheel increases zoom (was ${zoomBefore}%, now ${zoomAfter}%)`
        );
        // scrollTop should stay at 0 since this was a zoom action, not a scroll
        assert(
            scrollAfterCtrl === 0,
            `Ctrl+wheel does not scroll viewport (scrollTop=${scrollAfterCtrl}, expected 0)`
        );

        // ── Test 6: DOM_DELTA_LINE mode converted to pixels ──────────────────
        console.log('\n  -- Group 5: Line-Mode Delta Conversion --');

        await page.evaluate(() => {
            window.app.viewer.setZoom(300);
            window.app.viewer.viewport.scrollTop = 0;
        });
        await page.waitForTimeout(200);

        await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            wrapper.dispatchEvent(new WheelEvent('wheel', {
                deltaX: 0,
                deltaY: 4,          // 4 lines (DOM_DELTA_LINE = 1)
                deltaMode: 1,
                bubbles: true,
                cancelable: true,
            }));
        });
        await page.waitForTimeout(100);

        const scrollAfterLine = await page.evaluate(() => window.app.viewer.viewport.scrollTop);
        // 4 lines × 24px/line = 96px expected
        assert(
            scrollAfterLine >= 96,
            `DOM_DELTA_LINE(4) scrolls ~96px (scrollTop=${scrollAfterLine}, expected ≥96)`
        );

        // ── Test 7: Scroll works regardless of active tool ───────────────────
        console.log('\n  -- Group 6: Tool-Independent Scrolling --');

        // Switch to rect (drawing) tool — scroll should still forward to viewport
        await page.evaluate(() => {
            window.app.toolbar.setTool('rect');
            window.app.viewer.viewport.scrollTop = 0;
        });
        await page.waitForTimeout(200);

        await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            wrapper.dispatchEvent(new WheelEvent('wheel', {
                deltaX: 0, deltaY: 80, deltaMode: 0, bubbles: true, cancelable: true,
            }));
        });
        await page.waitForTimeout(100);

        const scrollInDrawMode = await page.evaluate(() => window.app.viewer.viewport.scrollTop);
        assert(
            scrollInDrawMode >= 80,
            `Scroll forwards to viewport even with drawing tool active (scrollTop=${scrollInDrawMode})`
        );

    } finally {
        // Restore neutral state
        await page.evaluate(() => {
            try {
                window.app.toolbar.setTool('select');
                window.app.viewer.setZoom(100);
            } catch (_) {}
        }).catch(() => {});
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
