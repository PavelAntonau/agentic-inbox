// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/mcp-credential.ts — per-mailbox MCP credential API.
//
// Mounts at /api/mailboxes (alongside inbox-policies, threads, the V2
// mailbox CRUD router) so the routes resolve as
// /api/mailboxes/:id/mcp-credential.
//
// Endpoints:
//   GET    /api/mailboxes/:id/mcp-credential — read the current binding
//   DELETE /api/mailboxes/:id/mcp-credential — hard-revoke the credential
//
// Both routes require the caller to own the mailbox or hold admin-level
// ACL on it. The MCPPanel (F.8) consumes both paths to render the
// Web|Token tabs and to drive the user's revoke button.
//
// The binding lifecycle is owned by `mcp_inbox_binding` (migration 0017).
// PAT mint writes the binding atomically (F.3); the dispatcher creates
// the OAuth binding on first /mcp call (F.4). This route is the user-
// facing read + revoke surface.

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import {
  deleteBindingForMailbox,
  getBindingForMailbox,
} from "../db/queries/mcp-inbox-binding";
import { hardDeletePatForUser } from "../db/queries/pats";
import { revokeAgentAuthorization } from "../db/queries/grants";
import { writeAudit } from "../lib/audit-log";
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
// Helpers
// ---------------------------------------------------------------------------

type Orm = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Verify the caller may administer `mailboxId`. Owner of the mailbox or
 * admin-level ACL holder both pass. Mirrors the `resolveOwnedMailbox(...,
 * "admin")` posture used by inbox-policies' mutation paths — credential
 * revocation is at least as sensitive as policy mutation.
 *
 * Returns the mailbox row on success, null on no-such-id / not-authorized.
 * The 404 path is intentionally indistinguishable from the 403 path
 * (mirrors agent-authorizations / inbox-policies) — info-non-disclosure.
 */
async function resolveAdminMailbox(
  orm: Orm,
  mailboxId: string,
  userId: string,
): Promise<typeof schema.mailboxes.$inferSelect | null> {
  const mailbox = await orm
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId))
    .get();

  if (!mailbox) return null;
  if (mailbox.owner_user_id === userId) return mailbox;

  const acl = await orm
    .select({ level: schema.mailbox_acls.level })
    .from(schema.mailbox_acls)
    .where(
      and(
        eq(schema.mailbox_acls.mailbox_id, mailboxId),
        eq(schema.mailbox_acls.user_id, userId),
      ),
    )
    .get();

  if (!acl) return null;
  return acl.level === "admin" ? mailbox : null;
}

interface CredentialView {
  kind: "pat" | "oauth" | null;
  // PAT path
  pat_id?: string;
  pat_label?: string | null;
  pat_token_prefix?: string;
  pat_token_suffix?: string;
  pat_created_at?: number;
  pat_last_used_at?: number | null;
  pat_expires_at?: number | null;
  // OAuth path
  oauth_client_id?: string;
  oauth_client_name?: string | null;
  oauth_client_uri?: string | null;
  oauth_client_icon?: string | null;
  oauth_bound_at?: number;
}

/**
 * Hydrate the binding into a UI-ready view: include the PAT label /
 * prefix-suffix for the Token tab, or the OAuth client metadata
 * (name / uri / icon) for the Web tab. Returns `{ kind: null }` for
 * "no credential set" so the panel can render the empty state without
 * a separate 404.
 */
async function hydrateCredentialView(
  orm: Orm,
  userId: string,
  mailboxId: string,
): Promise<CredentialView> {
  const binding = await getBindingForMailbox(orm, userId, mailboxId);
  if (!binding) return { kind: null };

  if (binding.kind === "pat") {
    if (!binding.pat_id) return { kind: null }; // schema CHECK precludes
    const pat = await orm
      .select({
        id: schema.oauth_personal_access_token.id,
        label: schema.oauth_personal_access_token.label,
        tokenPrefix: schema.oauth_personal_access_token.tokenPrefix,
        tokenSuffix: schema.oauth_personal_access_token.tokenSuffix,
        createdAt: schema.oauth_personal_access_token.createdAt,
        lastUsedAt: schema.oauth_personal_access_token.lastUsedAt,
        expiresAt: schema.oauth_personal_access_token.expiresAt,
      })
      .from(schema.oauth_personal_access_token)
      .where(
        and(
          eq(schema.oauth_personal_access_token.id, binding.pat_id),
          eq(schema.oauth_personal_access_token.userId, userId),
        ),
      )
      .get();

    if (!pat) {
      // Binding row references a PAT that no longer exists — invariant
      // breach (CASCADE should have dropped the binding). Surface as
      // empty state so the UI can recover by re-binding; log via audit.
      return { kind: null };
    }

    return {
      kind: "pat",
      pat_id: pat.id,
      pat_label: pat.label,
      pat_token_prefix: pat.tokenPrefix,
      pat_token_suffix: pat.tokenSuffix,
      pat_created_at: pat.createdAt,
      pat_last_used_at: pat.lastUsedAt,
      pat_expires_at: pat.expiresAt,
    };
  }

  // kind === "oauth"
  if (!binding.oauth_client_id) return { kind: null }; // schema CHECK precludes
  const client = await orm
    .select({
      clientId: schema.oauth_client.clientId,
      name: schema.oauth_client.name,
      uri: schema.oauth_client.uri,
      icon: schema.oauth_client.icon,
    })
    .from(schema.oauth_client)
    .where(eq(schema.oauth_client.clientId, binding.oauth_client_id))
    .get();

  return {
    kind: "oauth",
    oauth_client_id: binding.oauth_client_id,
    oauth_client_name: client?.name ?? null,
    oauth_client_uri: client?.uri ?? null,
    oauth_client_icon: client?.icon ?? null,
    oauth_bound_at: binding.created_at,
  };
}

