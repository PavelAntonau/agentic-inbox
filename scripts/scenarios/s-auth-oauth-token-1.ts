// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-AUTH-OAUTH-TOKEN-1 — oauth_refresh_token UNIQUE(token) wire-level guard.
 *
 * Audit fix S-1 (graph: ABfhYiMFim3q0u77iasH2): a duplicate refresh-token
 * row is a token-replay surface. Migration 0013 added
 * `CREATE UNIQUE INDEX oauth_refresh_token_token_unique ON oauth_refresh_token(token)`.
 * This scenario asserts the constraint actually fires when the SQL layer
 * sees the same `token` value twice — closing the gap a unit test alone
 * cannot, since unit tests don't run against the deployed migration set.
 *
 * Branches covered:
 *   POST /__mock/seed-oauth-refresh-token (token=T)            (201 — first insert OK)
 *   POST /__mock/seed-oauth-refresh-token (token=T, again)     (409 — UNIQUE_CONSTRAINT)
 *   POST /__mock/seed-oauth-refresh-token (token=T2)           (201 — different token OK)
 *   POST /__mock/seed-oauth-refresh-token (no body)             (400 — token required)
 *
 * The mock helper does a direct INSERT (bypassing better-auth), then
 * surfaces the SQLite UNIQUE-constraint error to the wire as 409 + a
 * `code: "UNIQUE_CONSTRAINT"` payload. A pre-migration deployment would
 * silently accept the duplicate and return 201 — that is the regression
 * this scenario locks against.
 *
 * Phase 1 retro adjustments_to_next called this out as the missing
 * coverage piece for S-1; this scenario fulfils that obligation.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

const scenario: Scenario = {
  id: "S-AUTH-OAUTH-TOKEN-1",
  description:
    "oauth_refresh_token UNIQUE(token) constraint fires at the wire level (S-1 / migration 0013)",
  covers:
    "first INSERT 201 → duplicate-token INSERT 409 UNIQUE_CONSTRAINT → distinct-token INSERT 201 → no-token 400",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // The mock helper requires a real users.id. Alice was bootstrapped at
    // login; that's enough.
    const tokenA = `s-auth-oauth-token-1-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    // 1. First INSERT → 201.
    const first = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-oauth-refresh-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(tokenA)}, user_email: ${JSON.stringify(TEST_USERS.alice)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (first.status !== 201) {
      throw new Error(
        `first INSERT expected 201, got ${first.status}: ${first.body.slice(0, 200)}`,
      );
    }
    const firstBody = JSON.parse(first.body) as { id: string; token: string };
    if (firstBody.token !== tokenA) {
      throw new Error(
        `expected echoed token=${tokenA}, got ${JSON.stringify(firstBody)}`,
      );
    }
    ctx.log(`first INSERT (token=${tokenA.slice(0, 24)}…) → 201 ✓`);

    // 2. Duplicate INSERT (same token) → 409 UNIQUE_CONSTRAINT.
    const dup = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-oauth-refresh-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(tokenA)}, user_email: ${JSON.stringify(TEST_USERS.alice)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (dup.status !== 409) {
      throw new Error(
        `duplicate INSERT expected 409 (UNIQUE — migration 0013), got ${dup.status}: ${dup.body.slice(0, 200)}`,
      );
    }
    const dupBody = JSON.parse(dup.body) as {
      error?: string;
      code?: string;
      detail?: string;
    };
    if (dupBody.code !== "UNIQUE_CONSTRAINT") {
      throw new Error(
        `expected code='UNIQUE_CONSTRAINT', got ${JSON.stringify(dupBody)}`,
      );
    }
    if (
      typeof dupBody.detail !== "string" ||
      !(
        dupBody.detail.includes("oauth_refresh_token.token") ||
        dupBody.detail.includes("oauth_refresh_token_token_unique") ||
        dupBody.detail.toLowerCase().includes("unique")
      )
    ) {
      throw new Error(
        `detail should reference the UNIQUE index, got ${JSON.stringify(dupBody.detail)}`,
      );
    }
    ctx.log(
      `duplicate INSERT → 409 code='UNIQUE_CONSTRAINT' detail="${(dupBody.detail ?? "").slice(0, 80)}" ✓`,
    );

    // 3. INSERT with a different token → 201 (control: the constraint is
    //    on the column, not the table).
    const tokenB = `s-auth-oauth-token-1-${Date.now()}-${Math.floor(Math.random() * 100000)}-B`;
    const distinct = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-oauth-refresh-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(tokenB)}, user_email: ${JSON.stringify(TEST_USERS.alice)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (distinct.status !== 201) {
      throw new Error(
        `distinct INSERT expected 201, got ${distinct.status}: ${distinct.body.slice(0, 200)}`,
      );
    }
    ctx.log(`distinct INSERT (token=${tokenB.slice(0, 24)}…) → 201 ✓`);

    // 4. No token in body → 400 (helper input validation).
    const noToken = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-oauth-refresh-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_email: ${JSON.stringify(TEST_USERS.alice)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noToken.status !== 400) {
      throw new Error(
        `no-token expected 400, got ${noToken.status}: ${noToken.body.slice(0, 200)}`,
      );
    }
    ctx.log(`no-token body → 400 ✓`);
    await ctx.screenshot("after-oauth-token-unique");

    // Two intentional failures (409 + 400). Allow ≤2 console errors.
    const consoleSnap = await ctx.captureConsole(
      "after-oauth-refresh-token-unique",
    );
    if (consoleSnap.errors > 2) {
      throw new Error(
        `expected ≤2 console errors (409 + 400 probes), got ${consoleSnap.errors} (see ${consoleSnap.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSnap.errors} (≤2 ✓)`);
  },
};

export default scenario;
