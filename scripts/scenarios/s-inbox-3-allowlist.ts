// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INBOX-3-ALLOWLIST — external_allow_mode='allowlist' filters senders.
 *
 * Branches covered:
 *   POST   /api/v1/mailboxes                                     (R2 mailbox key)
 *   POST   /api/mailboxes                                        (D1 row + policy)
 *   PATCH  /api/mailboxes/:id/policies                           (mode='allowlist')
 *   POST   /api/mailboxes/:id/policies/allowlist                 (kind='email' entry)
 *   POST   /api/mailboxes/:id/policies/allowlist                 (kind='domain' entry)
 *   POST   /__mock/inbox                                         (3 inbound probes: blocked, email-match, domain-match)
 *   GET    /api/v1/mailboxes/:addr/emails?folder=inbox           (count growth)
 *
 * receiveEmail (workers/index.ts) gates on:
 *   1. external_inbound_enabled (F-PHASE3-006)
 *   2. external_allow_mode='allowlist' → match against inbox_external_allowlist
 *      • kind='email'  : sender_pattern === lower(from.address)
 *      • kind='domain' : sender's domain (after the '@') === sender_pattern
 *
 * Sister scenario to S-INBOX-3 (external_inbound_enabled). Same dual-side
 * seed pattern (R2 v1 mailbox + D1 mailbox row) is required because the
 * BUCKET.head check still runs first, and the policy lookup hits the D1
 * row.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface CreatedMailboxD1 {
  id: string;
  address: string;
}

interface AllowlistEntry {
  id: string;
  inbox_id: string;
  sender_pattern: string;
  kind: "email" | "domain";
  created_at: number;
}

const scenario: Scenario = {
  id: "S-INBOX-3-ALLOWLIST",
  description:
    "external_allow_mode='allowlist' bounces non-matching senders; allows email + domain matches",
  covers:
    "PATCH allow_mode=allowlist → POST allowlist email + domain → 3 inject probes (block, email-match, domain-match) → re-set 'all' = arbitrary external lands",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const stamp = Date.now();
    const recipientAddress = `inbox3-al-${stamp}@actionnow.ai`;
    const allowedEmail = `ally-${stamp}@trusted.test`;
    const blockedEmail = `spammer-${stamp}@evil.test`;
    const allowedDomain = `friends-${stamp}.test`;
    const allowedDomainSender = `someone-${stamp}@${allowedDomain}`;
    const arbitraryExternal = `random-${stamp}@anywhere.test`;
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
            `${label}: INBOX grew ${baseline} → ${last} despite allowlist block`,
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

    // 1. Seed R2 (v1) mailbox so receiveEmail's BUCKET.head passes.
    const v1Seed = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Inbox-3 Allowlist Target', email: ${JSON.stringify(recipientAddress)} }),
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

    // 2. Seed D1 mailbox row.
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

    // 3. PATCH external_allow_mode → 'allowlist'.
    const patchMode = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${d1Mailbox.id}/policies', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ external_allow_mode: 'allowlist' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (patchMode.status !== 200) {
      throw new Error(
        `PATCH allow_mode returned ${patchMode.status}: ${patchMode.body.slice(0, 200)}`,
      );
    }
    const patched = JSON.parse(patchMode.body) as {
      external_allow_mode: "all" | "allowlist";
    };
    if (patched.external_allow_mode !== "allowlist") {
      throw new Error(
        `expected external_allow_mode=allowlist post-PATCH, got ${patched.external_allow_mode}`,
      );
    }
    ctx.log(`policy: external_allow_mode=allowlist ✓`);

    // 4. Add allowlist entries (email + domain).
    const addEntry = async (
      sender_pattern: string,
      kind: "email" | "domain",
    ): Promise<AllowlistEntry> => {
      const r = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const res = await fetch('/api/mailboxes/${d1Mailbox.id}/policies/allowlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender_pattern: ${JSON.stringify(sender_pattern)}, kind: ${JSON.stringify(kind)} }),
          });
          return { status: res.status, body: await res.text() };
        })()`,
      })) as { status: number; body: string };
      if (r.status !== 201) {
        throw new Error(
          `POST allowlist ${kind}=${sender_pattern} failed: ${r.status} ${r.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(r.body) as AllowlistEntry;
    };

    const emailEntry = await addEntry(allowedEmail, "email");
    const domainEntry = await addEntry(allowedDomain, "domain");
    ctx.log(
      `allowlist seeded: email=${emailEntry.id} (${allowedEmail}), domain=${domainEntry.id} (${allowedDomain})`,
    );

    // 5. Probe: blocked sender — INBOX must NOT grow.
    const baseline = await fetchInboxCount();
    ctx.log(`baseline INBOX count=${baseline}`);
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: blockedEmail,
      subject: `S-INBOX-3-ALLOWLIST blocked-sender ${stamp}`,
      body: "this should never land",
    });
    const afterBlock = await expectStableFor("blocked sender", baseline, 2_000);
    ctx.log(`blocked sender ${blockedEmail} → INBOX still ${afterBlock} ✓`);

    // 6. Probe: allowed-by-email — INBOX MUST grow.
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: allowedEmail,
      subject: `S-INBOX-3-ALLOWLIST email-match ${stamp}`,
      body: "exact email match",
    });
    const afterEmailMatch = await expectGrowsTo(
      "email-match sender",
      afterBlock,
      5_000,
    );
    ctx.log(
      `email-match sender ${allowedEmail} → INBOX grew ${afterBlock} → ${afterEmailMatch} ✓`,
    );

    // 7. Probe: allowed-by-domain — INBOX MUST grow.
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: allowedDomainSender,
      subject: `S-INBOX-3-ALLOWLIST domain-match ${stamp}`,
      body: "domain suffix match",
    });
    const afterDomainMatch = await expectGrowsTo(
      "domain-match sender",
      afterEmailMatch,
      5_000,
    );
    ctx.log(
      `domain-match sender ${allowedDomainSender} → INBOX grew ${afterEmailMatch} → ${afterDomainMatch} ✓`,
    );
    await ctx.screenshot("after-allowlist-matches");

    // 8. Reset to 'all' — arbitrary external sender now lands. Proves the
    //    block was the gate (and not e.g. a different bug bouncing
    //    everything).
    const resetMode = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${d1Mailbox.id}/policies', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ external_allow_mode: 'all' }),
        });
        return { status: res.status };
      })()`,
    })) as { status: number };
    if (resetMode.status !== 200) {
      throw new Error(`reset PATCH returned ${resetMode.status}`);
    }
    await ctx.mock.injectInbound({
      to: recipientAddress,
      from: arbitraryExternal,
      subject: `S-INBOX-3-ALLOWLIST mode=all probe ${stamp}`,
      body: "should land once mode is 'all'",
    });
    const afterReset = await expectGrowsTo(
      "post-reset arbitrary external",
      afterDomainMatch,
      5_000,
    );
    ctx.log(
      `mode='all' arbitrary external ${arbitraryExternal} → INBOX grew ${afterDomainMatch} → ${afterReset} ✓`,
    );

    const consoleSummary = await ctx.captureConsole("after-reset");
    if (consoleSummary.errors > 0) {
      throw new Error(
        `${consoleSummary.errors} console error(s) (see ${consoleSummary.path})`,
      );
    }
  },
};

export default scenario;
