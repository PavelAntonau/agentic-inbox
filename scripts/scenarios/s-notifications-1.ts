// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-NOTIFICATIONS-1 — Group-invitation notifications surface.
 *
 * Branches covered:
 *   POST /__mock/seed-user                              (seed bob — second internal user)
 *   POST /api/groups                                    (alice creates a group)
 *   POST /api/invitations                               (alice invites bob — invitee_user_id matches)
 *   POST /__mock/impersonate                            (swap to bob)
 *   GET  /api/notifications/unseen (baseline)           (1 pending invitation for bob)
 *   POST /api/invitations/:id/decline                   (bob declines)
 *   GET  /api/notifications/unseen (post-decline)       (0 invitations — declined rows filtered out)
 *
 * The /api/notifications/unseen endpoint surfaces pending group invitations where
 * invitee_user_id == ctx.user_id (workers/routes/notifications.ts:30-74). It filters
 * by status='pending' AND expires_at>now. Decline flips status to 'declined' so the
 * invitation drops out of the unseen list. Locks the unseen-lifecycle invariant for
 * the bell/notifications surface.
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

interface InvitationRow {
  id: string;
  group_id: string;
  invitee_email: string;
  invitee_user_id: string | null;
  invited_by: string;
  status: string;
  created_at: number;
  expires_at: number;
  group_name: string | null;
  group_description: string | null;
  inviter_display_name: string | null;
  inviter_email: string | null;
}

const scenario: Scenario = {
  id: "S-NOTIFICATIONS-1",
  description:
    "Group invitations surface via GET /api/notifications/unseen + decline lifecycle",
  covers:
    "POST /api/groups → POST /api/invitations → impersonate(bob) → GET /api/notifications/unseen=1 → POST /api/invitations/:id/decline → GET /api/notifications/unseen=0",
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

    // 2. Per-run-unique group name so cumulative DO state across re-runs doesn't
    //    accumulate same-named groups (groups.ts inserts unconditionally).
    const groupName = `notif-test-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const createGroup = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ${JSON.stringify(groupName)}, description: 'S-NOTIFICATIONS-1 fixture' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (createGroup.status !== 201) {
      throw new Error(
        `POST /api/groups expected 201, got ${createGroup.status}: ${createGroup.body.slice(0, 200)}`,
      );
    }
    const group = JSON.parse(createGroup.body) as { id: string; name: string };
    ctx.log(`group created: id=${group.id} name=${group.name}`);

    // 3. POST /api/invitations — alice invites bob (his email matches a seeded user,
    //    so invitee_user_id is set and the row surfaces in /unseen).
    const invite = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/invitations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group_id: ${JSON.stringify(group.id)}, email: ${JSON.stringify(bobEmail)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (invite.status !== 200) {
      throw new Error(
        `POST /api/invitations expected 200, got ${invite.status}: ${invite.body.slice(0, 200)}`,
      );
    }
    ctx.log(`invitation sent → 200 (privacy-preserving {sent:true} envelope)`);

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

    // 5. GET /api/notifications/unseen → 1 pending invitation, bound to alice's group.
    const unseenBefore = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/notifications/unseen');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (unseenBefore.status !== 200) {
      throw new Error(
        `GET /api/notifications/unseen ${unseenBefore.status}: ${unseenBefore.body.slice(0, 200)}`,
      );
    }
    const unseenBeforeBody = JSON.parse(unseenBefore.body) as {
      invitations: InvitationRow[];
    };
    const matched = unseenBeforeBody.invitations.find(
      (inv) => inv.group_id === group.id,
    );
    if (!matched) {
      throw new Error(
        `expected unseen invitation for group ${group.id}, got ${unseenBeforeBody.invitations.length} invitations: ${JSON.stringify(unseenBeforeBody.invitations.map((i) => ({ id: i.id, group_id: i.group_id, status: i.status })))}`,
      );
    }
    if (matched.status !== "pending") {
      throw new Error(
        `unseen invitation expected status='pending', got '${matched.status}'`,
      );
    }
    if (matched.invitee_user_id !== bob.id) {
      throw new Error(
        `invitee_user_id expected ${bob.id}, got ${matched.invitee_user_id}`,
      );
    }
    if (matched.group_name !== groupName) {
      throw new Error(
        `joined group_name expected '${groupName}', got '${matched.group_name}'`,
      );
    }
    if (matched.expires_at <= Date.now()) {
      throw new Error(
        `invitation already expired: expires_at=${matched.expires_at} now=${Date.now()}`,
      );
    }
    ctx.log(
      `bob's GET /api/notifications/unseen → 1 invitation for group=${matched.group_name} status=${matched.status} ✓`,
    );
    await ctx.screenshot("after-unseen-fetch");

    // 6. Decline the invitation.
    const decline = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/invitations/${matched.id}/decline', {
          method: 'POST',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (decline.status !== 200) {
      throw new Error(
        `POST /api/invitations/:id/decline expected 200, got ${decline.status}: ${decline.body.slice(0, 200)}`,
      );
    }
    ctx.log(`bob declines invitation ${matched.id} → 200 ✓`);

    // 7. GET /api/notifications/unseen → invitation no longer present (status filter excludes 'declined').
    const unseenAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/notifications/unseen');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const unseenAfterBody = JSON.parse(unseenAfter.body) as {
      invitations: InvitationRow[];
    };
    const stillPresent = unseenAfterBody.invitations.find(
      (inv) => inv.id === matched.id,
    );
    if (stillPresent) {
      throw new Error(
        `declined invitation still in unseen list: ${JSON.stringify(stillPresent)}`,
      );
    }
    ctx.log(
      `bob's GET /api/notifications/unseen post-decline → invitation gone ✓ (${unseenAfterBody.invitations.length} other(s) remain)`,
    );

    // No probe-shaped console errors expected — every fetch above is a 2xx.
    const consoleSummary = await ctx.captureConsole("after-notifications-flow");
    if (consoleSummary.errors > 0) {
      throw new Error(
        `expected 0 console errors, got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (0 ✓)`);
  },
};

export default scenario;
