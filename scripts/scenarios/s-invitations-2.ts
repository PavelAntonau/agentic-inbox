// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INVITATIONS-2 — Group invitation cancel lifecycle.
 *
 * Branches covered (workers/routes/invitations.ts:378-426 — F-I3 coverage):
 *   POST /api/invitations/:id/cancel  (200 — inviter cancels pending invite)
 *   POST /api/invitations/:id/cancel  (409 — already cancelled)
 *   POST /api/invitations/:id/cancel  (404 — invitation not found)
 *   POST /api/invitations/:id/cancel  (403 — non-inviter, non-global)
 *   POST /api/invitations/:id/cancel  (200 — inviter accepted, then global
 *                                            tries to cancel → 409 not-pending)
 *
 * Setup: alice (BOOTSTRAP_OWNER_EMAIL → global_owner) creates two groups, two
 * invitations to bob and a third user 'eve' (sole member). Bob accepts the
 * second one to exercise the not-pending → 409 branch when alice tries to
 * cancel an already-accepted invitation. Bob also tries to cancel an
 * invitation he isn't the inviter of (he's the invitee) — 403.
 *
 * Pairs with S-INVITATIONS-1 (accept) — together they cover both terminal
 * paths for an invitation lifecycle.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface SeededUser {
  id: string;
  email: string;
  role: string;
}

interface InvitationRow {
  id: string;
  group_id: string;
  invitee_email: string;
  status: string;
}

