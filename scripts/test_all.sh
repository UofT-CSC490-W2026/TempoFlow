#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[test_all] Running A5 (pytest) ..."
env MPLCONFIGDIR=/tmp "${ROOT_DIR}/A5/venv/bin/python" -m pytest "${ROOT_DIR}/A5/tests" -q

echo ""
echo "[test_all] Running web-app (vitest) ..."
cd "${ROOT_DIR}/web-app"
npm test

echo ""
echo "[test_all] ✅ All tests passed."
