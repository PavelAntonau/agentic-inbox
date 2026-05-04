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
 * D12 — sender-blind accept (FIXED 2026-05-04 — F-PHASE3-009 +
 * F-PHASE3-010 landed). Per the privacy directive the SENDER's outgoing
 * row keeps showing "pending" forever; only the RECIPIENT's mirror row
 * flips to 'accepted'. The assertions below verify both the new mirror
 * row at request time (009) and the sender-blind status (010).
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
    // F-PHASE3-009 (FIXED) — POST /api/contacts/request now inserts the
    // recipient's mirror row at request time (status='pending',
    // initiated_by=sender). The recipient's GET /api/contacts therefore
    // returns the pending row and the /contacts UI's "Incoming" tab can
    // render it.
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
    if (bobIncomingBody.contacts.length !== 1) {
      throw new Error(
        `bob's GET /api/contacts expected 1 row (the alice→bob mirror), got ${bobIncomingBody.contacts.length}`,
      );
    }
    const bobIncomingRow = bobIncomingBody.contacts[0];
    if (bobIncomingRow.owner_user_id !== bob.id) {
      throw new Error(
        `bob's incoming row owner_user_id expected ${bob.id}, got ${bobIncomingRow.owner_user_id}`,
      );
    }
    if (bobIncomingRow.contact_user_id !== alice.user_id) {
      throw new Error(
        `bob's incoming row contact_user_id expected ${alice.user_id}, got ${bobIncomingRow.contact_user_id}`,
      );
    }
    if (bobIncomingRow.status !== "pending") {
      throw new Error(
        `bob's incoming row status expected 'pending', got '${bobIncomingRow.status}'`,
      );
    }
    if (bobIncomingRow.initiated_by !== alice.user_id) {
      throw new Error(
        `bob's incoming row initiated_by expected ${alice.user_id}, got ${bobIncomingRow.initiated_by}`,
      );
    }
    ctx.log(
      `bob's GET /api/contacts → 1 pending row, initiated_by=alice ✓ (F-PHASE3-009 fixed)`,
    );

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

    // 8a. Alice's view (sender) — D12 strict says her row stays 'pending'
    //     forever, regardless of recipient action. F-PHASE3-010 fix: accept
    //     handler no longer touches the sender's row.
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
        `alice's row to bob missing after accept — got ${aliceAfterBody.contacts.length} rows`,
      );
    }
    if (aliceRow.status !== "pending") {
      throw new Error(
        `D12 sender-blind violated: alice's row to bob expected 'pending', got '${aliceRow.status}' — accept handler regressed F-PHASE3-010; check workers/routes/contacts.ts accept handler`,
      );
    }
    if (aliceRow.accepted_at !== null) {
      throw new Error(
        `D12 sender-blind violated: alice's row accepted_at expected null, got ${aliceRow.accepted_at}`,
      );
    }
    ctx.log(
      `alice's row → status='pending' accepted_at=null ✓ (D12 sender-blind, F-PHASE3-010 fixed)`,
    );
    await ctx.screenshot("after-accept-alice-view");

    // 8b. Switch to bob and verify HIS mirror row reflects the accept —
    //     the only side that flips to 'accepted' under D12.
    const impBob2 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(bobEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (impBob2.status !== 200) {
      throw new Error(
        `impersonate(bob) #2 ${impBob2.status}: ${impBob2.body.slice(0, 200)}`,
      );
    }

    const bobAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const bobAfterBody = JSON.parse(bobAfter.body) as {
      contacts: ContactRow[];
    };
    const bobRow = bobAfterBody.contacts.find(
      (r) => r.owner_user_id === bob.id && r.contact_user_id === alice.user_id,
    );
    if (!bobRow) {
      throw new Error(
        `bob's mirror row to alice missing after accept — got ${bobAfterBody.contacts.length} rows`,
      );
    }
    if (bobRow.status !== "accepted") {
      throw new Error(
        `bob's mirror row expected 'accepted', got '${bobRow.status}' — accept handler regressed`,
      );
    }
    if (typeof bobRow.accepted_at !== "number") {
      throw new Error(
        `bob's mirror row accepted_at expected number, got ${typeof bobRow.accepted_at}`,
      );
    }
    ctx.log(
      `bob's mirror row → status='accepted' accepted_at=${bobRow.accepted_at} ✓`,
    );

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
