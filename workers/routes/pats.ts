// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/pats.ts — Personal Access Token API (Phase 3 / T3.1).
//
// Mounts at /api/users/me/pats (see app.ts).
//
// Endpoints:
//   POST   /api/users/me/pats        — create (display-once: full token in response)
//   GET    /api/users/me/pats        — list owner's PATs (prefix/suffix only)
//   DELETE /api/users/me/pats/:id    — revoke (soft-delete via revoked_at)
//
// Owner-only by construction: every read/write filters on authzContext.user_id.
// Cookie auth required (this surface is for the user-facing /account UI; the
// MCP /mcp surface validates PATs by hash via the bearer middleware in T3.3).

import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/control-plane/schema";
import {
  insertPat,
  listPatsForUser,
  revokePatForUser,
} from "../db/queries/pats";
import { mintPat, newPatId } from "../lib/pat-tokens";
import { appendAudit } from "../lib/audit-log";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Auth guard — all PAT routes require an authenticated user
// ---------------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// POST /api/users/me/pats — create a new PAT (display-once)
// ---------------------------------------------------------------------------
//
// Request body:
//   {
//     label:         string  (1..120 chars)
//     scopes:        string[] (≥ 1; allowed values are the mcp:* scopes)
//     mailbox_id?:   string | null
//     ip_allowlist?: string[] | null
//     expires_at?:   number | null   (epoch ms; null = no expiry)
//   }
//
// Response (201):
//   {
//     pat:   PatListRow,            // public projection (no hash, no full token)
//     token: "pat_<base64url>"      // ONLY surfaced in this response
//   }
//
// The token is never persisted in plaintext anywhere. The caller (UI) is
// responsible for one-time display; subsequent GET responses surface
// token_prefix/token_suffix only.

const CreatePatSchema = z
  .object({
    label: z.string().min(1).max(120),
    scopes: z.array(z.string().min(1)).min(1),
    mailbox_id: z.string().min(1).nullable().optional(),
    ip_allowlist: z.array(z.string().min(1)).nullable().optional(),
    expires_at: z.number().int().positive().nullable().optional(),
  })
  .strict();

router.post("/", async (c) => {
  const ctx = c.var.authzContext!;
  const orm = drizzle(c.env.DB, { schema });

  const body = await c.req.json().catch(() => null);
  const parsed = CreatePatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", details: parsed.error.issues },
      400,
    );
  }
  const { label, scopes, mailbox_id, ip_allowlist, expires_at } = parsed.data;

  // expires_at must be in the future when supplied.
  const now = Date.now();
  if (expires_at != null && expires_at <= now) {
    return c.json({ error: "expires_at must be in the future" }, 400);
  }

  const pepper = c.env.TOKEN_PEPPER;
  if (!pepper) {
    throw new Error(
      "TOKEN_PEPPER must be set as a Worker secret in production",
    );
  }
  const minted = await mintPat(pepper);

  const pat = await insertPat(orm, {
    id: newPatId(),
    userId: ctx.user_id,
    label,
    tokenHash: minted.tokenHash,
    tokenPrefix: minted.tokenPrefix,
    tokenSuffix: minted.tokenSuffix,
    scopes,
    mailboxId: mailbox_id ?? null,
    ipAllowlist: ip_allowlist ?? null,
    createdAt: now,
    expiresAt: expires_at ?? null,
  });

  await appendAudit(
    c.env.DB,
    ctx,
    "pat.create",
    { kind: "oauth_personal_access_token", id: pat.id },
    {
      label,
      scopes,
      mailbox_id: mailbox_id ?? null,
      ip_allowlist_count: ip_allowlist?.length ?? 0,
      expires_at: expires_at ?? null,
    },
  );

  return c.json(
    {
      pat,
      token: minted.plaintext, // ONE-TIME — never persisted server-side
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET /api/users/me/pats — list owner's PATs (prefix/suffix only)
// ---------------------------------------------------------------------------
//
// Returns one row per oauth_personal_access_token owned by the caller,
// newest-first. Includes revoked rows; the UI can filter or render a "Revoked"
// badge as it sees fit.

router.get("/", async (c) => {
  const ctx = c.var.authzContext!;
  const orm = drizzle(c.env.DB, { schema });

  const pats = await listPatsForUser(orm, ctx.user_id);
  return c.json(pats);
});

// ---------------------------------------------------------------------------
// DELETE /api/users/me/pats/:id — revoke (soft-delete)
// ---------------------------------------------------------------------------
//
// Sets revoked_at = now. Idempotent at the user-visible level: re-revoking an
// already-revoked PAT or revoking someone else's PAT both return 404 (info-
// non-disclosure, mirrors /api/users/me/agent-authorizations).
//
// 204 No Content on success. T3.3's bearer middleware will reject revoked
// tokens (`WHERE revoked_at IS NULL` filter on the hash lookup).

router.delete("/:id", async (c) => {
  const ctx = c.var.authzContext!;
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id required" }, 400);

  const orm = drizzle(c.env.DB, { schema });
  const now = Date.now();
  const revokedAt = await revokePatForUser(orm, ctx.user_id, id, now);
  if (revokedAt == null) return c.json({ error: "PAT not found" }, 404);

  await appendAudit(
    c.env.DB,
    ctx,
    "pat.revoke",
    { kind: "oauth_personal_access_token", id },
    { revoked_at: revokedAt },
  );

  return new Response(null, { status: 204 });
});

export default router;
