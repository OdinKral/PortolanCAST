/**
 * PortolanCAST — L1 Landscape Canvas Rotation Tests
 *
 * Tests that the rotate button (⟳) cycles the view 90° clockwise and that:
 *   1. viewer.rotation cycles 0 → 90 → 180 → 270 → 0.
 *   2. The page URL re-renders with ?rotate=N so the server returns a rotated PNG.
 *   3. The rendered image changes dimensions (width↔height swapped for 90°).
 *   4. The Fabric canvas overlay resizes to match the new image dimensions.
 *   5. setRotation() accepts only valid values (0, 90, 180, 270).
 *   6. Rotate button is present in the DOM.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_l1_rotation.mjs"
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

        // ── Group 1: DOM presence ─────────────────────────────────────────────
        console.log('\n  -- Group 1: Rotate Button Presence --');

        const btnExists = await page.evaluate(() =>
            !!document.getElementById('btn-rotate')
        );
        assert(btnExists, 'btn-rotate button exists in DOM');

        const btnTitle = await page.evaluate(() =>
            document.getElementById('btn-rotate').title
        );
        assert(
            typeof btnTitle === 'string' && btnTitle.length > 0,
            `btn-rotate has title attribute (got "${btnTitle}")`
        );

        // ── Group 2: Initial rotation state ──────────────────────────────────
        console.log('\n  -- Group 2: Initial State --');

        const initialRotation = await page.evaluate(() =>
            window.app.viewer.rotation
        );
        assert(initialRotation === 0, `Initial rotation is 0° (got ${initialRotation})`);

        // ── Group 3: Capture natural dims at 0° ──────────────────────────────
        console.log('\n  -- Group 3: Dimension Capture and Rotation --');

        const dims0 = await page.evaluate(() => ({
            w: window.app.viewer.imageNaturalWidth,
            h: window.app.viewer.imageNaturalHeight,
        }));
        assert(
            dims0.w > 0 && dims0.h > 0,
            `Page has valid natural dimensions at 0°: ${dims0.w}×${dims0.h}`
        );

        // ── Group 4: Click rotate once → 90° ─────────────────────────────────
        await page.click('#btn-rotate');
        await page.waitForTimeout(1500); // wait for network re-render

        const rotation90 = await page.evaluate(() =>
            window.app.viewer.rotation
        );
        assert(rotation90 === 90, `After one click, rotation is 90° (got ${rotation90})`);

        const dims90 = await page.evaluate(() => ({
            w: window.app.viewer.imageNaturalWidth,
            h: window.app.viewer.imageNaturalHeight,
        }));

        // At 90° the image dims should be swapped (for a non-square page)
        // For square pages dims could be equal — just check they changed OR page is square
        const isSquarePage = dims0.w === dims0.h;
        if (isSquarePage) {
            assert(dims90.w > 0 && dims90.h > 0, 'Rotated image has valid dimensions (square page)');
        } else {
            assert(
                dims90.w === dims0.h && dims90.h === dims0.w,
                `90° rotation swaps dimensions: ${dims0.w}×${dims0.h} → ${dims90.w}×${dims90.h}`
            );
        }

        // ── Group 5: Fabric canvas resizes to match image ─────────────────────
        // After rotation, fitToWidth() auto-adjusts zoom so the rotated page
        // fills the viewport. The Fabric canvas dimensions are DISPLAY size
        // (natural * zoom/100), so we check aspect ratio matches, not absolute dims.
        const canvasDims = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            return { w: fc.width, h: fc.height };
        });
        const imageAspect = dims90.w / dims90.h;
        const canvasAspect = canvasDims.w / canvasDims.h;
        assert(
            Math.abs(imageAspect - canvasAspect) < 0.02,
            `Fabric canvas matches rotated image: canvas ${canvasDims.w}×${canvasDims.h} = image ${dims90.w}×${dims90.h}`
        );

        // ── Group 6: Second click → 180° ─────────────────────────────────────
        console.log('\n  -- Group 4: Full Rotation Cycle --');

        await page.click('#btn-rotate');
        await page.waitForTimeout(1500);

        const rotation180 = await page.evaluate(() =>
            window.app.viewer.rotation
        );
        assert(rotation180 === 180, `After two clicks, rotation is 180° (got ${rotation180})`);

        const dims180 = await page.evaluate(() => ({
            w: window.app.viewer.imageNaturalWidth,
            h: window.app.viewer.imageNaturalHeight,
        }));
        // 180° should restore original aspect (same W×H as 0°)
        assert(
            dims180.w === dims0.w && dims180.h === dims0.h,
            `180° restores original dimensions: ${dims180.w}×${dims180.h} == ${dims0.w}×${dims0.h}`
        );

        // ── Group 7: Two more clicks → back to 0° ────────────────────────────
        await page.click('#btn-rotate');
        await page.waitForTimeout(1500);
        await page.click('#btn-rotate');
        await page.waitForTimeout(1500);

        const rotation0 = await page.evaluate(() =>
            window.app.viewer.rotation
        );
        assert(rotation0 === 0, `After four total clicks, rotation wraps back to 0° (got ${rotation0})`);

        // ── Group 8: setRotation() input validation ───────────────────────────
        console.log('\n  -- Group 5: setRotation() Validation --');

        const validationResult = await page.evaluate(async () => {
            const v = window.app.viewer;
            const results = [];

            // Valid values
            for (const deg of [0, 90, 180, 270]) {
                v.setRotation(deg);
                results.push({ input: deg, got: v.rotation, ok: v.rotation === deg });
            }

            // Invalid value should snap to 0
            v.setRotation(45);
            results.push({ input: 45, got: v.rotation, ok: v.rotation === 0 });

            v.setRotation(-90);
            results.push({ input: -90, got: v.rotation, ok: v.rotation === 0 });

            return results;
        });
        // Wait for the last setRotation re-render
        await page.waitForTimeout(1500);

        for (const r of validationResult) {
            assert(r.ok, `setRotation(${r.input}) → rotation=${r.got} (expected ${r.input === 45 || r.input === -90 ? 0 : r.input})`);
        }

        // ── Group 9: Page URL includes rotate param ───────────────────────────
        console.log('\n  -- Group 6: URL Parameter --');

        // Inspect pdfImage.src (or currentSrc) — includes the rotate= param
        // even when served from cache, so we don't need to intercept the network.
        await page.evaluate(() => window.app.viewer.setRotation(90));
        await page.waitForTimeout(1500);

        const imgSrc = await page.evaluate(() =>
            window.app.viewer.pdfImage.src || window.app.viewer.pdfImage.currentSrc
        );
        assert(
            typeof imgSrc === 'string' && imgSrc.includes('rotate='),
            `pdfImage.src includes rotate= parameter (${imgSrc})`
        );

        const urlRotateValue = new URL(imgSrc).searchParams.get('rotate');
        assert(
            ['0', '90', '180', '270'].includes(urlRotateValue),
            `rotate= param has valid value (got "${urlRotateValue}")`
        );

        // The rotate value in the URL must match viewer.rotation
        const viewerRot = await page.evaluate(() => String(window.app.viewer.rotation));
        assert(
            urlRotateValue === viewerRot,
            `URL rotate=${urlRotateValue} matches viewer.rotation=${viewerRot}`
        );

        // Restore to 0° to leave clean state for other tests
        await page.evaluate(() => window.app.viewer.setRotation(0));
        await page.waitForTimeout(1500);

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
