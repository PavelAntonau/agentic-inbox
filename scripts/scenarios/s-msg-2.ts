// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-MSG-2 — Reply to an email (v1 in_reply_to threading).
 *
 * Branches covered: send initial email A via v1 → send reply B with
 * `in_reply_to`/`references`/`thread_id` set to A → both emails surface in
 * GET /api/v1/mailboxes/:id/emails?thread_id=<A> with B.in_reply_to == A.
 *
 * Scope note (architectural finding surfaced by this scenario):
 *
 *   The DO threads table (workers/durableObject:987 createThread) is NOT
 *   populated by either send (workers/index.ts:259) or receive (:640) — both
 *   call `createEmail` which only inserts into the `emails` table. The
 *   threads.ts CAS reply API (POST /api/mailboxes/:mid/threads/:tid/messages)
 *   therefore has no live threads to operate on through current product wires.
 *   Recorded as F-PHASE3-003 for follow-up. This scenario exercises the
 *   v1 email-level threading that real users get today.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

const scenario: Scenario = {
  id: "S-MSG-2",
  description: "Reply to an email via v1 in_reply_to threading",
  covers: "v1 send + v1 reply → same thread_id, in_reply_to set",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // Per-run unique sender — `/__mock/reset` doesn't drop R2 mailbox
    // keys, so re-using the same address would 409 on re-seed and the
    // browser-logged "Failed to load resource: 409" would fail the
    // post-reply console assertion when the suite runs twice in a row
    // (or when a prior scenario seeded the same address).
    const senderEmail = `thread-sender-${Date.now()}@actionnow.ai`;

    // Seed v1 mailbox so /api/v1/mailboxes/:id/emails passes requireMailbox.
    await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Thread Sender', email: ${JSON.stringify(senderEmail)} }),
        });
        if (!res.ok) {
          throw new Error('v1 seed failed: ' + res.status + ' ' + (await res.text()));
        }
        return true;
      })()`,
    });

    const mid = encodeURIComponent(senderEmail);
    const recipient = "thread-recipient@example.com";

    // 1. Send the initial email A. Body satisfies SendEmailRequestSchema.
    const aResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/${mid}/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: [${JSON.stringify(recipient)}],
            from: ${JSON.stringify(senderEmail)},
            subject: 'S-MSG-2 — initial',
            text: 'first message',
          }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (aResult.status >= 300) {
      throw new Error(
        `send A returned ${aResult.status}: ${aResult.body.slice(0, 200)}`,
      );
    }
    const a = JSON.parse(aResult.body) as { id: string; status: string };
    ctx.log(`A sent → id=${a.id}`);
    await ctx.screenshot("after-send-a");

    // 2. Send the reply B with in_reply_to=A.id, thread_id=A.id.
    const bResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/${mid}/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: [${JSON.stringify(recipient)}],
            from: ${JSON.stringify(senderEmail)},
            subject: 'Re: S-MSG-2 — initial',
            text: 'this is the reply',
            in_reply_to: ${JSON.stringify(a.id)},
            references: [${JSON.stringify(a.id)}],
            thread_id: ${JSON.stringify(a.id)},
          }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bResult.status >= 300) {
      throw new Error(
        `send B (reply) returned ${bResult.status}: ${bResult.body.slice(0, 200)}`,
      );
    }
    const b = JSON.parse(bResult.body) as { id: string; status: string };
    ctx.log(`B sent (reply to ${a.id}) → id=${b.id}`);
    if (b.id === a.id) {
      throw new Error(
        `reply id collided with original — both = ${a.id}; expected distinct ids`,
      );
    }
    await ctx.screenshot("after-send-b");

    // 3. Fetch the thread (filter by thread_id=A.id) — both A and B should appear.
    const threadResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/${mid}/emails?thread_id=' + encodeURIComponent(${JSON.stringify(a.id)}));
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (threadResult.status >= 300) {
      throw new Error(
        `thread fetch returned ${threadResult.status}: ${threadResult.body.slice(0, 200)}`,
      );
    }
    const parsed = JSON.parse(threadResult.body) as
      | Array<{
          id: string;
          in_reply_to?: string | null;
          thread_id?: string | null;
        }>
      | {
          emails?: Array<{
            id: string;
            in_reply_to?: string | null;
            thread_id?: string | null;
          }>;
        };
    const emails = Array.isArray(parsed) ? parsed : (parsed.emails ?? []);
    ctx.log(`thread emails fetched: ${emails.length}`);

    const aRow = emails.find((e) => e.id === a.id);
    const bRow = emails.find((e) => e.id === b.id);
    if (!aRow) {
      throw new Error(
        `original (A=${a.id}) missing from thread fetch; got ${emails.length} emails: ${emails.map((e) => e.id).join(",")}`,
      );
    }
    if (!bRow) {
      throw new Error(
        `reply (B=${b.id}) missing from thread fetch; got ${emails.length} emails: ${emails.map((e) => e.id).join(",")}`,
      );
    }
    if (bRow.in_reply_to !== a.id) {
      throw new Error(
        `B.in_reply_to expected ${a.id}, got ${bRow.in_reply_to ?? "null"}`,
      );
    }
    if (bRow.thread_id !== a.id) {
      throw new Error(
        `B.thread_id expected ${a.id}, got ${bRow.thread_id ?? "null"}`,
      );
    }
    ctx.log(
      `thread integrity ✓: B.in_reply_to=${bRow.in_reply_to} B.thread_id=${bRow.thread_id}`,
    );

    // 4. Both sends should land in the mock outbox (sent via stub waitUntil).
    const outbox = await ctx.mock.outbox(50);
    if (outbox.count < 2) {
      throw new Error(
        `outbox count after 2 sends = ${outbox.count}, expected ≥ 2`,
      );
    }
    ctx.log(`outbox count = ${outbox.count} (≥ 2 ✓)`);

    const console = await ctx.captureConsole("after-reply");
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) after reply (see ${console.path})`,
      );
    }
  },
};

export default scenario;
