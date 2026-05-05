// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-MSG-USER-TO-USER-1 — full inter-user delivery + reply round-trip.
 *
 * The user's directive (2026-05-05) requires the autonomous suite to
 * exercise "the complete end-to-end procedure, including user login and
 * sending messages to each other". S-MSG-1/2/3/5 each test ONE wire of
 * the messaging stack in isolation against `recipient@example.com`; this
 * scenario runs the actual cross-user happy path: alice signs in, both
 * mailboxes get provisioned, alice sends to bob, the message lands in
 * bob's INBOX, bob replies, alice's INBOX receives the reply, and her
 * SENT folder shows the original.
 *
 * The local-loopback fix in `workers/lib/mocks/email-binding.ts`
 * (commit 524f383) is what makes this work — without it, the v1 send
 * only wrote to the R2 outbox and bob's INBOX was always empty in
 * MOCK_MODE. This scenario locks that wire so a future regression of
 * the binding short-circuits the suite immediately.
 *
 * Branches covered:
 *   - dev-picker login (alice)
 *   - mailbox provisioning via /api/v1/mailboxes (both users)
 *   - /api/v1/mailboxes/:id/emails POST sender path
 *   - mockEmailBinding outbox-write + local-loopback to receiveEmail
 *   - bob's DO INBOX listing via /api/v1/mailboxes/:id/emails?folder=inbox
 *   - reply round-trip via /emails/:id/reply
 *   - alice's INBOX surfaces the reply
 *   - alice's SENT surfaces the original (recipient field populated)
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface SeededUser {
  id: string;
  email: string;
}

