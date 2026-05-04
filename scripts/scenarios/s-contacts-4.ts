// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CONTACTS-4 — Block flow with cascading mirror cleanup.
 *
 * Branches covered:
 *   POST /api/contacts/request                          (alice → bob, dual-row created)
 *   POST /__mock/impersonate                            (swap to bob)
 *   POST /api/contacts/:aliceId/accept                  (bob upgrades his mirror to 'accepted';
 *                                                        alice's row stays 'pending' per D12)
 *   POST /__mock/impersonate                            (back to alice)
 *   POST /api/contacts/:bobId/block                     (alice flips her row to 'blocked' AND
 *                                                        deletes bob's mirror — cascading
 *                                                        mirror cleanup, contacts.ts:420-433)
 *   GET  /api/contacts (as alice)                       (alice's row visible at status='blocked')
 *   GET  /api/contacts (as bob)                         (bob's mirror row is GONE — cascading
 *                                                        cleanup removed both 'accepted' and
 *                                                        'pending' mirrors)
 *   POST /api/contacts/request (bob → alice)            (403 — block detection both directions
 *                                                        at workers/routes/contacts.ts:130-158)
 *
 * Locks the cascading cleanup invariant: when alice blocks bob, the contact relationship
 * disappears from BOTH user views — alice sees a 'blocked' row, bob sees nothing. Bob's
 * subsequent /request to alice is rejected at the canSendContactRequest() guard with the
 * blockedByTarget signal.
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
  id: "S-CONTACTS-4",
  description:
    "Block flow with cascading mirror cleanup: accepted handshake → block flips alice + deletes bob mirror",
  covers:
    "POST /api/contacts/request → bob accepts → alice POST /:bobId/block → alice's row='blocked' AND bob's mirror gone AND bob's re-request → 403",
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

    // 3. alice → bob /request → 201.
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

    // 4. Impersonate bob and accept.
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
    ctx.log(`bob accepts alice → 200 ✓ (bob's mirror at status='accepted')`);

    // 5. Verify bob's mirror is at 'accepted' before the block.
    const bobBefore = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/contacts');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const bobBeforeBody = JSON.parse(bobBefore.body) as {
      contacts: ContactRow[];
    };
    const bobMirror = bobBeforeBody.contacts.find(
      (r) => r.owner_user_id === bob.id && r.contact_user_id === alice.user_id,
    );
    if (!bobMirror) {
      throw new Error(
        `bob's mirror row to alice missing pre-block — got ${bobBeforeBody.contacts.length} rows`,
      );
    }
    if (bobMirror.status !== "accepted") {
      throw new Error(
        `bob's mirror row pre-block expected 'accepted', got '${bobMirror.status}'`,
      );
    }
    ctx.log(`bob's mirror pre-block → status='accepted' ✓`);

    // 6. Switch back to alice and POST /:bobId/block.
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
        `alice block bob expected 200, got ${block.status}: ${block.body.slice(0, 200)}`,
      );
    }
    ctx.log(`alice POST /api/contacts/${bob.id}/block → 200 ✓`);

    // 7. Alice's GET /api/contacts → her row to bob is now status='blocked'.
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
        `alice's row to bob missing after block — got ${aliceAfterBody.contacts.length} rows`,
      );
    }
    if (aliceRow.status !== "blocked") {
      throw new Error(
        `alice's row to bob expected 'blocked', got '${aliceRow.status}'`,
      );
    }
    ctx.log(`alice's row → status='blocked' ✓`);
    await ctx.screenshot("after-block-alice-view");

    // 8. Bob's GET /api/contacts → mirror row GONE (cascading cleanup at contacts.ts:420-433
    //    deletes the non-blocked mirror).
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
    const bobMirrorAfter = bobAfterBody.contacts.find(
      (r) => r.owner_user_id === bob.id && r.contact_user_id === alice.user_id,
    );
    if (bobMirrorAfter) {
      throw new Error(
        `bob's mirror row to alice expected GONE after block, still present: ${JSON.stringify(bobMirrorAfter)}`,
      );
    }
    ctx.log(
      `bob's mirror row → GONE ✓ (cascading cleanup ${bobAfterBody.contacts.length} total rows)`,
    );

    // 9. Bob /request alice → 403 (block detection in canSendContactRequest, contacts.ts:130-158).
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
    if (bobReRequest.status !== 403) {
      throw new Error(
        `bob → alice /request post-block expected 403, got ${bobReRequest.status}: ${bobReRequest.body.slice(0, 200)}`,
      );
    }
    ctx.log(
      `bob → alice /request post-block → 403 ✓ (canSendContactRequest blocked)`,
    );

    // One 403 probe seeds 1 expected console error. Allow ≤1.
    const consoleSummary = await ctx.captureConsole("after-block-flow");
    if (consoleSummary.errors > 1) {
      throw new Error(
        `expected ≤1 console error (the 403 re-request probe), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤1 ✓)`);
  },
};

export default scenario;
