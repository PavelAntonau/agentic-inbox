// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/clients.ts — unified client management endpoints (Phase 2).
//
// Mounts at /api/users/me/clients and /api/users/me/clients/:id/grants (see app.ts).
//
// A "Client" is the unified model for any credential/session that grants inbox access.
// Browser sessions (better-auth `session` table) are projected as kind='browser' at
// read-time (UNION approach). Non-browser clients are persisted in the `clients` table.
//
// Endpoints:
//   GET    /api/users/me/clients               — list all clients (browser + stored)
//   POST   /api/users/me/clients               — create new non-browser client
//   DELETE /api/users/me/clients/:id           — revoke a client
//   GET    /api/users/me/clients/:id/grants    — list grants for a client
//   POST   /api/users/me/clients/:id/grants    — create a grant
//   DELETE /api/users/me/clients/:id/grants/:grantId — revoke a grant

import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Auth guard — all client routes require an authenticated user
// ---------------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random hex id. */
function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return (
    prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Derive a human-readable client name from a User-Agent string.
 * Identifies major browsers and OS combos; falls back to a generic label.
 */
function parseUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown browser";
  const s = ua.toLowerCase();
  if (s.includes("edg/") || s.includes("edge/")) return "Microsoft Edge";
  if (s.includes("chrome") && !s.includes("chromium")) return "Chrome";
  if (s.includes("firefox")) return "Firefox";
  if (s.includes("safari") && !s.includes("chrome")) return "Safari";
  if (s.includes("curl")) return "curl";
  return "Browser";
}

// ---------------------------------------------------------------------------
// GET /api/users/me/clients — list all clients (browser sessions UNION stored clients)
// ---------------------------------------------------------------------------
//
// Browser sessions come from the better-auth `session` table. Each is projected
// as kind='browser' with a synthetic id of 'session:<session_id>'. The current
// request's session (ctx.session_id) is flagged is_current=true.
//
// Stored clients come from the `clients` table. Both active and revoked rows are
// returned (revoked ones have revoked_at set). Active rows include their grants.

router.get("/", async (c) => {
  const ctx = c.var.authzContext!;
  const orm = drizzle(c.env.DB, { schema });
  const now = Date.now();
  const currentSessionId = ctx.session_id ?? null;

  // 1. Browser sessions — non-expired rows from better-auth session table
  const sessionRows = await orm
    .select({
      id: schema.session.id,
      expiresAt: schema.session.expiresAt,
      ipAddress: schema.session.ipAddress,
      userAgent: schema.session.userAgent,
      createdAt: schema.session.createdAt,
      updatedAt: schema.session.updatedAt,
    })
    .from(schema.session)
    .where(eq(schema.session.userId, ctx.user_id))
    .all();

  const browserClients = sessionRows
    .filter((r) => {
      const exp =
        typeof r.expiresAt === "number" ? r.expiresAt : Number(r.expiresAt);
      return exp > now;
    })
    .map((r) => ({
      id: `session:${r.id}`,
      kind: "browser" as const,
      name: parseUserAgent(r.userAgent),
      oauth_client_id: null,
      last_seen_at: r.updatedAt ?? r.createdAt,
      ip_address: r.ipAddress ?? null,
      user_agent: r.userAgent ?? null,
      revoked_at: null,
      created_at: r.createdAt,
      is_current: r.id === currentSessionId,
      grants: [] as Array<{
        inbox_id: string;
        scope: string;
        granted_at: number;
      }>,
    }));

  // 2. Stored clients (includes revoked)
  const storedRows = await orm
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.user_id, ctx.user_id))
    .all();

  // Fetch active grants for each stored client
  const storedClients = await Promise.all(
    storedRows.map(async (client) => {
      const grants = await orm
        .select({
          inbox_id: schema.clientGrants.inbox_id,
          scope: schema.clientGrants.scope,
          granted_at: schema.clientGrants.granted_at,
        })
        .from(schema.clientGrants)
        .where(
          and(
            eq(schema.clientGrants.client_id, client.id),
            isNull(schema.clientGrants.revoked_at),
          ),
        )
        .all();

      return {
        id: client.id,
        kind: client.kind,
        name: client.name,
        oauth_client_id: client.oauth_client_id ?? null,
        last_seen_at: client.last_seen_at ?? null,
        ip_address: client.ip_address ?? null,
        user_agent: client.user_agent ?? null,
        revoked_at: client.revoked_at ?? null,
        created_at: client.created_at,
        is_current: false as boolean,
        grants,
      };
    }),
  );

  // Sort: active stored first (revoked_at IS NULL), then browser sessions, then revoked
  const activeStored = storedClients.filter((c) => c.revoked_at === null);
  const revokedStored = storedClients.filter((c) => c.revoked_at !== null);
  const allClients = [...activeStored, ...browserClients, ...revokedStored];

  return c.json({ clients: allClients });
});

