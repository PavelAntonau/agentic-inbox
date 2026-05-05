// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-MAILBOX-2 — Share-with-group lifecycle (single-user variant).
 *
 * Branches covered:
 *   POST /api/mailboxes                                  (alice creates D1 mailbox)
 *   POST /api/groups                                     (alice creates group, becomes owner+admin)
 *   POST /api/mailboxes/:id/share (no group_id)          (400 — group_id required)
 *   POST /api/mailboxes/:id/share { bogus group_id }     (404 — group not found)
 *   POST /api/mailboxes/:id/share { group_id }           (200 — mailbox_groups row inserted)
 *   GET  /api/mailboxes/tree                             (mailbox now under groups[].mailboxes[])
 *   POST /api/mailboxes/:id/share { same group_id }      (409 — already in this group)
 *   DELETE /api/mailboxes/:id/share/:groupId             (200 — mailbox_groups row removed)
 *   GET  /api/mailboxes/tree                             (mailbox no longer under groups[])
 *   DELETE /api/mailboxes/:id/share/:groupId (idempotent)(404 — not in that group)
 *
 * Locks workers/routes/mailboxes.ts:326-453 — the share/unshare handlers
 * with their permission gate (canShare / canUnshare), the E7 cap probe (we
 * never trip it; cap is 10), and the duplicate / not-in-group return codes.
 *
 * Single-user variant intentionally — exercises the mailbox/group plumbing
 * without dragging the invitation flow in (which S-INVITATIONS-1 owns).
 * Bob doesn't appear; alice is sole group member as owner.
 *
 * Closes the "share-with-group" candidate from session 10's open list and
 * brings the suite from 28 → 29.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface TreeMailbox {
  id: string;
  address: string;
  display_name: string | null;
  owner_user_id: string;
}

interface MailboxTree {
  private?: TreeMailbox[];
  followed?: TreeMailbox[];
  // Per workers/lib/mailbox-tree.ts buildMailboxTree: each group section is
  // { group: { id, name, ... }, mailboxes: [...] } — group meta is nested,
  // not flat at the section root.
  groups?: Array<{
    group: { id: string; name: string };
    mailboxes: TreeMailbox[];
  }>;
}

const scenario: Scenario = {
  id: "S-MAILBOX-2",
  description:
    "Share-with-group lifecycle: 400/404/200/409 share probes + 200/404 unshare round trip with tree check",
  covers:
    "POST /api/mailboxes → POST /api/groups → POST /:id/share 400 + 404 + 200 + 409 → tree shows under groups[] → DELETE /:id/share/:groupId → tree no longer shows it → DELETE again → 404",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. Alice creates a per-run-unique mailbox.
    const localPart = `s-mbx-2-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const address = `${localPart}@actionnow.ai`;
    const createMb = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: ${JSON.stringify(address)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (createMb.status !== 201) {
      throw new Error(
        `POST /api/mailboxes expected 201, got ${createMb.status}: ${createMb.body.slice(0, 200)}`,
      );
    }
    const mailbox = JSON.parse(createMb.body) as {
      id: string;
      address: string;
    };
    ctx.log(`mailbox: id=${mailbox.id} addr=${mailbox.address}`);

    // 2. Alice creates a per-run-unique group (alice owner + sole admin member).
    const groupName = `s-mbx-2-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
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

    // 3. Validation probe — POST /:id/share {} → 400.
    const noBody = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noBody.status !== 400) {
      throw new Error(
        `share empty-body expected 400, got ${noBody.status}: ${noBody.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:id/share {} → 400 ✓`);

    // 4. POST /:id/share { bogus group_id } → 404 (group not found).
    const bogusGroup = "no-such-group-deadbeef";
    const bogus = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group_id: ${JSON.stringify(bogusGroup)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bogus.status !== 404) {
      throw new Error(
        `share with bogus group expected 404, got ${bogus.status}: ${bogus.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:id/share { bogus } → 404 ✓`);

    // 5. POST /:id/share { group_id } → 200.
    const share = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group_id: ${JSON.stringify(group.id)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (share.status !== 200) {
      throw new Error(
        `share happy-path expected 200, got ${share.status}: ${share.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:id/share { group_id } → 200 ✓`);

    // 6. GET /api/mailboxes/tree shows mailbox under groups[].mailboxes[].
    const treeAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/mailboxes/tree').then(r => r.json())`,
    })) as MailboxTree;
    const groupSlot = (treeAfter.groups ?? []).find(
      (g) => g.group.id === group.id,
    );
    if (!groupSlot) {
      throw new Error(
        `tree.groups missing the new group ${group.id}: ${JSON.stringify((treeAfter.groups ?? []).map((g) => g.group?.id))}`,
      );
    }
    const sharedMailbox = groupSlot.mailboxes.find((m) => m.id === mailbox.id);
    if (!sharedMailbox) {
      throw new Error(
        `mailbox missing from tree.groups[].mailboxes: ${JSON.stringify(groupSlot.mailboxes)}`,
      );
    }
    ctx.log(`tree.groups[${group.id}].mailboxes contains the mailbox ✓`);
    await ctx.screenshot("after-share");

    // 7. POST /:id/share { same group_id } → 409 (already in this group).
    const dup = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group_id: ${JSON.stringify(group.id)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (dup.status !== 409) {
      throw new Error(
        `duplicate share expected 409, got ${dup.status}: ${dup.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:id/share (duplicate) → 409 ✓`);

    // 8. DELETE /:id/share/:groupId → 200.
    const unshare = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/share/${group.id}', {
          method: 'DELETE',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (unshare.status !== 200) {
      throw new Error(
        `unshare expected 200, got ${unshare.status}: ${unshare.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE /:id/share/:groupId → 200 ✓`);

    // 9. GET /api/mailboxes/tree no longer shows the mailbox under that group.
    const treeAfterUnshare = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/mailboxes/tree').then(r => r.json())`,
    })) as MailboxTree;
    const groupSlotAfter = (treeAfterUnshare.groups ?? []).find(
      (g) => g.group.id === group.id,
    );
    const stillShared =
      groupSlotAfter?.mailboxes.some((m) => m.id === mailbox.id) ?? false;
    if (stillShared) {
      throw new Error(
        `mailbox still under group after unshare: ${JSON.stringify(groupSlotAfter?.mailboxes)}`,
      );
    }
    ctx.log(`tree.groups no longer contains the mailbox under that group ✓`);

    // Capture console BEFORE the trailing 404 idempotency probe — that probe
    // intentionally errors and would otherwise inflate the count.
    const consoleSnap = await ctx.captureConsole("after-share-flow");
    // Three intentional probes (400 + 404 bogus group + 409 duplicate) → allow ≤3.
    if (consoleSnap.errors > 3) {
      throw new Error(
        `expected ≤3 console errors (400 + 404 + 409 probes), got ${consoleSnap.errors} (see ${consoleSnap.path})`,
      );
    }

    // 10. DELETE again → 404 (mailbox is not in that group).
    const unshareAgain = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/share/${group.id}', {
          method: 'DELETE',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (unshareAgain.status !== 404) {
      throw new Error(
        `unshare-again expected 404, got ${unshareAgain.status}: ${unshareAgain.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE /:id/share/:groupId (idempotent) → 404 ✓`);
    ctx.log(`console errors pre-final-probe = ${consoleSnap.errors} (≤3 ✓)`);
  },
};

export default scenario;
