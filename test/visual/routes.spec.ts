// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase 7 T7.3 — visual baseline locked at MTV2 launch.
//
// Replaces the upstream-default 5-route spec (home / mailbox / settings /
// search-results / not-found) with the actual MTV2 route surface. Routes
// that need an authenticated identity inject the mock-Access cookie set
// for alice@actionnow.ai (global_owner per BOOTSTRAP_OWNER_EMAIL).
//
// To re-lock baselines: `npm run test:visual:update`.

import { test, expect } from "@playwright/test";

const ALICE_COOKIE = {
  name: "x-mock-user-email",
  value: encodeURIComponent("alice@actionnow.ai"),
  url: "http://localhost:5173",
};

interface RouteSpec {
  name: string;
  path: string;
  /** Inject alice cookie before navigating. Default: true. */
  auth?: boolean;
}

const routes: RouteSpec[] = [
  // Public surfaces
  { name: "login", path: "/login", auth: false },
  { name: "not-found", path: "/this-route-does-not-exist", auth: false },

  // Outlook three-pane shell (alice = global_owner)
  { name: "home", path: "/" },
  { name: "contacts", path: "/contacts" },

  // Groups + invitations
  { name: "groups", path: "/groups" },

  // Admin panel
  { name: "admin-users", path: "/admin/users" },
  { name: "admin-settings", path: "/admin/settings" },
  { name: "admin-tokens", path: "/admin/tokens" },
  { name: "admin-observability", path: "/admin/observability" },
];

for (const route of routes) {
  test(`visual baseline: ${route.name}`, async ({ page, context }) => {
    if (route.auth !== false) {
      await context.addCookies([ALICE_COOKIE]);
    } else {
      await context.clearCookies();
    }
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot(`${route.name}.png`);
  });
}
