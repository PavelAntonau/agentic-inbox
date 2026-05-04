// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-MSG-3 — Forward an inbound email via v1.
 *
 * Branches covered:
 *   POST /api/v1/mailboxes                                                (seed v1 mailbox)
 *   POST /__mock/inbox                                                    (synthesize inbound)
 *   GET  /api/v1/mailboxes/:addr/emails?folder=inbox                      (locate inbound id)
 *   POST /api/v1/mailboxes/:addr/emails/:id/forward                       (forward — handleForwardEmail)
 *   GET  /api/v1/mailboxes/:addr/emails?folder=sent                       (forwarded msg in SENT)
 *   GET  /__mock/outbox                                                   (delivery side-effect recorded)
 *
 * handleForwardEmail (workers/routes/reply-forward.ts:145):
 *   - Loads the original email via DO stub.
 *   - validateSender requires `from === mailboxId` (i.e. the forwarder's
 *     own mailbox address). The "from" of a forward is always the mailbox
 *     owner, not the original sender — the forward is a NEW outgoing email.
 *   - Generates a new internal id + outgoing Message-ID.
 *   - Inserts into Folders.SENT with thread_id = messageId (forwards open
 *     a NEW thread; per the route's design they don't inherit the
 *     original's thread).
 *   - sendEmail() via waitUntil — lands in /__mock/outbox.
 *
 * Per-run-unique recipient address keeps the v1 R2 seed re-runnable across
 * /__mock/reset cycles.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface InboxEmailRow {
  id: string;
  subject: string;
  sender: string;
  thread_id: string;
}

const scenario: Scenario = {
  id: "S-MSG-3",
  description: "Forward an inbound email via v1 forward endpoint",
  covers:
    "v1 inbound seed → POST forward → SENT folder grows → outbox records delivery → new thread_id (forward opens a fresh thread)",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const stamp = Date.now();
    const recipientAddress = `msg3-mailbox-${stamp}@actionnow.ai`;
    const originalSender = `external-${stamp}@upstream.test`;
    const forwardTarget = `forward-target-${stamp}@downstream.test`;
    const midForV1 = encodeURIComponent(recipientAddress);

    // 1. Seed v1 mailbox so receiveEmail BUCKET.head passes AND so
    //    /api/v1/mailboxes/:id/emails resolves the mailbox.
    const v1Seed = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Forwarding Mailbox', email: ${JSON.stringify(recipientAddress)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (v1Seed.status >= 300) {
      throw new Error(
        `v1 seed failed: ${v1Seed.status} ${v1Seed.body.slice(0, 200)}`,
      );
    }
    ctx.log(`v1 R2 mailbox seeded at ${recipientAddress}`);

    // 2. Inject an inbound email — lands in INBOX (no D1 row, so the
    //    F-PHASE3-006/007/008 gates are skipped — legacy always-accept).
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: originalSender,
      subject: `S-MSG-3 inbound to forward ${stamp}`,
      body: "this email will be forwarded",
    });
    ctx.log(`inbound injected from ${originalSender}`);

    // 3. Poll INBOX until the inbound shows up (DO write is async).
    const fetchInbox = async (): Promise<InboxEmailRow[]> => {
      const r = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const res = await fetch('/api/v1/mailboxes/${midForV1}/emails?folder=inbox');
          return { status: res.status, body: await res.text() };
        })()`,
      })) as { status: number; body: string };
      if (r.status >= 300) {
        throw new Error(`INBOX fetch ${r.status}: ${r.body.slice(0, 200)}`);
      }
      const parsed = JSON.parse(r.body) as
        | InboxEmailRow[]
        | { emails?: InboxEmailRow[] };
      return Array.isArray(parsed) ? parsed : (parsed.emails ?? []);
    };

    let inbound: InboxEmailRow | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const inbox = await fetchInbox();
      inbound = inbox.find((e) =>
        e.subject?.includes(`S-MSG-3 inbound to forward ${stamp}`),
      );
      if (inbound) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!inbound) {
      throw new Error(`inbound email did not land within 5s`);
    }
    ctx.log(`inbound id=${inbound.id} thread_id=${inbound.thread_id}`);

    const initialOutbox = await ctx.mock.outbox(50);
    const baselineOutbox = initialOutbox.count;

    // 4. POST forward — validateSender requires from === mailboxId.
    const fwResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/${midForV1}/emails/${inbound.id}/forward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: [${JSON.stringify(forwardTarget)}],
            from: ${JSON.stringify(recipientAddress)},
            subject: 'Fwd: S-MSG-3 inbound to forward ${stamp}',
            text: 'forwarded body, see attached original',
          }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (fwResult.status !== 202) {
      throw new Error(
        `POST forward returned ${fwResult.status}: ${fwResult.body.slice(0, 200)}`,
      );
    }
    const forwarded = JSON.parse(fwResult.body) as {
      id: string;
      status: string;
    };
    if (forwarded.id === inbound.id) {
      throw new Error(
        `forward id collided with original — both = ${inbound.id}`,
      );
    }
    if (forwarded.status !== "sent") {
      throw new Error(
        `forward status expected 'sent', got '${forwarded.status}'`,
      );
    }
    ctx.log(`forward sent: id=${forwarded.id} status=${forwarded.status}`);
    await ctx.screenshot("after-forward");

    // 5. The forwarded email must surface in SENT.
    const sentResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/${midForV1}/emails?folder=sent');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (sentResult.status >= 300) {
      throw new Error(
        `SENT fetch ${sentResult.status}: ${sentResult.body.slice(0, 200)}`,
      );
    }
    const sentParsed = JSON.parse(sentResult.body) as
      | InboxEmailRow[]
      | { emails?: InboxEmailRow[] };
    const sentEmails = Array.isArray(sentParsed)
      ? sentParsed
      : (sentParsed.emails ?? []);
    const sentRow = sentEmails.find((e) => e.id === forwarded.id);
    if (!sentRow) {
      throw new Error(
        `forwarded email ${forwarded.id} missing from SENT (got ${sentEmails.length} rows)`,
      );
    }
    // Forwards open a NEW thread (handleForwardEmail sets thread_id =
    // messageId of the new outgoing email).
    if (sentRow.thread_id !== forwarded.id) {
      throw new Error(
        `forward thread_id expected ${forwarded.id} (own id, fresh thread), got ${sentRow.thread_id}`,
      );
    }
    ctx.log(
      `forward in SENT, fresh thread_id=${sentRow.thread_id} (≠ original thread ${inbound.thread_id}) ✓`,
    );

    // 6. Outbox should reflect the deferred sendEmail. The waitUntil may
    //    settle slightly after the route returns, so poll briefly.
    const outboxDeadline = Date.now() + 3_000;
    let outboxCount = baselineOutbox;
    while (Date.now() < outboxDeadline) {
      const ob = await ctx.mock.outbox(50);
      outboxCount = ob.count;
      if (outboxCount > baselineOutbox) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (outboxCount <= baselineOutbox) {
      throw new Error(
        `outbox did not grow after forward (still ${outboxCount}, baseline ${baselineOutbox})`,
      );
    }
    ctx.log(
      `outbox grew ${baselineOutbox} → ${outboxCount} (deferred sendEmail recorded) ✓`,
    );

    const consoleSummary = await ctx.captureConsole("after-forward");
    if (consoleSummary.errors > 0) {
      throw new Error(
        `${consoleSummary.errors} console error(s) (see ${consoleSummary.path})`,
      );
    }
  },
};

export default scenario;
