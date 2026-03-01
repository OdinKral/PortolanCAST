/**
 * PortolanCAST — Health Monitor Plugin
 *
 * Purpose:
 *   Surfaces the app's runtime health as a colored status-bar dot and a
 *   right-panel tab. Runs fast (<500 ms) self-diagnostic checks against
 *   GET /api/health without requiring Playwright or a browser automation layer.
 *
 *   Also exposes a "Run Full Test Suite" button that streams the output of
 *   `node run_tests.mjs` live into a dark terminal-style box via
 *   POST /api/dev/run-tests (server-spawned subprocess, streamed back over HTTP).
 *
 * Architecture:
 *   1. init(container, app)   — renders the panel shell; attaches the status dot
 *   2. _renderShell()         — injects static HTML into the plugin container
 *   3. _runChecks()           — fetches /api/health, renders cards + updates dot
 *   4. _renderCards(data)     — builds one .health-check-card per check result
 *   5. _updateStatusDot(s)    — sets CSS variable on #sb-health, shows dot
 *   6. _runTestSuite()        — POST /api/dev/run-tests, streams into #health-test-output
 *
 * Status dot lifecycle:
 *   - Hidden (display:none) until the first check completes successfully.
 *   - Green  (#4caf50) = healthy
 *   - Orange (#ff9800) = degraded (disk warning, AI offline)
 *   - Red    (#f44336) = unhealthy (DB fail, filesystem fail)
 *   Clicking the dot activates the Health tab in the right panel.
 *
 * Security assumptions:
 *   - All fetch calls target the local FastAPI server (127.0.0.1:8000).
 *   - No user data is injected via innerHTML — textContent used everywhere.
 *   - Test runner button is intentionally dev-only; hardcoded route on the server.
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-03-01
 */

// =============================================================================
// CONSTANTS
// =============================================================================

// Maps check status → { icon, CSS class }
const CHECK_STATUS_META = {
    ok:          { icon: '✓', cls: 'health-check-ok'     },
    warn:        { icon: '⚠', cls: 'health-check-warn'   },
    fail:        { icon: '✗', cls: 'health-check-fail'   },
    unavailable: { icon: '~', cls: 'health-check-unavail' },
};

// Maps overall health status → dot color (CSS custom property value)
const DOT_COLORS = {
    healthy:   '#4caf50',
    degraded:  '#ff9800',
    unhealthy: '#f44336',
};

// Human-readable display names for check keys returned by the server
const CHECK_LABELS = {
    database:    'Database',
    pdf_engine:  'PDF Engine',
    disk_space:  'Disk Space',
    filesystem:  'Filesystem',
    ai_endpoint: 'AI Endpoint',
};

// =============================================================================
// PLUGIN MANIFEST
// =============================================================================

/**
 * HealthMonitorPlugin — plain object manifest (not a class).
 * Follows the same pattern as ExtendedCognitionPlugin; state lives on the object.
 * init() is called once when the plugin is registered by PluginLoader.
 */
