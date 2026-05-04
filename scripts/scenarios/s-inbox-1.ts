// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INBOX-1 — Create personal mailbox.
 *
 * Branches covered: CreateMailboxDialog open, POST /api/mailboxes,
 * sidebar refresh, DO bootstrap.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

const scenario: Scenario = {
  id: "S-INBOX-1",
  description: "Create a personal mailbox via the rail",
  covers: "CreateMailboxDialog → POST /api/mailboxes → sidebar update",
  smoke: true,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // The sidebar's "Create new mailbox" button lives in MailboxTreeRail.
    await ctx.click({ ariaLabel: "Create new mailbox" });
    await ctx.screenshot("create-dialog-open");

    // Address input is the autoFocus'd field; pick the first text input
    // inside the open dialog (Dialog has no explicit aria-label).
    await ctx.browser.call("browser_evaluate", {
      expression: `(() => {
        const dlg = document.querySelector('[role="dialog"]');
        if (!dlg) throw new Error('no open dialog');
        const inputs = dlg.querySelectorAll('input[type="text"], input:not([type]), input[type="email"]');
        if (!inputs.length) throw new Error('no text input in dialog');
        const el = inputs[0];
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) { desc.set.call(el, 'team-test@actionnow.ai'); } else { el.value = 'team-test@actionnow.ai'; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    });
    await ctx.screenshot("create-dialog-filled");

    // Submit via dialog-scoped selector — NOT a text-substring "Create"
    // click. The home empty-state has its own "Create Mailbox" button
    // outside the dialog, so a substring match hits the wrong button and
    // the dialog never submits (F-PHASE2-004 root cause).
    await ctx.click({ selector: '[role="dialog"] button[type="submit"]' });

    // Wait for the dialog to close — the dialog calls onCreated() on 2xx,
    // which flips createOpen to false in the rail's state.
    await ctx.waitFor({
      selector: "body:not(:has([role='dialog']))",
      timeoutMs: 8_000,
    });

    // Verify the mailbox actually exists in the tree (API truth, not DOM
    // text — the rail renders the local-part `team-test`, not the full
    // address, so substring assertions on the page are brittle).
    const tree = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/mailboxes/tree').then(r => r.json())`,
    })) as {
      private?: Array<{ address: string }>;
      followed?: Array<{ address: string }>;
    };
    const found = [...(tree.private ?? []), ...(tree.followed ?? [])].some(
      (m) => m.address === "team-test@actionnow.ai",
    );
    if (!found) {
      throw new Error(
        `mailbox not in /api/mailboxes/tree after create: ${JSON.stringify(tree).slice(0, 300)}`,
      );
    }
    ctx.log("mailbox verified in /api/mailboxes/tree");
    await ctx.screenshot("post-create");

    const console = await ctx.captureConsole("after-create");
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) after create (see ${console.path})`,
      );
    }
  },
};

export default scenario;
