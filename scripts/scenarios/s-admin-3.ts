// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-ADMIN-3 — Admin promote + demote with F-AU3 fail-closed.
 *
 * Branches covered:
 *   POST /api/admin/users/:bobId/promote                (200 — bob → global_admin)
 *   GET  /api/admin/users                               (bob role='global_admin')
 *   POST /api/admin/users/:bobId/demote                 (200 — bob → user)
 *   POST /api/admin/users/no-such-id/promote            (404 — user not found)
 *   POST /api/admin/users/:aliceId/demote               (422 — cannot-modify-owner)
 *   POST /api/admin/users/:bobId/promote (post-NaN)     (500 — F-AU3 fail-closed)
 *
 * Locks workers/routes/admin/users.ts:244-401 — the promote/demote handlers,
 * the F-AU3 parseAdminCap NaN-fail-closed branch (returns 500 on
 * unparseable max_global_admins), and the canAct peer-protection rules
 * (cannot-modify-owner targets the global_owner; user-not-found returns 404).
 *
 * Fail-closed planted via /__mock/seed-setting (bypasses the PATCH validator)
 * and reverted at the end so the scenario is order-independent.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface SeededUser {
  id: string;
  email: string;
  role: string;
}

interface AdminUserRow {
  id: string;
  email: string;
  role: string;
}