export const HealthMonitorPlugin = {
    name: 'health-monitor',
    label: 'Health',
    version: '1.0.0',

    // State set in init()
    _container: null,
    _app: null,
    _lastCheckTime: 0,   // epoch ms of the most recent /api/health call

    // =========================================================================
    // LIFECYCLE HOOKS (called by PluginLoader)
    // =========================================================================

    /**
     * Called once when the plugin is registered.
     * Renders the panel shell and wires the status-bar dot click handler.
     *
     * Args:
     *   container: The #tab-plugin-health-monitor div in the right panel.
     *   app:       The App instance (window.app).
     */
    init(container, app) {
        this._container = container;
        this._app = app;
        this._renderShell();
        this._bindStatusDotClick();
    },

    // =========================================================================
    // PRIVATE — SHELL RENDERING
    // =========================================================================

    /**
     * Inject the static panel HTML into the container div.
     *
     * HTML structure:
     *   #health-header       — uptime + last-checked timestamp
     *   #health-cards        — one .health-check-card per check (populated by _renderCards)
     *   #health-run-btn      — "Run Checks" button
     *   #health-divider      — visual separator before dev section
     *   #health-suite-btn    — "Run Full Test Suite" button
     *   #health-test-output  — dark pre box for streamed test output
     *
     * SECURITY: shell uses a safe literal template; dynamic data uses textContent only.
     */
    _renderShell() {
        if (!this._container) return;

        this._container.innerHTML = `
            <div id="health-header" class="health-header">
                <span id="health-status-text" class="health-status-text">Not checked yet</span>
                <span id="health-uptime" class="health-uptime"></span>
            </div>
            <div id="health-cards"></div>
            <button id="health-run-btn" class="toolbar-btn health-run-btn">
                ◎ Run Checks
            </button>
            <hr class="health-divider" />
            <div class="health-dev-section">
                <div class="health-dev-label">Developer</div>
                <button id="health-suite-btn" class="toolbar-btn health-suite-btn">
                    ▶ Run Full Test Suite
                </button>
                <pre id="health-test-output"></pre>
            </div>
        `;

        // Bind Run Checks button
        const runBtn = this._container.querySelector('#health-run-btn');
        if (runBtn) {
            runBtn.addEventListener('click', () => this._runChecks());
        }

        // Bind Run Full Test Suite button
        const suiteBtn = this._container.querySelector('#health-suite-btn');
        if (suiteBtn) {
            suiteBtn.addEventListener('click', () => this._runTestSuite());
        }
    },

    // =========================================================================
    // PRIVATE — STATUS DOT
    // =========================================================================

    /**
     * Wire the #sb-health status-bar dot to open the Health tab on click.
     * The dot is injected by editor.html; we only attach the click handler here.
     */
    _bindStatusDotClick() {
        const dot = document.getElementById('sb-health');
        if (!dot) return;

        dot.addEventListener('click', () => {
            // Activate the right panel "Health" tab.
            // PluginLoader creates: <button class="panel-tab" data-panel="plugin-{name}">
            const tabBtn = document.querySelector('.panel-tab[data-panel="plugin-health-monitor"]');
            if (tabBtn) tabBtn.click();
        });
    },

    /**
     * Update the status-bar dot color and visibility.
     *
     * Args:
     *   status: 'healthy' | 'degraded' | 'unhealthy'
     */
    _updateStatusDot(status) {
        const dot = document.getElementById('sb-health');
        if (!dot) return;

        const color = DOT_COLORS[status] || '#888';
        dot.style.setProperty('--health-dot-color', color);
        dot.style.display = 'inline-block';  // reveal after first check
    },

    // =========================================================================
    // PRIVATE — HEALTH CHECKS
    // =========================================================================

    /**
     * Fetch /api/health and render the results into the panel.
     *
     * Sets _lastCheckTime to prevent redundant calls on rapid tab switching.
     * Updates the status-bar dot color on success.
     */
    async _runChecks() {
        const runBtn = this._container?.querySelector('#health-run-btn');
        const cardsEl = this._container?.querySelector('#health-cards');
        const statusText = this._container?.querySelector('#health-status-text');
        const uptimeEl = this._container?.querySelector('#health-uptime');

        // Show loading state
        if (runBtn) { runBtn.disabled = true; runBtn.textContent = '◎ Checking…'; }
        if (statusText) statusText.textContent = 'Checking…';

        try {
            const resp = await fetch('/api/health');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            this._lastCheckTime = Date.now();

            // Update header
            if (statusText) {
                statusText.textContent = `Status: ${data.status}`;
                statusText.className = `health-status-text health-status-${data.status}`;
            }
            if (uptimeEl) {
                uptimeEl.textContent = `Uptime: ${this._formatUptime(data.uptime_seconds)}`;
            }

            // Render check result cards
            this._renderCards(data, cardsEl);

            // Update status-bar dot
            this._updateStatusDot(data.status);
        } catch (err) {
            if (statusText) {
                statusText.textContent = `Error: ${err.message}`;
                statusText.className = 'health-status-text health-status-unhealthy';
            }
            this._updateStatusDot('unhealthy');
        } finally {
            if (runBtn) { runBtn.disabled = false; runBtn.textContent = '◎ Run Checks'; }
        }
    },

    /**
     * Format uptime seconds into a human-readable string.
     *
     * Args:
     *   seconds: integer seconds since server start
     * Returns:
     *   String like "2h 34m" or "47s"
     */
    _formatUptime(seconds) {
        if (seconds < 60) return `${seconds}s`;
        const m = Math.floor(seconds / 60) % 60;
        const h = Math.floor(seconds / 3600);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    },

    /**
     * Build and insert one .health-check-card per check in the response.
     *
     * Args:
     *   data:      The full /api/health response object.
     *   container: The #health-cards DOM element.
     */
    _renderCards(data, container) {
        if (!container) return;
        container.innerHTML = '';

        const checks = data.checks || {};
        for (const [key, check] of Object.entries(checks)) {
            const meta = CHECK_STATUS_META[check.status] || CHECK_STATUS_META.fail;
            const label = CHECK_LABELS[key] || key;

            const card = document.createElement('div');
            card.className = `health-check-card ${meta.cls}`;
            card.dataset.checkName = key;  // allows tests to find by name

            const iconEl = document.createElement('span');
            iconEl.className = 'health-check-icon';
            // SECURITY: textContent — never innerHTML
            iconEl.textContent = meta.icon;

            const nameEl = document.createElement('span');
            nameEl.className = 'health-check-name';
            nameEl.textContent = label;

            const detailEl = document.createElement('span');
            detailEl.className = 'health-check-detail';
            // Build detail string from response fields
            const detail = check.detail
                || (check.response_time_ms !== undefined ? `${check.response_time_ms} ms` : '')
                || (check.free_gb !== undefined ? `${check.free_gb} GB free` : '');
            detailEl.textContent = detail;

            card.appendChild(iconEl);
            card.appendChild(nameEl);
            card.appendChild(detailEl);
            container.appendChild(card);
        }
    },

    // =========================================================================
    // PRIVATE — DEV TEST RUNNER
    // =========================================================================

    /**
     * Spawn `node run_tests.mjs` on the server and stream its stdout into
     * #health-test-output line by line using the Streams API.
     *
     * The button is disabled for the duration of the run to prevent double-clicks.
     * Output pre auto-scrolls to bottom as new text arrives.
     */
    async _runTestSuite() {
        const suiteBtn = this._container?.querySelector('#health-suite-btn');
        const outputEl = this._container?.querySelector('#health-test-output');

        if (!outputEl) return;

        // Clear previous run output
        outputEl.textContent = '';

        if (suiteBtn) { suiteBtn.disabled = true; suiteBtn.textContent = '▶ Running…'; }

        try {
            const resp = await fetch('/api/dev/run-tests', { method: 'POST' });
            if (!resp.ok) throw new Error(`Server error: HTTP ${resp.status}`);
            if (!resp.body) throw new Error('Response body is not a readable stream');

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            // Read chunks as they arrive and append to the output box
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // SECURITY: textContent — test output is developer-controlled,
                // but using textContent prevents any accidental HTML injection.
                outputEl.textContent += decoder.decode(value, { stream: true });
                // Auto-scroll to show latest output
                outputEl.scrollTop = outputEl.scrollHeight;
            }
        } catch (err) {
            outputEl.textContent += `\n[Error: ${err.message}]`;
        } finally {
            if (suiteBtn) { suiteBtn.disabled = false; suiteBtn.textContent = '▶ Run Full Test Suite'; }
        }
    },
};
