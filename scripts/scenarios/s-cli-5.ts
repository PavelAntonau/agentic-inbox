// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CLI-5 — POST /api/users/me/clients validation + lifecycle.
 *
 * Branches covered:
 *   POST /api/users/me/clients {} no kind                → 400
 *   POST /api/users/me/clients {kind: "browser"}         → 400 (browser kind reserved
 *                                                            for auto-rows derived
 *                                                            from sessions)
 *   POST /api/users/me/clients {kind: "mcp"} no name     → 400
 *   POST /api/users/me/clients {kind: "mcp", name}       → 201 + new id
 *   GET  /api/users/me/clients                           → list contains the new client
 *                                                            with revoked_at=null
 *   DELETE /api/users/me/clients/:id                     → 200 (revoked)
 *   GET  /api/users/me/clients                           → row carries revoked_at>0
 *
 * Per-run unique client name avoids any future UNIQUE(user_id, name)
 * collision should that index ever be added; today the name is free-form
 * (`workers/routes/clients.ts:184-243`).
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface ClientRow {
  id: string;
  user_id: string;
  kind: string;
  name: string;
  oauth_client_id: string | null;
  last_seen_at: number | null;
  ip_address: string | null;
  user_agent: string | null;
  revoked_at: number | null;
  created_at: number;
}

interface ClientsListResponse {
  clients?: ClientRow[];
}

const scenario: Scenario = {
  id: "S-CLI-5",
  description:
    "Connected-client create / list / revoke (kind validation + post-revoke flag)",
  covers:
    "POST /api/users/me/clients 400/400/400/201 → GET list contains row → DELETE → GET shows revoked_at",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. Empty body → 400.
    const noKind = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noKind.status !== 400) {
      throw new Error(
        `POST /clients {} expected 400, got ${noKind.status}: ${noKind.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /clients {} → 400 ✓`);

    // 2. browser kind reserved for auto-rows → 400.
    const browserKind = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'browser', name: 'should fail' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (browserKind.status !== 400) {
      throw new Error(
        `POST /clients {kind:'browser'} expected 400, got ${browserKind.status}: ${browserKind.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /clients {kind:'browser'} → 400 ✓`);

    // 3. mcp kind without name → 400.
    const noName = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'mcp' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noName.status !== 400) {
      throw new Error(
        `POST /clients {kind:'mcp'} expected 400, got ${noName.status}: ${noName.body.slice(0, 200)}`,
      );
    }
    ctx.log(`POST /clients {kind:'mcp'} → 400 ✓`);

    // 4. Valid create.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const clientName = `Test MCP ${runId}`;
    const create = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'mcp', name: ${JSON.stringify(clientName)} }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (create.status !== 201) {
      throw new Error(
        `POST /clients valid expected 201, got ${create.status}: ${create.body.slice(0, 200)}`,
      );
    }
    const created = JSON.parse(create.body) as ClientRow;
    if (typeof created.id !== "string" || !created.id.startsWith("cl")) {
      throw new Error(
        `created.id missing or not 'cl' prefixed: ${create.body.slice(0, 200)}`,
      );
    }
    if (created.kind !== "mcp") {
      throw new Error(`created.kind expected 'mcp', got '${created.kind}'`);
    }
    if (created.revoked_at !== null) {
      throw new Error(
        `created.revoked_at expected null, got ${created.revoked_at}`,
      );
    }
    ctx.log(`POST /clients valid → 201 id=${created.id} ✓`);

    // 5. Listing should include the new row.
    const list = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (list.status !== 200) {
      throw new Error(
        `GET /clients ${list.status}: ${list.body.slice(0, 200)}`,
      );
    }
    const listBody = JSON.parse(list.body) as ClientsListResponse;
    const clients = listBody.clients ?? [];
    const found = clients.find((c) => c.id === created.id);
    if (!found) {
      throw new Error(
        `created client (${created.id}) missing from GET list — got ${clients.length} rows`,
      );
    }
    if (found.revoked_at !== null) {
      throw new Error(
        `pre-revoke list row.revoked_at expected null, got ${found.revoked_at}`,
      );
    }
    ctx.log(`GET /clients contains ${created.id} (revoked_at=null) ✓`);

    // 6. DELETE → revoke.
    const del = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients/' + ${JSON.stringify(created.id)}, {
          method: 'DELETE',
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (del.status !== 200) {
      throw new Error(
        `DELETE /clients/${created.id} expected 200, got ${del.status}: ${del.body.slice(0, 200)}`,
      );
    }
    ctx.log(`DELETE /clients/${created.id} → 200 ✓`);

    // 7. Listing post-revoke — row should now have revoked_at>0.
    const list2 = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/users/me/clients');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    const list2Body = JSON.parse(list2.body) as ClientsListResponse;
    const clients2 = list2Body.clients ?? [];
    const post = clients2.find((c) => c.id === created.id);
    if (!post) {
      throw new Error(
        `revoked client (${created.id}) missing from post-revoke list — got ${clients2.length} rows`,
      );
    }
    if (typeof post.revoked_at !== "number" || post.revoked_at <= 0) {
      throw new Error(
        `post-revoke row.revoked_at expected number>0, got ${post.revoked_at}`,
      );
    }
    ctx.log(`post-revoke row revoked_at=${post.revoked_at} ✓`);
    await ctx.screenshot("after-clients-revoke");

    // The deliberate 400 probes (no kind, browser kind, no name) each
    // log a "Failed to load resource" entry. Tolerate up to 3.
    const consoleSummary = await ctx.captureConsole("after-clients");
    if (consoleSummary.errors > 3) {
      throw new Error(
        `expected ≤3 console errors (the 400 probes), got ${consoleSummary.errors} (see ${consoleSummary.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSummary.errors} (≤3 ✓)`);
  },
};

export default scenario;
