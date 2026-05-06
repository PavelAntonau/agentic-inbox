// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Phase E / TASK-E.4 — visual baselines run against the wrangler `mock:up`
// server (MOCK_MODE=1 on :8788) so each test starts from a deterministic
// fixture state. The previous setup pointed at `npm run dev` (Vite on
// :5173), where data accumulated across runs and 8/9 baselines drifted
// every session. The mock harness exposes `/__mock/reset` + `/__mock/seed-*`
// endpoints; the visual spec resets D1 + reseeds alice in `beforeEach`,
// fixes the JavaScript clock via `page.clock.install`, and masks the few
// remaining dynamic regions (mailbox-list sidebar, server-rendered
// "Since …" / "N ago" timestamps).
//
// Diff thresholds are configured under `expect.toHaveScreenshot` (NOT
// `toMatchSnapshot`) — the spec uses `expect(page).toHaveScreenshot(...)`,
// which has its own threshold key. Setting the wrong key silently falls
// back to the strict default and surfaces every sub-pixel font-AA drift
// as a baseline failure.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/visual",
  snapshotDir: "./test/visual/__screenshots__",
  expect: {
    // 5 % of total pixels = ~205 k for the 2560×1600 (DSF=2) viewport.
    // 5 000 absolute floor catches small AA / icon-rendering noise on
    // pages that are otherwise tiny. Both must be satisfied; the lower
    // value takes precedence for any given comparison.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.05,
      maxDiffPixels: 5_000,
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        baseURL: "http://localhost:8788",
      },
    },
  ],
  webServer: {
    // `mock:up` does build + migrate + wrangler-dev. Build under
    // react-router 7 + Vite takes ~60s on cold cache; migrate ~1s; wrangler
    // boot ~5s. 180s ceiling covers a cold CI start; reuses an already-
    // running server when developing locally.
    command: "npm run mock:up",
    url: "http://localhost:8788/__mock/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
