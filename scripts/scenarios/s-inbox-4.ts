// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-INBOX-4 — Allowlist add / remove (CRUD).
 *
 * Branches covered:
 *   POST   /api/mailboxes                                              (seed D1 mailbox)
 *   GET    /api/mailboxes/:id/policies                                 (initial: empty allowlist)
 *   POST   /api/mailboxes/:id/policies/allowlist                       (add 'email' kind)
 *   POST   /api/mailboxes/:id/policies/allowlist                       (add 'domain' kind)
 *   GET    /api/mailboxes/:id/policies                                 (allowlist length=2)
 *   DELETE /api/mailboxes/:id/policies/allowlist/:entryId              (remove email entry)
 *   GET    /api/mailboxes/:id/policies                                 (allowlist length=1)
 *   POST   /api/mailboxes/:id/policies/allowlist                       (invalid kind → 400)
 *   DELETE /api/mailboxes/:id/policies/allowlist/non-existent          (404)
 *
 * Allowlist enforcement at receive time is NOT covered here — that lives
 * with S-INBOX-3's broader external_inbound_enabled gate. This scenario
 * covers the persistence + validation contract only.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface CreatedMailbox {
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

interface PolicyState {
  external_inbound_enabled: boolean;
  external_allow_mode: "all" | "allowlist";
  internal_inbound_mode: string;
  allowlist: Array<{
    id: string;
    sender_pattern: string;
    kind: "email" | "domain";
    created_at: number;
  }>;
}

const scenario: Scenario = {
  id: "S-INBOX-4",
  description: "Allowlist add/remove CRUD on inbox policies",
  covers:
    "POST /policies/allowlist (email + domain) → GET /policies → DELETE entry → validation 400/404",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const stamp = Date.now();
    const mailboxAddress = `inbox4-target-${stamp}@actionnow.ai`;
    const emailEntry = `whitelisted-${stamp}@example.com`;
    const domainEntry = `partner-${stamp}.example.com`;

    // 1. Seed a D1 mailbox.
    const mb = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: ${JSON.stringify(mailboxAddress)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (mb.status !== 201) {
      throw new Error(
        `mailbox seed failed: ${mb.status} ${mb.body.slice(0, 200)}`,
      );
    }
    const mailbox = JSON.parse(mb.body) as CreatedMailbox;
    ctx.log(`mailbox: ${mailbox.id}`);

    // 2. Initial policy state — allowlist must be empty.
    const initial = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/policies');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (initial.status !== 200) {
      throw new Error(
        `initial GET /policies returned ${initial.status}: ${initial.body.slice(0, 200)}`,
      );
    }
    const initialState = JSON.parse(initial.body) as PolicyState;
    if (initialState.allowlist.length !== 0) {
      throw new Error(
        `expected empty allowlist on fresh mailbox, got ${initialState.allowlist.length} entries`,
      );
    }
    ctx.log(
      `initial allowlist empty ✓ (defaults: enabled=${initialState.external_inbound_enabled} mode=${initialState.external_allow_mode})`,
    );

    // 3. Add an 'email' allowlist entry.
    const addEmail = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/policies/allowlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender_pattern: ${JSON.stringify(emailEntry)}, kind: 'email' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (addEmail.status !== 201) {
      throw new Error(
        `add email entry returned ${addEmail.status}: ${addEmail.body.slice(0, 200)}`,
      );
    }
    const emailRow = JSON.parse(addEmail.body) as AllowlistEntry;
    if (emailRow.kind !== "email" || emailRow.sender_pattern !== emailEntry) {
      throw new Error(
        `email entry mismatch — expected kind=email pattern=${emailEntry}, got ${JSON.stringify(emailRow)}`,
      );
    }
    if (emailRow.inbox_id !== mailbox.id) {
      throw new Error(
        `entry.inbox_id mismatch — expected ${mailbox.id}, got ${emailRow.inbox_id}`,
      );
    }
    ctx.log(`email entry added: ${emailRow.id}`);

    // 4. Add a 'domain' allowlist entry.
    const addDomain = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/policies/allowlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender_pattern: ${JSON.stringify(domainEntry)}, kind: 'domain' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (addDomain.status !== 201) {
      throw new Error(
        `add domain entry returned ${addDomain.status}: ${addDomain.body.slice(0, 200)}`,
      );
    }
    const domainRow = JSON.parse(addDomain.body) as AllowlistEntry;
    ctx.log(`domain entry added: ${domainRow.id}`);

    // 5. GET /policies — both entries must be enumerated.
    const after2 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/policies');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const after2State = JSON.parse(after2.body) as PolicyState;
    if (after2State.allowlist.length !== 2) {
      throw new Error(
        `expected 2 allowlist entries after 2 adds, got ${after2State.allowlist.length}: ${JSON.stringify(after2State.allowlist)}`,
      );
    }
    const haveEmail = after2State.allowlist.find((e) => e.id === emailRow.id);
    const haveDomain = after2State.allowlist.find((e) => e.id === domainRow.id);
    if (!haveEmail || !haveDomain) {
      throw new Error(
        `enumerated entries missing one or both — got ${JSON.stringify(after2State.allowlist)}`,
      );
    }
    ctx.log(`both entries enumerated by GET /policies ✓`);

    // 6. Delete the email entry.
    const del = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/policies/allowlist/${emailRow.id}', {
          method: 'DELETE',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (del.status !== 200) {
      throw new Error(
        `DELETE entry returned ${del.status}: ${del.body.slice(0, 200)}`,
      );
    }
    const delBody = JSON.parse(del.body) as { deleted: boolean };
    if (delBody.deleted !== true) {
      throw new Error(`expected {deleted: true}, got ${del.body}`);
    }
    ctx.log(`email entry deleted`);

    // 7. GET /policies — allowlist must contain only the domain entry.
    const after1 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/policies');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const after1State = JSON.parse(after1.body) as PolicyState;
    if (after1State.allowlist.length !== 1) {
      throw new Error(
        `expected 1 allowlist entry after 1 delete, got ${after1State.allowlist.length}`,
      );
    }
    if (after1State.allowlist[0].id !== domainRow.id) {
      throw new Error(
        `surviving entry id mismatch — expected ${domainRow.id}, got ${after1State.allowlist[0].id}`,
      );
    }
    ctx.log(`only domain entry survives ✓`);
    await ctx.screenshot("after-delete");

    // Capture console BEFORE the deliberate 400/404 probes below — those
    // would otherwise stamp "Failed to load resource" entries that the
    // assertion below tolerates only inside the post-error capture.
    const cleanConsole = await ctx.captureConsole("after-crud");
    if (cleanConsole.errors > 0) {
      throw new Error(
        `unexpected console errors after CRUD (pre-error-probes): ${cleanConsole.errors} (see ${cleanConsole.path})`,
      );
    }

    // 8. Validation: invalid kind → 400.
    const badKind = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/policies/allowlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender_pattern: 'x@y.z', kind: 'wildcard' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (badKind.status !== 400) {
      throw new Error(
        `invalid kind expected 400, got ${badKind.status}: ${badKind.body.slice(0, 200)}`,
      );
    }
    ctx.log(`invalid kind rejected with 400 ✓`);

    // 9. DELETE non-existent entry → 404.
    const badDel = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes/${mailbox.id}/policies/allowlist/al-does-not-exist', {
          method: 'DELETE',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (badDel.status !== 404) {
      throw new Error(
        `DELETE non-existent expected 404, got ${badDel.status}: ${badDel.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE non-existent rejected with 404 ✓`);
  },
};

export default scenario;