const scenario: Scenario = {
  id: "S-ADMIN-3",
  description:
    "Admin promote + demote round-trip + F-AU3 NaN fail-closed via /__mock/seed-setting",
  covers:
    "promote bob 200 → list shows global_admin → demote bob 200 → promote no-such-id 404 → demote alice 422 cannot-modify-owner → seed bogus max_global_admins → promote 500 (F-AU3) → revert",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. Seed bob (role='user').
    const seedBob = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(TEST_USERS.bob)}, display_name: 'Bob Builder' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (seedBob.status >= 300) {
      throw new Error(
        `seed-user(bob) failed: ${seedBob.status} ${seedBob.body.slice(0, 200)}`,
      );
    }
    const bob = JSON.parse(seedBob.body) as SeededUser;
    ctx.log(`bob seeded: id=${bob.id} role=${bob.role}`);

    // 2. Read alice's id from the admin list (BOOTSTRAP_OWNER_EMAIL → global_owner).
    const list = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/admin/users').then(r => r.json())`,
    })) as { users: AdminUserRow[] };
    const aliceRow = list.users.find(
      (u) => u.email.toLowerCase() === TEST_USERS.alice,
    );
    if (!aliceRow || aliceRow.role !== "global_owner") {
      throw new Error(
        `expected alice as global_owner, got ${JSON.stringify(aliceRow)}`,
      );
    }

    // 3. POST /:bobId/promote → 200, bob now global_admin.
    const promote = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/${bob.id}/promote', { method: 'POST' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (promote.status !== 200) {
      throw new Error(
        `promote bob expected 200, got ${promote.status}: ${promote.body.slice(0, 200)}`,
      );
    }
    const promoteBody = JSON.parse(promote.body) as {
      ok: boolean;
      current_role: string;
    };
    if (!promoteBody.ok || promoteBody.current_role !== "global_admin") {
      throw new Error(`promote response wrong: ${JSON.stringify(promoteBody)}`);
    }
    ctx.log(`POST /:bobId/promote → 200 current_role='global_admin' ✓`);

    // 4. GET /api/admin/users — bob now shows global_admin.
    const afterPromote = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/admin/users').then(r => r.json())`,
    })) as { users: AdminUserRow[] };
    const bobAfter = afterPromote.users.find((u) => u.id === bob.id);
    if (!bobAfter || bobAfter.role !== "global_admin") {
      throw new Error(
        `expected bob.role='global_admin' after promote, got ${JSON.stringify(bobAfter)}`,
      );
    }
    ctx.log(`bob.role='global_admin' in list ✓`);

    // 5. POST /:bobId/demote → 200, bob → user.
    const demote = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/${bob.id}/demote', { method: 'POST' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (demote.status !== 200) {
      throw new Error(
        `demote bob expected 200, got ${demote.status}: ${demote.body.slice(0, 200)}`,
      );
    }
    const demoteBody = JSON.parse(demote.body) as {
      ok: boolean;
      current_role: string;
    };
    if (!demoteBody.ok || demoteBody.current_role !== "user") {
      throw new Error(`demote response wrong: ${JSON.stringify(demoteBody)}`);
    }
    ctx.log(`POST /:bobId/demote → 200 current_role='user' ✓`);

    // 6. POST /no-such-id/promote → 404 user-not-found.
    const noUser = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/no-such-id-deadbeef/promote', { method: 'POST' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noUser.status !== 404) {
      throw new Error(
        `promote no-such-id expected 404, got ${noUser.status}: ${noUser.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /no-such-id/promote → 404 ✓`);

    // 7. POST /:aliceId/demote — alice is global_owner; canAct returns
    //    cannot-modify-owner before any role check → 422.
    const demoteOwner = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/${aliceRow.id}/demote', { method: 'POST' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (demoteOwner.status !== 422) {
      throw new Error(
        `demote owner expected 422, got ${demoteOwner.status}: ${demoteOwner.body.slice(0, 200)}`,
      );
    }
    const demoteOwnerBody = JSON.parse(demoteOwner.body) as {
      ok: boolean;
      reason?: string;
    };
    if (
      demoteOwnerBody.ok !== false ||
      demoteOwnerBody.reason !== "cannot-modify-owner"
    ) {
      throw new Error(
        `expected reason='cannot-modify-owner', got ${JSON.stringify(demoteOwnerBody)}`,
      );
    }
    ctx.log(`POST /:aliceId/demote → 422 cannot-modify-owner ✓`);

    // 8. F-AU3 fail-closed: plant a non-integer max_global_admins via
    //    /__mock/seed-setting (PATCH endpoint validates input → cannot
    //    plant). promote handler reads via parseAdminCap → returns 500.
    const seedBogus = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-setting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'max_global_admins', value: 'not-a-number' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (seedBogus.status !== 200) {
      throw new Error(
        `seed-setting bogus expected 200, got ${seedBogus.status}: ${seedBogus.body.slice(0, 200)}`,
      );
    }
    ctx.log(`/__mock/seed-setting max_global_admins='not-a-number' ✓`);

    const promoteFailClosed = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/${bob.id}/promote', { method: 'POST' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (promoteFailClosed.status !== 500) {
      throw new Error(
        `promote with bogus cap expected 500 (F-AU3 fail-closed), got ${promoteFailClosed.status}: ${promoteFailClosed.body.slice(0, 200)}`,
      );
    }
    const failBody = JSON.parse(promoteFailClosed.body) as { error?: string };
    if (
      typeof failBody.error !== "string" ||
      !failBody.error.toLowerCase().includes("max_global_admins")
    ) {
      throw new Error(
        `F-AU3 500 should mention max_global_admins, got ${JSON.stringify(failBody)}`,
      );
    }
    ctx.log(`POST /promote → 500 (F-AU3 fail-closed) ✓`);
    await ctx.screenshot("after-fail-closed");

    // 9. Revert max_global_admins to a sane value so subsequent scenarios
    //    aren't poisoned (settings_version bump invalidates cache).
    const revert = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-setting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'max_global_admins', value: '5' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (revert.status !== 200) {
      throw new Error(`revert seed-setting expected 200, got ${revert.status}`);
    }
    ctx.log(`reverted max_global_admins → '5' ✓`);

    // Three intentional failures (404 + 422 + 500). Allow ≤3 console errors.
    const consoleSnap = await ctx.captureConsole("after-admin-promote-demote");
    if (consoleSnap.errors > 3) {
      throw new Error(
        `expected ≤3 console errors (404 + 422 + 500 probes), got ${consoleSnap.errors} (see ${consoleSnap.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSnap.errors} (≤3 ✓)`);
  },
};

export default scenario;
