#!/usr/bin/env bash
# =============================================================================
# PortolanCAST — Linux/WSL Build Script
#
# Purpose:
#   Builds the PortolanCAST desktop app in two stages:
#   1. PyInstaller: Freezes the Python backend into a standalone directory
#   2. electron-builder: Packages Electron + frozen backend into an AppImage
#
# Prerequisites:
#   - Python 3.10+ with pip (venv recommended)
#   - Node.js 18+ with npm
#   - All Python dependencies installed (pip install -r requirements.txt)
#
# Usage:
#   cd PortolanCAST
#   bash electron/build.sh
#
# Output:
#   electron/dist/ — contains the built AppImage
# =============================================================================

set -euo pipefail

# Navigate to project root (parent of electron/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== PortolanCAST Desktop Build ==="
echo "Project root: $PROJECT_ROOT"
echo ""

# -------------------------------------------------------------------------
# Step 1: PyInstaller — freeze the Python backend
# -------------------------------------------------------------------------
echo "--- Step 1: Building Python backend with PyInstaller ---"

cd "$PROJECT_ROOT"

# Install PyInstaller if not present
pip install --quiet pyinstaller

# Clean previous build artifacts
rm -rf "$SCRIPT_DIR/portolan-server" build/ dist/

# Run PyInstaller with the spec file
# Output goes to electron/portolan-server/ (referenced by electron-builder)
pyinstaller "$SCRIPT_DIR/pyinstaller.spec" \
    --distpath "$SCRIPT_DIR" \
    --workpath build/pyinstaller \
    --clean \
    --noconfirm

echo "Backend built: $SCRIPT_DIR/portolan-server/"
echo ""

# -------------------------------------------------------------------------
# Step 2: Electron — package the desktop app
# -------------------------------------------------------------------------
echo "--- Step 2: Building Electron app ---"

cd "$SCRIPT_DIR"

# Install Electron dependencies
npm install

# Build for Linux (AppImage)
npm run build:linux

echo ""
echo "=== Build complete ==="
echo "Output: $SCRIPT_DIR/dist/"
ls -lh "$SCRIPT_DIR/dist/" 2>/dev/null || echo "(check dist/ for output)"
