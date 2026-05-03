// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/tokens.ts — agent-token CRUD endpoints.
//
// Mounted at:
//   /api/tokens/mailboxes/:mailboxId/tokens  (issue + list per-mailbox)
//   /api/tokens/:tokenId/revoke              (revoke by token id)
//   /api/admin/tokens                        (admin-wide list, global only)
//
// Revocation order (SPEC-REQUIRED):
//   1. RevocationCache.revoke(cf_client_id)   ← local cache first
//   2. deleteServiceToken(cf_service_token_id) ← CF DELETE (mock in dev)
//   3. UPDATE agent_tokens.revoked_at          ← DB record last

import { Hono } from "hono";
import { eq, desc, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";
import { appendAudit } from "../lib/audit-log";
import {
  canIssueToken,
  canListTokens,
  canRevokeToken,
} from "../lib/mailbox-token-permissions";
import {
  createServiceToken,
  deleteServiceToken,
  mockCreateServiceToken,
  mockDeleteServiceToken,
} from "../lib/cloudflare-access-service-tokens";
import { getSettings } from "../lib/settings-cache";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Auth guard — all token routes require authenticated user
// ---------------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 of secret with TOKEN_PEPPER. Falls back to a no-op hash in dev. */
async function hashSecret(secret: string, pepper: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(secret));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isDev(env: Env): boolean {
  return (
    !env.CF_ACCOUNT_ID || !env.CF_ACCESS_API_TOKEN || !!env.CF_ACCESS_DEV_MODE
  );
}

// ---------------------------------------------------------------------------
// GET /api/admin/tokens — admin-wide list (global_owner / global_admin only)
// ---------------------------------------------------------------------------

router.get("/admin/tokens", async (c) => {
  const ctx = c.var.authzContext!;
  if (ctx.role !== "global_owner" && ctx.role !== "global_admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const orm = drizzle(c.env.DB, { schema });
  const tokens = await orm
    .select({
      id: schema.agent_tokens.id,
      cf_client_id: schema.agent_tokens.cf_client_id,
      mailbox_id: schema.agent_tokens.mailbox_id,
      issued_to_user: schema.agent_tokens.issued_to_user,
      label: schema.agent_tokens.label,
      max_instances: schema.agent_tokens.max_instances,
      created_at: schema.agent_tokens.created_at,
      last_seen_at: schema.agent_tokens.last_seen_at,
      revoked_at: schema.agent_tokens.revoked_at,
    })
    .from(schema.agent_tokens)
    .orderBy(desc(schema.agent_tokens.created_at))
    .all();

  return c.json({ tokens });
});

// ---------------------------------------------------------------------------
// GET /api/tokens/mailboxes/:mailboxId/tokens — per-mailbox list
// ---------------------------------------------------------------------------

router.get("/mailboxes/:mailboxId/tokens", async (c) => {
  const ctx = c.var.authzContext!;
  const { mailboxId } = c.req.param();
  const orm = drizzle(c.env.DB, { schema });

  const mailbox = await orm
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId))
    .get();
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const perm = canListTokens(ctx, mailbox);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  const tokens = await orm
    .select({
      id: schema.agent_tokens.id,
      cf_client_id: schema.agent_tokens.cf_client_id,
      label: schema.agent_tokens.label,
      max_instances: schema.agent_tokens.max_instances,
      created_at: schema.agent_tokens.created_at,
      last_seen_at: schema.agent_tokens.last_seen_at,
      revoked_at: schema.agent_tokens.revoked_at,
    })
    .from(schema.agent_tokens)
    .where(eq(schema.agent_tokens.mailbox_id, mailboxId))
    .orderBy(desc(schema.agent_tokens.created_at))
    .all();

  return c.json({ tokens });
});

// ---------------------------------------------------------------------------
// POST /api/tokens/mailboxes/:mailboxId/tokens — issue new token
// ---------------------------------------------------------------------------

const IssueTokenSchema = z.object({
  label: z.string().min(1).max(120),
  max_instances: z.number().int().min(1).max(20).default(1),
  duration: z.string().default("2160h"),
});

