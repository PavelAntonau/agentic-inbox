// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CONTACTS-3 — Decline flow + D12 sender-blind invariant + re-request edge.
 *
 * Branches covered:
 *   POST /api/contacts/request                          (alice → bob, status='pending')
 *   POST /__mock/impersonate                            (swap to bob)
 *   GET  /api/contacts                                  (bob sees pending row, then 0 rows after decline)
 *   POST /api/contacts/:senderId/decline                (bob declines; sets declined_at on bob's mirror)
 *   GET  /api/contacts                                  (alice's row stays 'pending' — D12 sender-blind)
 *   POST /api/contacts/request (alice → bob, again)     (409 — sender's existing row still 'pending')
 *   POST /api/contacts/request (bob  → alice)           (409 — bob's mirror at status='pending' with declined_at
 *                                                        still blocks; documented edge from session 9 — current
 *                                                        behaviour, see F-PHASE3-009-FIXED.md follow-on)
 *
 * F-PHASE3-010 FIXED 2026-05-04 — decline writes declined_at on the
 * RECIPIENT's mirror row. Recipient's GET /api/contacts filters via
 * `declined_at IS NULL` so the row disappears from his list. Sender's
 * row is intentionally untouched: D12 sender-blind ensures the sender
 * cannot tell whether the recipient declined, accepted, or hasn't yet
 * acted.
 *
 * Re-request-after-decline edge: per the session-9 hand-off,
 * F-PHASE3-009 (mirror-at-request-time) introduces a follow-on edge
 * where the recipient cannot initiate his own outgoing request to the
 * original sender after declining — the existing mirror row at
 * status='pending' (with declined_at set) trips the 409 check at
 * workers/routes/contacts.ts:184. Current behaviour preserves the
 * safer "block conflicting requests" stance; this scenario locks that
 * behaviour in so a future relaxation (gating the 409 on
 * `declined_at IS NULL`) is a deliberate change with a corresponding
 * test update.
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
  id: "S-CONTACTS-3",
  description:
    "Decline flow: declined_at filter + D12 sender-blind invariant + re-request 409 edges",
  covers:
    "POST /api/contacts/request → impersonate → POST /:senderId/decline → bob's GET filters out → alice's row stays 'pending' → both alice and bob hit 409 on re-request",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. Seed bob.
    const bobEmail = TEST_USERS.bob;
    const seedBob = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(bobEmail)}, display_name: 'Bob Builder' }),
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
    ctx.log(`bob seeded: id=${bob.id}`);

    // 2. Resolve alice's id.
    const meRes = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/me');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (meRes.status !== 200) {
      throw new Error(
        `/api/admin/me ${meRes.status}: ${meRes.body.slice(0, 200)}`,
      );
    }
    const alice = JSON.parse(meRes.body) as { user_id: string; role: string };
    ctx.log(`alice resolved: id=${alice.user_id}`);

    // 3. alice → bob /request → 201, dual rows created (sender + recipient mirror).
    const request = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_user_id: ${JSON.stringify(bob.id)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (request.status !== 201) {
      throw new Error(
        `request alice→bob expected 201, got ${request.status}: ${request.body.slice(0, 200)}`,
      );
    }
    ctx.log(`alice → bob /request → 201 ✓`);

    // 4. Impersonate bob.
    const impBob = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(bobEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (impBob.status !== 200) {
      throw new Error(
        `impersonate(bob) ${impBob.status}: ${impBob.body.slice(0, 200)}`,
      );
    }
    ctx.log(`impersonate → bob ✓`);

    // 5. Bob's incoming GET /api/contacts → 1 pending row (mirror created at /request time per F-PHASE3-009).
    const bobBefore = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const bobBeforeBody = JSON.parse(bobBefore.body) as {
      contacts: ContactRow[];
    };
    if (bobBeforeBody.contacts.length !== 1) {
      throw new Error(
        `bob's pre-decline /api/contacts expected 1 row, got ${bobBeforeBody.contacts.length}`,
      );
    }
    if (bobBeforeBody.contacts[0].status !== "pending") {
      throw new Error(
        `bob's incoming row pre-decline expected status='pending', got '${bobBeforeBody.contacts[0].status}'`,
      );
    }
    ctx.log(`bob's incoming GET /api/contacts → 1 pending row ✓`);

    // 6. POST /api/contacts/:aliceId/decline → 200.
    const decline = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/${alice.user_id}/decline', {
          method: 'POST',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (decline.status !== 200) {
      throw new Error(
        `bob decline alice expected 200, got ${decline.status}: ${decline.body.slice(0, 200)}`,
      );
    }
    ctx.log(`bob declines alice (POST /:aliceId/decline) → 200 ✓`);

    // 7. Bob's GET /api/contacts after decline → 0 rows (declined_at filter at workers/routes/contacts.ts:89).
    const bobAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const bobAfterBody = JSON.parse(bobAfter.body) as {
      contacts: ContactRow[];
    };
    if (bobAfterBody.contacts.length !== 0) {
      throw new Error(
        `bob's post-decline /api/contacts expected 0 rows (declined_at filter), got ${bobAfterBody.contacts.length}: ${JSON.stringify(bobAfterBody.contacts)}`,
      );
    }
    ctx.log(
      `bob's GET /api/contacts post-decline → 0 rows (declined_at filter ✓)`,
    );

    // 8. Bob attempts to /request alice himself → 409 (his mirror row at status='pending' with declined_at
    //    still trips the 409 check). Documents the re-request-after-decline edge.
    const bobReRequest = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_user_id: ${JSON.stringify(alice.user_id)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bobReRequest.status !== 409) {
      throw new Error(
        `bob → alice re-request expected 409 (re-request-after-decline edge), got ${bobReRequest.status}: ${bobReRequest.body.slice(0, 200)}`,
      );
    }
    ctx.log(
      `bob → alice /request post-decline → 409 ✓ (re-request-after-decline edge)`,
    );

    // 9. Switch back to alice.
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
    ctx.log(`impersonate → alice ✓`);

    // 10. Alice's GET /api/contacts → her row STILL at status='pending' (D12 sender-blind: decline doesn't
    //     touch sender). Locks the F-PHASE3-010 invariant.
    const aliceAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const aliceAfterBody = JSON.parse(aliceAfter.body) as {
      contacts: ContactRow[];
    };
    const aliceRow = aliceAfterBody.contacts.find(
      (r) => r.owner_user_id === alice.user_id && r.contact_user_id === bob.id,
    );
    if (!aliceRow) {
      throw new Error(
        `alice's row to bob missing post-decline — got ${aliceAfterBody.contacts.length} rows`,
      );
    }
    if (aliceRow.status !== "pending") {
      throw new Error(
        `D12 sender-blind violated post-decline: alice's row to bob expected 'pending', got '${aliceRow.status}'`,
      );
    }
    if (aliceRow.accepted_at !== null) {
      throw new Error(
        `D12 sender-blind violated: alice's row accepted_at expected null, got ${aliceRow.accepted_at}`,
      );
    }
    ctx.log(
      `alice's row → status='pending' accepted_at=null ✓ (D12 sender-blind under decline)`,
    );
    await ctx.screenshot("after-decline-alice-view");

    // 11. Alice tries to re-request bob → 409 (her own row is still 'pending').
    const aliceReRequest = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_user_id: ${JSON.stringify(bob.id)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (aliceReRequest.status !== 409) {
      throw new Error(
        `alice → bob re-request post-decline expected 409 (sender row still pending), got ${aliceReRequest.status}: ${aliceReRequest.body.slice(0, 200)}`,
      );
    }
    ctx.log(
      `alice → bob /request again post-decline → 409 ✓ (sender row still 'pending')`,
    );

    // Two 409 probes seed up to 2 expected console errors. Allow ≤2.
    const consoleSummary = await ctx.captureConsole("after-decline-flow");
    if (consoleSummary.errors > 2) {
      throw new Error(
        `expected ≤2 console errors (the two 409 probes), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤2 ✓)`);
  },
};

export default scenario;
