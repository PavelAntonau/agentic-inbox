// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-DRAFT-1 — Draft create + replace via the v1 drafts API.
 *
 * Branches covered:
 *   POST /api/v1/mailboxes                              (per-run-unique mailbox seed)
 *   POST /api/v1/mailboxes/:addr/drafts {body}          (initial draft, 201 + id)
 *   GET  /api/v1/mailboxes/:addr/emails?folder=draft    (draft visible)
 *   POST /api/v1/mailboxes/:addr/drafts {draft_id, ...} (replace flow:
 *                                                       deleteEmail(old) + createEmail(new))
 *   GET  /api/v1/mailboxes/:addr/emails?folder=draft    (only the new draft remains)
 *
 * Per-run unique mailbox suffix — the mailbox lives in R2 + the DO's
 * embedded SQLite, neither of which `/__mock/reset` clears (reset only
 * touches D1 control-plane + R2 outbox + OTP). Without uniqueness,
 * cumulative drafts would accumulate in the DO's emails table.
 *
 * Replace semantics — the v1 handler at workers/index.ts:323 does
 * `if (draft_id) await stub.deleteEmail(draft_id)` BEFORE inserting the
 * new draft. The handler comment flags it as not atomic ("create-then-
 * delete would be safer"); this scenario records the current observed
 * behaviour: old id gone, new id present.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface DraftListEntry {
  id: string;
  subject?: string;
  recipient?: string;
  body?: string;
  thread_id?: string;
}

interface DraftListResponse {
  emails?: DraftListEntry[];
}

const scenario: Scenario = {
  id: "S-DRAFT-1",
  description: "Draft autosave + replace via v1 drafts API",
  covers:
    "POST /drafts → folder=draft listing → POST /drafts {draft_id} replace → old id gone, new id present",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. Per-run-unique mailbox.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mailbox = `drafts-${runId}@actionnow.ai`;
    const seed = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Drafts test', email: ${JSON.stringify(mailbox)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (seed.status !== 200 && seed.status !== 201 && seed.status !== 409) {
      throw new Error(
        `v1 seed mailbox failed: ${seed.status} ${seed.body.slice(0, 200)}`,
      );
    }
    ctx.log(`mailbox seeded: ${mailbox}`);

    // 2. Initial draft.
    const mid = encodeURIComponent(mailbox);
    const create1 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/' + ${JSON.stringify(mid)} + '/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: 'recipient@example.com',
            subject: 'first draft',
            body: 'first draft body',
          }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (create1.status !== 201) {
      throw new Error(
        `initial draft expected 201, got ${create1.status}: ${create1.body.slice(0, 200)}`,
      );
    }
    const draft1 = JSON.parse(create1.body) as { id: string; status: string };
    if (typeof draft1.id !== "string" || draft1.id.length === 0) {
      throw new Error(
        `initial draft response missing id: ${create1.body.slice(0, 200)}`,
      );
    }
    if (draft1.status !== "draft") {
      throw new Error(
        `initial draft status expected 'draft', got '${draft1.status}'`,
      );
    }
    ctx.log(`initial draft created id=${draft1.id} ✓`);

    // 3. Listing folder=draft should contain draft1.
    const list1 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/' + ${JSON.stringify(mid)} + '/emails?folder=draft');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (list1.status !== 200) {
      throw new Error(
        `folder=draft list (1) ${list1.status}: ${list1.body.slice(0, 200)}`,
      );
    }
    const list1Body = JSON.parse(list1.body) as DraftListResponse;
    const list1Emails = list1Body.emails ?? [];
    if (!list1Emails.some((e) => e.id === draft1.id)) {
      throw new Error(
        `draft1 (${draft1.id}) missing from folder=draft listing — got ${list1Emails.length} rows`,
      );
    }
    ctx.log(`draft1 visible in folder=draft (count=${list1Emails.length}) ✓`);

    // 4. Replace via draft_id — handler deletes draft1, creates new draft2.
    const create2 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/' + ${JSON.stringify(mid)} + '/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            draft_id: ${JSON.stringify(draft1.id)},
            to: 'recipient@example.com',
            subject: 'second draft',
            body: 'second draft body — replaced',
          }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (create2.status !== 201) {
      throw new Error(
        `replace draft expected 201, got ${create2.status}: ${create2.body.slice(0, 200)}`,
      );
    }
    const draft2 = JSON.parse(create2.body) as { id: string };
    if (draft2.id === draft1.id) {
      throw new Error(
        `replace returned the same id (${draft1.id}); expected a fresh uuid (handler does deleteEmail+createEmail)`,
      );
    }
    ctx.log(`replace draft created id=${draft2.id} (was ${draft1.id}) ✓`);

    // 5. Listing folder=draft should now contain draft2 but NOT draft1.
    const list2 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/v1/mailboxes/' + ${JSON.stringify(mid)} + '/emails?folder=draft');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (list2.status !== 200) {
      throw new Error(
        `folder=draft list (2) ${list2.status}: ${list2.body.slice(0, 200)}`,
      );
    }
    const list2Body = JSON.parse(list2.body) as DraftListResponse;
    const list2Emails = list2Body.emails ?? [];
    if (!list2Emails.some((e) => e.id === draft2.id)) {
      throw new Error(
        `draft2 (${draft2.id}) missing from folder=draft listing after replace — got ${list2Emails.length} rows`,
      );
    }
    if (list2Emails.some((e) => e.id === draft1.id)) {
      throw new Error(
        `draft1 (${draft1.id}) still present after replace — handler should have deleted it (workers/index.ts:328)`,
      );
    }
    ctx.log(`draft2 present, draft1 deleted (count=${list2Emails.length}) ✓`);
    await ctx.screenshot("after-draft-replace");

    const consoleSummary = await ctx.captureConsole("after-drafts");
    if (consoleSummary.errors > 0) {
      throw new Error(
        `expected 0 console errors, got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (0 ✓)`);
  },
};

export default scenario;