router.post("/mailboxes/:mailboxId/tokens", async (c) => {
  const ctx = c.var.authzContext!;
  const { mailboxId } = c.req.param();
  const orm = drizzle(c.env.DB, { schema });

  const mailbox = await orm
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId))
    .get();
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const perm = canIssueToken(ctx, mailbox);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = IssueTokenSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", details: parsed.error.issues },
      400,
    );
  }
  const { label, max_instances, duration } = parsed.data;

  // Create CF Access service token (real in prod, mock in dev)
  const tokenName = `${mailboxId}:${ctx.user_id}:${label}`;
  let cfToken: Awaited<ReturnType<typeof createServiceToken>>;

  if (isDev(c.env)) {
    cfToken = mockCreateServiceToken({ name: tokenName, duration });
  } else {
    cfToken = await createServiceToken(
      c.env.CF_ACCOUNT_ID!,
      c.env.CF_ACCESS_API_TOKEN!,
      { name: tokenName, duration },
    );
  }

  // HMAC-SHA256 the secret with TOKEN_PEPPER
  const pepper = c.env.TOKEN_PEPPER ?? "dev-pepper";
  const secretHash = await hashSecret(cfToken.client_secret, pepper);

  // Persist to D1
  const tokenId = newId();
  const now = Date.now();
  await orm.insert(schema.agent_tokens).values({
    id: tokenId,
    cf_service_token_id: cfToken.id,
    cf_client_id: cfToken.client_id,
    secret_hash: secretHash,
    mailbox_id: mailboxId,
    issued_to_user: ctx.user_id,
    label,
    max_instances,
    created_at: now,
    last_seen_at: null,
    revoked_at: null,
  });

  // Audit
  await appendAudit(
    c.env.DB,
    ctx,
    "token.issue",
    { kind: "agent_token", id: tokenId },
    {
      label,
      mailbox_id: mailboxId,
      cf_client_id: cfToken.client_id,
      max_instances,
    },
  );

  // Return plaintext secret ONLY for this response
  return c.json(
    {
      token: {
        id: tokenId,
        cf_client_id: cfToken.client_id,
        client_secret: cfToken.client_secret, // ONE-TIME
        label,
        max_instances,
        created_at: now,
        expires_at: cfToken.expires_at,
      },
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// POST /api/tokens/:tokenId/revoke — revoke a token
// ---------------------------------------------------------------------------

router.post("/:tokenId/revoke", async (c) => {
  const ctx = c.var.authzContext!;
  const { tokenId } = c.req.param();
  const orm = drizzle(c.env.DB, { schema });

  const token = await orm
    .select()
    .from(schema.agent_tokens)
    .where(eq(schema.agent_tokens.id, tokenId))
    .get();
  if (!token) return c.json({ error: "Token not found" }, 404);
  if (token.revoked_at) return c.json({ error: "Token already revoked" }, 409);

  const mailbox = await orm
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, token.mailbox_id))
    .get();
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const perm = canRevokeToken(ctx, mailbox, token);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  const cfClientId = token.cf_client_id;
  const cfServiceTokenId = token.cf_service_token_id;
  const now = Date.now();

  // Step 1: RevocationCache — local revoke FIRST (prevents race-window misses)
  if (cfClientId) {
    const cacheId = c.env.REVOCATION_CACHE.idFromName(`account`);
    const cacheStub = c.env.REVOCATION_CACHE.get(cacheId);
    await cacheStub.fetch(
      new Request("http://do/revoke", {
        method: "POST",
        body: JSON.stringify({ cf_client_id: cfClientId }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Also revoke instances in AgentTokenLimiter
    const limiterId = c.env.AGENT_TOKEN_LIMITER.idFromName(tokenId);
    const limiterStub = c.env.AGENT_TOKEN_LIMITER.get(limiterId);
    await limiterStub.fetch(
      new Request("http://do/revoke", { method: "POST" }),
    );
  }

  // Step 2: Cloudflare DELETE (mock in dev)
  if (cfServiceTokenId) {
    try {
      if (isDev(c.env)) {
        mockDeleteServiceToken(cfServiceTokenId);
      } else {
        await deleteServiceToken(
          c.env.CF_ACCOUNT_ID!,
          c.env.CF_ACCESS_API_TOKEN!,
          cfServiceTokenId,
        );
      }
    } catch (err) {
      // Log but don't fail — local revocation already happened
      console.error(
        "CF service token delete failed (local revoke already applied):",
        err,
      );
    }
  }

  // Step 3: Update DB record
  await orm
    .update(schema.agent_tokens)
    .set({ revoked_at: now })
    .where(eq(schema.agent_tokens.id, tokenId));

  // Audit
  await appendAudit(
    c.env.DB,
    ctx,
    "token.revoke",
    { kind: "agent_token", id: tokenId },
    {
      mailbox_id: token.mailbox_id,
      cf_client_id: cfClientId,
    },
  );

  return c.json({ ok: true, revoked_at: now });
});

export default router;
