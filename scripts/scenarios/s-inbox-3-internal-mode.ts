// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INBOX-3-INTERNAL-MODE — internal_inbound_mode='none' bounces internal senders.
 *
 * Branches covered:
 *   POST  /__mock/seed-user                                        (bootstrap a 2nd internal user)
 *   POST  /api/v1/mailboxes                                        (R2 mailbox key)
 *   POST  /api/mailboxes                                           (D1 row + policy)
 *   PATCH /api/mailboxes/:id/policies                              (internal_inbound_mode='none' / 'everyone')
 *   POST  /__mock/inbox                                            (3 inbound probes)
 *   GET   /api/v1/mailboxes/:addr/emails?folder=inbox              (count growth)
 *
 * receiveEmail (workers/index.ts, F-PHASE3-008) classifies senders by
 * users-table membership. An internal sender (lower(from.address) matches
 * a users row) is gated on internal_inbound_mode:
 *   • 'everyone' (default) — accept
 *   • 'none'               — bounce
 *   • 'contacts_only'      — accept iff contacts row exists
 *
 * Probes:
 *   1. mode='none' + internal sender (bob)            → INBOX does NOT grow.
 *   2. mode='none' + external sender (anywhere.test)  → INBOX DOES grow
 *      (external path unaffected; proves the gate fires only on internals).
 *   3. mode='everyone' + internal sender (bob)        → INBOX DOES grow
 *      (re-enable validates the gate is the cause, not some other bug).
 *
 * Same dual-side seed pattern as S-INBOX-3 (R2 v1 mailbox + D1 mailbox row).
 * Bob's users row is created via /__mock/seed-user — bootstrapOwner only
 * auto-promotes BOOTSTRAP_OWNER_EMAIL=alice, so bob has no auth path.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface CreatedMailboxD1 {
  id: string;
  address: string;
}

