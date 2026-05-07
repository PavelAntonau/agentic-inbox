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
  buildPatInsertStmt,
  hardDeletePatForUser,
  insertPat,
  listPatsForUser,
  projectPatInsert,
  type PatInsert,
} from "../db/queries/pats";
import {
  buildPatBindingInsertStmt,
  isInboxBindingPkConflict,
} from "../db/queries/mcp-inbox-binding";
import { mintPat, newPatId } from "../lib/pat-tokens";
import { writeAudit } from "../lib/audit-log";
import { requireFreshBetterAuthSession } from "../auth";
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

  // Phase G-1 / Task 6 — PAT mint is a sensitive operation; require a fresh
  // better-auth session (≤ 5 min old). CF Access token path (null) is allowed
  // through — that token has its own freshness guarantee from the edge.
  const freshness = await requireFreshBetterAuthSession(c.env, c.req.raw);
  if (freshness !== null && !freshness.fresh) {
    void writeAudit(c.env.DB, {
      action: "auth.fresh_session_denied",
      target: { kind: "user", id: ctx.user_id },
      meta: { operation: "pat.create" },
      actor: ctx,
    });
    return c.json(
      {
        error: "Session too old for this operation",
        code: "FRESH_SESSION_REQUIRED",
      },
      401,
    );
  }

  // Phase G-1 / Task 10 — emit audit for PAT mint (auth.pat_minted namespace).
  // The existing `pat.create` writeAudit below covers the successful case;
  // the FRESH_SESSION_DENIED case is handled above. We emit auth.pat_minted
  // after the insert so it only fires when the mint actually succeeds.

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

  const insertInput: PatInsert = {
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
  };

  // Phase F (one-inbox-one-client): when the PAT is mailbox-scoped, the
  // mint must atomically insert the matching mcp_inbox_binding row so
  // that a pre-existing binding for (user, mailbox) aborts the whole
  // mint via SQLITE_CONSTRAINT_PRIMARYKEY. Without the batch, the PAT
  // row would land first and only the binding would 409, leaving a
  // dangling token behind.
  let pat;
  if (insertInput.mailboxId != null) {
    const patStmt = buildPatInsertStmt(c.env.DB, insertInput);
    const bindingStmt = buildPatBindingInsertStmt(c.env.DB, {
      userId: insertInput.userId,
      mailboxId: insertInput.mailboxId,
      patId: insertInput.id,
      now,
    });
    try {
      await c.env.DB.batch([patStmt, bindingStmt]);
    } catch (err) {
      if (isInboxBindingPkConflict(err)) {
        return c.json(
          {
            error: "inbox-credential-exists",
            detail:
              "This inbox already has an active MCP credential. Revoke the existing one before minting a new PAT.",
          },
          409,
        );
      }
      throw err;
    }
    pat = projectPatInsert(insertInput);
  } else {
    pat = await insertPat(orm, insertInput);
  }

  await writeAudit(c.env.DB, {
    action: "pat.create",
    target: { kind: "oauth_personal_access_token", id: pat.id },
    actor: ctx,
    meta: {
      label,
      scopes,
      mailbox_id: mailbox_id ?? null,
      ip_allowlist_count: ip_allowlist?.length ?? 0,
      expires_at: expires_at ?? null,
    },
  });

  // Phase G-1 / Task 10 — auth.pat_minted security audit event.
  void writeAudit(c.env.DB, {
    action: "auth.pat_minted",
    target: { kind: "oauth_personal_access_token", id: pat.id },
    actor: ctx,
    meta: { label, scopes, mailbox_id: mailbox_id ?? null },
  });

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
// DELETE /api/users/me/pats/:id — hard-delete
// ---------------------------------------------------------------------------
//
// Phase F (one-inbox-one-client, 2026-05-06): hard-deletes the PAT row.
// `ON DELETE CASCADE` on `mcp_inbox_binding.pat_id` drops the matching
// binding sentinel row in the same statement, freeing the (user, mailbox)
// pair for a fresh mint or for an OAuth-client bind on the next /mcp call.
// The audit-log row stays (server log retained per spec).
//
// Idempotent at the user-visible level: deleting a non-existent PAT or
// another user's PAT both return 404 (info-non-disclosure, mirrors
// /api/users/me/agent-authorizations).
//
// 204 No Content on success. The bearer middleware's `revoked_at IS NULL`
// filter remains for legacy soft-revoked rows but is moot for new
// deletes — the row is gone, so the SELECT returns nothing.

router.delete("/:id", async (c) => {
  const ctx = c.var.authzContext!;
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id required" }, 400);

  const orm = drizzle(c.env.DB, { schema });
  const deleted = await hardDeletePatForUser(orm, ctx.user_id, id);
  if (!deleted) return c.json({ error: "PAT not found" }, 404);

  await writeAudit(c.env.DB, {
    action: "pat.delete",
    target: { kind: "oauth_personal_access_token", id },
    actor: ctx,
    meta: { deleted_at: Date.now() },
  });

  return new Response(null, { status: 204 });
});

export default router;
