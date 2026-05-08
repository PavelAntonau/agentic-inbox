#!/usr/bin/env bash
# mobile-audit.sh — Playwright screenshot audit for the three mobile viewports.
#
# Usage:
#   ./scripts/mobile-audit.sh [--out-dir <path>]
#
# Prerequisites:
#   - Dev server running on http://localhost:5173  (npm run dev)
#   - Playwright chromium installed               (npx playwright install chromium)
#
# Captures fold + full-page screenshots of /login (email step + OTP step) at:
#   iPhone 14 Pro  (393 × 852, DPR 3)
#   iPhone SE 3rd  (375 × 667, DPR 2)
#   Pixel 7        (412 × 915, DPR 2.625)
#
# Output: <out-dir>/<index>-<device>-<step>.png  (6+ files)
#         <out-dir>/VERDICT.md                   (per-viewport verdict)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${REPO_ROOT}/.scratch/mobile-audit/post-phase-1"

# Parse --out-dir flag
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "${OUT_DIR}"

BASE_URL="${BASE_URL:-http://localhost:5173}"

echo "[1/3] Checking dev server at ${BASE_URL} ..."
if ! curl -sf "${BASE_URL}/" > /dev/null 2>&1 && ! curl -sf "${BASE_URL}/login" > /dev/null 2>&1; then
  echo "ERROR: Dev server not reachable at ${BASE_URL}. Start it with: npm run dev" >&2
  exit 1
fi

echo "[2/3] Running Playwright audit ..."

cd "${REPO_ROOT}"
node - << 'EOF'
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT_DIR = process.env.OUT_DIR;
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

const VIEWPORTS = [
  {
    name: 'iphone14pro',
    label: 'iPhone 14 Pro',
    width: 393,
    height: 852,
    dpr: 3,
  },
  {
    name: 'iphonese',
    label: 'iPhone SE (3rd gen)',
    width: 375,
    height: 667,
    dpr: 2,
  },
  {
    name: 'pixel7',
    label: 'Pixel 7',
    width: 412,
    height: 915,
    dpr: 2.625,
  },
];

const verdicts = [];

(async () => {
  const browser = await chromium.launch({ headless: true });
  let idx = 1;

  for (const vp of VIEWPORTS) {
    console.log(`  Viewport: ${vp.label} (${vp.width}×${vp.height})`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr,
    });
    const page = await context.newPage();

    // --- Email step ---
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Fold (viewport)
    const foldFile = path.join(OUT_DIR, `${String(idx).padStart(2, '0')}-${vp.name}-login-fold.png`);
    await page.screenshot({ path: foldFile, clip: { x: 0, y: 0, width: vp.width, height: vp.height } });
    console.log(`    Saved: ${path.basename(foldFile)}`);
    idx++;

    // Full page
    const fullFile = path.join(OUT_DIR, `${String(idx).padStart(2, '0')}-${vp.name}-login-fullpage.png`);
    await page.screenshot({ path: fullFile, fullPage: true });
    console.log(`    Saved: ${path.basename(fullFile)}`);
    idx++;

    // DOM probes
    const probe = await page.evaluate(() => {
      const emailInput = document.querySelector('input[type=email]');
      const buttons = Array.from(document.querySelectorAll('button, input[type=submit]'));
      const primaryBtn = buttons.find(b => b.textContent?.trim().toLowerCase().includes('send') || b.textContent?.trim().toLowerCase().includes('code'));
      const body = document.body;
      const scrollWidth = document.documentElement.scrollWidth;
      const innerWidth = window.innerWidth;

      return {
        emailFontSize: emailInput ? window.getComputedStyle(emailInput).fontSize : null,
        emailHeight: emailInput ? window.getComputedStyle(emailInput).height : null,
        emailInputMode: emailInput ? emailInput.getAttribute('inputmode') : null,
        emailAutoCapitalize: emailInput ? emailInput.getAttribute('autocapitalize') : null,
        primaryBtnHeight: primaryBtn ? window.getComputedStyle(primaryBtn).height : null,
        scrollWidth,
        innerWidth,
        overflow: scrollWidth > innerWidth,
      };
    });

    const noOverflow = !probe.overflow;
    const fontSizeOk = probe.emailFontSize === '16px';
    const btnHeightPx = probe.primaryBtnHeight ? parseFloat(probe.primaryBtnHeight) : 0;
    const tapTargetOk = btnHeightPx >= 44;

    verdicts.push({
      device: vp.label,
      noOverflow,
      emailFontSize: probe.emailFontSize,
      fontSizeOk,
      primaryBtnHeight: probe.primaryBtnHeight,
      tapTargetOk,
      emailInputMode: probe.emailInputMode,
      emailAutoCapitalize: probe.emailAutoCapitalize,
    });

    await context.close();
  }

  await browser.close();

  // Write VERDICT.md
  const verdictPath = path.join(OUT_DIR, 'VERDICT.md');
  const lines = [
    '# Phase 1 — Mobile Audit Verdict',
    '',
    `**Run date:** ${new Date().toISOString()}`,
    `**Server:** ${BASE_URL}`,
    '',
    '## Results',
    '',
  ];

  for (const v of verdicts) {
    const ok = (b) => b ? '✓' : '✗';
    lines.push(`### ${v.device}`);
    lines.push('');
    lines.push(`| Check | Result | Pass |`);
    lines.push(`|---|---|---|`);
    lines.push(`| No horizontal overflow | scrollWidth === innerWidth | ${ok(v.noOverflow)} |`);
    lines.push(`| Email input fontSize | ${v.emailFontSize ?? 'n/a'} | ${ok(v.fontSizeOk)} |`);
    lines.push(`| Primary button height | ${v.primaryBtnHeight ?? 'n/a'} | ${ok(v.tapTargetOk)} |`);
    lines.push(`| Email inputmode attr | ${v.emailInputMode ?? 'null'} | ${ok(v.emailInputMode === 'email')} |`);
    lines.push(`| Email autocapitalize attr | ${v.emailAutoCapitalize ?? 'null'} | ${ok(v.emailAutoCapitalize === 'none')} |`);
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('- DOM probes run against the local dev server (`CF_ACCESS_DEV_MODE=mock`),');
  lines.push('  which intercepts `/login` with the dev-identity picker. The React app');
  lines.push('  email input is not rendered until after CF Access auth in dev mode.');
  lines.push('  Font-size and attr checks are therefore against the mock page, not the');
  lines.push('  React login route. See T1.6 — the fix (text-[16px] on lg/xl Input');
  lines.push('  tiers) is unit-tested via KUMO_INPUT_VARIANTS assertions.');
  lines.push('');

  fs.writeFileSync(verdictPath, lines.join('\n'));
  console.log(`\n  VERDICT.md written to ${verdictPath}`);
  console.log('\n  Summary:');
  for (const v of verdicts) {
    const pass = v.noOverflow && v.fontSizeOk && v.tapTargetOk;
    console.log(`    ${v.device}: ${pass ? 'PASS' : 'PARTIAL'}`);
  }
})().catch(e => {
  console.error('Audit failed:', e.message);
  process.exit(1);
});
EOF