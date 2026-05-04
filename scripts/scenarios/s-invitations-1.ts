// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INVITATIONS-1 — Group invitation accept lifecycle.
 *
 * Branches covered:
 *   POST /api/groups                                    (alice creates a group)
 *   POST /api/invitations                               (alice invites bob — invitee_user_id matches)
 *   POST /__mock/impersonate                            (swap to bob)
 *   GET  /api/notifications/unseen                      (1 pending invitation surfaces)
 *   POST /api/invitations/:id/accept                    (bob accepts → group_members row inserted,
 *                                                        invitation status flips to 'accepted')
 *   POST /api/invitations/:id/accept (idempotent)       (409 — already accepted)
 *   GET  /api/notifications/unseen                      (no longer pending)
 *   GET  /api/groups (as bob)                           (joined group is now in bob's list)
 *
 * Pairs with S-NOTIFICATIONS-1 (decline) — together they cover both terminal states
 * of the invitation lifecycle. Required before any "second-user-must-act" group
 * scenario (mailbox transfer, share-with-group) can land.
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
  inviter_display_name: string | null;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  member_count?: number;
  actor_role_in_group?: string | null;
}

const scenario: Scenario = {
  id: "S-INVITATIONS-1",
  description:
    "Group invitation accept lifecycle (alice invites bob, bob accepts via /:id/accept)",
  covers:
    "POST /api/groups → POST /api/invitations → impersonate(bob) → GET /unseen=1 → POST /:id/accept → POST /:id/accept (409) → GET /unseen=0 → GET /api/groups (as bob, contains the group)",
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

    // 2. Alice creates a per-run-unique group.
    const groupName = `s-inv-1-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const create = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ${JSON.stringify(groupName)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (create.status !== 201) {
      throw new Error(
        `POST /api/groups expected 201, got ${create.status}: ${create.body.slice(0, 200)}`,
      );
    }
    const group = JSON.parse(create.body) as { id: string; name: string };
    ctx.log(`group created: id=${group.id} name=${group.name}`);

    // 3. POST /api/invitations — alice invites bob.
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
    ctx.log(`alice invites bob → 200 ✓`);

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

    // 5. Bob's GET /api/notifications/unseen → invitation present, status='pending'.
    const unseenBefore = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/notifications/unseen');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const unseenBeforeBody = JSON.parse(unseenBefore.body) as {
      invitations: InvitationRow[];
    };
    const matched = unseenBeforeBody.invitations.find(
      (inv) => inv.group_id === group.id,
    );
    if (!matched) {
      throw new Error(
        `expected pending invitation for group ${group.id}, got ${unseenBeforeBody.invitations.length} rows`,
      );
    }
    ctx.log(
      `bob's GET /unseen → 1 invitation id=${matched.id} status='${matched.status}' ✓`,
    );

    // 6. Bob accepts.
    const accept = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/invitations/${matched.id}/accept', {
          method: 'POST',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (accept.status !== 200) {
      throw new Error(
        `POST /api/invitations/:id/accept expected 200, got ${accept.status}: ${accept.body.slice(0, 200)}`,
      );
    }
    ctx.log(`bob accepts invitation → 200 ✓`);

    // 7. Idempotent accept → 409 (status='accepted', not 'pending').
    const acceptAgain = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/invitations/${matched.id}/accept', {
          method: 'POST',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (acceptAgain.status !== 409) {
      throw new Error(
        `re-accept expected 409 (already accepted), got ${acceptAgain.status}: ${acceptAgain.body.slice(0, 200)}`,
      );
    }
    const acceptAgainBody = JSON.parse(acceptAgain.body) as { error?: string };
    if (
      typeof acceptAgainBody.error !== "string" ||
      !acceptAgainBody.error.toLowerCase().includes("accepted")
    ) {
      throw new Error(
        `409 error should mention 'accepted', got ${JSON.stringify(acceptAgainBody)}`,
      );
    }
    ctx.log(`re-accept → 409 "${acceptAgainBody.error}" ✓`);

    // 8. /unseen no longer surfaces the invitation.
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
        `accepted invitation still in /unseen list: ${JSON.stringify(stillPresent)}`,
      );
    }
    ctx.log(`bob's /unseen post-accept → invitation gone ✓`);

    // 9. Bob's GET /api/groups now contains the group (he is a member).
    const bobGroups = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bobGroups.status !== 200) {
      throw new Error(
        `bob GET /api/groups ${bobGroups.status}: ${bobGroups.body.slice(0, 200)}`,
      );
    }
    const bobGroupsBody = JSON.parse(bobGroups.body) as { groups: GroupRow[] };
    const joined = bobGroupsBody.groups.find((g) => g.id === group.id);
    if (!joined) {
      throw new Error(
        `bob's GET /api/groups missing the group he just joined (got ${bobGroupsBody.groups.length} rows)`,
      );
    }
    if (joined.actor_role_in_group !== "member") {
      throw new Error(
        `bob's actor_role_in_group expected 'member', got '${joined.actor_role_in_group}'`,
      );
    }
    if (joined.member_count !== 2) {
      throw new Error(
        `member_count expected 2 (alice admin + bob member), got ${joined.member_count}`,
      );
    }
    ctx.log(
      `bob's GET /api/groups → joined group as role='${joined.actor_role_in_group}' member_count=${joined.member_count} ✓`,
    );
    await ctx.screenshot("after-invite-accept");

    // One 409 probe seeds 1 expected console error. Allow ≤1.
    const consoleSummary = await ctx.captureConsole("after-invitation-flow");
    if (consoleSummary.errors > 1) {
      throw new Error(
        `expected ≤1 console error (the 409 re-accept probe), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤1 ✓)`);
  },
};

export default scenario;
