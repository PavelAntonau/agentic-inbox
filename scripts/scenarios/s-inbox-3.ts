// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INBOX-3 — external_inbound_enabled disabled bounces inbound mail.
 *
 * Branches covered:
 *   POST  /api/v1/mailboxes                            (R2 mailbox key — required for receiveEmail)
 *   POST  /api/mailboxes                               (D1 row — carries the policy)
 *   PATCH /api/mailboxes/:id/policies                  (set external_inbound_enabled=false)
 *   POST  /__mock/inbox                                (synthesize an inbound email)
 *   GET   /api/v1/mailboxes/:addr/emails?folder=inbox  (verify INBOX did NOT grow)
 *
 * receiveEmail (workers/index.ts) gates on the D1 mailbox.external_inbound_enabled
 * column (introduced by migration 0007 + this scenario's product fix). When a D1
 * row exists for the recipient address and the column is false, the email is
 * silently bounced (logged + early return). v1-only mailboxes (R2 key, no D1 row)
 * keep their legacy always-accept behaviour to avoid breaking address callers
 * that predate the policy table.
 *
 * The seed flow uses BOTH POST /api/v1/mailboxes (R2 side) AND POST /api/mailboxes
 * (D1 side) at the SAME address. v1-only mailboxes wouldn't trigger the policy
 * lookup; D1-only mailboxes wouldn't pass the BUCKET.head check at receiveEmail.
 * Per-run-unique address dodges the R2 re-seed 409 / D1 unique-address 409.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface CreatedMailboxD1 {
  id: string;
  address: string;
}

const scenario: Scenario = {
  id: "S-INBOX-3",
  description:
    "External inbound disabled → /__mock/inbox bounced (no INBOX growth)",
  covers:
    "PATCH external_inbound_enabled=false → POST /__mock/inbox → INBOX unchanged",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const stamp = Date.now();
    const recipientAddress = `inbox3-target-${stamp}@actionnow.ai`;
    const senderExternal = "outsider@example.org";
    const midForV1 = encodeURIComponent(recipientAddress);

    // 1. Seed R2 mailbox key so receiveEmail's BUCKET.head passes.
    const v1Seed = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Inbox-3 Target', email: ${JSON.stringify(recipientAddress)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (v1Seed.status >= 300) {
      throw new Error(
        `v1 mailbox seed failed: ${v1Seed.status} ${v1Seed.body.slice(0, 200)}`,
      );
    }
    ctx.log(`v1 R2 mailbox seeded`);

    // 2. Seed D1 mailbox row so the policy lookup hits.
    const d1Seed = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: ${JSON.stringify(recipientAddress)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (d1Seed.status !== 201) {
      throw new Error(
        `D1 mailbox seed failed: ${d1Seed.status} ${d1Seed.body.slice(0, 200)}`,
      );
    }
    const d1Mailbox = JSON.parse(d1Seed.body) as CreatedMailboxD1;
    ctx.log(`D1 mailbox seeded id=${d1Mailbox.id}`);

    // 3. PATCH the policy to disable external inbound.
    const patch = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${d1Mailbox.id}/policies', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ external_inbound_enabled: false }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (patch.status !== 200) {
      throw new Error(
        `PATCH policies returned ${patch.status}: ${patch.body.slice(0, 200)}`,
      );
    }
    const patched = JSON.parse(patch.body) as {
      external_inbound_enabled: boolean;
    };
    if (patched.external_inbound_enabled !== false) {
      throw new Error(
        `expected external_inbound_enabled=false post-PATCH, got ${patched.external_inbound_enabled}`,
      );
    }
    ctx.log(`policy: external_inbound_enabled=false ✓`);

    // 4. Capture INBOX baseline (must be 0 for a freshly-seeded mailbox).
    const preRes = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/${midForV1}/emails?folder=inbox');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (preRes.status >= 300) {
      throw new Error(
        `pre-inject INBOX fetch failed: ${preRes.status} ${preRes.body.slice(0, 200)}`,
      );
    }
    const preParsed = JSON.parse(preRes.body) as
      | Array<unknown>
      | { emails?: Array<unknown> };
    const preCount = Array.isArray(preParsed)
      ? preParsed.length
      : (preParsed.emails?.length ?? 0);
    ctx.log(`pre-inject INBOX count=${preCount}`);
    await ctx.screenshot("pre-inject");

    // 5. Inject inbound — receiveEmail must short-circuit on the policy gate.
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: senderExternal,
      subject: `S-INBOX-3 should-be-bounced ${stamp}`,
      body: "this email should never land",
    });
    ctx.log(`POST /__mock/inbox → injection attempted`);

    // 6. Poll briefly to give the DO a chance to commit if (incorrectly) the
    //    bounce didn't fire. Then assert INBOX still empty.
    const deadline = Date.now() + 2_000;
    let postCount = 0;
    while (Date.now() < deadline) {
      const r = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const res = await fetch('/api/v1/mailboxes/${midForV1}/emails?folder=inbox');
          return { status: res.status, body: await res.text() };
        })()`,
      })) as { status: number; body: string };
      const parsed = JSON.parse(r.body) as
        | Array<unknown>
        | { emails?: Array<unknown> };
      postCount = Array.isArray(parsed)
        ? parsed.length
        : (parsed.emails?.length ?? 0);
      if (postCount > preCount) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (postCount > preCount) {
      throw new Error(
        `policy bounced ASSERTION FAILED — INBOX grew ${preCount} → ${postCount} despite external_inbound_enabled=false`,
      );
    }
    ctx.log(
      `INBOX still ${postCount} after inject (pre=${preCount}) — bounce verified ✓`,
    );

    // 7. Re-enable policy and confirm a subsequent inject DOES land — proves
    //    the gate is the cause and the rest of the path still works.
    const reEnable = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${d1Mailbox.id}/policies', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ external_inbound_enabled: true }),
        });
        return { status: res.status };
      })()`,
    })) as { status: number };
    if (reEnable.status !== 200) {
      throw new Error(`re-enable PATCH returned ${reEnable.status}`);
    }
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: senderExternal,
      subject: `S-INBOX-3 should-land ${stamp}`,
      body: "this email should land after re-enable",
    });

    const reDeadline = Date.now() + 5_000;
    let reCount = 0;
    while (Date.now() < reDeadline) {
      const r = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const res = await fetch('/api/v1/mailboxes/${midForV1}/emails?folder=inbox');
          return { status: res.status, body: await res.text() };
        })()`,
      })) as { status: number; body: string };
      const parsed = JSON.parse(r.body) as
        | Array<unknown>
        | { emails?: Array<unknown> };
      reCount = Array.isArray(parsed)
        ? parsed.length
        : (parsed.emails?.length ?? 0);
      if (reCount > preCount) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (reCount <= preCount) {
      throw new Error(
        `re-enable failed — INBOX still ${reCount} (pre=${preCount}); the gate may now be over-blocking`,
      );
    }
    ctx.log(`re-enable verified: INBOX grew ${preCount} → ${reCount} ✓`);
    await ctx.screenshot("post-reenable");

    const console = await ctx.captureConsole("after-reenable");
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) (see ${console.path})`,
      );
    }
  },
};

export default scenario;
