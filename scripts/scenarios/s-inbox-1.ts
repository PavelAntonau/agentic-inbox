// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INBOX-1 — Create personal mailbox.
 *
 * Branches covered: CreateMailboxDialog open, POST /api/mailboxes,
 * sidebar refresh, DO bootstrap.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs, assertText } from "./_helpers";

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

    // Address input is the autoFocus'd field; fill via aria target.
    // The dialog has no explicit aria-label; pick the first text input
    // inside an open dialog.
    await ctx.browser.call("browser_evaluate", {
      function: `() => {
        const dlg = document.querySelector('[role="dialog"]');
        if (!dlg) throw new Error('no open dialog');
        const inputs = dlg.querySelectorAll('input[type="text"], input:not([type])');
        if (!inputs.length) throw new Error('no text input in dialog');
        const el = inputs[0];
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(el, 'team-test@actionnow.ai');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }`,
    });
    await ctx.screenshot("create-dialog-filled");

    // Submit by clicking the Create / Save / Submit button — the dialog
    // footer button is typically labelled "Create".
    await ctx.click({ text: "Create" });

    // After success the dialog closes and the rail reloads. Assert the new
    // address appears somewhere on the page (sidebar tree).
    await assertText(ctx, "team-test@actionnow.ai", 8_000);
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