// ---------------------------------------------------------------------------
// POST /api/users/me/clients — create a new non-browser client (manual placeholder)
// ---------------------------------------------------------------------------
//
// Browser clients are created implicitly via better-auth sessions; they cannot
// be created via this endpoint (kind='browser' is rejected with 400).
//
// Phase 3 OAuth registration will write real mcp clients; this endpoint serves
// as a placeholder for manual MCP/ios/desktop/other clients.

router.post("/", async (c) => {
  const ctx = c.var.authzContext!;
  const orm = drizzle(c.env.DB, { schema });

  let body: { kind?: unknown; name?: unknown; oauth_client_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { kind, name, oauth_client_id } = body;

  const allowedKinds = ["mcp", "ios", "desktop", "other"] as const;
  if (!kind || !allowedKinds.includes(kind as (typeof allowedKinds)[number])) {
    return c.json(
      {
        error:
          "kind must be one of: mcp, ios, desktop, other (browser not allowed via POST)",
      },
      400,
    );
  }
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  if (oauth_client_id !== undefined && typeof oauth_client_id !== "string") {
    return c.json(
      { error: "oauth_client_id must be a string if provided" },
      400,
    );
  }

  const now = Date.now();
  const id = newId("cl");

  await orm
    .insert(schema.clients)
    .values({
      id,
      user_id: ctx.user_id,
      kind: kind as (typeof allowedKinds)[number],
      name: name.trim(),
      oauth_client_id: oauth_client_id ?? null,
      last_seen_at: null,
      ip_address: null,
      user_agent: null,
      revoked_at: null,
      created_at: now,
    })
    .run();

  const created = await orm
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.id, id))
    .get();

  return c.json(created, 201);
});

// ---------------------------------------------------------------------------
// DELETE /api/users/me/clients/:id — revoke a client
// ---------------------------------------------------------------------------
//
// Sets revoked_at=now(). 404 if the client doesn't exist or belongs to a
// different user. 200 + { revoked: true } on success.
//
// Browser sessions (id starts with 'session:') are deleted from the session table.

router.delete("/:id", async (c) => {
  const ctx = c.var.authzContext!;
  const clientId = c.req.param("id");
  const orm = drizzle(c.env.DB, { schema });
  const now = Date.now();

  // Handle browser-session synthetic IDs
  if (clientId.startsWith("session:")) {
    const sessionId = clientId.slice("session:".length);
    const row = await orm
      .select({ id: schema.session.id, userId: schema.session.userId })
      .from(schema.session)
      .where(
        and(
          eq(schema.session.id, sessionId),
          eq(schema.session.userId, ctx.user_id),
        ),
      )
      .get();
    if (!row) return c.json({ error: "Client not found" }, 404);

    await orm
      .delete(schema.session)
      .where(eq(schema.session.id, sessionId))
      .run();
    return c.json({ revoked: true });
  }

  // Stored client
  const client = await orm
    .select({
      id: schema.clients.id,
      user_id: schema.clients.user_id,
      revoked_at: schema.clients.revoked_at,
    })
    .from(schema.clients)
    .where(
      and(
        eq(schema.clients.id, clientId),
        eq(schema.clients.user_id, ctx.user_id),
      ),
    )
    .get();

  if (!client) return c.json({ error: "Client not found" }, 404);
  if (client.revoked_at !== null) return c.json({ revoked: true }); // already revoked

  await orm
    .update(schema.clients)
    .set({ revoked_at: now })
    .where(eq(schema.clients.id, clientId))
    .run();

  return c.json({ revoked: true });
});

// ---------------------------------------------------------------------------
// GET /api/users/me/clients/:id/grants — list grants for a client
// ---------------------------------------------------------------------------

router.get("/:id/grants", async (c) => {
  const ctx = c.var.authzContext!;
  const clientId = c.req.param("id");
  const orm = drizzle(c.env.DB, { schema });

  // Browser sessions have no stored grants
  if (clientId.startsWith("session:")) {
    return c.json({ grants: [] });
  }

  // Verify ownership
  const client = await orm
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(
      and(
        eq(schema.clients.id, clientId),
        eq(schema.clients.user_id, ctx.user_id),
      ),
    )
    .get();

  if (!client) return c.json({ error: "Client not found" }, 404);

  const grants = await orm
    .select()
    .from(schema.clientGrants)
    .where(
      and(
        eq(schema.clientGrants.client_id, clientId),
        isNull(schema.clientGrants.revoked_at),
      ),
    )
    .all();

  return c.json({ grants });
});

// ---------------------------------------------------------------------------
// POST /api/users/me/clients/:id/grants — create a grant
// ---------------------------------------------------------------------------
//
// Validates:
//  - scope in ('read', 'write')
//  - the caller owns the target inbox (via mailboxes.owner_user_id OR mailbox_acls)
//  - no active duplicate (client_id, inbox_id, scope) — returns 409 on conflict