const scenario: Scenario = {
  id: "S-INBOX-3-INTERNAL-MODE",
  description:
    "internal_inbound_mode='none' bounces internal senders; externals unaffected; re-enable lets internals land",
  covers:
    "PATCH internal_inbound_mode=none → inject internal (bob) blocked → external still lands → re-enable everyone → bob lands",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const stamp = Date.now();
    const recipientAddress = `inbox3-int-${stamp}@actionnow.ai`;
    const internalSender = TEST_USERS.bob; // bob@actionnow.ai
    const externalSender = `outsider-${stamp}@anywhere.test`;
    const midForV1 = encodeURIComponent(recipientAddress);

    const fetchInboxCount = async (): Promise<number> => {
      const r = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const res = await fetch('/api/v1/mailboxes/${midForV1}/emails?folder=inbox');
          return { status: res.status, body: await res.text() };
        })()`,
      })) as { status: number; body: string };
      if (r.status >= 300) {
        throw new Error(
          `INBOX fetch failed: ${r.status} ${r.body.slice(0, 200)}`,
        );
      }
      const parsed = JSON.parse(r.body) as
        | Array<unknown>
        | { emails?: Array<unknown> };
      return Array.isArray(parsed)
        ? parsed.length
        : (parsed.emails?.length ?? 0);
    };

    const expectStableFor = async (
      label: string,
      baseline: number,
      windowMs: number,
    ): Promise<number> => {
      const deadline = Date.now() + windowMs;
      let last = baseline;
      while (Date.now() < deadline) {
        last = await fetchInboxCount();
        if (last > baseline) {
          throw new Error(
            `${label}: INBOX grew ${baseline} → ${last} despite mode=none gate`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return last;
    };

    const expectGrowsTo = async (
      label: string,
      baseline: number,
      windowMs: number,
    ): Promise<number> => {
      const deadline = Date.now() + windowMs;
      let cur = baseline;
      while (Date.now() < deadline) {
        cur = await fetchInboxCount();
        if (cur > baseline) return cur;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `${label}: INBOX still ${cur} after ${windowMs}ms (expected > ${baseline})`,
      );
    };

    // 1. Seed bob as a second internal user. Idempotent — 200/{id, ...}
    //    on duplicate. Direct INSERT via /__mock/seed-user because
    //    bootstrapOwner only auto-promotes BOOTSTRAP_OWNER_EMAIL.
    const seedBob = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(internalSender)}, role: 'user' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (seedBob.status >= 300) {
      throw new Error(
        `seed-user(bob) failed: ${seedBob.status} ${seedBob.body.slice(0, 200)}`,
      );
    }
    const bob = JSON.parse(seedBob.body) as {
      id: string;
      email: string;
      role: string;
    };
    ctx.log(`bob seeded: id=${bob.id}`);

    // 2. Seed R2 (v1) mailbox so receiveEmail's BUCKET.head passes.
    const v1Seed = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Inbox-3 InternalMode Target', email: ${JSON.stringify(recipientAddress)} }),
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

    // 3. Seed D1 mailbox row (alice owns it, owner_user_id is alice's id).
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

    // 4. PATCH internal_inbound_mode='none'.
    const patchNone = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${d1Mailbox.id}/policies', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ internal_inbound_mode: 'none' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (patchNone.status !== 200) {
      throw new Error(
        `PATCH internal_inbound_mode=none returned ${patchNone.status}: ${patchNone.body.slice(0, 200)}`,
      );
    }
    const patchedNone = JSON.parse(patchNone.body) as {
      internal_inbound_mode: "everyone" | "contacts_only" | "none";
    };
    if (patchedNone.internal_inbound_mode !== "none") {
      throw new Error(
        `expected internal_inbound_mode=none post-PATCH, got ${patchedNone.internal_inbound_mode}`,
      );
    }
    ctx.log(`policy: internal_inbound_mode=none ✓`);

    const baseline = await fetchInboxCount();
    ctx.log(`baseline INBOX count=${baseline}`);

    // 5. Probe: internal sender (bob) — INBOX must NOT grow.
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: internalSender,
      subject: `S-INBOX-3-INTERNAL-MODE bob-blocked ${stamp}`,
      body: "internal sender bob, mode=none",
    });
    const afterBob = await expectStableFor(
      "internal=bob blocked",
      baseline,
      2_000,
    );
    ctx.log(
      `internal sender ${internalSender} → INBOX still ${afterBob} (mode=none) ✓`,
    );

    // 6. Probe: external sender — INBOX MUST grow (external path unaffected).
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: externalSender,
      subject: `S-INBOX-3-INTERNAL-MODE external-allowed ${stamp}`,
      body: "external sender, mode=none affects internals only",
    });
    const afterExternal = await expectGrowsTo(
      "external sender lands",
      afterBob,
      5_000,
    );
    ctx.log(
      `external sender ${externalSender} → INBOX grew ${afterBob} → ${afterExternal} (proves gate is internal-only) ✓`,
    );
    await ctx.screenshot("after-mode-none");

    // 7. Re-enable: PATCH internal_inbound_mode='everyone' — bob lands.
    const patchEveryone = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${d1Mailbox.id}/policies', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ internal_inbound_mode: 'everyone' }),
        });
        return { status: res.status };
      })()`,
    })) as { status: number };
    if (patchEveryone.status !== 200) {
      throw new Error(
        `PATCH internal_inbound_mode=everyone returned ${patchEveryone.status}`,
      );
    }
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: internalSender,
      subject: `S-INBOX-3-INTERNAL-MODE bob-allowed ${stamp}`,
      body: "internal sender bob, mode=everyone",
    });
    const afterReEnable = await expectGrowsTo(
      "internal=bob lands after re-enable",
      afterExternal,
      5_000,
    );
    ctx.log(
      `re-enable verified: INBOX grew ${afterExternal} → ${afterReEnable} (bob lands) ✓`,
    );

    const consoleSummary = await ctx.captureConsole("after-reenable");
    if (consoleSummary.errors > 0) {
      throw new Error(
        `${consoleSummary.errors} console error(s) (see ${consoleSummary.path})`,
      );
    }
  },
};

export default scenario;
