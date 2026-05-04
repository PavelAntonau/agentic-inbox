// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-AUTH-4 — Expired session is filtered from listings.
 *
 * Branches covered:
 *   POST /__mock/seed-session            (test-only seed for the better-auth `session` table)
 *   GET  /api/users/me/sessions           (filters expired rows in application code)
 *   GET  /api/users/me/clients            (filters expired browser sessions in application code)
 *
 * Why this scenario uses the mock seed:
 *   The dev-mode picker (`/login` POST identity=…) sets the `x-mock-user-email`
 *   cookie but does NOT populate the `session` table — that table is only
 *   written by the better-auth OTP flow. Without a seed surface there is no
 *   way to exercise the expiry filter at sessions.ts:79 / clients.ts:103-106
 *   in MOCK_MODE. /__mock/seed-session lets us insert sessions with controlled
 *   expiry; the production deploy never sees the route (mounted only when
 *   MOCK_MODE=1).
 *
 * What this scenario does NOT cover:
 *   - "User is redirected to /login when the session expires." That requires
 *     the auth path to read the better-auth session, which is not the active
 *     auth path in MOCK_MODE (cookie/env-var fallback dominates — see
 *     F-PHASE2-003). Until a non-mock path is testable end-to-end, the
 *     filter-at-listing behaviour is the meaningful product surface.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface SeededSession {
  id: string;
  user_id: string;
  expires_at: number;
  ip_address: string;
  user_agent: string;
  created_at: number;
  updated_at: number;
}

interface SessionsListRow {
  id: string;
  is_current: boolean;
  expires_at: number;
}

interface ClientsListRow {
  id: string;
  kind: string;
  name: string;
  revoked_at: number | null;
}

const scenario: Scenario = {
  id: "S-AUTH-4",
  description: "Expired sessions are filtered from /sessions and /clients",
  covers:
    "/__mock/seed-session → GET /api/users/me/sessions → GET /api/users/me/clients (expired filtered)",
  smoke: false,

  async run(ctx) {
    // Login first — this triggers bootstrapOwner so a `users` row exists for
    // alice and /__mock/seed-session can resolve user_id by email.
    await loginAs(ctx, TEST_USERS.alice);

    const now = Date.now();
    // Past expiry — server filters this out.
    const expiredAt = now - 60 * 60 * 1000;
    // Future expiry — server keeps this.
    const validAt = now + 30 * 24 * 60 * 60 * 1000;

    // 1. Seed expired session.
    const expiredRes = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: ${JSON.stringify(TEST_USERS.alice)},
            expires_at: ${expiredAt},
            user_agent: 'S-AUTH-4 expired/1.0',
          }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (expiredRes.status !== 200) {
      throw new Error(
        `seed expired session returned ${expiredRes.status}: ${expiredRes.body.slice(0, 200)}`,
      );
    }
    const expired = JSON.parse(expiredRes.body) as SeededSession;
    ctx.log(
      `seeded expired session id=${expired.id} expires_at=${expired.expires_at} (now=${now})`,
    );

    // 2. Seed valid session.
    const validRes = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/__mock/seed-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: ${JSON.stringify(TEST_USERS.alice)},
            expires_at: ${validAt},
            user_agent: 'S-AUTH-4 valid/1.0',
          }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (validRes.status !== 200) {
      throw new Error(
        `seed valid session returned ${validRes.status}: ${validRes.body.slice(0, 200)}`,
      );
    }
    const valid = JSON.parse(validRes.body) as SeededSession;
    ctx.log(
      `seeded valid session id=${valid.id} expires_at=${valid.expires_at}`,
    );

    // 3. GET /api/users/me/sessions — expired must be excluded.
    const sessRes = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/sessions');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (sessRes.status !== 200) {
      throw new Error(
        `GET /api/users/me/sessions returned ${sessRes.status}: ${sessRes.body.slice(0, 200)}`,
      );
    }
    const sessRows = JSON.parse(sessRes.body) as SessionsListRow[];
    const sawExpired = sessRows.some((r) => r.id === expired.id);
    const sawValid = sessRows.some((r) => r.id === valid.id);
    if (sawExpired) {
      throw new Error(
        `expired session id=${expired.id} surfaced in /sessions (must be filtered)`,
      );
    }
    if (!sawValid) {
      throw new Error(
        `valid session id=${valid.id} missing from /sessions; got ids=${sessRows
          .map((r) => r.id)
          .join(",")}`,
      );
    }
    ctx.log(
      `/sessions: expired filtered ✓, valid present ✓ (total rows=${sessRows.length})`,
    );

    // 4. GET /api/users/me/clients — browser-projected sessions must follow
    //    the same filter (clients.ts:103-106).
    const cliRes = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (cliRes.status !== 200) {
      throw new Error(
        `GET /api/users/me/clients returned ${cliRes.status}: ${cliRes.body.slice(0, 200)}`,
      );
    }
    const cliBody = JSON.parse(cliRes.body) as { clients: ClientsListRow[] };
    const expiredCli = cliBody.clients.find(
      (c) => c.id === `session:${expired.id}`,
    );
    const validCli = cliBody.clients.find(
      (c) => c.id === `session:${valid.id}`,
    );
    if (expiredCli) {
      throw new Error(
        `expired session surfaced as browser client: ${JSON.stringify(expiredCli)}`,
      );
    }
    if (!validCli) {
      throw new Error(
        `valid session missing from browser clients; ids=${cliBody.clients
          .map((c) => c.id)
          .join(",")}`,
      );
    }
    if (validCli.kind !== "browser") {
      throw new Error(
        `valid session client.kind expected 'browser', got ${validCli.kind}`,
      );
    }
    ctx.log(`/clients: expired filtered ✓, valid present as kind=browser ✓`);
    await ctx.screenshot("after-listing");

    const console = await ctx.captureConsole("after-listing");
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) (see ${console.path})`,
      );
    }
  },
};

export default scenario;
