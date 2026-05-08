#!/usr/bin/env bash
# scripts/lighthouse-mobile.sh — Mobile PWA Lighthouse gate.
#
# Usage:
#   ./scripts/lighthouse-mobile.sh [URL]
#
# Default URL: http://localhost:4173  (vite preview port)
# Override:    BASE_URL=http://localhost:8788 ./scripts/lighthouse-mobile.sh
#              or pass the URL as the first positional argument.
#
# Exit codes:
#   0 — PWA score >= 0.9
#   1 — PWA score < 0.9 (hard gate)
#
# Advisory scores (printed but do NOT fail the build):
#   accessibility, performance
#
# Output:
#   .scratch/lighthouse-mobile.json  (full Lighthouse JSON report)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_FILE="${REPO_ROOT}/.scratch/lighthouse-mobile.json"

mkdir -p "${REPO_ROOT}/.scratch"

# Resolve target URL: positional arg > env var > default
TARGET_URL="${1:-${BASE_URL:-http://localhost:4173}}"

echo "[lighthouse-mobile] Target: ${TARGET_URL}"
echo "[lighthouse-mobile] Output: ${OUT_FILE}"

# Run lighthouse via npx (no global install required).
# --emulated-form-factor=mobile  — Moto G4 emulation (Lighthouse standard)
# --only-categories              — skip SEO/best-practices to keep output focused
# --output=json                  — machine-readable for score extraction below
# --chrome-flags="--headless"    — CI-safe (no display required)
npx --yes lighthouse@13 "${TARGET_URL}" \
  --emulated-form-factor=mobile \
  --only-categories=pwa,accessibility,performance \
  --output=json \
  --output-path="${OUT_FILE}" \
  --chrome-flags="--headless --no-sandbox --disable-dev-shm-usage" \
  --quiet

echo "[lighthouse-mobile] Report written."

# Extract scores (each is 0–1; multiply by 100 for display).
PWA_SCORE=$(node -e "
  const r = require('${OUT_FILE}');
  process.stdout.write(String(r.categories.pwa.score));
")
A11Y_SCORE=$(node -e "
  const r = require('${OUT_FILE}');
  process.stdout.write(String(r.categories.accessibility.score));
")
PERF_SCORE=$(node -e "
  const r = require('${OUT_FILE}');
  process.stdout.write(String(r.categories.performance.score));
")

PWA_PCT=$(node -e "process.stdout.write(String(Math.round(${PWA_SCORE}*100)))")
A11Y_PCT=$(node -e "process.stdout.write(String(Math.round(${A11Y_SCORE}*100)))")
PERF_PCT=$(node -e "process.stdout.write(String(Math.round(${PERF_SCORE}*100)))")

echo ""
echo "┌─────────────────────────────────┐"
echo "│  Lighthouse Mobile Scores       │"
echo "├─────────────────────────────────┤"
echo "│  PWA           : ${PWA_PCT}% (gate ≥90)  │"
echo "│  Accessibility : ${A11Y_PCT}% (advisory)  │"
echo "│  Performance   : ${PERF_PCT}% (advisory)  │"
echo "└─────────────────────────────────┘"
echo ""

# Hard gate: PWA must be >= 0.9
PASS=$(node -e "process.stdout.write(Number(${PWA_SCORE}) >= 0.9 ? 'yes' : 'no')")
if [ "${PASS}" = "yes" ]; then
  echo "[lighthouse-mobile] PASS — PWA score ${PWA_PCT}% >= 90%"
  exit 0
else
  echo "[lighthouse-mobile] FAIL — PWA score ${PWA_PCT}% < 90% (gate not met)" >&2
  exit 1
fi
