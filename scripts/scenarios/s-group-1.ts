// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-GROUP-1 — Group CRUD by the group owner.
 *
 * Branches covered:
 *   POST /api/groups                                    (400 missing name, 400 too-long name,
 *                                                        201 success — actor becomes admin member)
 *   GET  /api/groups                                    (alice's group enumerated, joined member_count,
 *                                                        actor_role_in_group='owner' for the creator)
 *   GET  /api/groups/:groupId                           (group detail with members[] including alice
 *                                                        as role_in_group='admin')
 *   PATCH /api/groups/:groupId                          (rename — owner-only)
 *   GET  /api/groups (post-rename)                      (new name visible)
 *
 * Locks the single-user happy path for the groups surface — required before
 * S-INVITATIONS-1 (which exercises the multi-user invite flow). Per-run-unique
 * group name avoids cumulative DO state across re-runs.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  created_at: number;
  member_count?: number;
  actor_role_in_group?: string | null;
}

interface GroupDetail extends GroupRow {
  members: Array<{
    group_id: string;
    user_id: string;
    role_in_group: string;
    joined_at: number;
  }>;
}

const scenario: Scenario = {
  id: "S-GROUP-1",
  description:
    "Group CRUD: 400 validation, 201 create, GET listing+detail, PATCH rename",
  covers:
    "POST /api/groups 400 + 201 → GET /api/groups (member_count + actor_role_in_group='owner') → GET /:id (members joined) → PATCH rename → GET shows new name",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. POST /api/groups with no name → 400.
    const noName = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noName.status !== 400) {
      throw new Error(
        `POST /api/groups {} expected 400, got ${noName.status}: ${noName.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /api/groups {} → 400 ✓`);

    // 2. POST /api/groups with too-long name → 400.
    const longName = "x".repeat(101);
    const tooLong = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ${JSON.stringify(longName)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (tooLong.status !== 400) {
      throw new Error(
        `POST /api/groups {long name} expected 400, got ${tooLong.status}: ${tooLong.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /api/groups {>100 char name} → 400 ✓`);

    // 3. POST /api/groups with valid name → 201, actor becomes admin member.
    const groupName = `s-group-1-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const desc = "S-GROUP-1 fixture";
    const create = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ${JSON.stringify(groupName)}, description: ${JSON.stringify(desc)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (create.status !== 201) {
      throw new Error(
        `POST /api/groups {valid} expected 201, got ${create.status}: ${create.body.slice(0, 200)}`,
      );
    }
    const created = JSON.parse(create.body) as GroupRow;
    if (created.name !== groupName) {
      throw new Error(
        `created group name expected '${groupName}', got '${created.name}'`,
      );
    }
    ctx.log(`POST /api/groups {valid} → 201 id=${created.id} ✓`);

    // 4. GET /api/groups → alice's group is listed with member_count=1 and actor_role_in_group='owner'.
    //    The groups.ts handler reports 'owner' when the actor is the group's owner_user_id.
    const list = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (list.status !== 200) {
      throw new Error(
        `GET /api/groups ${list.status}: ${list.body.slice(0, 200)}`,
      );
    }
    const listBody = JSON.parse(list.body) as { groups: GroupRow[] };
    const myGroup = listBody.groups.find((g) => g.id === created.id);
    if (!myGroup) {
      throw new Error(
        `created group missing from GET /api/groups (got ${listBody.groups.length} rows)`,
      );
    }
    if (myGroup.member_count !== 1) {
      throw new Error(`member_count expected 1, got ${myGroup.member_count}`);
    }
    if (myGroup.actor_role_in_group !== "owner") {
      throw new Error(
        `actor_role_in_group expected 'owner', got '${myGroup.actor_role_in_group}'`,
      );
    }
    ctx.log(
      `GET /api/groups → name='${myGroup.name}' member_count=${myGroup.member_count} actor_role='${myGroup.actor_role_in_group}' ✓`,
    );
    await ctx.screenshot("after-list-groups");

    // 5. GET /api/groups/:groupId → detail with members[] containing alice as role_in_group='admin'.
    //    (groups.ts inserts the creator as role_in_group='admin' on POST.)
    const detail = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${created.id}');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (detail.status !== 200) {
      throw new Error(
        `GET /api/groups/:id ${detail.status}: ${detail.body.slice(0, 200)}`,
      );
    }
    const detailBody = JSON.parse(detail.body) as GroupDetail;
    if (!detailBody.members || detailBody.members.length !== 1) {
      throw new Error(
        `detail members[] expected length 1, got ${detailBody.members?.length ?? "(missing)"}`,
      );
    }
    const aliceMember = detailBody.members[0];
    if (aliceMember.role_in_group !== "admin") {
      throw new Error(
        `alice's group_member.role_in_group expected 'admin', got '${aliceMember.role_in_group}'`,
      );
    }
    if (detailBody.actor_role_in_group !== "owner") {
      throw new Error(
        `detail.actor_role_in_group expected 'owner', got '${detailBody.actor_role_in_group}'`,
      );
    }
    ctx.log(
      `GET /api/groups/${created.id} → members[0].role='${aliceMember.role_in_group}' actor_role='owner' ✓`,
    );

    // 6. PATCH /api/groups/:groupId — rename (owner-only).
    const newName = `${groupName}-renamed`;
    const rename = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups/${created.id}', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ${JSON.stringify(newName)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (rename.status !== 200) {
      throw new Error(
        `PATCH /api/groups/:id rename expected 200, got ${rename.status}: ${rename.body.slice(0, 200)}`,
      );
    }
    ctx.log(`PATCH /api/groups/${created.id} → 200 ✓`);

    // 7. GET /api/groups (post-rename) → name reflects the new value.
    const listAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/groups');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const listAfterBody = JSON.parse(listAfter.body) as { groups: GroupRow[] };
    const renamed = listAfterBody.groups.find((g) => g.id === created.id);
    if (!renamed) {
      throw new Error(
        `renamed group missing from GET /api/groups (got ${listAfterBody.groups.length} rows)`,
      );
    }
    if (renamed.name !== newName) {
      throw new Error(
        `post-rename name expected '${newName}', got '${renamed.name}'`,
      );
    }
    ctx.log(`GET /api/groups post-rename → name='${renamed.name}' ✓`);

    // Two 400 probes seed up to 2 expected console errors. Allow ≤2.
    const consoleSummary = await ctx.captureConsole("after-group-flow");
    if (consoleSummary.errors > 2) {
      throw new Error(
        `expected ≤2 console errors (the two 400 probes), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤2 ✓)`);
  },
};

export default scenario;
