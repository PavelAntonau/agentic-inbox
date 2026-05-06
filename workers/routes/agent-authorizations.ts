// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/agent-authorizations.ts — Connected Agents API (Phase 2 / T2.3).
//
// Mounts at /api/users/me/agent-authorizations (see app.ts).
//
// Endpoints:
//   GET    /api/users/me/agent-authorizations              — list grants
//   DELETE /api/users/me/agent-authorizations/:clientId    — revoke (RFC 7009)
//
// Owner-only by construction: every read/write filters on authzContext.user_id.
// Cookie auth required (no /mcp bearer tokens reach this surface — cookies are
// rejected on /mcp by the bearer middleware, and this router is mounted under
// the cookie-gated /api/users/me/* tree).

import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { TRUSTED_CLIENT_IDS } from "~/lib/cached-trusted-clients";
import * as schema from "../db/control-plane/schema";
import {
  listAgentAuthorizations,
  revokeAgentAuthorization,
} from "../db/queries/grants";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Auth guard — all routes require an authenticated user
// ---------------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// GET /api/users/me/agent-authorizations — list owner's grants
// ---------------------------------------------------------------------------
//
// Returns one row per oauth_consent owned by the caller. Each row is
// enriched with:
//   - client metadata (name / uri / icon) from oauth_client
//   - parsed scopes (JSON-array or whitespace-delimited tolerated)
//   - granted_at  — oauth_consent.created_at
//   - last_used_at — max(oauth_access_token.created_at) for the (user, client)
//   - is_trusted  — derived from the cached trusted-client allowlist (T1.6)
//
// The response is shaped for direct rendering by the Connected Agents card on
// /account (T2.4): one card per row.

router.get("/", async (c) => {
  const ctx = c.var.authzContext!;
  const orm = drizzle(c.env.DB, { schema });

  const rows = await listAgentAuthorizations(orm, ctx.user_id);

  return c.json(
    rows.map((r) => ({
      client_id: r.client_id,
      client_name: r.client_name,
      client_uri: r.client_uri,
      client_icon: r.client_icon,
      scopes: r.scopes,
      granted_at: r.granted_at,
      last_used_at: r.last_used_at,
      is_trusted: TRUSTED_CLIENT_IDS.has(r.client_id),
    })),
  );
});

// ---------------------------------------------------------------------------
// DELETE /api/users/me/agent-authorizations/:clientId — revoke
// ---------------------------------------------------------------------------
//
// User-side analog of RFC 7009: revoke the entire grant for (caller, client).
// Deletes every access token, refresh token, and consent row for that
// (user, client) pair. The oauth_client row stays — it's a global registration.
//
// 204 No Content on success.
// 404 when no consent row owned by the caller exists for `clientId` (this also
// covers the "wrong owner" case — owner-only by construction).
//
// D1 strong consistency means the next /mcp request from the revoked client
// fails token verification within seconds (the JWT remains signature-valid
// until expiry, but verifying a refresh-rotation produces no new access
// token, and any in-DB opaque/refresh paths return 404 immediately).

router.delete("/:clientId", async (c) => {
  const ctx = c.var.authzContext!;
  const clientId = c.req.param("clientId");
  if (!clientId) {
    return c.json({ error: "client_id required" }, 400);
  }
  const orm = drizzle(c.env.DB, { schema });

  // Phase C2 / TASK-C2.2: pass the D1 binding so the revoke runs as a
  // single d1.batch transaction (insert tombstone + delete access tokens
  // + delete refresh tokens + delete consent). Closes the audit A-03
  // race window.
  const result = await revokeAgentAuthorization(
    orm,
    c.env.DB,
    ctx.user_id,
    clientId,
  );
  if (!result) {
    return c.json({ error: "Authorization not found" }, 404);
  }

  return new Response(null, { status: 204 });
});

export default router;
