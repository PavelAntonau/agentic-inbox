// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-ADMIN-2 — Admin users list + invite.
 *
 * Branches covered:
 *   GET  /api/admin/users                          (200 — list with owns_mailboxes_count)
 *   POST /api/admin/users/invite                   (400 — missing email)
 *   POST /api/admin/users/invite                   (400 — invalid email syntax)
 *   POST /api/admin/users/invite                   (200 — new email; users row inserted)
 *   POST /api/admin/users/invite                   (200 — same email idempotent; no leak)
 *   GET  /api/admin/users                          (new email present in list)
 *
 * Locks workers/routes/admin/users.ts:69-238 — list aggregation
 * (LEFT JOIN mailboxes → owns_mailboxes_count) and the privacy-preserving
 * invite handler (always returns ok:true regardless of pre-existing user
 * status, per E15/E16). Cloudflare Access upsert is mocked
 * (MOCK_MODE → upsertEmail returns mocked:true without network call).
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface AdminUserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
  last_login_at: number | null;
  owns_mailboxes_count: number;
}

const scenario: Scenario = {
  id: "S-ADMIN-2",
  description:
    "Admin users list + invite: 400 validation × 2 → 200 happy → 200 idempotent → list reflects new row",
  covers:
    "GET /api/admin/users → POST /invite missing-email 400 → POST /invite bad-syntax 400 → POST /invite ok 200 → POST /invite same-email 200 → GET shows new row",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. GET /api/admin/users — alice present, owns_mailboxes_count is a number.
    const list = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (list.status !== 200) {
      throw new Error(
        `GET /api/admin/users expected 200, got ${list.status}: ${list.body.slice(0, 200)}`,
      );
    }
    const listBody = JSON.parse(list.body) as { users: AdminUserRow[] };
    if (!Array.isArray(listBody.users) || listBody.users.length === 0) {
      throw new Error(
        `expected ≥1 user in list, got ${JSON.stringify(listBody)}`,
      );
    }
    const aliceRow = listBody.users.find(
      (u) => u.email.toLowerCase() === TEST_USERS.alice,
    );
    if (!aliceRow) {
      throw new Error(
        `alice missing from /api/admin/users (got ${listBody.users.length} rows)`,
      );
    }
    if (typeof aliceRow.owns_mailboxes_count !== "number") {
      throw new Error(
        `owns_mailboxes_count is not a number: ${typeof aliceRow.owns_mailboxes_count}`,
      );
    }
    ctx.log(
      `GET /api/admin/users → ${listBody.users.length} rows, alice present (mailboxes=${aliceRow.owns_mailboxes_count}) ✓`,
    );

    // 2. POST /invite without email → 400.
    const noEmail = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noEmail.status !== 400) {
      throw new Error(
        `POST /invite no-email expected 400, got ${noEmail.status}: ${noEmail.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /invite {} → 400 ✓`);

    // 3. POST /invite with bad syntax → 400.
    const badSyntax = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'not-an-email' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (badSyntax.status !== 400) {
      throw new Error(
        `POST /invite bad-syntax expected 400, got ${badSyntax.status}: ${badSyntax.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /invite { 'not-an-email' } → 400 ✓`);

    // 4. POST /invite with new email → 200, ok:true.
    const newEmail = `s-admin-2-${Date.now()}-${Math.floor(Math.random() * 1000)}@actionnow.ai`;
    const happy = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(newEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (happy.status !== 200) {
      throw new Error(
        `POST /invite happy expected 200, got ${happy.status}: ${happy.body.slice(0, 200)}`,
      );
    }
    const happyBody = JSON.parse(happy.body) as { ok: boolean };
    if (happyBody.ok !== true) {
      throw new Error(`expected ok:true, got ${JSON.stringify(happyBody)}`);
    }
    ctx.log(`POST /invite ${newEmail} → 200 ok:true ✓`);

    // 5. POST /invite with same email — idempotent, still 200 ok:true (privacy).
    const dup = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/users/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(newEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (dup.status !== 200) {
      throw new Error(
        `POST /invite duplicate expected 200 (privacy), got ${dup.status}: ${dup.body.slice(0, 200)}`,
      );
    }
    const dupBody = JSON.parse(dup.body) as { ok: boolean };
    if (dupBody.ok !== true) {
      throw new Error(
        `duplicate-invite expected ok:true (no leak), got ${JSON.stringify(dupBody)}`,
      );
    }
    ctx.log(`POST /invite (idempotent) → 200 ok:true (no leak) ✓`);

    // 6. GET /api/admin/users now contains the invited email.
    const after = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/admin/users').then(r => r.json())`,
    })) as { users: AdminUserRow[] };
    const invited = after.users.find(
      (u) => u.email.toLowerCase() === newEmail.toLowerCase(),
    );
    if (!invited) {
      throw new Error(
        `invited email ${newEmail} missing from /api/admin/users (got ${after.users.length} rows)`,
      );
    }
    if (invited.role !== "user") {
      throw new Error(
        `invited row role expected 'user', got '${invited.role}'`,
      );
    }
    ctx.log(`GET /api/admin/users contains ${newEmail} role='user' ✓`);
    await ctx.screenshot("after-invite");

    // Two intentional 400 probes (no-email + bad-syntax). Allow ≤2 console errors.
    const consoleSnap = await ctx.captureConsole("after-admin-invite");
    if (consoleSnap.errors > 2) {
      throw new Error(
        `expected ≤2 console errors (no-email + bad-syntax probes), got ${consoleSnap.errors} (see ${consoleSnap.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSnap.errors} (≤2 ✓)`);
  },
};

export default scenario;
