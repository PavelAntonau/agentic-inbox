// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CLI-2 — Grant inbox access to a non-browser client.
 *
 * Branches covered:
 *   POST   /api/users/me/clients              (create kind='mcp' client)
 *   POST   /api/mailboxes                     (seed a D1 mailbox to grant against)
 *   POST   /api/users/me/clients/:id/grants   (create grant inbox_id+scope='read')
 *   GET    /api/users/me/clients/:id/grants   (verify grant present)
 *   GET    /api/users/me/clients              (verify grant on the client row)
 *
 * Per-run-unique address pattern keeps the scenario re-runnable across
 * `/__mock/reset` cycles (D1 mailboxes table IS cleared by reset, but R2
 * keys are not — irrelevant here since this scenario uses D1-only flows).
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
  id: "S-CLI-2",
  description: "Grant inbox read access to an MCP client",
  covers:
    "POST clients (mcp) → POST grants → GET /:id/grants → GET clients (with grants)",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const stamp = Date.now();
    const mailboxAddress = `cli2-target-${stamp}@actionnow.ai`;
    const clientName = `S-CLI-2 mcp ${stamp}`;

    // 1. Seed a D1 mailbox to grant against.
    const mb = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/mailboxes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: ${JSON.stringify(mailboxAddress)} }),
        });
        const text = await res.text();
        return { status: res.status, body: text };
      })()`,
    })) as { status: number; body: string };
    if (mb.status !== 201) {
      throw new Error(
        `POST /api/mailboxes returned ${mb.status}: ${mb.body.slice(0, 200)}`,
      );
    }
    const mailbox = JSON.parse(mb.body) as CreatedMailbox;
    ctx.log(`mailbox created: id=${mailbox.id} address=${mailbox.address}`);
    await ctx.screenshot("after-create-mailbox");

    // 2. Create a non-browser MCP client.
    const cl = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'mcp', name: ${JSON.stringify(clientName)} }),
        });
        const text = await res.text();
        return { status: res.status, body: text };
      })()`,
    })) as { status: number; body: string };
    if (cl.status !== 201) {
      throw new Error(
        `POST /api/users/me/clients returned ${cl.status}: ${cl.body.slice(0, 200)}`,
      );
    }
    const client = JSON.parse(cl.body) as CreatedClient;
    ctx.log(`mcp client created: id=${client.id} name=${client.name}`);
    if (client.kind !== "mcp") {
      throw new Error(
        `expected kind=mcp on created client, got ${client.kind}`,
      );
    }

    // 3. Grant the client read access to the mailbox.
    const gr = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients/${client.id}/grants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inbox_id: ${JSON.stringify(mailbox.id)}, scope: 'read' }),
        });
        const text = await res.text();
        return { status: res.status, body: text };
      })()`,
    })) as { status: number; body: string };
    if (gr.status !== 201) {
      throw new Error(
        `POST grants returned ${gr.status}: ${gr.body.slice(0, 200)}`,
      );
    }
    const grant = JSON.parse(gr.body) as GrantRow;
    ctx.log(
      `grant created: id=${grant.id} client_id=${grant.client_id} inbox_id=${grant.inbox_id} scope=${grant.scope}`,
    );
    if (grant.client_id !== client.id) {
      throw new Error(
        `grant.client_id mismatch — expected ${client.id}, got ${grant.client_id}`,
      );
    }
    if (grant.inbox_id !== mailbox.id) {
      throw new Error(
        `grant.inbox_id mismatch — expected ${mailbox.id}, got ${grant.inbox_id}`,
      );
    }
    if (grant.scope !== "read") {
      throw new Error(`grant.scope expected 'read', got '${grant.scope}'`);
    }
    if (grant.revoked_at !== null) {
      throw new Error(
        `grant.revoked_at expected null on creation, got ${grant.revoked_at}`,
      );
    }

    // 4. GET /:id/grants — confirm the grant is enumerated.
    const grList = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients/${client.id}/grants');
        const text = await res.text();
        return { status: res.status, body: text };
      })()`,
    })) as { status: number; body: string };
    if (grList.status !== 200) {
      throw new Error(
        `GET grants returned ${grList.status}: ${grList.body.slice(0, 200)}`,
      );
    }
    const grListBody = JSON.parse(grList.body) as { grants: GrantRow[] };
    const enumerated = grListBody.grants.find((g) => g.id === grant.id);
    if (!enumerated) {
      throw new Error(
        `grant ${grant.id} missing from GET /:id/grants — got ${grListBody.grants
          .map((g) => g.id)
          .join(",")}`,
      );
    }
    ctx.log(`grant enumerated by GET /:id/grants ✓`);

    // 5. GET /api/users/me/clients — confirm the grant rolls up onto the client row.
    const clList = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients');
        const text = await res.text();
        return { status: res.status, body: text };
      })()`,
    })) as { status: number; body: string };
    if (clList.status !== 200) {
      throw new Error(
        `GET /api/users/me/clients returned ${clList.status}: ${clList.body.slice(0, 200)}`,
      );
    }
    const clListBody = JSON.parse(clList.body) as { clients: ClientRow[] };
    const ours = clListBody.clients.find((c) => c.id === client.id);
    if (!ours) {
      throw new Error(
        `client ${client.id} missing from GET /api/users/me/clients`,
      );
    }
    const rolledGrant = ours.grants.find(
      (g) => g.inbox_id === mailbox.id && g.scope === "read",
    );
    if (!rolledGrant) {
      throw new Error(
        `client.grants did not include (inbox=${mailbox.id}, scope=read); got ${JSON.stringify(ours.grants)}`,
      );
    }
    ctx.log(`grant present on client row ✓`);
    await ctx.screenshot("after-grant");

    const console = await ctx.captureConsole("after-grant");
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) after grant (see ${console.path})`,
      );
    }
  },
};

export default scenario;
