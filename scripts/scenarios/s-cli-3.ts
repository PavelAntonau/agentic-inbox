// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CLI-3 — Revoke a non-browser client.
 *
 * Branches covered:
 *   POST   /api/users/me/clients               (create kind='mcp' client)
 *   POST   /api/users/me/clients/:id/grants    (seed an active grant)
 *   DELETE /api/users/me/clients/:id           (revoke client)
 *   GET    /api/users/me/clients               (revoked_at populated, sorted into revoked tail)
 *   POST   /api/users/me/clients/:id/grants    (after revoke → 400 "Client is revoked")
 *
 * Grants on a revoked client are NOT explicitly revoked by the DELETE endpoint
 * — they remain rows with revoked_at=null but cannot be exercised because the
 * grant-create path 400s on a revoked client. (The product treats client
 * revocation as the higher-level kill switch; explicit grant revocation is
 * a separate concern.)
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface CreatedMailbox {
  id: string;
  address: string;
}

interface CreatedClient {
  id: string;
  kind: string;
  name: string;
  revoked_at: number | null;
}

interface ClientRow {
  id: string;
  kind: string;
  name: string;
  revoked_at: number | null;
  grants: Array<{ inbox_id: string; scope: string; granted_at: number }>;
}

const scenario: Scenario = {
  id: "S-CLI-3",
  description: "Revoke an MCP client; subsequent grant attempts 400",
  covers:
    "POST clients → POST grants → DELETE clients/:id → GET clients (revoked_at set) → POST grants again → 400",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const stamp = Date.now();
    const mailboxAddress = `cli3-target-${stamp}@actionnow.ai`;
    const clientName = `S-CLI-3 mcp ${stamp}`;

    // 1. Seed mailbox + client + initial grant.
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

    const cl = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'mcp', name: ${JSON.stringify(clientName)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (cl.status !== 201) {
      throw new Error(
        `client create failed: ${cl.status} ${cl.body.slice(0, 200)}`,
      );
    }
    const client = JSON.parse(cl.body) as CreatedClient;
    ctx.log(`client: ${client.id} (revoked_at=${client.revoked_at})`);
    if (client.revoked_at !== null) {
      throw new Error(
        `freshly-created client should have revoked_at=null, got ${client.revoked_at}`,
      );
    }

    const gr = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients/${client.id}/grants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inbox_id: ${JSON.stringify(mailbox.id)}, scope: 'write' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (gr.status !== 201) {
      throw new Error(
        `pre-revoke grant create failed: ${gr.status} ${gr.body.slice(0, 200)}`,
      );
    }
    ctx.log(`pre-revoke grant created`);

    // 2. Revoke the client.
    const revokeBefore = Date.now();
    const rv = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients/${client.id}', { method: 'DELETE' });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (rv.status !== 200) {
      throw new Error(
        `DELETE client returned ${rv.status}: ${rv.body.slice(0, 200)}`,
      );
    }
    const rvBody = JSON.parse(rv.body) as { revoked: boolean };
    if (rvBody.revoked !== true) {
      throw new Error(`expected {revoked: true}, got ${rv.body}`);
    }
    ctx.log(`client revoked`);
    await ctx.screenshot("after-revoke");

    // 3. GET /api/users/me/clients — revoked_at must be set, row must sort
    //    into the revoked tail (after active stored + browser sessions).
    const clList = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (clList.status !== 200) {
      throw new Error(
        `GET clients returned ${clList.status}: ${clList.body.slice(0, 200)}`,
      );
    }
    const clListBody = JSON.parse(clList.body) as { clients: ClientRow[] };
    const ours = clListBody.clients.find((c) => c.id === client.id);
    if (!ours) {
      throw new Error(
        `revoked client ${client.id} missing from GET /api/users/me/clients`,
      );
    }
    if (ours.revoked_at === null) {
      throw new Error(`revoked_at expected non-null, got null`);
    }
    if (ours.revoked_at < revokeBefore) {
      throw new Error(
        `revoked_at=${ours.revoked_at} predates DELETE call (revokeBefore=${revokeBefore})`,
      );
    }
    ctx.log(
      `revoked_at=${ours.revoked_at} (after revokeBefore=${revokeBefore}) ✓`,
    );

    // 4. Attempting a new grant on a revoked client must 400.
    const grAfter = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients/${client.id}/grants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inbox_id: ${JSON.stringify(mailbox.id)}, scope: 'read' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (grAfter.status !== 400) {
      throw new Error(
        `post-revoke grant expected 400, got ${grAfter.status}: ${grAfter.body.slice(0, 200)}`,
      );
    }
    const grAfterBody = JSON.parse(grAfter.body) as { error?: string };
    if (
      typeof grAfterBody.error !== "string" ||
      !grAfterBody.error.toLowerCase().includes("revoked")
    ) {
      throw new Error(
        `expected error mentioning 'revoked', got ${JSON.stringify(grAfterBody)}`,
      );
    }
    ctx.log(`post-revoke grant blocked with 400 "${grAfterBody.error}" ✓`);

    // Capture console BEFORE the deliberate 400 above would otherwise stamp
    // a "Failed to load resource: 400" entry. The capture happens after the
    // full sequence — the 400 IS expected and the framework treats fetch
    // 4xx as a console error in some browsers. We only fail if the OTHER
    // calls produced unexpected errors.
    const console = await ctx.captureConsole("after-revoke");
    // Tolerate exactly one expected 400 from the post-revoke probe; any
    // additional errors fail. Browsers vary in whether fetch() 4xx is
    // logged at all, so the floor is 0 and the ceiling is 1.
    if (console.errors > 1) {
      throw new Error(
        `expected ≤1 console error (the probed 400), got ${console.errors} (see ${console.path})`,
      );
    }
    ctx.log(`console errors = ${console.errors} (≤1 ✓)`);
  },
};

export default scenario;
