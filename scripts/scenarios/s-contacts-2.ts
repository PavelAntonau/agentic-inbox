// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CONTACTS-2 — Two-user accept handshake.
 *
 * Branches covered:
 *   POST /__mock/seed-user                              (seed bob)
 *   POST /api/contacts/request                          (alice → bob, status='pending')
 *   POST /__mock/impersonate                            (swap x-mock-user-email cookie to bob)
 *   GET  /api/contacts                                  (bob's incoming view: pending row from alice)
 *   POST /api/contacts/:aliceId/accept                  (bob accepts; mirror row inserted)
 *   POST /__mock/impersonate                            (back to alice)
 *   GET  /api/contacts                                  (alice's view: row now status='accepted')
 *
 * D12 — sender-blind accept: per the privacy directive the SENDER's
 * outgoing row is supposed to keep showing "pending" forever. The
 * current accept handler flips both sides (the mirror row plus the
 * original) to 'accepted' (workers/routes/contacts.ts:248-275). This
 * scenario records ground truth: it documents what the API actually
 * does today and would catch any future regression. If product chooses
 * to honour D12 strictly, the assertion below is the place to invert.
 *
 * Per-run-unique recipient suffix avoids cross-run accept collisions —
 * the contacts table is keyed on (owner_user_id, contact_user_id) and
 * /__mock/reset clears it, but if /reset ever fails to drop a row this
 * scenario shouldn't false-fail the rest of the suite.
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
  id: "S-CONTACTS-2",
  description:
    "Two-user accept handshake (alice requests, bob accepts via impersonate)",
  covers:
    "POST /api/contacts/request → /__mock/impersonate → POST /api/contacts/:senderId/accept → mirror row + status flip",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. Seed bob — second internal user. The seed-user endpoint is
    //    idempotent on lower(email), so re-runs land the same row.
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
    ctx.log(`bob seeded: id=${bob.id} email=${bob.email}`);

    // 2. Resolve alice's id (current authzContext) — needed later when bob
    //    accepts the row whose sender == alice.
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
    ctx.log(`alice resolved: id=${alice.user_id} role=${alice.role}`);

    // 3. alice → bob contact request.
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
    ctx.log(`alice → bob request 201 ✓`);

    // 4. Impersonate bob — swap the x-mock-user-email cookie via /__mock.
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

    // 5. As bob: GET /api/contacts.
    //
    // FINDING F-PHASE3-009 — recipient cannot see incoming pending
    // requests via /api/contacts. The endpoint filters strictly on
    // `owner_user_id == ctx.user_id` (workers/routes/contacts.ts:86-91)
    // and POST /api/contacts/request only inserts ONE row
    // (owner=sender, contact=recipient, line 191-205). The UI's
    // "Incoming" tab on /contacts therefore renders empty for the
    // recipient until product writes the recipient-side mirror row at
    // request time. The accept endpoint itself works regardless because
    // it queries the SENDER's row directly (line 230-241), so the
    // handshake CAN complete via the API even though no UI surface
    // surfaces the pending request to the recipient.
    //
    // This scenario records the current state: bob's list is empty.
    // When product fixes F-PHASE3-009 (insert mirror pending row), the
    // assertion below will fail and surface the change.
    const bobIncoming = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bobIncoming.status !== 200) {
      throw new Error(
        `bob GET /api/contacts ${bobIncoming.status}: ${bobIncoming.body.slice(0, 200)}`,
      );
    }
    const bobIncomingBody = JSON.parse(bobIncoming.body) as {
      contacts: ContactRow[];
    };
    if (bobIncomingBody.contacts.length !== 0) {
      throw new Error(
        `F-PHASE3-009 may have shifted: bob's GET /api/contacts expected 0 rows pre-accept, got ${bobIncomingBody.contacts.length} — if product just landed the mirror-row fix, update this assertion.`,
      );
    }
    ctx.log(`bob's GET /api/contacts empty (F-PHASE3-009 documented state) ✓`);

    // 6. As bob: POST /api/contacts/:aliceId/accept.
    //    Per the route comment, the :id parameter is the requester's user_id
    //    (alice), not bob's; ctx.user_id (bob) is implied by the cookie.
    const accept = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts/${alice.user_id}/accept', {
          method: 'POST',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (accept.status !== 200) {
      throw new Error(
        `bob accept alice expected 200, got ${accept.status}: ${accept.body.slice(0, 200)}`,
      );
    }
    ctx.log(`bob accepts alice (POST /api/contacts/:aliceId/accept) → 200 ✓`);

    // 7. Switch back to alice.
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

    // 8. Alice's view should now show bob row as 'accepted' with
    //    accepted_at timestamp set.
    //
    // FINDING F-PHASE3-010 — D12 strict sender-blind not enforced.
    // The plan's D12 directive (.scratch/requirements.md, line 61-72)
    // specifies the sender's outgoing row stays "pending" forever from
    // their view, regardless of recipient action. Today the accept
    // handler flips BOTH sides (workers/routes/contacts.ts:248-275 —
    // UPDATE original to 'accepted', plus mirror INSERT). Sender therefore
    // sees the flip immediately. This scenario records the current
    // observed behaviour — when D12 lands strictly, alice's row will
    // stay 'pending' here and the assertion below inverts.
    const aliceAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const aliceAfterBody = JSON.parse(aliceAfter.body) as {
      contacts: ContactRow[];
    };
    const accepted = aliceAfterBody.contacts.find(
      (r) => r.owner_user_id === alice.user_id && r.contact_user_id === bob.id,
    );
    if (!accepted) {
      throw new Error(
        `alice's row to bob missing after accept — got ${aliceAfterBody.contacts.length} rows`,
      );
    }
    if (accepted.status !== "accepted") {
      throw new Error(
        `alice's row to bob expected 'accepted', got '${accepted.status}' — accept handler may have changed; check workers/routes/contacts.ts:248-275`,
      );
    }
    if (typeof accepted.accepted_at !== "number") {
      throw new Error(
        `accepted_at expected number, got ${typeof accepted.accepted_at}`,
      );
    }
    ctx.log(
      `alice's row → status='accepted' accepted_at=${accepted.accepted_at} ✓`,
    );
    await ctx.screenshot("after-accept");

    // No probe-shaped console errors expected — every fetch above is a 2xx.
    const consoleSummary = await ctx.captureConsole("after-handshake");
    if (consoleSummary.errors > 0) {
      throw new Error(
        `expected 0 console errors, got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (0 ✓)`);
  },
};

export default scenario;
