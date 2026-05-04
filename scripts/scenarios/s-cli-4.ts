// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CLI-4 — Revoke a single grant; client itself remains active.
 *
 * Branches covered:
 *   POST   /api/users/me/clients                              (kind='mcp')
 *   POST   /api/users/me/clients/:id/grants                   (seed two grants)
 *   DELETE /api/users/me/clients/:id/grants/:grantId          (revoke one)
 *   GET    /api/users/me/clients/:id/grants                   (only the surviving grant remains)
 *   GET    /api/users/me/clients                              (client.revoked_at === null; grants list shrinks)
 *   POST   /api/users/me/clients/:id/grants                   (still allowed because client is active)
 *   DELETE /api/users/me/clients/:id/grants/:grantId          (idempotent re-revoke → 200)
 *   DELETE /api/users/me/clients/:id/grants/:bogus            (404)
 *
 * Sister scenario to S-CLI-3 (which revokes the *client*). The contrast is
 * the key invariant: client revocation is the higher-level kill switch and
 * blocks new grants; grant revocation is fine-grained and leaves the client
 * fully usable.
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

interface GrantRow {
  id: string;
  client_id: string;
  inbox_id: string;
  scope: "read" | "write";
  granted_at: number;
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
  id: "S-CLI-4",
  description: "Revoke a single grant without revoking the client",
  covers:
    "POST grants → DELETE grants/:grantId → GET grants (one remaining) → client still active → re-grant works → idempotent re-revoke → 404 on bogus grant",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const stamp = Date.now();
    const addressOne = `cli4-target-one-${stamp}@actionnow.ai`;
    const addressTwo = `cli4-target-two-${stamp}@actionnow.ai`;
    const clientName = `S-CLI-4 mcp ${stamp}`;

