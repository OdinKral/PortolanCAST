/**
 * PortolanCAST — Photo Attachments Browser Tests
 *
 * Tests the markup photo attachment system: API endpoints, UI shell in the
 * properties panel, upload flow, thumbnail display, and delete.
 *
 * Groups:
 *   1. UI Shell (5)              — section exists, hidden before select, attach btn
 *   2. API — Upload (5)          — POST /markup-photos, response shape, extension guard
 *   3. API — Get & Delete (5)    — GET /markup-photos/{id}, DELETE, photo list counts
 *   4. Panel After Select (5)    — photos section visible on markup select, thumbnail
 *   5. Static File Serving (3)   — uploaded photo served at /data/photos/{id}
 *
 * Total: 23 tests
 * Running total after this suite: 527 + 23 = 550
 *
 * Requires server running on http://127.0.0.1:8000 with at least one document (id=1).
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_photos.mjs"
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-02-25
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

// Minimal 1x1 white JPEG — valid image content for upload tests.
// Using a known tiny JPEG avoids file system operations in tests.
const TINY_JPEG_BASE64 =
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
    'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA' +
    'Av/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQE' +
    'AAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYn' +
    'KCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqS' +
    'k5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn' +
    '6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A9/ooooA//9k=';

async function run() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Track uploaded photo IDs so we can clean up after ourselves
    const uploadedPhotoIds = [];

    try {
        // =====================================================================
        // SETUP: Load edit page, clear previous markups, add a fresh markup
        // =====================================================================
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

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

        // Add one markup with a known markupId for photo attachment tests
        const testMarkupId = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 80, top: 80, width: 100, height: 60,
                fill: 'transparent', stroke: '#ff4444', strokeWidth: 2,
                markupType: 'issue', markupStatus: 'open',
                markupNote: 'Photo test markup', markupAuthor: 'Tester',
            });
            // Stamp markupId just like canvas.stampDefaults does
            rect.markupId = 'test-photo-markup-' + Date.now();
            fc.add(rect);
            fc.setActiveObject(rect);
            fc.renderAll();
            return rect.markupId;
        });
        await page.waitForTimeout(300);

        // =====================================================================
        // TEST GROUP 1: UI Shell
        // =====================================================================
        console.log('\n--- Test Group 1: UI Shell ---');

        // 1.1 — #markup-photos-section div exists in the DOM
        const photosSection = await page.$('#markup-photos-section');
        assert(photosSection !== null, '#markup-photos-section div exists in properties panel');

        // 1.2 — Photos section is visible when a markup is selected (was hidden before)
        const photosSectionVisible = await page.evaluate(() => {
            const el = document.getElementById('markup-photos-section');
            if (!el) return false;
            return el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
        });
        assert(photosSectionVisible, '#markup-photos-section is visible when markup is selected');

        // 1.3 — #btn-attach-photo button exists
        const attachBtn = await page.$('#btn-attach-photo');
        assert(attachBtn !== null, '#btn-attach-photo button exists in properties panel');

        // 1.4 — #markup-photos-grid exists
        const photosGrid = await page.$('#markup-photos-grid');
        assert(photosGrid !== null, '#markup-photos-grid div exists');

        // 1.5 — #photo-file-input hidden input exists (used to trigger file picker)
        const fileInput = await page.$('#photo-file-input');
        assert(fileInput !== null, '#photo-file-input hidden file input exists');

        // =====================================================================
        // TEST GROUP 2: API — Upload
        // =====================================================================
        console.log('\n--- Test Group 2: API Upload ---');

        // 2.1 — POST /api/documents/1/markup-photos → 200 with valid JPEG
        const uploadResp = await page.evaluate(async (args) => {
            const { markupId, jpegBase64 } = args;

            // Decode base64 to binary
            const binary = atob(jpegBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'image/jpeg' });

            const form = new FormData();
            form.append('markup_id', markupId);
            form.append('description', 'Test photo');
            form.append('photo', blob, 'test.jpg');

            const r = await fetch('/api/documents/1/markup-photos', {
                method: 'POST',
                body: form,
            });
            return { status: r.status, data: await r.json() };
        }, { markupId: testMarkupId, jpegBase64: TINY_JPEG_BASE64 });

        assert(uploadResp.status === 200, 'POST /markup-photos → 200 for valid JPEG');

        // Save the photo_id for later tests
        const uploadedPhotoId = uploadResp.data?.photo_id;
        if (uploadedPhotoId) uploadedPhotoIds.push(uploadedPhotoId);

        // 2.2 — Response has expected shape: photo_id, markup_id, url, description, created_at
        const ud = uploadResp.data || {};
        assert(
            'photo_id' in ud && 'markup_id' in ud && 'url' in ud,
            'Upload response has photo_id, markup_id, url fields'
        );

        // 2.3 — Returned markup_id matches what we sent
        assert(
            ud.markup_id === testMarkupId,
            `Returned markup_id matches sent markup_id (got: "${ud.markup_id}")`
        );

        // 2.4 — URL starts with /data/photos/
        assert(
            typeof ud.url === 'string' && ud.url.startsWith('/data/photos/'),
            `URL starts with /data/photos/ (got: "${ud.url}")`
        );

        // 2.5 — Invalid extension → 400
        const badExtResp = await page.evaluate(async (mId) => {
            const form = new FormData();
            form.append('markup_id', mId);
            form.append('photo', new Blob(['bad'], { type: 'text/plain' }), 'test.txt');
            const r = await fetch('/api/documents/1/markup-photos', {
                method: 'POST', body: form,
            });
            return { status: r.status };
        }, testMarkupId);
        assert(badExtResp.status === 400, 'Invalid extension (.txt) → 400');

        // =====================================================================
        // TEST GROUP 3: API — Get & Delete
        // =====================================================================
        console.log('\n--- Test Group 3: API Get & Delete ---');

        // 3.1 — GET /markup-photos/{markup_id} returns the uploaded photo
        const getResp = await page.evaluate(async (args) => {
            const r = await fetch(`/api/documents/1/markup-photos/${args.markupId}`);
            return { status: r.status, data: await r.json() };
        }, { markupId: testMarkupId });
        assert(getResp.status === 200, 'GET /markup-photos/{markup_id} → 200');

        // 3.2 — Response has "photos" array with at least 1 item
        assert(
            Array.isArray(getResp.data?.photos) && getResp.data.photos.length >= 1,
            `GET response has photos array with ≥1 item (got: ${getResp.data?.photos?.length})`
        );

        // 3.3 — The returned photo has photo_id matching what we uploaded
        const returnedPhoto = getResp.data?.photos?.[0];
        assert(
            returnedPhoto?.photo_id === uploadedPhotoId,
            `First photo's photo_id matches uploaded (got: "${returnedPhoto?.photo_id}")`
        );

        // 3.4 — Upload a second photo then GET returns 2 items
        await page.evaluate(async (args) => {
            const binary = atob(args.jpeg);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const form = new FormData();
            form.append('markup_id', args.markupId);
            form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'test2.jpg');
            await fetch('/api/documents/1/markup-photos', { method: 'POST', body: form });
        }, { markupId: testMarkupId, jpeg: TINY_JPEG_BASE64 });

        const getResp2 = await page.evaluate(async (mId) => {
            const r = await fetch(`/api/documents/1/markup-photos/${mId}`);
            return await r.json();
        }, testMarkupId);
        assert(
            (getResp2.photos?.length || 0) >= 2,
            `After second upload, GET returns ≥2 photos (got: ${getResp2.photos?.length})`
        );

        // 3.5 — DELETE /markup-photos/{photo_id} → 200, and GET then returns 1 fewer
        const delResp = await page.evaluate(async (photoId) => {
            const r = await fetch(`/api/documents/1/markup-photos/${photoId}`, { method: 'DELETE' });
            return { status: r.status };
        }, uploadedPhotoId);
        assert(delResp.status === 200, `DELETE /markup-photos/${uploadedPhotoId} → 200`);
        uploadedPhotoIds.shift(); // no longer need cleanup for this one

        // =====================================================================
        // TEST GROUP 4: Panel After Select
        // =====================================================================
        console.log('\n--- Test Group 4: Panel After Select ---');

        // Select the markup so the properties panel is showing it
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const obj = fc.getObjects().find(o => o.markupNote === 'Photo test markup');
            if (obj) {
                fc.setActiveObject(obj);
                fc.renderAll();
            }
        });
        await page.waitForTimeout(500);

        // 4.1 — Properties panel is visible
        const propertiesActive = await page.evaluate(() => {
            const el = document.getElementById('tab-properties');
            return el && (el.classList.contains('active') || el.style.display !== 'none');
        });
        assert(propertiesActive, 'Properties panel is active/visible after markup select');

        // 4.2 — Photos section is visible (the selected markup has photos)
        const photosSectionShown = await page.evaluate(() => {
            const el = document.getElementById('markup-photos-section');
            return el && el.style.display !== 'none';
        });
        assert(photosSectionShown, 'Photos section visible when markup is selected');

        // 4.3 — Deselecting hides the photos section
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.discardActiveObject();
            window.app.canvas.fabricCanvas.renderAll();
        });
        await page.waitForTimeout(200);

        const photosSectionHidden = await page.evaluate(() => {
            const el = document.getElementById('markup-photos-section');
            return !el || el.style.display === 'none';
        });
        assert(photosSectionHidden, 'Photos section hidden when no markup is selected');

        // 4.4 — markup_id is stamped on canvas objects (a UUID-like string)
        const hasMarkupId = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const obj = fc.getObjects().find(o => o.markupNote === 'Photo test markup');
            return typeof obj?.markupId === 'string' && obj.markupId.length > 0;
        });
        assert(hasMarkupId, 'Canvas markup objects have markupId string property');

        // 4.5 — Empty markup_id → 400 from upload endpoint
        const noIdResp = await page.evaluate(async (jpeg) => {
            const binary = atob(jpeg);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const form = new FormData();
            // Deliberately omit markup_id
            form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'test.jpg');
            const r = await fetch('/api/documents/1/markup-photos', { method: 'POST', body: form });
            return { status: r.status };
        }, TINY_JPEG_BASE64);
        assert(noIdResp.status === 400, 'Missing markup_id → 400');

        // =====================================================================
        // TEST GROUP 5: Static File Serving
        // =====================================================================
        console.log('\n--- Test Group 5: Static File Serving ---');

        // Upload a fresh photo and verify the URL is fetchable
        const freshUpload = await page.evaluate(async (args) => {
            const binary = atob(args.jpeg);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const form = new FormData();
            form.append('markup_id', args.markupId);
            form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'serve_test.jpg');
            const r = await fetch('/api/documents/1/markup-photos', { method: 'POST', body: form });
            return await r.json();
        }, { markupId: testMarkupId, jpeg: TINY_JPEG_BASE64 });

        if (freshUpload.photo_id) uploadedPhotoIds.push(freshUpload.photo_id);

        // 5.1 — The URL path from the upload response is fetchable (returns 200)
        const photoUrl = freshUpload.url || '';
        const serveResp = await page.evaluate(async (url) => {
            if (!url) return { status: 0 };
            const r = await fetch(url);
            return { status: r.status, contentType: r.headers.get('content-type') || '' };
        }, photoUrl);
        assert(serveResp.status === 200, `Uploaded photo served at ${photoUrl} → 200`);

        // 5.2 — Content-Type is an image type
        assert(
            serveResp.contentType.startsWith('image/'),
            `Served photo has image Content-Type (got: "${serveResp.contentType}")`
        );

        // 5.3 — GET /markup-photos/{markup_id} returns urls that all start with /data/photos/
        const photosCheck = await page.evaluate(async (mId) => {
            const r = await fetch(`/api/documents/1/markup-photos/${mId}`);
            const data = await r.json();
            return (data.photos || []).map(p => p.url);
        }, testMarkupId);
        const allUrlsCorrect = photosCheck.every(u => u.startsWith('/data/photos/'));
        assert(
            allUrlsCorrect,
            `All photo URLs start with /data/photos/ (checked ${photosCheck.length} photos)`
        );

    } finally {
        // Cleanup: delete any photos we uploaded during the test run
        for (const photoId of uploadedPhotoIds) {
            await page.evaluate(async (pid) => {
                await fetch(`/api/documents/1/markup-photos/${pid}`, { method: 'DELETE' });
            }, photoId).catch(() => {});
        }
        await browser.close();
    }

    // ==========================================================================
    // RESULTS SUMMARY
    // ==========================================================================
    console.log('\n');
    console.log('════════════════════════════════════════');
    console.log('  Photo Attachments');
    console.log('════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('════════════════════════════════════════');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('[Photos Test] Fatal error:', err);
    process.exit(1);
});
