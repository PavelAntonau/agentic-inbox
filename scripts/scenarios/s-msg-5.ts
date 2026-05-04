// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-MSG-5 — Mock-inject inbound email.
 *
 * Branches covered: POST /__mock/inbox synthesizes an email via receiveEmail
 * (workers/index.ts:544) → DO appends to INBOX folder → the email surfaces in
 * GET /api/v1/mailboxes/:id/emails?folder=inbox.
 *
 * Precondition: the recipient mailbox MUST exist in R2 (`mailboxes/<addr>.json`)
 * because receiveEmail short-circuits with "mailbox does not exist" otherwise
 * (workers/index.ts:582 — env.BUCKET.head check). We seed via /api/v1/mailboxes
 * POST.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

const scenario: Scenario = {
  id: "S-MSG-5",
  description: "Inject an inbound email and observe it land in INBOX",
  covers: "POST /__mock/inbox → receiveEmail → DO INBOX folder → v1 GET",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // Per-run unique recipient — `/__mock/reset` doesn't drop R2 mailbox
    // keys, so a re-used address would 409 on re-seed and the resulting
    // "Failed to load resource: 409" console error would fail the
    // post-inject console assertion.
    const recipientEmail = `inbound-target-${Date.now()}@actionnow.ai`;
    const senderExternal = "outsider@example.org";

    // Seed the recipient mailbox in R2 so receiveEmail's BUCKET.head check passes.
    await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Inbound Target', email: ${JSON.stringify(recipientEmail)} }),
        });
        if (!res.ok) {
          throw new Error('v1 seed failed: ' + res.status + ' ' + (await res.text()));
        }
        return true;
      })()`,
    });

    const mid = encodeURIComponent(recipientEmail);

    // Capture pre-state — INBOX should be empty for this freshly-seeded mailbox.
    const preResult = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/${mid}/emails?folder=inbox');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (preResult.status >= 300) {
      throw new Error(
        `pre-fetch INBOX returned ${preResult.status}: ${preResult.body.slice(0, 200)}`,
      );
    }
    const preParsed = JSON.parse(preResult.body) as
      | Array<{ id: string }>
      | { emails?: Array<{ id: string }> };
    const preEmails = Array.isArray(preParsed)
      ? preParsed
      : (preParsed.emails ?? []);
    ctx.log(`INBOX pre-inject count = ${preEmails.length}`);
    await ctx.screenshot("pre-inject");

    // Inject inbound via /__mock/inbox.
    const subject = `S-MSG-5 inbound ${Date.now()}`;
    await ctx.mock.injectInbound({
      to: recipientEmail,
      from: senderExternal,
      subject,
      body: "this is the synthesized inbound body",
    });
    ctx.log(`POST /__mock/inbox → injected (to=${recipientEmail})`);

    // Poll INBOX for the new email — the inject is sync, but allow a brief
    // window for the DO's createEmail to commit before the read.
    const deadline = Date.now() + 5_000;
    let postEmails: Array<{
      id: string;
      subject?: string | null;
      sender?: string | null;
    }> = [];
    while (Date.now() < deadline) {
      const r = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const res = await fetch('/api/v1/mailboxes/${mid}/emails?folder=inbox');
          return { status: res.status, body: await res.text() };
        })()`,
      })) as { status: number; body: string };
      if (r.status < 300) {
        const parsed = JSON.parse(r.body) as
          | Array<{
              id: string;
              subject?: string | null;
              sender?: string | null;
            }>
          | {
              emails?: Array<{
                id: string;
                subject?: string | null;
                sender?: string | null;
              }>;
            };
        postEmails = Array.isArray(parsed) ? parsed : (parsed.emails ?? []);
        if (postEmails.length > preEmails.length) break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (postEmails.length <= preEmails.length) {
      throw new Error(
        `INBOX did not grow after inject (pre=${preEmails.length}, post=${postEmails.length})`,
      );
    }
    ctx.log(
      `INBOX post-inject count = ${postEmails.length} (grew by ${postEmails.length - preEmails.length})`,
    );

    // Validate the injected email's metadata. receiveEmail lower-cases
    // recipients and senders.
    const match = postEmails.find(
      (e) =>
        e.subject === subject &&
        (e.sender ?? "").toLowerCase() === senderExternal.toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `injected email not found by subject+sender; got ${postEmails
          .map((e) => `${e.id}(${e.subject ?? ""}|${e.sender ?? ""})`)
          .join(", ")}`,
      );
    }
    ctx.log(`injected email found: id=${match.id} subject="${match.subject}"`);
    await ctx.screenshot("post-inject");

    const console = await ctx.captureConsole("after-inject");
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) after inject (see ${console.path})`,
      );
    }
  },
};

export default scenario;
