"""
PortolanCAST — Health & Dev Endpoints

Purpose:
    Server health check (DB, PDF engine, disk, AI endpoint) and dev-only
    test runner endpoint. The health check is consumed by the HealthMonitor
    plugin and the status-bar dot indicator.

Security assumptions:
    - Health check exposes only system status, no sensitive data
    - Test runner is hardcoded command — no user input accepted
    - Intended for local dev use only

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import asyncio
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from config import db, PROJECTS_DIR, TEMP_DIR, app_start_time

router = APIRouter()


@router.get('/api/health')
async def health_check():
    """
    Fast self-diagnostic: DB, PDF engine, disk space, filesystem write, AI endpoint.

    Used by the HealthMonitor plugin (right-panel "Health" tab) and the status-bar
    dot indicator. Intentionally avoids touching private internals — uses only the
    public Database API so the check mirrors real usage.

    Returns:
        JSON: { status, timestamp, uptime_seconds, checks }
        where status is 'healthy' | 'degraded' | 'unhealthy'.
    """
    checks = {}
    overall = 'healthy'

    # 1. Database — use public API to exercise the same path as real requests
    t0 = time.time()
    try:
        db.get_all_documents()
        ms = round((time.time() - t0) * 1000, 1)
        checks['database'] = {'status': 'ok', 'response_time_ms': ms}
    except Exception as e:
        checks['database'] = {'status': 'fail', 'detail': str(e)}
        overall = 'unhealthy'

    # 2. PDF engine — confirm PyMuPDF is importable and report version
    try:
        import fitz
        checks['pdf_engine'] = {'status': 'ok', 'detail': f'PyMuPDF {fitz.version[0]}'}
    except Exception as e:
        checks['pdf_engine'] = {'status': 'fail', 'detail': str(e)}
        overall = 'unhealthy'

    # 3. Disk space — warn at <1 GB free (large PDFs need headroom)
    try:
        usage = shutil.disk_usage(PROJECTS_DIR)
        free_gb = round(usage.free / (1024 ** 3), 1)
        status = 'warn' if free_gb < 1.0 else 'ok'
        checks['disk_space'] = {'status': status, 'free_gb': free_gb}
        if status == 'warn' and overall == 'healthy':
            overall = 'degraded'
    except Exception as e:
        checks['disk_space'] = {'status': 'fail', 'detail': str(e)}

    # 4. Filesystem write test — confirm data directory is writable
    try:
        test_path = TEMP_DIR / f'health_{uuid.uuid4().hex[:8]}.tmp'
        test_path.write_text('ok')
        test_path.unlink()
        checks['filesystem'] = {'status': 'ok'}
    except Exception as e:
        checks['filesystem'] = {'status': 'fail', 'detail': str(e)}
        overall = 'unhealthy'

    # 5. AI endpoint — ClaudeProxy is optional; offline = degraded, not unhealthy
    try:
        import requests as req
        r = req.get('http://127.0.0.1:11435/health', timeout=2)
        checks['ai_endpoint'] = {'status': 'ok', 'detail': f'HTTP {r.status_code}'}
    except Exception:
        checks['ai_endpoint'] = {'status': 'unavailable', 'detail': 'ClaudeProxy offline'}
        if overall == 'healthy':
            overall = 'degraded'

    return {
        'status': overall,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'uptime_seconds': round(time.time() - app_start_time),
        'checks': checks,
    }


@router.post('/api/dev/run-tests')
async def run_dev_tests():
    """
    DEV ONLY: Spawn the Playwright test suite and stream stdout line-by-line.

    Runs `node run_tests.mjs` in the project root as an async subprocess.
    Each line of output is yielded immediately via StreamingResponse so the
    browser panel updates in real time.

    Security note:
        - No user input accepted; command is hardcoded.
        - Intended for local dev use only (same trust level as the rest of the app).
    """
    project_root = Path(__file__).parent.parent

    async def _stream():
        proc = await asyncio.create_subprocess_exec(
            'node', 'run_tests.mjs',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(project_root),
        )
        async for line in proc.stdout:
            yield line.decode('utf-8', errors='replace')
        await proc.wait()

    return StreamingResponse(_stream(), media_type='text/plain; charset=utf-8')
