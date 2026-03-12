#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# Eye Tracking Desktop — One-Command Setup
# ─────────────────────────────────────────────
# Usage:  chmod +x setup.sh && ./setup.sh
# ─────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Pre-flight checks ──────────────────────

info "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Please install Node.js 20+ from https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js 20+ is required (found v$(node -v)). Please upgrade from https://nodejs.org"
fi
info "Node.js $(node -v) ✓"

# npm
if ! command -v npm &>/dev/null; then
  error "npm is not installed. It should come with Node.js."
fi
info "npm $(npm -v) ✓"

# Python 3
if command -v python3 &>/dev/null; then
  PYTHON=python3
elif command -v python &>/dev/null; then
  PYTHON=python
else
  error "Python 3 is not installed. Please install Python 3.8+ from https://python.org"
fi

PY_VERSION=$($PYTHON --version 2>&1 | awk '{print $2}')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 8 ]; }; then
  error "Python 3.8+ is required (found $PY_VERSION). Please upgrade."
fi
info "Python $PY_VERSION ✓"

# ── Linux-only: system libraries for OpenCV ──

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  info "Linux detected — checking system libraries for OpenCV..."
  MISSING_PKGS=()
  for pkg in libgl1 libsm6 libxext6; do
    if ! dpkg -s "$pkg" &>/dev/null 2>&1; then
      MISSING_PKGS+=("$pkg")
    fi
  done
  if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    warn "Missing system packages: ${MISSING_PKGS[*]}"
    warn "Install them with:  sudo apt-get install -y ${MISSING_PKGS[*]}"
    read -rp "Install now? (y/N) " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      sudo apt-get update && sudo apt-get install -y "${MISSING_PKGS[@]}"
    else
      warn "Skipping — OpenCV may fail at runtime without these packages."
    fi
  fi
fi

# ── Python virtual environment ──────────────

info "Setting up Python virtual environment..."

if [ ! -d ".venv" ]; then
  $PYTHON -m venv .venv
  info "Created .venv"
else
  info ".venv already exists, reusing it"
fi

# Activate
# shellcheck disable=SC1091
source .venv/bin/activate

info "Upgrading pip..."
pip install --upgrade pip --quiet

info "Installing Python dependencies..."
pip install -r tracker/requirements.txt --quiet

info "Python packages installed ✓"

# ── Node dependencies ──────────────────────

info "Installing Node.js dependencies..."
npm ci
info "Node.js packages installed ✓"

# ── Verify install ──────────────────────────

info "Verifying installation..."

$PYTHON -c "import cv2, mediapipe, numpy, pandas; print('Python imports OK')" \
  || error "Python dependency check failed"

npx electron --version &>/dev/null \
  || warn "Electron binary check failed — try 'npm ci' again"

# ── Done ────────────────────────────────────

echo ""
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo ""
echo "  To start developing:"
echo ""
echo "    source .venv/bin/activate"
echo "    npm run dev"
echo ""
echo "  Other commands:"
echo "    npm run build       Build for production"
echo "    npm run test        Run tests"
echo "    npm run lint        Lint the codebase"
echo ""