    // 1. Seed two distinct mailboxes (one per scope, to keep the UNIQUE
    //    (client_id, inbox_id, scope) guard out of the way).
    const seedMailbox = async (address: string): Promise<CreatedMailbox> => {
      const res = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const r = await fetch('/api/mailboxes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: ${JSON.stringify(address)} }),
          });
          return { status: r.status, body: await r.text() };
        })()`,
      })) as { status: number; body: string };
      if (res.status !== 201) {
        throw new Error(
          `mailbox seed (${address}) failed: ${res.status} ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as CreatedMailbox;
    };

    const mailboxOne = await seedMailbox(addressOne);
    const mailboxTwo = await seedMailbox(addressTwo);
    ctx.log(`mailboxes: ${mailboxOne.id}, ${mailboxTwo.id}`);

    // 2. Create the MCP client.
    const cl = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/users/me/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'mcp', name: ${JSON.stringify(clientName)} }),
        });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (cl.status !== 201) {
      throw new Error(
        `client create failed: ${cl.status} ${cl.body.slice(0, 200)}`,
      );
    }
    const client = JSON.parse(cl.body) as CreatedClient;
    ctx.log(`client: ${client.id}`);

    // 3. Seed two grants — read on mailboxOne, write on mailboxTwo.
    const seedGrant = async (
      inboxId: string,
      scope: "read" | "write",
    ): Promise<GrantRow> => {
      const res = (await ctx.browser.call("browser_evaluate", {
        expression: `(async () => {
          const r = await fetch('/api/users/me/clients/${client.id}/grants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inbox_id: ${JSON.stringify(inboxId)}, scope: ${JSON.stringify(scope)} }),
          });
          return { status: r.status, body: await r.text() };
        })()`,
      })) as { status: number; body: string };
      if (res.status !== 201) {
        throw new Error(
          `grant seed (${inboxId}, ${scope}) failed: ${res.status} ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as GrantRow;
    };

    const grantOne = await seedGrant(mailboxOne.id, "read");
    const grantTwo = await seedGrant(mailboxTwo.id, "write");
    ctx.log(`grants: ${grantOne.id}, ${grantTwo.id}`);

    // 4. Revoke grantOne.
    const rv = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/users/me/clients/${client.id}/grants/${grantOne.id}', {
          method: 'DELETE',
        });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (rv.status !== 200) {
      throw new Error(
        `DELETE grant returned ${rv.status}: ${rv.body.slice(0, 200)}`,
      );
    }
    const rvBody = JSON.parse(rv.body) as { revoked: boolean };
    if (rvBody.revoked !== true) {
      throw new Error(`expected {revoked: true}, got ${rv.body}`);
    }
    ctx.log(`grant ${grantOne.id} revoked ✓`);
    await ctx.screenshot("after-grant-revoke");

    // 5. GET /:id/grants — only grantTwo remains (revoked rows filtered).
    const grList = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/users/me/clients/${client.id}/grants');
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (grList.status !== 200) {
      throw new Error(
        `GET grants returned ${grList.status}: ${grList.body.slice(0, 200)}`,
      );
    }
    const grListBody = JSON.parse(grList.body) as { grants: GrantRow[] };
    const ids = grListBody.grants.map((g) => g.id);
    if (ids.includes(grantOne.id)) {
      throw new Error(
        `revoked grant ${grantOne.id} should be filtered, but appears in GET /:id/grants (got ${ids.join(",")})`,
      );
    }
    if (!ids.includes(grantTwo.id)) {
      throw new Error(
        `surviving grant ${grantTwo.id} missing from GET /:id/grants (got ${ids.join(",")})`,
      );
    }
    ctx.log(`grants list shrunk to [${ids.join(",")}] ✓`);

    // 6. GET /api/users/me/clients — client itself remains active, grants
    //    rolled-up list also reflects the revocation.
    const clList = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/users/me/clients');
        return { status: r.status, body: await r.text() };
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
        `client ${client.id} missing from GET /api/users/me/clients`,
      );
    }
    if (ours.revoked_at !== null) {
      throw new Error(
        `client.revoked_at expected null (grant revocation must NOT revoke client), got ${ours.revoked_at}`,
      );
    }
    const rolledOne = ours.grants.find(
      (g) => g.inbox_id === mailboxOne.id && g.scope === "read",
    );
    const rolledTwo = ours.grants.find(
      (g) => g.inbox_id === mailboxTwo.id && g.scope === "write",
    );
    if (rolledOne) {
      throw new Error(
        `revoked grant should be absent from client.grants rollup, found ${JSON.stringify(rolledOne)}`,
      );
    }
    if (!rolledTwo) {
      throw new Error(
        `surviving grant (mailboxTwo, write) missing from client.grants rollup`,
      );
    }
    ctx.log(`client active, rollup reflects single surviving grant ✓`);

    // 7. Active client must still accept new grants — re-grant the
    //    just-revoked (mailboxOne, read) tuple. Because the unique guard
    //    only counts active rows (revoked_at IS NULL), this succeeds with
    //    a new grant id.
    const reGrant = await seedGrant(mailboxOne.id, "read");
    if (reGrant.id === grantOne.id) {
      throw new Error(
        `re-grant produced same id ${reGrant.id} — should be a fresh row`,
      );
    }
    ctx.log(
      `re-grant after grant-revoke succeeded with new id ${reGrant.id} ✓`,
    );

    // 8. Idempotent re-revoke of the original grantOne — already-revoked
    //    path returns 200 {revoked: true} (NOT 404).
    const rv2 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/users/me/clients/${client.id}/grants/${grantOne.id}', {
          method: 'DELETE',
        });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (rv2.status !== 200) {
      throw new Error(
        `idempotent re-revoke expected 200, got ${rv2.status}: ${rv2.body.slice(0, 200)}`,
      );
    }
    const rv2Body = JSON.parse(rv2.body) as { revoked: boolean };
    if (rv2Body.revoked !== true) {
      throw new Error(
        `idempotent re-revoke expected {revoked: true}, got ${rv2.body}`,
      );
    }
    ctx.log(`idempotent re-revoke returned 200 ✓`);

    // 9. DELETE on a non-existent grant id → 404.
    const bogus = "cgdoesnotexist00000000000000000000";
    const miss = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const r = await fetch('/api/users/me/clients/${client.id}/grants/${bogus}', {
          method: 'DELETE',
        });
        return { status: r.status, body: await r.text() };
      })()`,
    })) as { status: number; body: string };
    if (miss.status !== 404) {
      throw new Error(
        `DELETE bogus grant expected 404, got ${miss.status}: ${miss.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE bogus grant returned 404 ✓`);

    // The 404 above can stamp a "Failed to load resource: 404" entry in
    // some browsers. Tolerate ≤1 expected console error from that probe.
    const consoleSummary = await ctx.captureConsole("after-bogus-delete");
    if (consoleSummary.errors > 1) {
      throw new Error(
        `expected ≤1 console error (from the deliberate 404 probe), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤1 ✓)`);
  },
};

export default scenario;