const scenario: Scenario = {
  id: "S-MSG-USER-TO-USER-1",
  description: "Alice and Bob exchange messages end-to-end (send + reply)",
  covers:
    "login → provision two mailboxes → alice→bob send → local loopback to bob's INBOX → bob reply → alice's INBOX surfaces reply",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // Seed bob as a real user so impersonate works on the cookie path.
    const seedBob = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(TEST_USERS.bob)}, display_name: 'Bob Builder' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (seedBob.status >= 300) {
      throw new Error(
        `seed-user(bob) failed: ${seedBob.status} ${seedBob.body.slice(0, 200)}`,
      );
    }
    const bobUser = JSON.parse(seedBob.body) as SeededUser;
    ctx.log(`bob seeded: id=${bobUser.id}`);

    // Per-run unique addresses so DO state from prior cycles doesn't
    // bleed in (mirrors S-MSG-1's runId pattern).
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const aliceMb = `s-msg-u2u-1-alice-${runId}@actionnow.ai`;
    const bobMb = `s-msg-u2u-1-bob-${runId}@actionnow.ai`;

    // Provision alice's v1 mailbox while alice is the actor.
    const mkAlice = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Alice', email: ${JSON.stringify(aliceMb)} }),
        });
        return { status: res.status, body: (await res.text()).slice(0, 200) };
      })()`,
    })) as { status: number; body: string };
    if (mkAlice.status !== 201) {
      throw new Error(
        `alice mailbox create expected 201, got ${mkAlice.status}: ${mkAlice.body}`,
      );
    }
    ctx.log(`alice mailbox ${aliceMb} provisioned ✓`);

    // Switch to bob and provision his mailbox.
    await impersonate(ctx, TEST_USERS.bob);
    const mkBob = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Bob', email: ${JSON.stringify(bobMb)} }),
        });
        return { status: res.status, body: (await res.text()).slice(0, 200) };
      })()`,
    })) as { status: number; body: string };
    if (mkBob.status !== 201) {
      throw new Error(
        `bob mailbox create expected 201, got ${mkBob.status}: ${mkBob.body}`,
      );
    }
    ctx.log(`bob mailbox ${bobMb} provisioned ✓`);

    // Back to alice, send to bob.
    await impersonate(ctx, TEST_USERS.alice);
    const subject = `S-MSG-U2U-1 hello bob ${runId}`;
    const send = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/' + encodeURIComponent(${JSON.stringify(aliceMb)}) + '/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: [${JSON.stringify(bobMb)}], from: ${JSON.stringify(aliceMb)},
            subject: ${JSON.stringify(subject)},
            text: 'Hello Bob — sent by S-MSG-USER-TO-USER-1.',
          }),
        });
        return { status: res.status, body: (await res.text()).slice(0, 200) };
      })()`,
    })) as { status: number; body: string };
    if (send.status !== 202) {
      throw new Error(
        `alice→bob send expected 202, got ${send.status}: ${send.body}`,
      );
    }
    ctx.log(`alice→bob send → 202 ✓`);
    await ctx.screenshot("alice-sent");

    // Switch to bob, confirm INBOX has the message.
    await impersonate(ctx, TEST_USERS.bob);
    // Tiny settle for the deferred receiveEmail (waitUntil).
    await new Promise((r) => setTimeout(r, 500));
    const bobInbox = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/' + encodeURIComponent(${JSON.stringify(bobMb)}) + '/emails?folder=inbox');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bobInbox.status !== 200) {
      throw new Error(
        `bob INBOX list expected 200, got ${bobInbox.status}: ${bobInbox.body.slice(0, 200)}`,
      );
    }
    const bobInboxBody = JSON.parse(bobInbox.body) as {
      emails: Array<{ id: string; subject: string; sender: string }>;
      totalCount: number;
    };
    const inboxMsg = bobInboxBody.emails.find((e) => e.subject === subject);
    if (!inboxMsg) {
      throw new Error(
        `bob INBOX missing subject "${subject}" — local loopback regression? totalCount=${bobInboxBody.totalCount}`,
      );
    }
    if (inboxMsg.sender !== aliceMb) {
      throw new Error(
        `bob INBOX message sender expected ${aliceMb}, got ${inboxMsg.sender}`,
      );
    }
    ctx.log(`bob INBOX surfaces alice's message id=${inboxMsg.id} ✓`);
    await ctx.screenshot("bob-inbox");

    // Bob replies via the v1 reply endpoint.
    const replySubject = `Re: ${subject}`;
    const reply = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const url = '/api/v1/mailboxes/' + encodeURIComponent(${JSON.stringify(bobMb)}) +
          '/emails/' + ${JSON.stringify(inboxMsg.id)} + '/reply';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: ${JSON.stringify(bobMb)}, to: [${JSON.stringify(aliceMb)}],
            subject: ${JSON.stringify(replySubject)},
            text: 'Hi Alice — got it!',
          }),
        });
        return { status: res.status, body: (await res.text()).slice(0, 200) };
      })()`,
    })) as { status: number; body: string };
    if (reply.status !== 202) {
      throw new Error(
        `bob→alice reply expected 202, got ${reply.status}: ${reply.body}`,
      );
    }
    ctx.log(`bob→alice reply → 202 ✓`);

    // Switch to alice, verify reply landed in her INBOX and original is in SENT.
    await impersonate(ctx, TEST_USERS.alice);
    await new Promise((r) => setTimeout(r, 500));

    const aliceInbox = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/' + encodeURIComponent(${JSON.stringify(aliceMb)}) + '/emails?folder=inbox');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const aliceInboxBody = JSON.parse(aliceInbox.body) as {
      emails: Array<{ id: string; subject: string; sender: string }>;
      totalCount: number;
    };
    const replyMsg = aliceInboxBody.emails.find(
      (e) => e.subject === replySubject,
    );
    if (!replyMsg) {
      throw new Error(
        `alice INBOX missing reply "${replySubject}" — totalCount=${aliceInboxBody.totalCount}`,
      );
    }
    if (replyMsg.sender !== bobMb) {
      throw new Error(
        `alice INBOX reply sender expected ${bobMb}, got ${replyMsg.sender}`,
      );
    }
    ctx.log(`alice INBOX surfaces bob's reply id=${replyMsg.id} ✓`);

    const aliceSent = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/' + encodeURIComponent(${JSON.stringify(aliceMb)}) + '/emails?folder=sent');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const aliceSentBody = JSON.parse(aliceSent.body) as {
      emails: Array<{ subject: string; recipient: string | null }>;
    };
    const sentMsg = aliceSentBody.emails.find((e) => e.subject === subject);
    if (!sentMsg) {
      throw new Error(
        `alice SENT missing original "${subject}" — emails=${aliceSentBody.emails.length}`,
      );
    }
    if (!sentMsg.recipient || !sentMsg.recipient.includes(bobMb)) {
      throw new Error(
        `alice SENT recipient field empty/wrong (got ${JSON.stringify(sentMsg.recipient)}) — recipient persistence regression?`,
      );
    }
    ctx.log(`alice SENT shows original with recipient=${sentMsg.recipient} ✓`);
    await ctx.screenshot("alice-inbox-with-reply");
  },
};

async function impersonate(
  ctx: Parameters<Scenario["run"]>[0],
  email: string,
): Promise<void> {
  const res = (await ctx.browser.call("browser_evaluate", {
    expression: `(async () => {
      const res = await fetch('/__mock/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ${JSON.stringify(email)} }),
      });
      return { status: res.status, body: (await res.text()).slice(0, 200) };
    })()`,
  })) as { status: number; body: string };
  if (res.status !== 200) {
    throw new Error(`impersonate(${email}) ${res.status}: ${res.body}`);
  }
  ctx.log(`impersonate → ${email} ✓`);
}

export default scenario;
