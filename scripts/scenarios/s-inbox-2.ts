// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INBOX-2 — Delete a mailbox.
 *
 * Branches covered: POST /api/mailboxes (create) → DELETE /api/mailboxes/:id
 * → /api/mailboxes/tree no longer lists the mailbox.
 *
 * Scope note (gap discovered while implementing T3.3):
 *
 *   The plan's S-INBOX-2 description named both "rename" AND "delete". The
 *   D1-backed `/api/mailboxes` router (workers/routes/mailboxes.ts) exposes
 *   POST + DELETE but NOT PUT — there is no rename endpoint in the D1 stack.
 *   The legacy `/api/v1/mailboxes/:mailboxId` PUT only updates the R2 settings
 *   blob; it does not rename the address (the address IS the mailbox id in
 *   the v1 stack). A real rename endpoint is product work outside T3.3 scope.
 *   See finding F-PHASE3-002 for the gap; this scenario covers create+delete
 *   only.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

const scenario: Scenario = {
  id: "S-INBOX-2",
  description: "Delete a mailbox via DELETE /api/mailboxes/:id",
  covers: "POST /api/mailboxes → DELETE /api/mailboxes/:id → tree update",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const address = "to-be-deleted@actionnow.ai";

    // 1. Create via the D1 router (same path as S-INBOX-1 happy path).
    const createResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: ${JSON.stringify(address)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (createResult.status !== 201) {
      throw new Error(
        `create returned ${createResult.status}: ${createResult.body.slice(0, 200)}`,
      );
    }
    const created = JSON.parse(createResult.body) as {
      id: string;
      address: string;
    };
    ctx.log(`created mailbox id=${created.id} address=${created.address}`);

    // 2. Verify it appears in the tree.
    const treeBefore = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/mailboxes/tree').then(r => r.json())`,
    })) as {
      private?: Array<{ id: string; address: string }>;
      followed?: Array<{ id: string; address: string }>;
    };
    const presentBefore = [
      ...(treeBefore.private ?? []),
      ...(treeBefore.followed ?? []),
    ].some((m) => m.id === created.id);
    if (!presentBefore) {
      throw new Error(
        `mailbox not in tree after create: ${JSON.stringify(treeBefore).slice(0, 300)}`,
      );
    }
    ctx.log("mailbox visible in tree (pre-delete)");
    await ctx.screenshot("post-create");

    // 3. DELETE.
    const delResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/' + ${JSON.stringify(created.id)}, {
          method: 'DELETE',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (delResult.status !== 204) {
      throw new Error(
        `delete returned ${delResult.status}: ${delResult.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE /api/mailboxes/${created.id} → 204`);

    // 4. Verify it's gone from the tree.
    const treeAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/mailboxes/tree').then(r => r.json())`,
    })) as {
      private?: Array<{ id: string; address: string }>;
      followed?: Array<{ id: string; address: string }>;
    };
    const presentAfter = [
      ...(treeAfter.private ?? []),
      ...(treeAfter.followed ?? []),
    ].some((m) => m.id === created.id);
    if (presentAfter) {
      throw new Error(
        `mailbox still in tree after delete: ${JSON.stringify(treeAfter).slice(0, 300)}`,
      );
    }
    ctx.log("mailbox gone from tree (post-delete)");
    await ctx.screenshot("post-delete");

    // Capture console BEFORE the idempotency probe — the second DELETE
    // intentionally hits 404, which the browser logs as "Failed to load
    // resource" at error level. Capturing first separates real product
    // errors from the expected 404 noise we generate next.
    const consoleSnap = await ctx.captureConsole("after-delete");
    if (consoleSnap.errors > 0) {
      throw new Error(
        `${consoleSnap.errors} console error(s) after delete (see ${consoleSnap.path})`,
      );
    }

    // 5. Second DELETE should 404 (idempotency check). Done last because it
    // necessarily produces a 404-as-console-error.
    const delAgain = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/' + ${JSON.stringify(created.id)}, {
          method: 'DELETE',
        });
        return { status: res.status };
      })()`,
    })) as { status: number };
    if (delAgain.status !== 404) {
      throw new Error(
        `second delete returned ${delAgain.status}, expected 404`,
      );
    }
    ctx.log(`second DELETE → 404 (correct: not found)`);
  },
};

export default scenario;
