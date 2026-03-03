"""
portolan_dev_mcp.py — PortolanCAST Dev Plane MCP Server (Phase 2)
==================================================================

Purpose:
    Exposes the PortolanCAST source code, test infrastructure, and project
    pipeline to AI agents as a read-only dev plane MCP server.

    This is the DEV PLANE server — agents can read source files, run tests,
    inspect git history, and read the project pipeline document.
    Code modification is intentionally excluded: that stays human-in-the-loop
    via Claude Code.

Key features:
    6 MCP tools:
        - list_source_files  — walk project directory tree
        - read_file          — read source files (traversal-guarded)
        - run_tests          — execute test suite, stream results
        - get_git_log        — recent commits
        - get_git_diff       — current working tree diff stats
        - get_pipeline       — read the Engineering_OpenRevu pipeline doc

Security architecture:
    Two separate processes (portolan_mcp.py + portolan_dev_mcp.py) instead of
    one combined server. This keeps security surfaces bounded: the operational
    server handles data writes; the dev server is read-only.

    SECURITY: read_file enforces path traversal protection:
        1. Resolve the path absolutely to defeat ../ sequences
        2. Verify the resolved path starts with PROJECT_ROOT
        3. Check the file extension against an allowlist
    No file outside the project directory or with a disallowed extension
    can be read, even if an AI agent constructs a crafted path string.

    SECURITY: run_tests runs via subprocess with a fixed command — the test
    file argument is validated against the project directory before use.
    No shell=True to prevent injection.

Threat model:
    - Attacker could craft a path like "../../etc/passwd" → defeated by resolve()
    - Attacker could request ".env" or ".db" → defeated by extension allowlist
    - Attacker could request a file outside PROJECT_ROOT → defeated by prefix check
    - Attacker could inject shell commands via test_file arg → defeated by
      subprocess list form and path validation

Usage:
    venv/bin/python3 portolan_dev_mcp.py

Author: PortolanCAST project
Version: 1.0.0
Date: 2026-03-02
"""

# =============================================================================
# IMPORTS
# =============================================================================

import subprocess
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP

# =============================================================================
# SERVER SETUP
# =============================================================================

mcp = FastMCP("PortolanCAST-Dev")

# Absolute path to the project root — all file access is bounded to this tree.
# __file__ is this script; .parent is the directory containing it (project root).
PROJECT_ROOT = Path(__file__).parent.resolve()

# =============================================================================
# SECURITY CONSTANTS
# =============================================================================

# Extension allowlist for read_file — only these file types can be served.
# SECURITY: Excludes .env, .db, .key, .pem, .sqlite and other sensitive types.
ALLOWED_EXTENSIONS = {".py", ".js", ".mjs", ".html", ".css", ".md", ".json", ".txt"}

# Directories to skip when listing source files.
# These are either generated artifacts (node_modules, __pycache__) or
# large data stores (data/) that have no value to an AI reading source.
SKIP_DIRS = {
    "node_modules", "venv", "__pycache__", "data", ".git",
}

# Path to the pipeline document for this project.
# This is outside PROJECT_ROOT (in the PAI skill tree) so it gets special handling.
PIPELINE_PATH = Path.home() / ".claude/PIPELINES/Engineering_OpenRevu/PIPELINE.md"

# =============================================================================
# SECURITY HELPERS
# =============================================================================

def _safe_path(path: str) -> Path:
    """
    Resolve and validate a file path for safe reading.

    Defeats path traversal by:
    1. Resolving the path absolutely (collapses ../ sequences)
    2. Verifying the resolved path starts with PROJECT_ROOT
    3. Checking the extension against ALLOWED_EXTENSIONS

    SECURITY: This must be called on ANY user-supplied path before reading.

    Args:
        path: Relative or absolute path supplied by the AI caller

    Returns:
        Resolved, validated Path object

    Raises:
        ValueError: If path traversal is detected or extension is not allowed
    """
    # Resolve relative to PROJECT_ROOT, then absolutify
    resolved = (PROJECT_ROOT / path).resolve()

    # SECURITY: Prevent directory traversal — resolved path must be inside root
    if not str(resolved).startswith(str(PROJECT_ROOT)):
        raise ValueError(
            f"Path traversal not allowed: '{path}' resolves outside project root"
        )

    # SECURITY: Extension allowlist — disallow .env, .db, .sqlite, .key, etc.
    if resolved.suffix not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"Extension '{resolved.suffix}' is not in the read allowlist. "
            f"Allowed: {sorted(ALLOWED_EXTENSIONS)}"
        )

    return resolved

# =============================================================================
# TOOL 1 — LIST SOURCE FILES
# =============================================================================

@mcp.tool()
def list_source_files(subdir: str = "") -> dict:
    """
    List source files in the project directory tree.

    Returns file paths relative to the project root. Skips generated
    directories (node_modules, venv, __pycache__, data/, .git/).

    Args:
        subdir: Optional subdirectory to scope the listing (e.g., "static/js").
                Defaults to the entire project root.

    Returns:
        {"files": ["path/to/file.py", ...], "total": int, "root": str}
    """
    # Resolve the start directory — still bounded inside PROJECT_ROOT
    if subdir:
        start = (PROJECT_ROOT / subdir).resolve()
        if not str(start).startswith(str(PROJECT_ROOT)):
            return {"error": "Subdir traversal not allowed"}
    else:
        start = PROJECT_ROOT

    files = []
    for p in start.rglob("*"):
        # Skip directories in the exclusion list — prune the walk
        if any(skip in p.parts for skip in SKIP_DIRS):
            continue
        if p.is_file():
            # Return relative path strings for readability
            files.append(str(p.relative_to(PROJECT_ROOT)))

    files.sort()
    return {"files": files, "total": len(files), "root": str(PROJECT_ROOT)}


