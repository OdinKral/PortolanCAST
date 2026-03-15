/**
 * PortolanCAST — Parts Inventory Tests
 *
 * Purpose:
 *   Validates the Parts Inventory module: entity parts CRUD API,
 *   cross-entity parts listing, and EntityModal parts section UI.
 *
 * Groups:
 *   Group 1: Parts CRUD API (9 tests)
 *   Group 2: Cross-Entity Parts API (4 tests)
 *   Group 3: EntityModal Parts Section — Browser (7 tests)
 *   Group 4: Input Validation (5 tests)
 *
 * Design:
 *   - Per-run timestamp prefix on tag numbers prevents UNIQUE collisions.
 *   - Entities created during the run are cleaned up in finally.
 *   - API tests run via page.evaluate() to use the browser fetch context.
 *
 * Run:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_parts_inventory.mjs"
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-03-14
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID   = 1;
let passed = 0;
let failed = 0;

// Per-run unique suffix prevents UNIQUE constraint collisions between runs.
const RUN_TAG = `${Date.now()}`;

// Tracks entity IDs for cleanup in finally.
const createdEntityIds = [];

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

// Helper: create an entity via API and track for cleanup
async function apiCreateEntity(page, tag, extra = {}) {
    const data = await page.evaluate(async ({ tag, extra }) => {
        const r = await fetch('/api/entities', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_number: tag, ...extra }),
        });
        return { status: r.status, body: await r.json() };
    }, { tag, extra });
    return data;
}

// Helper: delete entity (best-effort, used in cleanup)
async function apiDeleteEntity(page, entityId) {
    await page.evaluate(async (id) => {
        await fetch(`/api/entities/${id}`, { method: 'DELETE' });
    }, entityId);
}

async function run() {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to editor with a document loaded
    await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
    // Wait for app to initialize
    await page.waitForFunction(() => window.app && window.app.canvas);
    await page.waitForTimeout(500);

    try {
        // =================================================================
        // GROUP 1: Parts CRUD API (9 tests)
        // =================================================================
        console.log('\nGroup 1: Parts CRUD API');

        // Create a test entity
        const partsEntityTag = `PARTS-${RUN_TAG}`;
        const entityResult = await apiCreateEntity(page, partsEntityTag, {
            equip_type: 'AHU',
            building: 'Test Building',
            location: 'MER-1',
        });
        assert(entityResult.status === 201, '1.1 Create test entity');
        // POST /api/entities returns entity at top level, not wrapped in .entity
        const entityId = entityResult.body.id;
        if (entityId) createdEntityIds.push(entityId);

        // 1.2 Create a part
        const createResult = await page.evaluate(async (eid) => {
            const r = await fetch(`/api/entities/${eid}/parts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    part_number: 'BELT-001',
                    description: 'Replacement Belt Assembly',
                    quantity: 3,
                    unit: 'each',
                    location: 'Bin A5',
                    notes: 'OEM part, fits AHU-3 only',
                }),
            });
            return { status: r.status, body: await r.json() };
        }, entityId);
        assert(createResult.status === 201, '1.2 Create part returns 201');
        assert(createResult.body.part?.part_number === 'BELT-001', '1.3 Part number matches');
        assert(createResult.body.part?.quantity === 3, '1.4 Quantity matches');
        const partId = createResult.body.part?.id;

        // 1.5 List parts for entity
        const listResult = await page.evaluate(async (eid) => {
            const r = await fetch(`/api/entities/${eid}/parts`);
            return { status: r.status, body: await r.json() };
        }, entityId);
        assert(listResult.status === 200, '1.5 List parts returns 200');
        assert(listResult.body.parts?.length === 1, '1.6 One part in list');

        // 1.7 Update part quantity
        const updateResult = await page.evaluate(async (pid) => {
            const r = await fetch(`/api/entity-parts/${pid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: 5, location: 'Bin B2' }),
            });
            return { status: r.status, body: await r.json() };
        }, partId);
        assert(updateResult.status === 200, '1.7 Update part returns 200');

        // 1.8 Verify update
        const afterUpdate = await page.evaluate(async (eid) => {
            const r = await fetch(`/api/entities/${eid}/parts`);
            return { status: r.status, body: await r.json() };
        }, entityId);
        const updatedPart = afterUpdate.body.parts?.find(p => p.id === partId);
        assert(updatedPart?.quantity === 5, '1.8 Quantity updated to 5');

        // 1.9 Delete part
        const deleteResult = await page.evaluate(async (pid) => {
            const r = await fetch(`/api/entity-parts/${pid}`, { method: 'DELETE' });
            return { status: r.status, body: await r.json() };
        }, partId);
        assert(deleteResult.status === 200, '1.9 Delete part returns 200');

        // =================================================================
        // GROUP 2: Cross-Entity Parts API (4 tests)
        // =================================================================
        console.log('\nGroup 2: Cross-Entity Parts API');

        // Create a second entity with parts for cross-entity testing
        const entity2Tag = `PARTS2-${RUN_TAG}`;
        const entity2Result = await apiCreateEntity(page, entity2Tag, {
            equip_type: 'FCU',
            building: 'Test Building',
            location: 'MER-2',
        });
        const entity2Id = entity2Result.body.id;
        if (entity2Id) createdEntityIds.push(entity2Id);

        // Add parts to both entities
        await page.evaluate(async ({ eid1, eid2 }) => {
            await fetch(`/api/entities/${eid1}/parts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ part_number: 'FLT-20x20', description: 'Air Filter 20x20x2', quantity: 6 }),
            });
            await fetch(`/api/entities/${eid2}/parts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ part_number: 'VALVE-01', description: 'Control Valve', quantity: 1 }),
            });
        }, { eid1: entityId, eid2: entity2Id });

        // 2.1 Cross-entity list (all parts)
        const allPartsResult = await page.evaluate(async () => {
            const r = await fetch('/api/parts');
            return { status: r.status, body: await r.json() };
        });
        assert(allPartsResult.status === 200, '2.1 GET /api/parts returns 200');
        assert(allPartsResult.body.parts?.length >= 2, '2.2 At least 2 parts across entities');
        assert(allPartsResult.body.total >= 2, '2.3 Total count matches');

        // 2.4 Filtered by entity_id
        const filteredResult = await page.evaluate(async (eid) => {
            const r = await fetch(`/api/parts?entity_id=${eid}`);
            return { status: r.status, body: await r.json() };
        }, entity2Id);
        assert(filteredResult.body.parts?.length === 1, '2.4 Filtered returns 1 part for entity 2');

        // =================================================================
        // GROUP 3: EntityModal Parts Section — Browser (7 tests)
        // =================================================================
        console.log('\nGroup 3: EntityModal Parts Section — Browser');

        // Ensure we have a part on entity 1 for modal testing
        // (we already added FLT-20x20 above)

        // 3.1 Open the EntityModal for our test entity
        const modalOpened = await page.evaluate(async (eid) => {
            if (!window.app?.entityModal) return false;
            await window.app.entityModal.open(eid);
            const overlay = document.getElementById('entity-modal');
            return overlay && overlay.style.display !== 'none';
        }, entityId);
        assert(modalOpened, '3.1 EntityModal opens for test entity');

        // 3.2 Parts Inventory section header exists
        await page.waitForTimeout(500);
        const hasPartsSection = await page.evaluate(() => {
            const headers = document.querySelectorAll('.entity-modal-section-header');
            for (const h of headers) {
                if (h.textContent.includes('Parts Inventory')) return true;
            }
            return false;
        });
        assert(hasPartsSection, '3.2 Parts Inventory section header exists');

        // 3.3 Parts table has at least one row
        const partRowCount = await page.evaluate(() => {
            return document.querySelectorAll('.entity-part-row').length;
        });
        assert(partRowCount >= 1, '3.3 Parts table has data rows');

        // 3.4 Add a part via the inline form
        const addedViaUI = await page.evaluate(async () => {
            const addRow = document.querySelector('.entity-part-add-row');
            if (!addRow) return false;
            const inputs = addRow.querySelectorAll('input');
            // inputs[0] = part number, inputs[1] = description, inputs[2] = qty, inputs[3] = unit
            if (inputs.length < 4) return false;

            inputs[0].value = 'UI-TEST-001';
            inputs[0].dispatchEvent(new Event('input'));
            inputs[1].value = 'Test Part From UI';
            inputs[1].dispatchEvent(new Event('input'));
            inputs[2].value = '2';
            inputs[2].dispatchEvent(new Event('input'));
            inputs[3].value = 'box';
            inputs[3].dispatchEvent(new Event('input'));

            const addBtn = addRow.querySelector('button');
            if (!addBtn) return false;
            addBtn.click();

            // Wait for API round-trip
            await new Promise(r => setTimeout(r, 500));

            // Check that new row appeared
            const rows = document.querySelectorAll('.entity-part-row');
            for (const row of rows) {
                const numSpan = row.querySelector('.part-col-number');
                if (numSpan && numSpan.textContent === 'UI-TEST-001') return true;
            }
            return false;
        });
        assert(addedViaUI, '3.4 Part added via inline form appears in table');

        // 3.5 Header count updated
        const headerCount = await page.evaluate(() => {
            const headers = document.querySelectorAll('.entity-modal-section-header');
            for (const h of headers) {
                if (h.textContent.includes('Parts Inventory')) {
                    const match = h.textContent.match(/\((\d+)\)/);
                    return match ? parseInt(match[1], 10) : -1;
                }
            }
            return -1;
        });
        assert(headerCount >= 2, '3.5 Parts header count updated after add');

        // 3.6 Delete a part via the UI delete button
        const deletedViaUI = await page.evaluate(async () => {
            const rows = document.querySelectorAll('.entity-part-row');
            const targetRow = Array.from(rows).find(r => {
                const num = r.querySelector('.part-col-number');
                return num && num.textContent === 'UI-TEST-001';
            });
            if (!targetRow) return false;

            const deleteBtn = targetRow.querySelectorAll('button')[1]; // second button is delete
            if (!deleteBtn) return false;
            deleteBtn.click();

            await new Promise(r => setTimeout(r, 500));

            // Verify row is removed
            const remaining = document.querySelectorAll('.entity-part-row');
            for (const r of remaining) {
                const num = r.querySelector('.part-col-number');
                if (num && num.textContent === 'UI-TEST-001') return false;
            }
            return true;
        });
        assert(deletedViaUI, '3.6 Part deleted via UI button removes row');

        // 3.7 Close modal
        const modalClosed = await page.evaluate(() => {
            window.app.entityModal.close();
            const overlay = document.getElementById('entity-modal');
            return overlay && overlay.style.display === 'none';
        });
        assert(modalClosed, '3.7 EntityModal closes cleanly');

        // =================================================================
        // GROUP 4: Input Validation (5 tests)
        // =================================================================
        console.log('\nGroup 4: Input Validation');

        // 4.1 Missing part_number → 400
        const noPart = await page.evaluate(async (eid) => {
            const r = await fetch(`/api/entities/${eid}/parts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: 'Missing part number' }),
            });
            return r.status;
        }, entityId);
        assert(noPart === 400, '4.1 Missing part_number returns 400');

        // 4.2 Missing description → 400
        const noDesc = await page.evaluate(async (eid) => {
            const r = await fetch(`/api/entities/${eid}/parts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ part_number: 'X-123' }),
            });
            return r.status;
        }, entityId);
        assert(noDesc === 400, '4.2 Missing description returns 400');

        // 4.3 Non-existent entity → 404
        const badEntity = await page.evaluate(async () => {
            const r = await fetch('/api/entities/nonexistent-uuid-999/parts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ part_number: 'X', description: 'Y' }),
            });
            return r.status;
        });
        assert(badEntity === 404, '4.3 Non-existent entity returns 404');

        // 4.4 Update non-existent part → 404
        const badPart = await page.evaluate(async () => {
            const r = await fetch('/api/entity-parts/99999', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: 10 }),
            });
            return r.status;
        });
        assert(badPart === 404, '4.4 Update non-existent part returns 404');

        // 4.5 Delete non-existent part → 404
        const delBad = await page.evaluate(async () => {
            const r = await fetch('/api/entity-parts/99999', { method: 'DELETE' });
            return r.status;
        });
        assert(delBad === 404, '4.5 Delete non-existent part returns 404');

    } finally {
        // ---- Cleanup ----
        console.log('\nCleanup: deleting test entities...');
        for (const eid of createdEntityIds) {
            await apiDeleteEntity(page, eid);
        }

        await browser.close();

        console.log(`\n${'═'.repeat(50)}`);
        console.log(`Results: ${passed} passed, ${failed} failed`);
        console.log(`${'═'.repeat(50)}`);

        if (failed > 0) process.exit(1);
    }
}

run().catch(err => {
    console.error('Test runner crashed:', err);
    process.exit(1);
});
