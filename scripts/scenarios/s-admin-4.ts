// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-ADMIN-4 — DELETE /api/admin/users/:id branches.
 *
 * Branches covered:
 *   DELETE /api/admin/users/:charlieId      (200 — happy path; row removed)
 *   GET    /api/admin/users                  (charlie no longer present)
 *   DELETE /api/admin/users/no-such-id       (404 — user not found)
 *   DELETE /api/admin/users/:aliceId         (422 — cannot-modify-owner)
 *   DELETE /api/admin/users/:daveId          (409 — owns-mailboxes,
 *                                                  message + count)
 *
 * Locks workers/routes/admin/users.ts:407-474 — the lookup, canAct
 * decision tree (cannot-modify-owner → owns-mailboxes → role-based
 * permission), and the audit-before-delete ordering.
 *
 * Uses /__mock/seed-user for charlie + dave, then impersonates dave
 * to POST /api/mailboxes (so the mailbox is owned by dave, not alice),
 * then switches back to alice for the DELETE probe.
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
  owns_mailboxes_count: number;
}

const scenario: Scenario = {
  id: "S-ADMIN-4",
  description:
    "Admin DELETE :id — happy path + 404 + cannot-modify-owner + owns-mailboxes",
  covers:
    "DELETE charlie 200 → list excludes charlie → DELETE no-such-id 404 → DELETE alice 422 cannot-modify-owner → seed dave + create dave-owned mailbox → DELETE dave 409 owns-mailboxes",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // Read alice's id from the admin list (BOOTSTRAP_OWNER_EMAIL).
    const beforeList = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/admin/users').then(r => r.json())`,
    })) as { users: AdminUserRow[] };
    const aliceRow = beforeList.users.find(
      (u) => u.email.toLowerCase() === TEST_USERS.alice,
    );
    if (!aliceRow) {
      throw new Error(`alice missing from admin list at scenario start`);
    }

    // 1. Seed charlie (role='user', no mailboxes).
    const charlieEmail = `s-admin-4-charlie-${Date.now()}-${Math.floor(Math.random() * 1000)}@actionnow.ai`;
    const seedCharlie = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(charlieEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (seedCharlie.status >= 300) {
      throw new Error(
        `seed-user(charlie) failed: ${seedCharlie.status} ${seedCharlie.body.slice(0, 200)}`,
      );
    }
    const charlie = JSON.parse(seedCharlie.body) as SeededUser;
    ctx.log(`charlie seeded: id=${charlie.id}`);

    // 2. DELETE charlie → 200 (no mailboxes, role='user', alice is owner).
    const delCharlie = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/${charlie.id}', { method: 'DELETE' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (delCharlie.status !== 200) {
      throw new Error(
        `DELETE charlie expected 200, got ${delCharlie.status}: ${delCharlie.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE /:charlieId → 200 ✓`);

    // 3. GET list — charlie no longer present.
    const afterDel = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/admin/users').then(r => r.json())`,
    })) as { users: AdminUserRow[] };
    const charlieGone = !afterDel.users.some((u) => u.id === charlie.id);
    if (!charlieGone) {
      throw new Error(`charlie still in /api/admin/users after DELETE`);
    }
    ctx.log(`charlie removed from list ✓`);

    // 4. DELETE no-such-id → 404.
    const noUser = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/no-such-id-deadbeef', { method: 'DELETE' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noUser.status !== 404) {
      throw new Error(
        `DELETE no-such-id expected 404, got ${noUser.status}: ${noUser.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE /no-such-id → 404 ✓`);

    // 5. DELETE alice (global_owner) → 422 cannot-modify-owner.
    const delOwner = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/${aliceRow.id}', { method: 'DELETE' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (delOwner.status !== 422) {
      throw new Error(
        `DELETE owner expected 422, got ${delOwner.status}: ${delOwner.body.slice(0, 200)}`,
      );
    }
    const delOwnerBody = JSON.parse(delOwner.body) as {
      ok: boolean;
      reason?: string;
    };
    if (
      delOwnerBody.ok !== false ||
      delOwnerBody.reason !== "cannot-modify-owner"
    ) {
      throw new Error(
        `expected reason='cannot-modify-owner', got ${JSON.stringify(delOwnerBody)}`,
      );
    }
    ctx.log(`DELETE /:aliceId → 422 cannot-modify-owner ✓`);

    // 6. Seed dave, impersonate, create a mailbox owned by dave.
    const daveEmail = `s-admin-4-dave-${Date.now()}-${Math.floor(Math.random() * 1000)}@actionnow.ai`;
    const seedDave = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(daveEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (seedDave.status >= 300) {
      throw new Error(
        `seed-user(dave) failed: ${seedDave.status} ${seedDave.body.slice(0, 200)}`,
      );
    }
    const dave = JSON.parse(seedDave.body) as SeededUser;

    // Impersonate dave.
    const impDave = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(daveEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (impDave.status !== 200) {
      throw new Error(
        `impersonate(dave) ${impDave.status}: ${impDave.body.slice(0, 200)}`,
      );
    }

    // Dave creates a mailbox.
    const daveAddr = `s-admin-4-${Date.now()}-${Math.floor(Math.random() * 1000)}@actionnow.ai`;
    const createMb = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: ${JSON.stringify(daveAddr)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (createMb.status !== 201) {
      throw new Error(
        `dave's POST /api/mailboxes expected 201, got ${createMb.status}: ${createMb.body.slice(0, 200)}`,
      );
    }
    ctx.log(`dave created mailbox ${daveAddr} ✓`);

    // Switch back to alice.
    const impAlice = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(TEST_USERS.alice)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (impAlice.status !== 200) {
      throw new Error(
        `impersonate(alice) ${impAlice.status}: ${impAlice.body.slice(0, 200)}`,
      );
    }

    // 7. DELETE dave → 409 owns-mailboxes (count=1, message present).
    const delDave = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/${dave.id}', { method: 'DELETE' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (delDave.status !== 409) {
      throw new Error(
        `DELETE dave expected 409, got ${delDave.status}: ${delDave.body.slice(0, 200)}`,
      );
    }
    const delDaveBody = JSON.parse(delDave.body) as {
      ok: boolean;
      reason?: string;
      owns_mailboxes_count?: number;
      message?: string;
    };
    if (
      delDaveBody.ok !== false ||
      delDaveBody.reason !== "owns-mailboxes" ||
      delDaveBody.owns_mailboxes_count !== 1
    ) {
      throw new Error(
        `owns-mailboxes 409 shape wrong: ${JSON.stringify(delDaveBody)}`,
      );
    }
    if (
      typeof delDaveBody.message !== "string" ||
      !delDaveBody.message.toLowerCase().includes("transfer")
    ) {
      throw new Error(
        `expected message to mention 'transfer', got ${JSON.stringify(delDaveBody.message)}`,
      );
    }
    ctx.log(
      `DELETE /:daveId → 409 owns-mailboxes count=1 message="${delDaveBody.message}" ✓`,
    );
    await ctx.screenshot("after-owns-mailboxes-block");

    // Three intentional failures (404 + 422 + 409). Allow ≤3 console errors.
    const consoleSnap = await ctx.captureConsole("after-admin-delete");
    if (consoleSnap.errors > 3) {
      throw new Error(
        `expected ≤3 console errors (404 + 422 + 409 probes), got ${consoleSnap.errors} (see ${consoleSnap.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSnap.errors} (≤3 ✓)`);
  },
};

export default scenario;
