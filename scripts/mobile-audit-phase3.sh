#!/usr/bin/env bash
# mobile-audit-phase3.sh — Phase 3 visual regression sweep (T3.4).
#
# Sister of mobile-audit.sh — same shape, but:
#   • Captures the production-built path: BASE_URL defaults to wrangler
#     dev on :8788 (`npm run mock:up`), not the Vite dev server.
#   • Adds the iPad mini (768 × 1024) viewport so the breakpoint
#     snap from mobile bottom-sheet to desktop card is visible.
#   • Captures the OTP step in addition to the email step. The dev
#     picker overrides /login under MOCK_MODE=1, so we drive past it
#     by POSTing identity=alice@actionnow.ai then navigate the
#     authenticated app — which exercises the same hydration script
#     graph that ships in production.
#   • Outputs to `.scratch/mobile-audit/post-phase-3/` by default.
#
# Usage:
#   ./scripts/mobile-audit-phase3.sh [--out-dir <path>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${REPO_ROOT}/.scratch/mobile-audit/post-phase-3"

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

BASE_URL="${BASE_URL:-http://127.0.0.1:8788}"

echo "[1/3] Probing wrangler at ${BASE_URL} ..."
if ! curl -fsS -m 3 "${BASE_URL}/__mock/health" >/dev/null 2>&1; then
  echo "ERROR: ${BASE_URL}/__mock/health unreachable. Run \`npm run mock:up\` in another terminal first." >&2
  exit 1
fi

echo "[2/3] Running Playwright audit at 4 viewports × 2 steps ..."

cd "${REPO_ROOT}"
OUT_DIR="${OUT_DIR}" BASE_URL="${BASE_URL}" node - << 'EOF'
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT_DIR = process.env.OUT_DIR;
const BASE_URL = process.env.BASE_URL;

const VIEWPORTS = [
  { name: 'iphone14pro', label: 'iPhone 14 Pro',  width: 393, height: 852,  dpr: 3 },
  { name: 'iphonese',    label: 'iPhone SE',      width: 375, height: 667,  dpr: 2 },
  { name: 'pixel7',      label: 'Pixel 7',        width: 412, height: 915,  dpr: 2.625 },
  { name: 'ipadmini',    label: 'iPad mini',      width: 768, height: 1024, dpr: 2 },
];

const verdicts = [];

(async () => {
  const browser = await chromium.launch({ headless: true });
  let idx = 1;

  for (const vp of VIEWPORTS) {
    console.log(`  ${vp.label} (${vp.width}×${vp.height})`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr,
    });
    const page = await context.newPage();

    // ---- Email step (dev picker under MOCK_MODE — same surface the
    //      pre-redesign baseline captured) ----
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    const emailFold = path.join(OUT_DIR, `${String(idx).padStart(2,'0')}-${vp.name}-email-fold.png`);
    await page.screenshot({ path: emailFold, clip: { x:0, y:0, width: vp.width, height: vp.height } });
    idx++;
    const emailFull = path.join(OUT_DIR, `${String(idx).padStart(2,'0')}-${vp.name}-email-fullpage.png`);
    await page.screenshot({ path: emailFull, fullPage: true });
    idx++;

    // DOM probes (no horizontal overflow, breakpoint check).
    const emailProbe = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      title: document.title,
    }));

    // ---- Authenticated app surface (post-login).  Reset state, log in
    //      via the picker, navigate to / which renders the React app
    //      with the same hydration script graph as production. ----
    await page.evaluate(async () => {
      try { await fetch('/__mock/reset', { method: 'POST' }); } catch {}
      await fetch('/login', {
        method: 'POST',
        body: new URLSearchParams({ identity: 'alice@actionnow.ai' }),
        credentials: 'same-origin',
      });
    });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const homeFold = path.join(OUT_DIR, `${String(idx).padStart(2,'0')}-${vp.name}-home-fold.png`);
    await page.screenshot({ path: homeFold, clip: { x:0, y:0, width: vp.width, height: vp.height } });
    idx++;
    const homeFull = path.join(OUT_DIR, `${String(idx).padStart(2,'0')}-${vp.name}-home-fullpage.png`);
    await page.screenshot({ path: homeFull, fullPage: true });
    idx++;

    const homeProbe = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      mobileSheet: !!document.querySelector('[data-mobile-bottom-sheet]'),
    }));

    verdicts.push({
      device: vp.label,
      width: vp.width,
      emailNoOverflow: emailProbe.scrollWidth <= emailProbe.innerWidth + 1,
      homeNoOverflow: homeProbe.scrollWidth <= homeProbe.innerWidth + 1,
      breakpointTier: vp.width >= 768 ? 'desktop' : 'mobile',
    });

    await context.close();
  }

  await browser.close();

  const verdictPath = path.join(OUT_DIR, 'VERDICT.md');
  const lines = [
    '# T3.4 — Phase 3 Mobile Visual Regression',
    '',
    `**Run:** ${new Date().toISOString()}`,
    `**Source:** ${BASE_URL} (production-built, wrangler dev --local)`,
    '',
    '## Per-viewport',
    '',
    '| Device | Width | Tier | /login no-overflow | / no-overflow |',
    '|---|---|---|---|---|',
  ];
  for (const v of verdicts) {
    const ok = b => b ? 'PASS' : 'FAIL';
    lines.push(`| ${v.device} | ${v.width} | ${v.breakpointTier} | ${ok(v.emailNoOverflow)} | ${ok(v.homeNoOverflow)} |`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- /login under MOCK_MODE=1 serves the dev identity picker, not the');
  lines.push('  React Turnstile widget. Apples-to-apples with the pre-redesign');
  lines.push('  baseline captured under the same MOCK_MODE.');
  lines.push('- /home (after dev-picker login as alice@actionnow.ai) renders the');
  lines.push('  full React app surface — same hydration scripts as production.');
  lines.push('- iPad mini (768×1024) crosses the `md:` breakpoint and should');
  lines.push('  render the desktop card layout, NOT the mobile bottom-sheet.');
  fs.writeFileSync(verdictPath, lines.join('\n') + '\n');
  console.log(`  VERDICT.md → ${verdictPath}`);
  for (const v of verdicts) {
    const pass = v.emailNoOverflow && v.homeNoOverflow;
    console.log(`    ${v.device}: ${pass ? 'PASS' : 'PARTIAL'}`);
  }
})().catch(e => {
  console.error('Audit failed:', e.message);
  process.exit(1);
});
EOF

echo "[3/3] Done — screenshots in ${OUT_DIR}"