# =============================================================================
# TOOL 2 — READ FILE
# =============================================================================

@mcp.tool()
def read_file(path: str) -> dict:
    """
    Read the content of a source file in the project.

    Path is relative to the project root (e.g., "main.py", "static/js/canvas.js").
    Only files with allowed extensions (.py, .js, .mjs, .html, .css, .md, .json,
    .txt) can be read. Path traversal (../) is blocked.

    Args:
        path: Relative path within the project root

    Returns:
        {"path": str, "content": str, "lines": int} or {"error": str}
    """
    try:
        safe = _safe_path(path)
    except ValueError as e:
        return {"error": str(e)}

    if not safe.exists():
        return {"error": f"File not found: {path}"}

    if not safe.is_file():
        return {"error": f"Path is not a file: {path}"}

    content = safe.read_text(encoding="utf-8", errors="replace")
    return {
        "path":    str(safe.relative_to(PROJECT_ROOT)),
        "content": content,
        "lines":   content.count("\n") + 1,
    }


# =============================================================================
# TOOL 3 — RUN TESTS
# =============================================================================

@mcp.tool()
def run_tests(test_file: Optional[str] = None) -> dict:
    """
    Run the PortolanCAST test suite (or a single test file).

    Executes via Node.js. If no test_file is specified, runs the full suite
    via run_tests.mjs. Output is captured and returned as a string.

    SECURITY: test_file is validated to exist within the project directory
    before execution. No shell=True — arguments are passed as a list.

    Note: The FastAPI server at http://127.0.0.1:8000 must be running before
    tests can execute (tests use browser automation against live server).

    Args:
        test_file: Optional relative path to a specific .mjs test file
                   (e.g., "test_health_monitor.mjs"). Omit to run all tests.

    Returns:
        {"exit_code": int, "output": str, "test_file": str}
    """
    if test_file is None:
        target = "run_tests.mjs"
    else:
        # SECURITY: validate the test file path before executing it
        target = test_file.strip()
        test_path = (PROJECT_ROOT / target).resolve()
        if not str(test_path).startswith(str(PROJECT_ROOT)):
            return {"error": "Path traversal not allowed in test_file"}
        if not test_path.exists():
            return {"error": f"Test file not found: {target}"}
        if test_path.suffix != ".mjs":
            return {"error": "Only .mjs test files are allowed"}

    try:
        result = subprocess.run(
            ["node", target],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout for full suite
        )
        # Combine stdout and stderr — test runners use both
        combined = result.stdout
        if result.stderr:
            combined += "\n--- stderr ---\n" + result.stderr

        return {
            "exit_code": result.returncode,
            "output":    combined,
            "test_file": target,
        }
    except subprocess.TimeoutExpired:
        return {
            "exit_code": -1,
            "output":    "Test run timed out after 300 seconds",
            "test_file": target,
        }
    except FileNotFoundError:
        return {
            "exit_code": -1,
            "output":    "node not found — is Node.js installed?",
            "test_file": target,
        }


# =============================================================================
# TOOL 4 — GET GIT LOG
# =============================================================================

@mcp.tool()
def get_git_log(n: int = 10) -> dict:
    """
    Get recent git commit history for the project.

    Args:
        n: Number of commits to return (default: 10, max: 100)

    Returns:
        {"log": str, "commit_count": int}
    """
    # Clamp n to prevent huge outputs
    n = max(1, min(n, 100))

    result = subprocess.run(
        ["git", "log", "--oneline", f"-{n}"],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=10,
    )

    log_text = result.stdout.strip()
    lines = [l for l in log_text.splitlines() if l]

    return {
        "log":          log_text,
        "commit_count": len(lines),
    }


# =============================================================================
# TOOL 5 — GET GIT DIFF
# =============================================================================

@mcp.tool()
def get_git_diff() -> dict:
    """
    Get the current working tree diff statistics against HEAD.

    Returns a summary of which files have changed and how many lines,
    without showing full diff content (keeps output size manageable).

    Returns:
        {"diff_stat": str, "has_changes": bool}
    """
    result = subprocess.run(
        ["git", "diff", "--stat", "HEAD"],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=10,
    )

    stat = result.stdout.strip()
    return {
        "diff_stat":   stat,
        "has_changes": bool(stat),
    }


# =============================================================================
# TOOL 6 — GET PIPELINE
# =============================================================================

@mcp.tool()
def get_pipeline() -> dict:
    """
    Read the Engineering_OpenRevu pipeline document.

    The pipeline document tracks the PortolanCAST project roadmap, current
    phase status, completed milestones, and upcoming work. Use this to
    understand where the project is and what comes next.

    Returns:
        {"content": str, "path": str} or {"error": str}
    """
    # SECURITY NOTE: PIPELINE_PATH is a hardcoded constant, not user-supplied.
    # No traversal risk — the path never comes from caller input.
    if not PIPELINE_PATH.exists():
        return {
            "error": f"Pipeline document not found at {PIPELINE_PATH}. "
                     "Has the Engineering_OpenRevu pipeline been created?"
        }

    content = PIPELINE_PATH.read_text(encoding="utf-8", errors="replace")
    return {
        "content": content,
        "path":    str(PIPELINE_PATH),
    }


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    # FastMCP handles stdio transport automatically.
    mcp.run()
