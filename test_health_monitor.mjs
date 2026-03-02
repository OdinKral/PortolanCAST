/**
 * PortolanCAST — Health Monitor Tests
 *
 * Purpose:
 *   Validates the two-tier health system added in the 2026-03-01 session:
 *   (1) GET /api/health — fast server-side self-diagnostic endpoint
 *   (2) Health Monitor Plugin — status-bar dot + right-panel Health tab
 *   (3) Dev Test Runner — POST /api/dev/run-tests streaming button
 *
 * Groups:
 *   Group 1:  Health API (5 tests) — pure HTTP checks, no canvas required
 *   Group 2:  Health Panel UI (8 tests) — Playwright DOM assertions
 *   Group 3:  Dev Test Runner (7 tests) — streaming output validation
 *
 * Notes on Group 3 timeouts:
 *   The streaming test does NOT wait for all 36 suites (5+ minutes).
 *   Tests 3.4/3.5 verify output starts within 10s and contains the header.
 *   Tests 3.6/3.7 check the "Running: test_shapes.mjs" dispatch line, which
 *   appears within seconds (before execSync blocks for Chrome launch).
 *   Waiting for "Results:" would require test_shapes.mjs to complete in the
 *   nested dev-runner subprocess environment (90s+) — too slow for CI.
 *
 * Run:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_health_monitor.mjs"
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
// MAIN TEST RUNNER
// =============================================================================

async function run() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        // ── Initial load ──────────────────────────────────────────────────────
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 1: Health API
        //
        // Tests GET /api/health directly via fetch inside page.evaluate().
        // No canvas interaction required.
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 1: Health API --');

        // 1.1 — GET /api/health returns HTTP 200
        const healthStatus = await page.evaluate(async () => {
            const r = await fetch('/api/health');
            return r.status;
        });
        assert(healthStatus === 200, 'GET /api/health returns HTTP 200');

        // 1.2 — Response JSON has a "status" field (healthy/degraded/unhealthy)
        const healthData = await page.evaluate(async () => {
            const r = await fetch('/api/health');
            return r.json();
        });
        assert(
            typeof healthData.status === 'string' &&
            ['healthy', 'degraded', 'unhealthy'].includes(healthData.status),
            `Response has valid "status" field (got "${healthData.status}")`
        );

        // 1.3 — Response has "checks" with a "database" key
        assert(
            healthData.checks && typeof healthData.checks.database === 'object',
            'Response has checks.database object'
        );

        // 1.4 — Database check status is "ok" on a healthy dev machine
        assert(
            healthData.checks?.database?.status === 'ok',
            `checks.database.status === "ok" (got "${healthData.checks?.database?.status}")`
        );

        // 1.5 — Disk space check exists and is "ok" or "warn" (never "fail" on dev)
        const diskStatus = healthData.checks?.disk_space?.status;
        assert(
            diskStatus === 'ok' || diskStatus === 'warn',
            `checks.disk_space.status is "ok" or "warn" (got "${diskStatus}")`
        );

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 2: Health Panel UI
        //
        // Verifies the HealthMonitorPlugin injected its tab, cards, and dot
        // into the DOM correctly.
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 2: Health Panel UI --');

        // 2.1 — "Health" tab button exists in #right-panel-tabs
        const tabBtnExists = await page.evaluate(() =>
            document.querySelector('.panel-tab[data-panel="plugin-health-monitor"]') !== null
        );
        assert(tabBtnExists, '"Health" tab button exists in #right-panel-tabs');

        // 2.2 — Clicking Health tab shows #tab-plugin-health-monitor
        await page.evaluate(() =>
            document.querySelector('.panel-tab[data-panel="plugin-health-monitor"]').click()
        );
        await page.waitForTimeout(200);

        const tabActive = await page.evaluate(() => {
            const tab = document.getElementById('tab-plugin-health-monitor');
            return tab !== null && tab.classList.contains('active');
        });
        assert(tabActive, '#tab-plugin-health-monitor becomes active after clicking Health tab');

        // 2.3 — Run Checks button exists inside the panel
        const runBtnExists = await page.evaluate(() =>
            document.getElementById('health-run-btn') !== null
        );
        assert(runBtnExists, '#health-run-btn exists inside Health panel');

        // 2.4 — Click "Run Checks" and wait for cards to appear
        await page.evaluate(() => document.getElementById('health-run-btn').click());
        await page.waitForTimeout(1500);   // health check fetches server + renders

        const cardsExist = await page.evaluate(() =>
            document.querySelectorAll('.health-check-card').length > 0
        );
        assert(cardsExist, '.health-check-card elements appear after Run Checks');

        // 2.5 — At least one card has the "ok" style (database check passes)
        const hasOkCard = await page.evaluate(() =>
            document.querySelector('.health-check-ok') !== null
        );
        assert(hasOkCard, 'At least one .health-check-ok card rendered');

        // 2.6 — #sb-health dot exists in the status bar DOM
        const dotExists = await page.evaluate(() =>
            document.getElementById('sb-health') !== null
        );
        assert(dotExists, '#sb-health dot element exists in status bar');

        // 2.7 — Dot has a non-gray color after checks run (--health-dot-color set)
        const dotColor = await page.evaluate(() => {
            const dot = document.getElementById('sb-health');
            return dot ? dot.style.getPropertyValue('--health-dot-color').trim() : '';
        });
        assert(
            dotColor !== '' && dotColor !== '#888',
            `Dot has colored --health-dot-color after checks (got "${dotColor}")`
        );

        // 2.8 — Clicking #sb-health activates the Health tab
        // First switch away to a different tab, then click the dot
        await page.evaluate(() =>
            document.querySelector('.panel-tab[data-panel="properties"]')?.click()
        );
        await page.waitForTimeout(150);

        // Use evaluate() to click #sb-health — avoids Playwright auto-scroll side effects
        await page.evaluate(() => document.getElementById('sb-health').click());
        await page.waitForTimeout(300);

        const dotActivatesTab = await page.evaluate(() => {
            const tab = document.getElementById('tab-plugin-health-monitor');
            return tab !== null && tab.classList.contains('active');
        });
        assert(dotActivatesTab, 'Clicking #sb-health dot activates the Health tab');

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 3: Dev Test Runner
        //
        // Verifies the streaming test suite button exists and that POST
        // /api/dev/run-tests produces live output in #health-test-output.
        //
        // We do NOT wait for all 33 suites. We wait only for the first
        // "Results:" line (appears after test_shapes.mjs finishes, ~30s).
        // Timeout is set to 90 seconds to handle slow machines.
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 3: Dev Test Runner --');

        // Re-open Health tab in case a previous click moved away
        await page.evaluate(() =>
            document.querySelector('.panel-tab[data-panel="plugin-health-monitor"]').click()
        );
        await page.waitForTimeout(200);

        // 3.1 — "Run Full Test Suite" button exists
        const suiteBtnExists = await page.evaluate(() =>
            document.getElementById('health-suite-btn') !== null
        );
        assert(suiteBtnExists, '#health-suite-btn exists in Health panel');

        // 3.2 — #health-test-output pre element exists
        const outputExists = await page.evaluate(() =>
            document.getElementById('health-test-output') !== null
        );
        assert(outputExists, '#health-test-output pre element exists');

        // 3.3 — Clicking the button disables it (shows spinner state)
        // Use evaluate() to avoid Playwright auto-scroll (button may be off-screen)
        await page.evaluate(() => document.getElementById('health-suite-btn').click());
        await page.waitForTimeout(300);   // immediate DOM update after click

        const btnDisabledOnStart = await page.evaluate(() => {
            const btn = document.getElementById('health-suite-btn');
            return btn !== null && btn.disabled === true;
        });
        assert(btnDisabledOnStart, '#health-suite-btn becomes disabled immediately after click');

        // 3.4 — Output pre receives text content within 10s (subprocess starts fast)
        await page.waitForFunction(
            () => {
                const el = document.getElementById('health-test-output');
                return el && el.textContent.trim().length > 0;
            },
            { timeout: 10_000 }
        );
        const hasOutput = await page.evaluate(() => {
            const el = document.getElementById('health-test-output');
            return el && el.textContent.trim().length > 0;
        });
        assert(hasOutput, '#health-test-output receives text content within 10s');

        // 3.5 — Output contains "PortolanCAST" (header printed by run_tests.mjs)
        const hasHeader = await page.evaluate(() => {
            const el = document.getElementById('health-test-output');
            return el && el.textContent.includes('PortolanCAST');
        });
        assert(hasHeader, 'Output contains "PortolanCAST" test suite header');

        // 3.6 — Output contains "Running: test_shapes.mjs" (suite dispatch line)
        // run_tests.mjs prints "Running: <file>" immediately BEFORE calling execSync,
        // so this line appears within seconds — no waiting for Chrome to launch.
        // This verifies: (a) streaming body content flows (not just the header),
        // and (b) the runner progressed from header into the suite dispatch loop.
        // Checking "Results:" would require test_shapes.mjs to complete inside the
        // nested dev-runner subprocess (90s+ in this environment) — too slow for CI.
        await page.waitForFunction(
            () => {
                const el = document.getElementById('health-test-output');
                return el && el.textContent.includes('Running:');
            },
            { timeout: 15_000 }
        );
        const hasRunning = await page.evaluate(() => {
            const el = document.getElementById('health-test-output');
            return el && el.textContent.includes('Running:');
        });
        assert(hasRunning, 'Output contains "Running:" suite dispatch line');

        // 3.7 — Output contains "test_shapes.mjs" (first suite name in dispatch line)
        const hasFirstSuite = await page.evaluate(() => {
            const el = document.getElementById('health-test-output');
            return el && el.textContent.includes('test_shapes.mjs');
        });
        assert(hasFirstSuite, 'Output contains "test_shapes.mjs" (first suite dispatched)');

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
