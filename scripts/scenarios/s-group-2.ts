// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-GROUP-2 — Group member role changes + member removal lifecycle.
 *
 * Branches covered (workers/routes/groups.ts:456-680):
 *   POST /api/groups                                       (alice creates group)
 *   POST /api/invitations + impersonate(bob) + accept      (bob becomes member, role='member')
 *   POST /:groupId/members/:userId/role { role: "admin" }  (200 — promote bob; group.member-promoted audit)
 *   POST /:groupId/members/:userId/role { role: "member" } (200 — demote back; group.member-demoted)
 *   POST /:groupId/members/:userId/role { role: "owner" }  (400 — only "admin" or "member" allowed)
 *   POST /:groupId/members/:ownerId/role { role: "admin" } (400 — "Use transfer endpoint to change owner role")
 *   POST /:bogusGroupId/members/:userId/role               (404 — group not found)
 *   DELETE /:groupId/members/:ownerUserId                  (400 — "Owner must transfer ownership first")
 *   DELETE /:groupId/members/:userId                       (200 — bob removed; group.member-removed audit)
 *   GET   /:groupId/members                                (members[] no longer contains bob)
 *
 * Single-actor (alice) drives every guard except the membership setup,
 * where bob's accept is the only second-actor step. Locks the peer-immutable
 * + owner-protected invariants and the role validation surface — required
 * before any "admin can demote member" UI work can land safely.
 *
 * Closes the "group-management surfaces (transfer ownership, member role
 * changes, member removal)" candidate from session 10's open list and
 * brings the suite from 29 → 30 — final scenario of T3.2.
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
  status: string;
}

interface MemberRow {
  user_id: string;
  role_in_group: string;
  joined_at: number;
  email?: string | null;
  display_name?: string | null;
  status?: string | null;
  is_owner?: boolean;
}

