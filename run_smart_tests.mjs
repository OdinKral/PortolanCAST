/**
 * PortolanCAST — Smart Test Runner
 *
 * Purpose:
 *   Runs only the test suites affected by recent code changes, plus any
 *   previously-failed suites. Uses git diff to detect changed files, then
 *   maps them to test suites via a static dependency graph.
 *
 * Usage:
 *   node run_smart_tests.mjs              # quick canary (5 suites, ~60s daily smoke test)
 *   node run_smart_tests.mjs --smart      # changed files since last commit (git-diff based)
 *   node run_smart_tests.mjs --staged     # only staged changes
 *   node run_smart_tests.mjs --all        # run everything (same as run_tests.mjs)
 *   node run_smart_tests.mjs --retry      # re-run only previously failed suites
 *   node run_smart_tests.mjs --since HEAD~3  # changes in last 3 commits
 *   node run_smart_tests.mjs --batch 5    # run 5 suites at a time (WSL2 memory relief)
 *
 * How it works:
 *   1. Reads git diff to find changed source files
 *   2. Looks up each file in DEPENDENCY_MAP → collects affected test suites
 *   3. Loads .test_failures.json (if exists) → adds previously-failed suites
 *   4. Deduplicates and runs only the targeted suites
 *   5. Saves failures to .test_failures.json for next --retry run
 *
 * The full runner (run_tests.mjs) is still available for CI / full regression.
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-03-09
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// =============================================================================
// DEPENDENCY MAP: source file → test suites that exercise it
// =============================================================================
// Key: path relative to project root (supports prefix matching for directories)
// Value: array of test suite filenames
//
// Design: when a source file changes, we run every test suite that could be
// affected. The map is intentionally broad — false positives (running an extra
// suite) are cheap; false negatives (missing a broken suite) are expensive.
// =============================================================================

const DEPENDENCY_MAP = {
    // ── Backend ─────────────────────────────────────────────────────────
    'db.py': [
        // DB schema/methods underpin almost everything, but these suites
        // exercise DB-heavy features directly
        'test_shapes.mjs', 'test_properties.mjs', 'test_markup_list.mjs',
        'test_phase2.mjs', 'test_phase5_layers.mjs', 'test_bundle.mjs',
        'test_photos.mjs', 'test_brief_tags.mjs', 'test_search.mjs',
        'test_stage3a.mjs', 'test_stage3b.mjs', 'test_sprint1_capture.mjs',
        'test_nodecast.mjs', 'test_obsidian_export.mjs',
        'test_parts_inventory.mjs',
    ],
    // config.py holds singletons (db, pdf_engine, templates, paths) shared
    // by all routes — changes here have the same broad blast radius as the
    // old monolithic main.py entry.
    'config.py': [
        'test_shapes.mjs', 'test_properties.mjs', 'test_markup_list.mjs',
        'test_phase1_tools.mjs', 'test_phase2.mjs',
        'test_phase3a.mjs', 'test_phase3b.mjs',
        'test_phase4a.mjs', 'test_phase4b.mjs', 'test_phase4c.mjs',
        'test_phase5_layers.mjs', 'test_bundle.mjs',
        'test_photos.mjs', 'test_search.mjs', 'test_brief_tags.mjs',
        'test_rfi_generator.mjs', 'test_health_monitor.mjs',
        'test_stage3a.mjs', 'test_stage3b.mjs',
        'test_ocr_text.mjs', 'test_image_overlay.mjs',
        'test_nodecast.mjs', 'test_obsidian_export.mjs',
        'test_sprint1_capture.mjs', 'test_equipment_marker.mjs',
        'test_parts_inventory.mjs',
    ],
    // main.py is now a thin shell — only app creation, static mounts,
    // router includes, and startup. Much smaller blast radius.
    'main.py': [
        'test_shapes.mjs', 'test_health_monitor.mjs',
    ],
    'pdf_engine.py': [
        'test_ocr_text.mjs', 'test_phase2.mjs', 'test_l1_rotation.mjs',
    ],

    // ── Backend: Route modules (granular blast radius) ───────────────────
    // Each route file maps to only the test suites that exercise its endpoints.
    // Editing routes/backup.py now triggers 1 suite instead of 26.
    'routes/backup.py':        ['test_bundle.mjs'],
    'routes/parts.py':         ['test_parts_inventory.mjs'],
    'routes/entity_photos.py': ['test_sprint1_capture.mjs'],
    'routes/entity_tasks.py':  ['test_stage3b.mjs', 'test_sprint1_capture.mjs'],
    'routes/entities.py':      ['test_stage3a.mjs', 'test_stage3b.mjs', 'test_sprint1_capture.mjs', 'test_equipment_marker.mjs'],
    'routes/text.py':          ['test_ocr_text.mjs'],
    'routes/photos.py':        ['test_photos.mjs'],
    'routes/search.py':        ['test_search.mjs', 'test_brief_tags.mjs', 'test_rfi_generator.mjs', 'test_obsidian_export.mjs'],
    'routes/reports.py':       ['test_brief_tags.mjs', 'test_rfi_generator.mjs', 'test_obsidian_export.mjs'],
    'routes/ai.py':            ['test_phase4c.mjs'],
    'routes/bundles.py':       ['test_bundle.mjs', 'test_q1_bundle_naming.mjs'],
    'routes/settings.py':      ['test_phase2.mjs', 'test_phase5_layers.mjs', 'test_l1_rotation.mjs'],
    'routes/markups.py':       ['test_shapes.mjs', 'test_properties.mjs', 'test_markup_list.mjs'],
    'routes/documents.py':     ['test_shapes.mjs', 'test_properties.mjs', 'test_phase2.mjs', 'test_bundle.mjs', 'test_image_overlay.mjs', 'test_phase1_tools.mjs'],
    'routes/pages.py':         ['test_shapes.mjs', 'test_properties.mjs'],
    'routes/health.py':        ['test_health_monitor.mjs'],

    // ── Frontend: Core modules ──────────────────────────────────────────
    'static/js/app.js': [
        // App controller initializes everything — run core suites
        'test_shapes.mjs', 'test_properties.mjs', 'test_markup_list.mjs',
        'test_phase1_tools.mjs', 'test_phase2.mjs',
        'test_phase3a.mjs', 'test_phase3b.mjs',
        'test_phase4a.mjs', 'test_phase4b.mjs', 'test_phase4c.mjs',
        'test_phase5_layers.mjs', 'test_toolchest.mjs',
        'test_health_monitor.mjs', 'test_stage3b.mjs',
        'test_sprint1_capture.mjs', 'test_panel_collapse.mjs',
    ],
    'static/js/canvas.js': [
        'test_shapes.mjs', 'test_properties.mjs', 'test_markup_list.mjs',
        'test_phase1_tools.mjs', 'test_phase1_polish.mjs',
        'test_phase2.mjs', 'test_phase3a.mjs', 'test_phase3b.mjs',
        'test_color_meaning.mjs', 'test_highlight_color.mjs',
        'test_phase4a.mjs', 'test_phase5_layers.mjs',
        'test_polyline.mjs', 'test_arrow.mjs', 'test_sticky_note.mjs',
        'test_toolchest.mjs', 'test_nodecast.mjs', 'test_image_overlay.mjs',
        'test_equipment_marker.mjs',
    ],
    'static/js/toolbar.js': [
        'test_shapes.mjs', 'test_phase1_tools.mjs', 'test_phase1_polish.mjs',
        'test_phase2.mjs', 'test_phase3b.mjs',
        'test_l2_toolbar_custom.mjs', 'test_l3_mode_bar.mjs',
        'test_polyline.mjs', 'test_arrow.mjs', 'test_sticky_note.mjs',
        'test_image_overlay.mjs', 'test_sprint1_capture.mjs',
        'test_equipment_marker.mjs',
    ],
    'static/js/properties.js': [
        'test_properties.mjs', 'test_phase1_tools.mjs', 'test_phase2.mjs',
        'test_color_meaning.mjs', 'test_highlight_color.mjs',
        'test_photos.mjs', 'test_stage3a.mjs', 'test_stage3b.mjs',
        'test_sprint1_capture.mjs', 'test_image_overlay.mjs',
    ],
    'static/js/markup-list.mjs': [
        'test_markup_list.mjs', 'test_phase1_tools.mjs', 'test_phase2.mjs',
        'test_phase4a.mjs', 'test_phase5_layers.mjs',
        'test_brief_tags.mjs', 'test_image_overlay.mjs',
    ],
    'static/js/pdf-viewer.js': [
        'test_shapes.mjs', 'test_properties.mjs', 'test_phase1_tools.mjs',
        'test_phase2.mjs', 'test_l1_rotation.mjs', 'test_ocr_text.mjs',
    ],
    'static/js/layers.js': [
        'test_phase5_layers.mjs', 'test_q3_layer_context.mjs',
        'test_image_overlay.mjs',
    ],
    'static/js/measure.js': [
        'test_phase2.mjs', 'test_phase4a.mjs',
    ],
    'static/js/measure-summary.js': [
        'test_phase4a.mjs',
    ],
    'static/js/scale.js': [
        'test_phase2.mjs',
    ],

    // ── Frontend: Feature modules ───────────────────────────────────────
    'static/js/quick-capture.js': [
        'test_sprint1_capture.mjs',
    ],
    'static/js/entity-manager.js': [
        'test_stage3b.mjs', 'test_sprint1_capture.mjs', 'test_parts_inventory.mjs',
    ],
    'static/js/entity-modal.js': [
        'test_stage3b.mjs', 'test_sprint1_capture.mjs', 'test_parts_inventory.mjs',
    ],
    'static/js/equipment-marker.js': [
        'test_equipment_marker.mjs',
    ],
    'static/js/search.js': [
        'test_search.mjs',
    ],
    'static/js/review-brief.js': [
        'test_brief_tags.mjs', 'test_phase4c.mjs',
    ],
    'static/js/rfi-generator.js': [
        'test_rfi_generator.mjs',
    ],
    'static/js/page-text.js': [
        'test_ocr_text.mjs',
    ],
    'static/js/node-editor.js': [
        'test_phase3a.mjs',
    ],
    'static/js/tools-panel.js': [
        'test_toolchest.mjs',
    ],
    'static/js/plugins.js': [
        'test_phase4b.mjs', 'test_phase4c.mjs',
        'test_health_monitor.mjs', 'test_nodecast.mjs',
    ],
    'static/js/plugins/extended-cognition.js': [
        'test_phase4c.mjs',
    ],
    'static/js/plugins/health-monitor.js': [
        'test_health_monitor.mjs',
    ],
    'static/js/plugins/nodecast.js': [
        'test_nodecast.mjs', 'test_obsidian_export.mjs',
    ],

    // ── HTML & CSS ──────────────────────────────────────────────────────
    // editor.html DOM changes can break any browser test — run a broad set
    'templates/editor.html': [
        'test_shapes.mjs', 'test_properties.mjs', 'test_markup_list.mjs',
        'test_phase1_tools.mjs', 'test_phase2.mjs',
        'test_phase4a.mjs', 'test_phase4b.mjs', 'test_phase4c.mjs',
        'test_phase5_layers.mjs', 'test_bundle.mjs',
        'test_photos.mjs', 'test_search.mjs', 'test_brief_tags.mjs',
        'test_rfi_generator.mjs', 'test_health_monitor.mjs',
        'test_stage3a.mjs', 'test_stage3b.mjs', 'test_ocr_text.mjs',
        'test_toolchest.mjs', 'test_nodecast.mjs',
        'test_image_overlay.mjs', 'test_sprint1_capture.mjs',
    ],
    // CSS rarely breaks tests, but these suites check visual properties
    'static/css/style.css': [
        'test_l1_rotation.mjs', 'test_l2_toolbar_custom.mjs',
        'test_l3_mode_bar.mjs', 'test_highlight_color.mjs',
        'test_b3_scroll.mjs', 'test_panel_collapse.mjs',
    ],
    'templates/base.html': [
        'test_shapes.mjs', 'test_properties.mjs',
    ],
};

// Complete list of all test files (same order as run_tests.mjs)
const ALL_TEST_FILES = [
    'test_shapes.mjs', 'test_properties.mjs', 'test_markup_list.mjs',
    'test_color_meaning.mjs', 'test_phase1_tools.mjs', 'test_phase1_polish.mjs',
    'test_phase2.mjs', 'test_phase3a.mjs', 'test_phase3b.mjs',
    'test_phase4a.mjs', 'test_phase4b.mjs', 'test_phase4c.mjs',
    'test_phase5_layers.mjs', 'test_bundle.mjs', 'test_photos.mjs',
    'test_search.mjs', 'test_brief_tags.mjs', 'test_rfi_generator.mjs',
    'test_highlight_color.mjs', 'test_b3_scroll.mjs',
    'test_q3_layer_context.mjs', 'test_q1_bundle_naming.mjs',
    'test_q2_callout_edit.mjs', 'test_l1_rotation.mjs',
    'test_l2_toolbar_custom.mjs', 'test_l3_mode_bar.mjs',
    'test_ocr_text.mjs', 'test_polyline.mjs', 'test_arrow.mjs',
    'test_sticky_note.mjs', 'test_nodecast.mjs', 'test_obsidian_export.mjs',
    'test_toolchest.mjs', 'test_health_monitor.mjs', 'test_stage3a.mjs',
    'test_image_overlay.mjs', 'test_stage3b.mjs', 'test_sprint1_capture.mjs',
];

// Quick canary suites — 5 broad integration tests that verify every layer of
// the stack in ~60 seconds. Default mode for daily development. If any of these
// break, something fundamental changed and you should run --smart or --all.
const QUICK_CANARY_SUITES = [
    'test_shapes.mjs',          // core drawing + DB + markup save/load
    'test_bundle.mjs',          // PDF + photos + ZIP export/import round-trip
    'test_health_monitor.mjs',  // server health + startup + API connectivity
    'test_stage3a.mjs',         // entity system CRUD + linking
    'test_phase2.mjs',          // scale + measure + settings persistence
];

const FAILURES_FILE = '.test_failures.json';

// =============================================================================
// CLI ARGUMENT PARSING
// =============================================================================

const args = process.argv.slice(2);
const flagAll    = args.includes('--all');
const flagSmart  = args.includes('--smart');
const flagRetry  = args.includes('--retry');
const flagStaged = args.includes('--staged');
const flagHelp   = args.includes('--help') || args.includes('-h');

// --since HEAD~N: compare against a specific ref instead of HEAD
const sinceIdx = args.indexOf('--since');
const sinceRef = sinceIdx !== -1 ? args[sinceIdx + 1] : null;

// --batch N: run N suites at a time with a pause between batches.
// WSL2 without dedicated GPU leaks Chromium memory across sequential
// Playwright launches. Running in batches lets the OS reclaim memory
// between groups, preventing resource exhaustion on long regression runs.
const batchIdx = args.indexOf('--batch');
const batchSize = batchIdx !== -1 ? parseInt(args[batchIdx + 1], 10) : 0;
const BATCH_PAUSE_MS = 5000; // 5 seconds between batches

if (flagHelp) {
    console.log(`
PortolanCAST — Smart Test Runner

Usage:
  node run_smart_tests.mjs              Quick canary (5 suites, ~60s daily smoke test)
  node run_smart_tests.mjs --smart      Run tests affected by uncommitted changes (git-diff)
  node run_smart_tests.mjs --staged     Run tests affected by staged changes only
  node run_smart_tests.mjs --since REF  Run tests affected by changes since REF
                                        (e.g. --since HEAD~3, --since main)
  node run_smart_tests.mjs --retry      Re-run only previously failed suites
  node run_smart_tests.mjs --all        Run all suites (full regression)
  node run_smart_tests.mjs --batch N    Run N suites at a time with ${BATCH_PAUSE_MS/1000}s pause
                                        between batches (WSL2 memory relief).
                                        Combine with any mode: --all --batch 5
  node run_smart_tests.mjs --help       Show this help

Quick canary tests 5 broad suites that touch every layer of the stack.
If a canary fails, run --smart or --all to identify the specific issue.
Previously-failed suites are always included automatically (except in quick mode).
Failures are saved to .test_failures.json for the next --retry run.
`);
    process.exit(0);
}

// =============================================================================
// DETECT CHANGED FILES
// =============================================================================

/**
 * Get list of changed files from git.
 *
 * Strategy:
 *   --staged   → git diff --cached --name-only
 *   --since X  → git diff X --name-only
 *   default    → git diff HEAD --name-only (staged + unstaged vs last commit)
 *
 * Returns: array of file paths relative to repo root
 */