// ---------------------------------------------------------------------------
// GET /api/mailboxes/:id/mcp-credential
// ---------------------------------------------------------------------------

router.get("/:id/mcp-credential", async (c) => {
  const ctx = c.var.authzContext!;
  const mailboxId = c.req.param("id");
  if (!mailboxId) return c.json({ error: "id required" }, 400);

  const orm = drizzle(c.env.DB, { schema });
  const mailbox = await resolveAdminMailbox(orm, mailboxId, ctx.user_id);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const view = await hydrateCredentialView(orm, ctx.user_id, mailboxId);
  return c.json(view);
});

// ---------------------------------------------------------------------------
// DELETE /api/mailboxes/:id/mcp-credential
// ---------------------------------------------------------------------------
//
// Hard-revokes the (user, mailbox) credential, regardless of kind.
//
// PAT path: DELETE FROM oauth_personal_access_token. The binding row is
// dropped by `ON DELETE CASCADE`.
//
// OAuth path: reuse `revokeAgentAuthorization` (atomic batch — tombstone
// + access-token + refresh-token + consent), then explicitly delete the
// binding row. The binding's `oauth_client_id` references `oauth_client`,
// which is global and intentionally NOT deleted by the consent delete —
// so the binding row would otherwise stay after revoke. Two writes (the
// authz batch + the binding delete) are needed because they target
// different keys; the surface is still atomic from the user's
// perspective: by the time we return 204, no JWT minted from the old
// grant survives (tombstone), no new tokens can be minted (consent
// gone), and the binding is clear (next /mcp call re-binds).
//
// 204 No Content on success; 404 when there is no credential to revoke.

router.delete("/:id/mcp-credential", async (c) => {
  const ctx = c.var.authzContext!;
  const mailboxId = c.req.param("id");
  if (!mailboxId) return c.json({ error: "id required" }, 400);

  const orm = drizzle(c.env.DB, { schema });
  const mailbox = await resolveAdminMailbox(orm, mailboxId, ctx.user_id);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const binding = await getBindingForMailbox(orm, ctx.user_id, mailboxId);
  if (!binding) return c.json({ error: "No credential set" }, 404);

  if (binding.kind === "pat") {
    if (!binding.pat_id) {
      return c.json({ error: "Invariant: kind=pat with null pat_id" }, 500);
    }
    const deleted = await hardDeletePatForUser(
      orm,
      ctx.user_id,
      binding.pat_id,
    );
    if (!deleted) {
      // PAT row gone but binding still here — CASCADE should have
      // cleaned up. Force a binding delete to recover the empty state.
      await deleteBindingForMailbox(orm, ctx.user_id, mailboxId);
    }
    await writeAudit(c.env.DB, {
      action: "mcp_credential.revoke",
      target: { kind: "mailbox", id: mailboxId },
      actor: ctx,
      meta: {
        kind: "pat",
        pat_id: binding.pat_id,
        deleted_at: Date.now(),
      },
    });
    return new Response(null, { status: 204 });
  }

  // kind === "oauth"
  if (!binding.oauth_client_id) {
    return c.json(
      { error: "Invariant: kind=oauth with null oauth_client_id" },
      500,
    );
  }
  const result = await revokeAgentAuthorization(
    orm,
    c.env.DB,
    ctx.user_id,
    binding.oauth_client_id,
    Date.now(),
  );
  // The consent row may already be absent (e.g. the user revoked the
  // grant via the Connected Agents card before hitting this route). The
  // binding still needs to come down regardless — drop it and report
  // success so the UI lands in the empty state.
  await deleteBindingForMailbox(orm, ctx.user_id, mailboxId);

  await writeAudit(c.env.DB, {
    action: "mcp_credential.revoke",
    target: { kind: "mailbox", id: mailboxId },
    actor: ctx,
    meta: {
      kind: "oauth",
      oauth_client_id: binding.oauth_client_id,
      consents_deleted: result?.consents_deleted ?? 0,
      access_tokens_deleted: result?.access_tokens_deleted ?? 0,
      refresh_tokens_deleted: result?.refresh_tokens_deleted ?? 0,
      deleted_at: Date.now(),
    },
  });

  return new Response(null, { status: 204 });
});

export default router;