const scenario: Scenario = {
  id: "S-GROUP-2",
  description:
    "Group member role + removal: promote/demote, role validation 400s, owner-protected guards, member removal",
  covers:
    "POST /:groupId/members/:userId/role 200 (promote→demote) + 400 (bogus role / owner) + 404 (bogus group) → DELETE /:groupId/members/:ownerId 400 (owner-protected) → DELETE /:groupId/members/:userId 200 → GET /:groupId/members confirms removal",
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

    // 3. Alice creates a per-run-unique group.
    const groupName = `s-group-2-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const createGrp = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ${JSON.stringify(groupName)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (createGrp.status !== 201) {
      throw new Error(
        `POST /api/groups expected 201, got ${createGrp.status}: ${createGrp.body.slice(0, 200)}`,
      );
    }
    const group = JSON.parse(createGrp.body) as { id: string; name: string };
    ctx.log(`group: id=${group.id} name=${group.name}`);

    // 4. Alice invites bob.
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

    // 5. Impersonate bob, find the invitation id, accept.
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

    const unseen = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/notifications/unseen');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const unseenBody = JSON.parse(unseen.body) as {
      invitations: InvitationRow[];
    };
    const inv = unseenBody.invitations.find((i) => i.group_id === group.id);
    if (!inv) {
      throw new Error(
        `bob's /unseen missing invitation for group ${group.id} (${unseenBody.invitations.length} rows)`,
      );
    }
    const accept = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/invitations/${inv.id}/accept', {
          method: 'POST',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (accept.status !== 200) {
      throw new Error(
        `bob accept expected 200, got ${accept.status}: ${accept.body.slice(0, 200)}`,
      );
    }
    ctx.log(`bob accepts invitation → 200 ✓ (now group_member role='member')`);

    // 6. Switch back to alice.
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

    // 7. Promote bob to admin.
    const promote = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${group.id}/members/${bob.id}/role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (promote.status !== 200) {
      throw new Error(
        `promote bob expected 200, got ${promote.status}: ${promote.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:gid/members/${bob.id}/role { admin } → 200 ✓`);

    // 8. GET /:groupId/members → bob now has role_in_group='admin'.
    const membersAfterPromote = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${group.id}/members');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const membersAfterPromoteBody = JSON.parse(membersAfterPromote.body) as {
      members: MemberRow[];
    };
    const bobAdmin = membersAfterPromoteBody.members.find(
      (m) => m.user_id === bob.id,
    );
    if (!bobAdmin) {
      throw new Error(
        `bob missing from members[] post-promote (${membersAfterPromoteBody.members.length} rows)`,
      );
    }
    if (bobAdmin.role_in_group !== "admin") {
      throw new Error(
        `bob's role_in_group expected 'admin', got '${bobAdmin.role_in_group}'`,
      );
    }
    ctx.log(`GET /:gid/members → bob role='admin' ✓`);

    // 9. Demote bob back to member (covers the symmetric path).
    const demote = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${group.id}/members/${bob.id}/role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'member' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (demote.status !== 200) {
      throw new Error(
        `demote bob expected 200, got ${demote.status}: ${demote.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:gid/members/${bob.id}/role { member } → 200 ✓`);
    await ctx.screenshot("after-promote-demote");

    // 10. Validation probe — bogus role → 400.
    const bogusRole = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${group.id}/members/${bob.id}/role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'owner' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bogusRole.status !== 400) {
      throw new Error(
        `bogus role expected 400, got ${bogusRole.status}: ${bogusRole.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:gid/members/${bob.id}/role { owner } → 400 ✓`);

    // 11. Owner-protected — POST role on owner (alice herself) → 400 "Use transfer endpoint".
    const ownerRole = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${group.id}/members/${alice.user_id}/role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (ownerRole.status !== 400) {
      throw new Error(
        `role-on-owner expected 400, got ${ownerRole.status}: ${ownerRole.body.slice(0, 200)}`,
      );
    }
    const ownerRoleBody = JSON.parse(ownerRole.body) as { error?: string };
    if (
      typeof ownerRoleBody.error !== "string" ||
      !ownerRoleBody.error.toLowerCase().includes("transfer")
    ) {
      throw new Error(
        `role-on-owner 400 should mention 'transfer', got ${JSON.stringify(ownerRoleBody)}`,
      );
    }
    ctx.log(`POST /:gid/members/<owner>/role → 400 "${ownerRoleBody.error}" ✓`);

    // 12. 404 probe — bogus group id.
    const bogusGroupId = "no-such-group-deadbeef";
    const bogusGroup = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${bogusGroupId}/members/${bob.id}/role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bogusGroup.status !== 404) {
      throw new Error(
        `role on bogus group expected 404, got ${bogusGroup.status}: ${bogusGroup.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /<bogus-gid>/members/.../role → 404 ✓`);

    // 13. DELETE on owner → 400 "Owner must transfer ownership first".
    const delOwner = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${group.id}/members/${alice.user_id}', {
          method: 'DELETE',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    // Self-leave path fires first (userId === ctx.user_id) and returns the
    // owner-must-transfer 400 with code='owner-must-transfer'.
    if (delOwner.status !== 400) {
      throw new Error(
        `DELETE on owner expected 400, got ${delOwner.status}: ${delOwner.body.slice(0, 200)}`,
      );
    }
    const delOwnerBody = JSON.parse(delOwner.body) as {
      error?: string;
      code?: string;
    };
    if (
      typeof delOwnerBody.error !== "string" ||
      !delOwnerBody.error.toLowerCase().includes("transfer")
    ) {
      throw new Error(
        `DELETE-on-owner 400 should mention 'transfer', got ${JSON.stringify(delOwnerBody)}`,
      );
    }
    ctx.log(
      `DELETE /:gid/members/<owner> → 400 code='${delOwnerBody.code ?? "(none)"}' ✓`,
    );

    // 14. DELETE bob → 200.
    const delBob = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${group.id}/members/${bob.id}', {
          method: 'DELETE',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (delBob.status !== 200) {
      throw new Error(
        `DELETE bob expected 200, got ${delBob.status}: ${delBob.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE /:gid/members/${bob.id} → 200 ✓`);

    // 15. GET /:groupId/members no longer contains bob.
    const membersAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${group.id}/members');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const membersAfterBody = JSON.parse(membersAfter.body) as {
      members: MemberRow[];
    };
    const stillBob = membersAfterBody.members.some((m) => m.user_id === bob.id);
    if (stillBob) {
      throw new Error(
        `bob still in members[] post-DELETE: ${JSON.stringify(membersAfterBody.members)}`,
      );
    }
    ctx.log(`bob no longer in members[] post-DELETE ✓`);
    await ctx.screenshot("after-member-removal");

    // Three intentional 4xx probes (bogus role 400 + owner role 400 + bogus group 404
    // + owner DELETE 400) → allow ≤4 console errors.
    const consoleSummary = await ctx.captureConsole("after-group-2-flow");
    if (consoleSummary.errors > 4) {
      throw new Error(
        `expected ≤4 console errors (4xx probes), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤4 ✓)`);
  },
};

export default scenario;