function getChangedFiles() {
    let cmd;
    if (flagStaged) {
        cmd = 'git diff --cached --name-only';
    } else if (sinceRef) {
        cmd = `git diff ${sinceRef} --name-only`;
    } else {
        // Uncommitted changes (staged + unstaged) vs HEAD
        // Plus untracked test files (in case a new test was added)
        const tracked = execSync('git diff HEAD --name-only', { encoding: 'utf-8' }).trim();
        const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf-8' }).trim();
        const combined = [tracked, untracked].filter(Boolean).join('\n');
        return combined ? combined.split('\n').filter(Boolean) : [];
    }
    const output = execSync(cmd, { encoding: 'utf-8' }).trim();
    return output ? output.split('\n').filter(Boolean) : [];
}

// =============================================================================
// MAP CHANGED FILES → TEST SUITES
// =============================================================================

/**
 * Given a list of changed file paths, return the set of test suites to run.
 *
 * Logic:
 *   1. If a test file itself changed → include it directly
 *   2. If a source file matches a DEPENDENCY_MAP key → include mapped suites
 *   3. If a changed file matches no map entry → flag it (unknown impact)
 *
 * Returns: { suites: Set<string>, reasons: Map<string, string[]> }
 */
function mapFilesToSuites(changedFiles) {
    const suites = new Set();
    const reasons = new Map(); // suite → [reasons]
    const unmapped = [];

    for (const file of changedFiles) {
        // 1. Changed test file → run it directly
        if (file.startsWith('test_') && file.endsWith('.mjs')) {
            suites.add(file);
            addReason(reasons, file, `self-changed`);
            continue;
        }

        // 2. Check dependency map (exact match or prefix match)
        let matched = false;
        for (const [source, tests] of Object.entries(DEPENDENCY_MAP)) {
            if (file === source || file.startsWith(source + '/')) {
                for (const t of tests) {
                    suites.add(t);
                    addReason(reasons, t, file);
                }
                matched = true;
            }
        }

        // 3. Unmapped file — track for reporting but don't panic
        if (!matched) {
            unmapped.push(file);
        }
    }

    return { suites, reasons, unmapped };
}