router.post("/:id/grants", async (c) => {
  const ctx = c.var.authzContext!;
  const clientId = c.req.param("id");
  const orm = drizzle(c.env.DB, { schema });

  // Browser-session clients don't support stored grants
  if (clientId.startsWith("session:")) {
    return c.json(
      { error: "Browser session clients do not support grants" },
      400,
    );
  }

  // Verify client ownership
  const client = await orm
    .select({ id: schema.clients.id, revoked_at: schema.clients.revoked_at })
    .from(schema.clients)
    .where(
      and(
        eq(schema.clients.id, clientId),
        eq(schema.clients.user_id, ctx.user_id),
      ),
    )
    .get();

  if (!client) return c.json({ error: "Client not found" }, 404);
  if (client.revoked_at !== null)
    return c.json({ error: "Client is revoked" }, 400);

  let body: { inbox_id?: unknown; scope?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { inbox_id, scope } = body;

  if (!inbox_id || typeof inbox_id !== "string") {
    return c.json({ error: "inbox_id is required" }, 400);
  }
  if (scope !== "read" && scope !== "write") {
    return c.json({ error: "scope must be 'read' or 'write'" }, 400);
  }

  // Verify the caller owns or has write-level ACL on the inbox
  const inbox = await orm
    .select({
      id: schema.mailboxes.id,
      owner_user_id: schema.mailboxes.owner_user_id,
    })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, inbox_id))
    .get();

  if (!inbox) return c.json({ error: "Inbox not found" }, 404);

  const isOwner = inbox.owner_user_id === ctx.user_id;
  if (!isOwner) {
    // Check mailbox_acls for write or admin level
    const acl = await orm
      .select({ level: schema.mailbox_acls.level })
      .from(schema.mailbox_acls)
      .where(
        and(
          eq(schema.mailbox_acls.mailbox_id, inbox_id),
          eq(schema.mailbox_acls.user_id, ctx.user_id),
        ),
      )
      .get();

    const hasAccess = acl && (acl.level === "write" || acl.level === "admin");
    if (!hasAccess) {
      return c.json({ error: "Inbox not found or access denied" }, 404);
    }
  }

  // Check for existing active grant (UNIQUE conflict guard)
  const existing = await orm
    .select({ id: schema.clientGrants.id })
    .from(schema.clientGrants)
    .where(
      and(
        eq(schema.clientGrants.client_id, clientId),
        eq(schema.clientGrants.inbox_id, inbox_id),
        eq(schema.clientGrants.scope, scope as "read" | "write"),
        isNull(schema.clientGrants.revoked_at),
      ),
    )
    .get();

  if (existing) {
    return c.json(
      {
        error:
          "Grant already exists for this (client, inbox, scope) combination",
      },
      409,
    );
  }

  const now = Date.now();
  const grantId = newId("cg");

  await orm
    .insert(schema.clientGrants)
    .values({
      id: grantId,
      client_id: clientId,
      inbox_id,
      scope: scope as "read" | "write",
      granted_at: now,
      revoked_at: null,
    })
    .run();

  const grant = await orm
    .select()
    .from(schema.clientGrants)
    .where(eq(schema.clientGrants.id, grantId))
    .get();

  return c.json(grant, 201);
});

// ---------------------------------------------------------------------------
// DELETE /api/users/me/clients/:id/grants/:grantId — revoke a grant
// ---------------------------------------------------------------------------
//
// Sets revoked_at=now(). 404 if not found or not owned. 200 on success.

router.delete("/:id/grants/:grantId", async (c) => {
  const ctx = c.var.authzContext!;
  const clientId = c.req.param("id");
  const grantId = c.req.param("grantId");
  const orm = drizzle(c.env.DB, { schema });
  const now = Date.now();

  // Verify client ownership
  const client = await orm
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(
      and(
        eq(schema.clients.id, clientId),
        eq(schema.clients.user_id, ctx.user_id),
      ),
    )
    .get();

  if (!client) return c.json({ error: "Client not found" }, 404);

  const grant = await orm
    .select({
      id: schema.clientGrants.id,
      revoked_at: schema.clientGrants.revoked_at,
    })
    .from(schema.clientGrants)
    .where(
      and(
        eq(schema.clientGrants.id, grantId),
        eq(schema.clientGrants.client_id, clientId),
      ),
    )
    .get();

  if (!grant) return c.json({ error: "Grant not found" }, 404);
  if (grant.revoked_at !== null) return c.json({ revoked: true }); // already revoked

  await orm
    .update(schema.clientGrants)
    .set({ revoked_at: now })
    .where(eq(schema.clientGrants.id, grantId))
    .run();

  return c.json({ revoked: true });
});

export default router;
