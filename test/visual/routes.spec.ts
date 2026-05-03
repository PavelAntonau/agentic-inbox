// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test, expect } from "@playwright/test";

const routes = [
  { name: "home", path: "/" },
  { name: "mailbox", path: "/mailbox" },
  { name: "settings", path: "/settings" },
  { name: "search-results", path: "/search-results" },
  { name: "not-found", path: "/not-found" },
];

for (const route of routes) {
  test(`visual baseline: ${route.name}`, async ({ page }) => {
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot(`${route.name}.png`);
  });
}
