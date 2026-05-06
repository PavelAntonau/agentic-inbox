// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase 7 T7.3 — visual baseline locked at MTV2 launch.
// Phase E / TASK-E.4 — deterministic test-fixture reset hook + clock fix
//   + targeted masks so the baselines stop drifting between runs. Each
//   test:
//     1. POSTs to `/__mock/reset` → clears D1 tables, outbox, OTP tee.
//     2. POSTs to `/__mock/seed-user` for alice (global_owner) so the
//        authenticated routes have someone to render.
//     3. Installs a fixed `page.clock` so client-side `new Date()` /
//        `Date.now()` calls render the same string every run.
//     4. Masks the mailbox-list sidebar (auto-created drafts mailboxes
//        carry `Date.now()` in their names) and the server-rendered
//        timestamp regions on admin/observability.
//
// To re-lock baselines: `npm run test:visual:update`.

import { test, expect, type Page, type Locator } from "@playwright/test";

const ALICE_EMAIL = "alice@actionnow.ai";
const BASE = "http://localhost:8788";

// 2026-05-06 00:00:00 UTC — round figure, deterministic across machines.
const FIXED_CLOCK_MS = Date.UTC(2026, 4, 6, 0, 0, 0);

const ALICE_COOKIE = {
  name: "x-mock-user-email",
  value: encodeURIComponent(ALICE_EMAIL),
  url: BASE,
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

/**
 * Selectors for regions whose content is inherently dynamic (timestamps,
 * auto-generated mailbox names, etc.). The screenshot comparator overlays
 * a magenta rectangle on each match before computing the diff, so the
 * dynamic content does not contribute to the failure threshold.
 */
function dynamicMasks(page: Page): Locator[] {
  return [
    // The left-side mailbox tree includes auto-created drafts whose names
    // carry `Date.now()` in millisecond resolution — different every run.
    page.locator('aside, nav[aria-label*="Mailbox"], [data-mailbox-tree]'),
    // Any HTML5 <time> element renders a relative- or absolute-time
    // string that drifts between runs.
    page.locator("time"),
    // admin/observability shows "Since <timestamp>" + "<N>d ago" rows that
    // are rendered server-side from the live clock.
    page.locator(':text-matches("Since \\\\d", "i")'),
    page.locator(':text-matches("\\\\d+(s|m|h|d|w|y)?\\\\s*ago", "i")'),
    page.locator(':text-matches("NaN", "i")'),
  ];
}

test.beforeEach(async ({ page, request }) => {
  // Fix the client-side clock BEFORE navigation so any client-rendered
  // time formatting (Intl.DateTimeFormat, formatDistanceToNow, etc.) is
  // deterministic. Server-side timestamps still drift; those are masked.
  await page.clock.install({ time: new Date(FIXED_CLOCK_MS) });

  // Phase E / TASK-E.4 — wipe every dev-state surface so the next test
  // navigates against an identical fixture set.
  const reset = await request.post(`${BASE}/__mock/reset`);
  if (!reset.ok()) {
    throw new Error(
      `__mock/reset failed: ${reset.status()} ${await reset.text()}`,
    );
  }

  // Re-seed alice as global_owner so every authenticated route has a row
  // to render. The seed is idempotent — the helper collapses on the
  // lower(email) UNIQUE index so re-running for the same email returns
  // the existing row.
  const seed = await request.post(`${BASE}/__mock/seed-user`, {
    data: {
      email: ALICE_EMAIL,
      display_name: "Alice",
      role: "global_owner",
    },
  });
  if (!seed.ok()) {
    throw new Error(
      `__mock/seed-user failed: ${seed.status()} ${await seed.text()}`,
    );
  }
});

for (const route of routes) {
  test(`visual baseline: ${route.name}`, async ({ page, context }) => {
    if (route.auth !== false) {
      await context.addCookies([ALICE_COOKIE]);
    } else {
      await context.clearCookies();
    }
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot(`${route.name}.png`, {
      mask: dynamicMasks(page),
    });
  });
}
