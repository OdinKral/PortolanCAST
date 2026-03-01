#!/usr/bin/env bash
# =============================================================================
# PortolanCAST — Launch Script
#
# Activates the Python virtual environment and starts the FastAPI server.
# Usage: ./run.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Activate virtual environment
if [ ! -d "venv" ]; then
    echo "ERROR: Virtual environment not found. Run: python3 -m venv venv && pip install -r requirements.txt"
    exit 1
fi

source venv/bin/activate

# Verify critical dependency is installed
python -c "import fastapi" 2>/dev/null || {
    echo "ERROR: Dependencies not installed. Run: pip install -r requirements.txt"
    exit 1
}

# Ensure data directories exist
mkdir -p data/projects data/temp

echo "============================================"
echo "  PortolanCAST v0.1.0"
echo "  http://127.0.0.1:8000"
echo "============================================"
echo ""

# Start the server
# --reload enables auto-restart on code changes (development mode)
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
