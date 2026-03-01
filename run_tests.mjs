/**
 * PortolanCAST — Test Runner
 *
 * Purpose:
 *   Runs all Phase 1 browser test suites sequentially and prints a combined
 *   summary. Each suite runs in its own Node subprocess so failures in one
 *   don't prevent others from running.
 *
 * Usage:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node run_tests.mjs"
 *
 * Individual suites remain independently runnable:
 *   node test_shapes.mjs
 *   node test_properties.mjs
 *   etc.
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-17
 */

import { execSync } from 'child_process';

// =============================================================================
// TEST SUITE LIST
// =============================================================================

const TEST_FILES = [
    'test_shapes.mjs',
    'test_properties.mjs',
    'test_markup_list.mjs',
    'test_color_meaning.mjs',
    'test_phase1_tools.mjs',
    'test_phase1_polish.mjs',
    // Phase 2: Measurement tools
    'test_phase2.mjs',
    // Phase 3A: Pan/Edit Separation + Vector Node Editing
    'test_phase3a.mjs',
    // Phase 3B: Mode-Tab Toolbar + Bug Fixes (stopPropagation, measurement recalc)
    'test_phase3b.mjs',
    // Phase 4A: Measurement Summary Panel (Measures tab, stat cards, CSV export)
    'test_phase4a.mjs',
    // Phase 4B: Plugin Loader API (register, tab injection, lifecycle events)
    'test_phase4b.mjs',
    // Phase 4C: ExtendedCognition Plugin (EC Brief, AI summary, stats accuracy)
    'test_phase4c.mjs',
    // Phase 5: Layer System (panel, CRUD, visibility/lock, markup assignment)
    'test_phase5_layers.mjs',
    // Bundle: .portolan export/import round-trip
    'test_bundle.mjs',
    // Photo Attachments
    'test_photos.mjs',
    // Global Search
    'test_search.mjs',
    // Review Brief + Markup Tags
    'test_brief_tags.mjs',
    // RFI Generator
    'test_rfi_generator.mjs',
    // B2: Highlight color fix
    'test_highlight_color.mjs',
    // B3: Canvas scroll forwarding
    'test_b3_scroll.mjs',
    // Q3: Right-click layer assignment context menu
    'test_q3_layer_context.mjs',
    // Q1: Bundle save-as naming dialog
    'test_q1_bundle_naming.mjs',
    // Q2: Callout label editable (double-click re-edit + auto-edit on placement)
    'test_q2_callout_edit.mjs',
    // L1: Landscape canvas rotation (server-side rotate param, btn-rotate, dimension swap)
    'test_l1_rotation.mjs',
    // L2: Toolbar customization (compact mode, shortcut hints, Escape key close)
    'test_l2_toolbar_custom.mjs',
    // L3: Persistent mode bar (status bar tool indicator, quick-switch buttons)
    'test_l3_mode_bar.mjs',
    // OCR: Page text extraction (native PyMuPDF + Tesseract OCR fallback)
    'test_ocr_text.mjs',
    // MVMF P1: Polyline tool (click-accumulate-dblclick, rubber-band, round-trip)
    'test_polyline.mjs',
    // MVMF P2: Arrow tool (drag to place, Group(shaft+arrowhead), Shift+A shortcut)
    'test_arrow.mjs',
    // MVMF P3: Sticky Note tool (click-to-place Textbox, yellow background, S shortcut)
    'test_sticky_note.mjs',
    // nodeCAST Phase 1: force-directed markup graph plugin (tag-connected nodes, Graph tab)
    'test_nodecast.mjs',
    // nodeCAST Phase 2 + Obsidian Export: All Pages toggle + Obsidian .zip exporter
    'test_obsidian_export.mjs',
    // Tool Chest: Stamps, Presets, Sequences, Formatted Typewriter (typography panel)
    'test_toolchest.mjs',
    // Health Monitor: GET /api/health + Health panel UI + streaming dev test runner
    'test_health_monitor.mjs',
];

// =============================================================================
// RUNNER
// =============================================================================

console.log('╔══════════════════════════════════════════════════╗');
console.log('║          PortolanCAST — Full Test Suite              ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log();

let totalPassed = 0;
let totalFailed = 0;
let suitesRun = 0;
let suitesFailed = 0;
const results = [];

for (const file of TEST_FILES) {
    console.log(`\n${'━'.repeat(50)}`);
    console.log(`  Running: ${file}`);
    console.log(`${'━'.repeat(50)}`);

    try {
        const output = execSync(`node ${file}`, {
            encoding: 'utf-8',
            timeout: 120000, // 2 minutes per suite max
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        console.log(output);

        // Parse pass/fail counts from output line: "Results: N passed, M failed, T total"
        const match = output.match(/Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed/);
        if (match) {
            const passed = parseInt(match[1], 10);
            const failed = parseInt(match[2], 10);
            totalPassed += passed;
            totalFailed += failed;
            results.push({ file, passed, failed, error: false });
        } else {
            // Suite ran but didn't print parseable results
            results.push({ file, passed: 0, failed: 0, error: false, note: 'no parseable results' });
        }
        suitesRun++;
    } catch (err) {
        // Suite exited with non-zero (test failures) or crashed
        const output = (err.stdout || '') + (err.stderr || '');
        console.log(output);

        const match = output.match(/Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed/);
        if (match) {
            const passed = parseInt(match[1], 10);
            const failed = parseInt(match[2], 10);
            totalPassed += passed;
            totalFailed += failed;
            results.push({ file, passed, failed, error: false });
        } else {
            // Suite crashed without printing results
            totalFailed++;
            results.push({ file, passed: 0, failed: 1, error: true, note: 'crashed' });
        }
        suitesRun++;
        suitesFailed++;
    }
}

// =============================================================================
// COMBINED SUMMARY
// =============================================================================

console.log(`\n${'═'.repeat(50)}`);
console.log('  COMBINED RESULTS');
console.log(`${'═'.repeat(50)}`);
console.log();

// Per-suite summary table
for (const r of results) {
    const status = r.failed > 0 || r.error ? 'FAIL' : 'PASS';
    const icon = status === 'PASS' ? '✓' : '✗';
    const extra = r.note ? ` (${r.note})` : '';
    console.log(`  ${icon} ${r.file.padEnd(28)} ${r.passed} passed, ${r.failed} failed${extra}`);
}

console.log();
console.log(`  Total: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} total`);
console.log(`  Suites: ${suitesRun} run, ${suitesFailed} failed`);
console.log(`${'═'.repeat(50)}`);

process.exit(totalFailed > 0 ? 1 : 0);