const scenario: Scenario = {
  id: "S-INVITATIONS-2",
  description:
    "Group invitation cancel lifecycle: inviter 200 → re-cancel 409 → no-such-id 404 → non-inviter 403 → accepted-then-cancel 409",
  covers:
    "alice creates group + invites bob → cancel 200 → cancel 409 already-cancelled → cancel no-such-id 404 → invite eve → bob (non-inviter) cancel 403 → bob accepts → alice cancel 409 not-pending",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // Seed bob.
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
    ctx.log(`bob seeded: id=${bob.id}`);

    // Seed eve.
    const eveEmail = `s-inv-2-eve-${Date.now()}-${Math.floor(Math.random() * 1000)}@actionnow.ai`;
    const seedEve = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(eveEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (seedEve.status >= 300) {
      throw new Error(
        `seed-user(eve) failed: ${seedEve.status} ${seedEve.body.slice(0, 200)}`,
      );
    }

    // Helper — alice creates a group, returns the row.
    const makeGroup = async (
      label: string,
    ): Promise<{ id: string; name: string }> => {
      const name = `s-inv-2-${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const res = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const r = await fetch('/api/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: ${JSON.stringify(name)} }),
          });
          return { status: r.status, body: await r.text() };
        })()`,
      })) as { status: number; body: string };
      if (res.status !== 201) {
        throw new Error(
          `POST /api/groups (${label}) ${res.status}: ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as { id: string; name: string };
    };

    // Helper — POST /api/invitations and recover the new id via the
    // /__mock/invitations-by-group lookup. The wire response from POST
    // /api/invitations is `{ sent: true }` only (privacy contract — does
    // not leak whether the email matched an existing user), so we cannot
    // pluck the id from the response. The mock helper exposes the rows
    // directly; the scenario diffs before/after to isolate the new row.
    const inviteTo = async (
      groupId: string,
      email: string,
    ): Promise<string> => {
      const beforeRes = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const r = await fetch('/__mock/invitations-by-group?group_id=${groupId}');
          return { status: r.status, body: await r.text() };
        })()`,
      })) as { status: number; body: string };
      if (beforeRes.status !== 200) {
        throw new Error(
          `GET /__mock/invitations-by-group ${beforeRes.status}: ${beforeRes.body.slice(0, 200)}`,
        );
      }
      const beforeBody = JSON.parse(beforeRes.body) as {
        invitations: InvitationRow[];
      };
      const beforeIds = new Set(beforeBody.invitations.map((i) => i.id));

      const res = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const r = await fetch('/api/invitations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_id: ${JSON.stringify(groupId)}, email: ${JSON.stringify(email)} }),
          });
          return { status: r.status, body: await r.text() };
        })()`,
      })) as { status: number; body: string };
      if (res.status !== 200) {
        throw new Error(
          `POST /api/invitations ${res.status}: ${res.body.slice(0, 200)}`,
        );
      }

      const afterRes = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const r = await fetch('/__mock/invitations-by-group?group_id=${groupId}');
          return { status: r.status, body: await r.text() };
        })()`,
      })) as { status: number; body: string };
      if (afterRes.status !== 200) {
        throw new Error(
          `GET /__mock/invitations-by-group (after) ${afterRes.status}`,
        );
      }
      const afterBody = JSON.parse(afterRes.body) as {
        invitations: InvitationRow[];
      };
      const fresh = afterBody.invitations.find(
        (i) =>
          i.invitee_email.toLowerCase() === email.toLowerCase() &&
          !beforeIds.has(i.id),
      );
      if (!fresh) {
        throw new Error(
          `couldn't locate fresh invitation for ${email} in group ${groupId}`,
        );
      }
      return fresh.id;
    };

    // === Group A: cancel by inviter, idempotent re-cancel, non-existent id. ===
    const groupA = await makeGroup("A");
    const invA = await inviteTo(groupA.id, TEST_USERS.bob);
    ctx.log(`alice invited bob to ${groupA.name}, inv=${invA}`);

    // 1. POST /:id/cancel as inviter → 200.
    const cancel1 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/invitations/${invA}/cancel', { method: 'POST' });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (cancel1.status !== 200) {
      throw new Error(
        `cancel by inviter expected 200, got ${cancel1.status}: ${cancel1.body.slice(0, 200)}`,
      );
    }
    const cancel1Body = JSON.parse(cancel1.body) as { ok: boolean };
    if (cancel1Body.ok !== true) {
      throw new Error(
        `cancel response shape wrong: ${JSON.stringify(cancel1Body)}`,
      );
    }
    ctx.log(`POST /:invA/cancel (inviter) → 200 ok:true ✓`);

    // 2. POST /:id/cancel again → 409 already-cancelled.
    const cancelAgain = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/invitations/${invA}/cancel', { method: 'POST' });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (cancelAgain.status !== 409) {
      throw new Error(
        `re-cancel expected 409, got ${cancelAgain.status}: ${cancelAgain.body.slice(0, 200)}`,
      );
    }
    const cancelAgainBody = JSON.parse(cancelAgain.body) as {
      error?: string;
    };
    if (
      typeof cancelAgainBody.error !== "string" ||
      !cancelAgainBody.error.toLowerCase().includes("cancelled")
    ) {
      throw new Error(
        `re-cancel error should mention 'cancelled', got ${JSON.stringify(cancelAgainBody)}`,
      );
    }
    ctx.log(
      `POST /:invA/cancel (re-cancel) → 409 "${cancelAgainBody.error}" ✓`,
    );

    // 3. POST /no-such-id/cancel → 404.
    const noInv = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/invitations/no-such-invitation-deadbeef/cancel', { method: 'POST' });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (noInv.status !== 404) {
      throw new Error(
        `cancel no-such-id expected 404, got ${noInv.status}: ${noInv.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /no-such-id/cancel → 404 ✓`);

    // === Group B: bob (non-inviter) tries to cancel → 403. ===
    const groupB = await makeGroup("B");
    const invB = await inviteTo(groupB.id, eveEmail);
    ctx.log(`alice invited eve to ${groupB.name}, inv=${invB}`);

    // Impersonate bob (he is NOT the inviter, NOT the invitee, NOT global).
    const impBob = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/__mock/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(TEST_USERS.bob)} }),
        });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (impBob.status !== 200) {
      throw new Error(`impersonate(bob) ${impBob.status}`);
    }

    // 4. Bob (non-inviter, non-global) tries cancel → 403.
    const forbid = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/invitations/${invB}/cancel', { method: 'POST' });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (forbid.status !== 403) {
      throw new Error(
        `bob (non-inviter) cancel expected 403, got ${forbid.status}: ${forbid.body.slice(0, 200)}`,
      );
    }
    const forbidBody = JSON.parse(forbid.body) as { error?: string };
    if (
      typeof forbidBody.error !== "string" ||
      !forbidBody.error.toLowerCase().includes("forbidden")
    ) {
      throw new Error(
        `403 error should mention 'forbidden', got ${JSON.stringify(forbidBody)}`,
      );
    }
    ctx.log(`bob's POST /:invB/cancel → 403 "${forbidBody.error}" ✓`);

    // === Group C: bob is the invitee, accepts, alice tries to cancel → 409. ===
    // Switch back to alice for setup.
    const impAlice = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/__mock/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(TEST_USERS.alice)} }),
        });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (impAlice.status !== 200) {
      throw new Error(`impersonate(alice) ${impAlice.status}`);
    }

    const groupC = await makeGroup("C");
    const invC = await inviteTo(groupC.id, TEST_USERS.bob);

    // Bob accepts.
    const impBob2 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/__mock/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(TEST_USERS.bob)} }),
        });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (impBob2.status !== 200) {
      throw new Error(`impersonate(bob#2) ${impBob2.status}`);
    }
    const accept = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/invitations/${invC}/accept', { method: 'POST' });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (accept.status !== 200) {
      throw new Error(
        `bob accept expected 200, got ${accept.status}: ${accept.body.slice(0, 200)}`,
      );
    }
    ctx.log(`bob accepted invC ✓`);

    // Switch back to alice (global_owner) and try to cancel an accepted
    // invitation. Even with global authority, "not pending" → 409.
    const impAlice2 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/__mock/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(TEST_USERS.alice)} }),
        });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (impAlice2.status !== 200) {
      throw new Error(`impersonate(alice#2) ${impAlice2.status}`);
    }
    const cancelAccepted = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/invitations/${invC}/cancel', { method: 'POST' });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (cancelAccepted.status !== 409) {
      throw new Error(
        `cancel accepted expected 409, got ${cancelAccepted.status}: ${cancelAccepted.body.slice(0, 200)}`,
      );
    }
    const cancelAcceptedBody = JSON.parse(cancelAccepted.body) as {
      error?: string;
    };
    if (
      typeof cancelAcceptedBody.error !== "string" ||
      !cancelAcceptedBody.error.toLowerCase().includes("accepted")
    ) {
      throw new Error(
        `cancel-accepted error should mention 'accepted', got ${JSON.stringify(cancelAcceptedBody)}`,
      );
    }
    ctx.log(`alice cancel-after-accept → 409 "${cancelAcceptedBody.error}" ✓`);
    await ctx.screenshot("after-cancel-flow");

    // Four intentional failures (409 + 404 + 403 + 409). Allow ≤4.
    const consoleSnap = await ctx.captureConsole("after-invitation-cancel");
    if (consoleSnap.errors > 4) {
      throw new Error(
        `expected ≤4 console errors (409+404+403+409 probes), got ${consoleSnap.errors} (see ${consoleSnap.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSnap.errors} (≤4 ✓)`);
  },
};

export default scenario;
