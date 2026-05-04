// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CONTACTS-1 — Send + dedup + block on the contacts CRUD.
 *
 * Branches covered:
 *   POST /__mock/seed-user                              (seed bob — second internal user)
 *   POST /api/contacts/request                          (400 missing target, 404 unknown target,
 *                                                        201 success, 409 already pending)
 *   GET  /api/contacts                                  (pending row enumerated, email + display
 *                                                        joined from users)
 *   POST /api/contacts/:userId/block                    (flips relationship to 'blocked')
 *   GET  /api/contacts                                  (blocked row visible with status='blocked')
 *
 * The request → accept handshake requires the recipient (bob) to act on
 * the row, which our MOCK_MODE auth path can't currently simulate (only
 * BOOTSTRAP_OWNER_EMAIL=alice gets through authzContext). This scenario
 * therefore exercises the alice-only branches of the contacts API; the
 * full handshake is a future S-CONTACTS-* scenario unlocked by either a
 * second-user impersonation surface or a /__mock/seed-contact endpoint.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface SeededUser {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: number;
}

interface ContactRow {
  owner_user_id: string;
  contact_user_id: string;
  status: "pending" | "accepted" | "blocked";
  initiated_by: string;
  created_at: number;
  accepted_at: number | null;
  email: string | null;
  display_name: string | null;
}

const scenario: Scenario = {
  id: "S-CONTACTS-1",
  description:
    "Contacts CRUD (alice-only branches): request, dedup, block, listing",
  covers:
    "POST /api/contacts/request 400/404/201/409 → GET /api/contacts pending row → POST :userId/block → GET shows status='blocked'",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. Seed bob (idempotent on lower(email)).
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
    ctx.log(`bob seeded: id=${bob.id} email=${bob.email}`);

    // 2. POST /api/contacts/request without target_user_id → 400.
    const noTarget = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noTarget.status !== 400) {
      throw new Error(
        `request without target expected 400, got ${noTarget.status}: ${noTarget.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /api/contacts/request {} → 400 ✓`);

    // 3. POST /api/contacts/request with non-existent target → 404.
    const badTarget = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_user_id: 'user-does-not-exist' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (badTarget.status !== 404) {
      throw new Error(
        `request with bad target expected 404, got ${badTarget.status}: ${badTarget.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /api/contacts/request {bad-id} → 404 ✓`);

    // 4. POST /api/contacts/request with bob's id → 201.
    const okRequest = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_user_id: ${JSON.stringify(bob.id)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (okRequest.status !== 201) {
      throw new Error(
        `request to bob expected 201, got ${okRequest.status}: ${okRequest.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /api/contacts/request {bob} → 201 ✓`);

    // 5. Re-POST same request → 409 (already pending).
    const dupRequest = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_user_id: ${JSON.stringify(bob.id)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (dupRequest.status !== 409) {
      throw new Error(
        `duplicate request expected 409, got ${dupRequest.status}: ${dupRequest.body.slice(0, 200)}`,
      );
    }
    const dupBody = JSON.parse(dupRequest.body) as { error?: string };
    if (
      typeof dupBody.error !== "string" ||
      !dupBody.error.toLowerCase().includes("pending")
    ) {
      throw new Error(
        `409 error should mention 'pending', got ${JSON.stringify(dupBody)}`,
      );
    }
    ctx.log(`duplicate request → 409 "${dupBody.error}" ✓`);

    // 6. GET /api/contacts → pending row (alice → bob) with joined email.
    const pendingList = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (pendingList.status !== 200) {
      throw new Error(
        `GET /api/contacts ${pendingList.status}: ${pendingList.body.slice(0, 200)}`,
      );
    }
    const pendingBody = JSON.parse(pendingList.body) as {
      contacts: ContactRow[];
    };
    const pendingRow = pendingBody.contacts.find(
      (r) => r.contact_user_id === bob.id,
    );
    if (!pendingRow) {
      throw new Error(
        `pending contact for bob missing from GET /api/contacts (got ${pendingBody.contacts.length} rows)`,
      );
    }
    if (pendingRow.status !== "pending") {
      throw new Error(
        `expected pending row to have status='pending', got '${pendingRow.status}'`,
      );
    }
    if (pendingRow.email !== bob.email) {
      throw new Error(
        `joined email expected ${bob.email}, got ${pendingRow.email ?? "null"}`,
      );
    }
    if (pendingRow.display_name !== "Bob Builder") {
      throw new Error(
        `joined display_name expected 'Bob Builder', got ${pendingRow.display_name ?? "null"}`,
      );
    }
    ctx.log(
      `pending row enumerated: contact=${pendingRow.contact_user_id} email=${pendingRow.email} display=${pendingRow.display_name} ✓`,
    );
    await ctx.screenshot("after-pending-list");

    // 7. POST /api/contacts/:bobId/block → 200.
    const block = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/${bob.id}/block', {
          method: 'POST',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (block.status !== 200) {
      throw new Error(
        `block returned ${block.status}: ${block.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /api/contacts/${bob.id}/block → 200 ✓`);

    // 8. GET /api/contacts after block → status='blocked'.
    const blockedList = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const blockedBody = JSON.parse(blockedList.body) as {
      contacts: ContactRow[];
    };
    const blockedRow = blockedBody.contacts.find(
      (r) => r.contact_user_id === bob.id,
    );
    if (!blockedRow) {
      throw new Error(
        `blocked row for bob missing from GET /api/contacts after block`,
      );
    }
    if (blockedRow.status !== "blocked") {
      throw new Error(
        `expected status='blocked' after block, got '${blockedRow.status}'`,
      );
    }
    ctx.log(`blocked row visible with status='${blockedRow.status}' ✓`);

    // The deliberate 400 (no target), 404 (bad target), and 409 (duplicate)
    // probes each stamp a "Failed to load resource: <code>" entry in Chrome.
    // Tolerate up to 3 expected console errors; anything beyond is a real
    // regression. Floor 0 because some browser configurations don't log
    // fetch 4xx at all.
    const consoleSummary = await ctx.captureConsole("after-contacts-flow");
    if (consoleSummary.errors > 3) {
      throw new Error(
        `expected ≤3 console errors (the 400/404/409 probes), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤3 ✓)`);
  },
};

export default scenario;
