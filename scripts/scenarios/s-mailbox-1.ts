// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-MAILBOX-1 — Mailbox ownership transfer end-to-end.
 *
 * Branches covered:
 *   POST /api/mailboxes                                (alice creates D1 mailbox at per-run-unique addr)
 *   POST /api/mailboxes/:id/transfer (no body)         (400 — new_owner_user_id required)
 *   POST /api/mailboxes/:id/transfer (bogus user)      (404 — receiver not found / inactive)
 *   POST /__mock/seed-user                             (seed bob as receiver)
 *   POST /api/mailboxes/:id/transfer { new_owner_user_id: bob } (200 — owner_user_id flips,
 *                                                       mailbox_acls revokes alice/admin and inserts bob/admin)
 *   GET  /api/mailboxes/tree (as alice)                (mailbox no longer appears under alice's
 *                                                       private[] — she has no admin ACL row anymore)
 *   POST /__mock/impersonate (bob)
 *   GET  /api/mailboxes/tree (as bob)                  (mailbox now under bob's private[] with
 *                                                       owner_user_id=bob)
 *
 * Locks workers/routes/mailboxes.ts:461-538 — the transfer handler updates
 * `mailboxes.owner_user_id`, then drops the old owner's admin ACL row and
 * inserts an admin ACL row for the new owner. The tree view drives off
 * mailbox_acls (via buildMailboxTree), so the post-transfer GET reflects
 * both sides cleanly.
 *
 * Closes the "mailbox transfer" candidate from session 10's open list and
 * brings the suite from 27 → 28.
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

interface TreeMailbox {
  id: string;
  address: string;
  display_name: string | null;
  owner_user_id: string;
}

interface MailboxTree {
  private?: TreeMailbox[];
  followed?: TreeMailbox[];
  groups?: Array<{ id: string; name: string; mailboxes: TreeMailbox[] }>;
}

const scenario: Scenario = {
  id: "S-MAILBOX-1",
  description:
    "Mailbox ownership transfer: alice→bob via POST /:id/transfer, ACL flip verified across both trees",
  covers:
    "POST /api/mailboxes → 400 (no body) + 404 (bogus user) probes → seed-user(bob) → POST /:id/transfer 200 → alice's tree no longer lists it → impersonate(bob) → bob's tree lists it with owner=bob",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. Per-run-unique mailbox address (transfer leaves it pinned across cycles
    //    if we reuse a fixed local-part).
    const localPart = `s-mbx-1-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const address = `${localPart}@actionnow.ai`;

    const create = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: ${JSON.stringify(address)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (create.status !== 201) {
      throw new Error(
        `POST /api/mailboxes expected 201, got ${create.status}: ${create.body.slice(0, 200)}`,
      );
    }
    const created = JSON.parse(create.body) as { id: string; address: string };
    ctx.log(`created mailbox id=${created.id} address=${created.address}`);

    // 2. Validation probe — POST /:id/transfer with no body → 400.
    const noBody = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${created.id}/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noBody.status !== 400) {
      throw new Error(
        `transfer empty-body expected 400, got ${noBody.status}: ${noBody.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:id/transfer {} → 400 ✓`);

    // 3. Validation probe — POST /:id/transfer with a bogus receiver id → 404.
    const bogusId = "this-user-does-not-exist-deadbeef";
    const bogus = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${created.id}/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ new_owner_user_id: ${JSON.stringify(bogusId)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bogus.status !== 404) {
      throw new Error(
        `transfer to bogus id expected 404, got ${bogus.status}: ${bogus.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:id/transfer {bogus} → 404 ✓`);

    // 4. Seed bob via /__mock/seed-user (active receiver with default visibility).
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

    // 5. POST /:id/transfer { new_owner_user_id: bob } → 200.
    const transfer = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${created.id}/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ new_owner_user_id: ${JSON.stringify(bob.id)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (transfer.status !== 200) {
      throw new Error(
        `transfer alice→bob expected 200, got ${transfer.status}: ${transfer.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /:id/transfer { new_owner_user_id: bob } → 200 ✓`);
    await ctx.screenshot("after-transfer");

    // 6. Alice's GET /api/mailboxes/tree no longer lists the mailbox under
    //    private[] — her admin ACL row was revoked.
    const aliceTree = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/mailboxes/tree').then(r => r.json())`,
    })) as MailboxTree;
    const stillInAlicePrivate = (aliceTree.private ?? []).some(
      (m) => m.id === created.id,
    );
    if (stillInAlicePrivate) {
      throw new Error(
        `alice's tree.private still contains the transferred mailbox: ${JSON.stringify(aliceTree.private)}`,
      );
    }
    ctx.log(
      `alice's tree.private no longer contains the transferred mailbox ✓`,
    );

    // 7. Impersonate bob.
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

    // 8. Bob's GET /api/mailboxes/tree → mailbox is in private[] with owner=bob.
    const bobTree = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/mailboxes/tree').then(r => r.json())`,
    })) as MailboxTree;
    const bobMailbox = (bobTree.private ?? []).find((m) => m.id === created.id);
    if (!bobMailbox) {
      throw new Error(
        `bob's tree.private missing the transferred mailbox: ${JSON.stringify(bobTree.private)}`,
      );
    }
    if (bobMailbox.owner_user_id !== bob.id) {
      throw new Error(
        `bob's mailbox.owner_user_id expected '${bob.id}', got '${bobMailbox.owner_user_id}'`,
      );
    }
    ctx.log(`bob's tree.private contains the mailbox with owner_user_id=bob ✓`);
    await ctx.screenshot("bob-after-transfer");

    // Two probes (400 + 404) seed up to 2 console errors. Allow ≤2.
    const consoleSummary = await ctx.captureConsole("after-transfer-flow");
    if (consoleSummary.errors > 2) {
      throw new Error(
        `expected ≤2 console errors (the 400 + 404 probes), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤2 ✓)`);
  },
};

export default scenario;