function addReason(map, suite, reason) {
    if (!map.has(suite)) map.set(suite, []);
    map.get(suite).push(reason);
}

// =============================================================================
// LOAD PREVIOUS FAILURES
// =============================================================================

function loadPreviousFailures() {
    try {
        if (existsSync(FAILURES_FILE)) {
            const data = JSON.parse(readFileSync(FAILURES_FILE, 'utf-8'));
            return data.failed || [];
        }
    } catch (_) { /* corrupted file — ignore */ }
    return [];
}

function saveFailures(failedSuites) {
    writeFileSync(FAILURES_FILE, JSON.stringify({
        timestamp: new Date().toISOString(),
        failed: failedSuites,
    }, null, 2));
}

// =============================================================================
// SUITE RUNNER (reuses run_tests.mjs logic)
// =============================================================================

function runSuite(file) {
    try {
        const output = execSync(`node ${file}`, {
            encoding: 'utf-8',
            timeout: 120000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log(output);
        const match = output.match(/Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed/);
        if (match) {
            return { file, passed: +match[1], failed: +match[2], error: false };
        }
        // Parseable alt format: "Suite Name: N passed, M failed"
        const alt = output.match(/(\d+)\s*passed,\s*(\d+)\s*failed/);
        if (alt) {
            return { file, passed: +alt[1], failed: +alt[2], error: false };
        }
        return { file, passed: 0, failed: 0, error: false, note: 'no parseable results' };
    } catch (err) {
        const output = (err.stdout || '') + (err.stderr || '');
        console.log(output);
        const match = output.match(/Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed/);
        if (match) {
            return { file, passed: +match[1], failed: +match[2], error: false };
        }
        const alt = output.match(/(\d+)\s*passed,\s*(\d+)\s*failed/);
        if (alt) {
            return { file, passed: +alt[1], failed: +alt[2], error: false };
        }
        return { file, passed: 0, failed: 1, error: true, note: 'crashed' };
    }
}

// =============================================================================
// MAIN
// =============================================================================

console.log('╔══════════════════════════════════════════════════╗');
console.log('║        PortolanCAST — Smart Test Runner         ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log();

let suitesToRun;
let selectionReasons = new Map();

if (flagAll) {
    // Full regression — same as run_tests.mjs
    console.log('  Mode: --all (full regression)');
    suitesToRun = [...ALL_TEST_FILES];
} else if (flagRetry) {
    // Re-run only previous failures
    const prev = loadPreviousFailures();
    if (prev.length === 0) {
        console.log('  Mode: --retry');
        console.log('  No previous failures found. Nothing to re-run.');
        console.log('  (Run tests first, or use --all for full regression)');
        process.exit(0);
    }
    console.log(`  Mode: --retry (${prev.length} previously-failed suite(s))`);
    suitesToRun = prev;
    for (const s of prev) addReason(selectionReasons, s, 'previous failure');
} else if (flagSmart || flagStaged || sinceRef) {
    // Smart selection: git diff → dependency map → suites
    const modeLabel = flagStaged ? '--staged' : sinceRef ? `--since ${sinceRef}` : 'uncommitted changes';
    console.log(`  Mode: smart selection (${modeLabel})`);
    console.log();

    const changedFiles = getChangedFiles();
    if (changedFiles.length === 0) {
        console.log('  No changed files detected. Nothing to test.');
        console.log('  Use --all for full regression, or --retry for previous failures.');
        process.exit(0);
    }

    console.log(`  Changed files (${changedFiles.length}):`);
    for (const f of changedFiles.slice(0, 20)) {
        console.log(`    ${f}`);
    }
    if (changedFiles.length > 20) {
        console.log(`    ... and ${changedFiles.length - 20} more`);
    }
    console.log();

    const { suites, reasons, unmapped } = mapFilesToSuites(changedFiles);
    selectionReasons = reasons;

    // Add previously-failed suites
    const prevFailures = loadPreviousFailures();
    for (const pf of prevFailures) {
        if (ALL_TEST_FILES.includes(pf)) {
            suites.add(pf);
            addReason(selectionReasons, pf, 'previous failure');
        }
    }

    if (suites.size === 0) {
        console.log('  No test suites affected by these changes.');
        if (unmapped.length > 0) {
            console.log(`  (${unmapped.length} changed file(s) not in dependency map)`);
        }
        console.log('  Use --all for full regression if unsure.');
        process.exit(0);
    }

    // Preserve run order from ALL_TEST_FILES
    suitesToRun = ALL_TEST_FILES.filter(f => suites.has(f));

    if (unmapped.length > 0) {
        console.log(`  Note: ${unmapped.length} changed file(s) not in dependency map:`);
        for (const u of unmapped.slice(0, 5)) {
            console.log(`    ${u}`);
        }
        if (unmapped.length > 5) console.log(`    ... and ${unmapped.length - 5} more`);
        console.log();
    }
} else {
    // Default: quick canary — 5 broad suites that touch every stack layer
    console.log('  Mode: quick canary (default)');
    console.log('  Running 5 broad integration suites for daily smoke testing.');
    console.log('  Use --smart for git-diff based selection, --all for full regression.');
    suitesToRun = [...QUICK_CANARY_SUITES];
    for (const s of suitesToRun) addReason(selectionReasons, s, 'canary');
}

// Print selection summary
console.log(`  Selected ${suitesToRun.length} of ${ALL_TEST_FILES.length} suites:`);
for (const s of suitesToRun) {
    const why = selectionReasons.get(s);
    const tag = why ? ` (${[...new Set(why)].join(', ')})` : '';
    console.log(`    ${s}${tag}`);
}
console.log();

// =============================================================================
// RUN SELECTED SUITES
// =============================================================================

/**
 * Sleep helper for batch pauses.
 * Uses a blocking loop (not async) because the runner is synchronous.
 */
function sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // Busy-wait — acceptable for short pauses between test batches
    }
}

let totalPassed = 0;
let totalFailed = 0;
const results = [];
const failedSuites = [];

// Show batch info if applicable
if (batchSize > 0 && suitesToRun.length > batchSize) {
    const batchCount = Math.ceil(suitesToRun.length / batchSize);
    console.log(`  Batch mode: ${batchSize} suites per batch, ${batchCount} batches, ${BATCH_PAUSE_MS / 1000}s pause`);
    console.log();
}

for (let i = 0; i < suitesToRun.length; i++) {
    const file = suitesToRun[i];

    // Batch boundary pause — let WSL2 reclaim Chromium memory
    if (batchSize > 0 && i > 0 && i % batchSize === 0) {
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(suitesToRun.length / batchSize);
        console.log();
        console.log(`  ── Batch ${batchNum}/${totalBatches} ── pausing ${BATCH_PAUSE_MS / 1000}s for memory recovery ──`);
        console.log();
        sleepSync(BATCH_PAUSE_MS);
    }

    console.log(`\n${'━'.repeat(50)}`);
    console.log(`  Running: ${file} (${i + 1}/${suitesToRun.length})`);
    console.log(`${'━'.repeat(50)}`);

    const result = runSuite(file);
    results.push(result);
    totalPassed += result.passed;
    totalFailed += result.failed;

    if (result.failed > 0 || result.error) {
        failedSuites.push(file);
    }
}

// Save failures for --retry
saveFailures(failedSuites);

// =============================================================================
// SUMMARY
// =============================================================================

console.log(`\n${'═'.repeat(50)}`);
console.log('  SMART TEST RESULTS');
console.log(`${'═'.repeat(50)}`);
console.log();

for (const r of results) {
    const status = r.failed > 0 || r.error ? 'FAIL' : 'PASS';
    const icon = status === 'PASS' ? '✓' : '✗';
    const extra = r.note ? ` (${r.note})` : '';
    console.log(`  ${icon} ${r.file.padEnd(30)} ${r.passed} passed, ${r.failed} failed${extra}`);
}

console.log();
console.log(`  Suites: ${suitesToRun.length} selected, ${failedSuites.length} failed`);
console.log(`  Tests:  ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} total`);
console.log(`  Skipped: ${ALL_TEST_FILES.length - suitesToRun.length} suites (not affected)`);

if (failedSuites.length > 0) {
    console.log();
    console.log(`  Failures saved → run "node run_smart_tests.mjs --retry" to re-run`);
}

console.log(`${'═'.repeat(50)}`);

process.exit(totalFailed > 0 ? 1 : 0);
