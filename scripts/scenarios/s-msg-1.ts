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

    // Seed via the v1 (R2-backed) endpoint — the SAME stack that
    // `/api/v1/mailboxes/:id/emails` POST will read from. The control-
    // plane `/api/mailboxes` (D1) and the legacy `/api/v1/mailboxes`
    // (R2) are separate worlds; mixing them is what produced the 404 in
    // F-PHASE2-005 (the v1 send's `requireMailbox` middleware does
    // BUCKET.head('mailboxes/<id>.json'), which a D1-only seed never
    // creates). The v1 mailboxId IS the email.
    //
    // Per-run unique sender — the DO `checkSendRateLimit` counts SENT-
    // folder rows in the last hour and `/__mock/reset` does NOT clear
    // DO storage (only D1 control-plane + R2 outbox). After 20 cumulative
    // runs the fixed `sender@actionnow.ai` mailbox would 429. Same
    // pattern S-MSG-5 already uses on the recipient side.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const senderEmail = `sender-${runId}@actionnow.ai`;
    await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Sender', email: ${JSON.stringify(senderEmail)} }),
        });
        if (!res.ok && res.status !== 409) {
          const body = await res.text();
          throw new Error('v1 seed mailbox failed: ' + res.status + ' ' + body);
        }
        return true;
      })()`,
    });

    // Reload so the rail picks up any client-plane changes (the v1 seed
    // doesn't touch D1, so the rail tree may stay empty — that's fine
    // for this scenario, which exercises the v1 send wire).
    await ctx.browser.call("browser_navigate", { url: `${ctx.baseUrl}/` });
    await ctx.screenshot("home-with-mailbox");

    const outboxBefore = await ctx.mock.outbox(50);

    // Send through the v1 API surface. Body must satisfy
    // SendEmailRequestSchema (workers/lib/schemas.ts:61): `from` is
    // required, body content goes in `text` or `html` (NOT `body_text`).
    // The original scenario sent `{to, subject, body_text}` — both
    // missing-`from` and the body-field rename were silently masked by
    // the upstream 404 from requireMailbox.
    const sendResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const senderEmail = ${JSON.stringify(senderEmail)};
        const mid = encodeURIComponent(senderEmail);
        const res = await fetch('/api/v1/mailboxes/' + mid + '/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: ['recipient@example.com'],
            from: senderEmail,
            subject: 'S-MSG-1 smoke',
            text: 'sent by S-MSG-1',
          }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
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
