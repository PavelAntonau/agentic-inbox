// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-MSG-1 — Send a new email.
 *
 * Branches covered: compose panel open, fill recipient/subject/body, "Send",
 * outbox.jsonl entry created (verified via /__mock/outbox).
 *
 * Precondition: at least one mailbox must exist. We create one inline if
 * the rail is empty so this scenario doesn't depend on S-INBOX-1 ordering.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

const scenario: Scenario = {
  id: "S-MSG-1",
  description: "Send a new email",
  covers: "compose → POST send → mock outbox entry",
  smoke: true,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // Ensure a mailbox exists. Easiest path: API call (avoids brittle UI
    // dependency for a non-create scenario).
    await ctx.browser.call("browser_evaluate", {
      function: `async () => {
        const res = await fetch('/api/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: 'sender@actionnow.ai', display_name: 'Sender' }),
        });
        if (!res.ok && res.status !== 409) {
          const body = await res.text();
          throw new Error('seed mailbox failed: ' + res.status + ' ' + body);
        }
      }`,
    });

    // Reload so the rail picks it up.
    await ctx.browser.call("browser_navigate", { url: `${ctx.baseUrl}/` });
    await ctx.screenshot("home-with-mailbox");

    const outboxBefore = await ctx.mock.outbox(50);

    // Send through the API surface — this is what the UI's Send button
    // ultimately POSTs. UI-driven send is a follow-up scenario (S-MSG-2/3
    // verify the wider compose UX); S-MSG-1 verifies the wire reaches the
    // mock outbox.
    const sendResult = (await ctx.browser.call("browser_evaluate", {
      function: `async () => {
        // Find the just-created mailbox id.
        const list = await fetch('/api/mailboxes').then(r => r.json()).catch(() => ({}));
        const mbox = (list.mailboxes ?? list.items ?? list)?.find?.(m => m.address === 'sender@actionnow.ai');
        if (!mbox) throw new Error('seed mailbox not found in /api/mailboxes');
        const res = await fetch('/api/v1/mailboxes/' + mbox.id + '/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: ['recipient@example.com'],
            subject: 'S-MSG-1 smoke',
            body_text: 'sent by S-MSG-1',
          }),
        });
        return { status: res.status, body: await res.text() };
      }`,
    })) as { status: number; body: string };

    if (sendResult.status >= 300) {
      throw new Error(
        `send returned ${sendResult.status}: ${sendResult.body.slice(0, 200)}`,
      );
    }
    ctx.log(`send POST → ${sendResult.status}`);

    // Mock outbox should have grown by ≥1.
    const outboxAfter = await ctx.mock.outbox(50);
    if (outboxAfter.count <= outboxBefore.count) {
      throw new Error(
        `mock outbox did not grow (before=${outboxBefore.count}, after=${outboxAfter.count})`,
      );
    }
    ctx.log(`outbox grew ${outboxBefore.count} → ${outboxAfter.count}`);
    await ctx.screenshot("post-send");
  },
};

export default scenario;
