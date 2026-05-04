// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/inbox-policies.ts — inbox inbound policy endpoints (Phase 2).
//
// Mounts at /api/mailboxes (see app.ts — registered alongside existing mailboxes router).
// The routes are registered on the SAME prefix path as the mailboxes router so they
// resolve as /api/mailboxes/:id/policies and /api/mailboxes/:id/policies/allowlist/:entryId.
//
// Endpoints:
//   GET    /api/mailboxes/:id/policies                        — get policy state
//   PATCH  /api/mailboxes/:id/policies                        — update policy fields
//   POST   /api/mailboxes/:id/policies/allowlist              — add allowlist entry
//   DELETE /api/mailboxes/:id/policies/allowlist/:entryId     — remove allowlist entry

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Auth guard — all inbox-policy routes require an authenticated user
// ---------------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random hex id with optional prefix. */
function newId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return (
    prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Resolve a mailbox and verify ownership (or write/admin ACL).
 * Returns the full mailbox row, or null if not found / access denied.
 */
async function resolveOwnedMailbox(
  orm: ReturnType<typeof drizzle>,
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

  // Check mailbox_acls for write or admin level
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

  if (acl && (acl.level === "write" || acl.level === "admin")) return mailbox;
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/mailboxes/:id/policies — get policy state
// ---------------------------------------------------------------------------
//
// Returns current policy fields plus the full allowlist.
// 404 if mailbox not found or caller does not own/have write access to it.

router.get("/:id/policies", async (c) => {
  const ctx = c.var.authzContext!;
  const mailboxId = c.req.param("id");
  const orm = drizzle(c.env.DB, { schema });

  const mailbox = await resolveOwnedMailbox(orm, mailboxId, ctx.user_id);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const allowlist = await orm
    .select()
    .from(schema.inboxExternalAllowlist)
    .where(eq(schema.inboxExternalAllowlist.inbox_id, mailboxId))
    .all();

  return c.json({
    external_inbound_enabled: mailbox.external_inbound_enabled,
    external_send_enabled: mailbox.external_send_enabled,
    external_allow_mode: mailbox.external_allow_mode,
    internal_inbound_mode: mailbox.internal_inbound_mode,
    allowlist: allowlist.map((e) => ({
      id: e.id,
      sender_pattern: e.sender_pattern,
      kind: e.kind,
      created_at: e.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/mailboxes/:id/policies — update any subset of policy fields
// ---------------------------------------------------------------------------
//
// Accepts any combination of: external_inbound_enabled, external_send_enabled,
// external_allow_mode, internal_inbound_mode. Unknown fields are ignored.
// Returns the updated state.

router.patch("/:id/policies", async (c) => {
  const ctx = c.var.authzContext!;
  const mailboxId = c.req.param("id");
  const orm = drizzle(c.env.DB, { schema });

  const mailbox = await resolveOwnedMailbox(orm, mailboxId, ctx.user_id);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  let body: {
    external_inbound_enabled?: unknown;
    external_send_enabled?: unknown;
    external_allow_mode?: unknown;
    internal_inbound_mode?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates: {
    external_inbound_enabled?: boolean;
    external_send_enabled?: boolean;
    external_allow_mode?: "all" | "allowlist";
    internal_inbound_mode?: "everyone" | "contacts_only" | "none";
  } = {};

  if ("external_inbound_enabled" in body) {
    const v = body.external_inbound_enabled;
    if (typeof v !== "boolean") {
      return c.json(
        { error: "external_inbound_enabled must be a boolean" },
        400,
      );
    }
    updates.external_inbound_enabled = v;
  }

  if ("external_send_enabled" in body) {
    const v = body.external_send_enabled;
    if (typeof v !== "boolean") {
      return c.json({ error: "external_send_enabled must be a boolean" }, 400);
    }
    updates.external_send_enabled = v;
  }

  if ("external_allow_mode" in body) {
    const v = body.external_allow_mode;
    if (v !== "all" && v !== "allowlist") {
      return c.json(
        { error: "external_allow_mode must be 'all' or 'allowlist'" },
        400,
      );
    }
    updates.external_allow_mode = v;
  }

  if ("internal_inbound_mode" in body) {
    const v = body.internal_inbound_mode;
    if (v !== "everyone" && v !== "contacts_only" && v !== "none") {
      return c.json(
        {
          error:
            "internal_inbound_mode must be 'everyone', 'contacts_only', or 'none'",
        },
        400,
      );
    }
    updates.internal_inbound_mode = v;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No recognised fields to update" }, 400);
  }

  await orm
    .update(schema.mailboxes)
    .set(updates)
    .where(eq(schema.mailboxes.id, mailboxId))
    .run();

  // Re-fetch the updated row
  const updated = await orm
    .select({
      external_inbound_enabled: schema.mailboxes.external_inbound_enabled,
      external_send_enabled: schema.mailboxes.external_send_enabled,
      external_allow_mode: schema.mailboxes.external_allow_mode,
      internal_inbound_mode: schema.mailboxes.internal_inbound_mode,
    })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId))
    .get();

  const allowlist = await orm
    .select()
    .from(schema.inboxExternalAllowlist)
    .where(eq(schema.inboxExternalAllowlist.inbox_id, mailboxId))
    .all();

  return c.json({
    external_inbound_enabled: updated!.external_inbound_enabled,
    external_send_enabled: updated!.external_send_enabled,
    external_allow_mode: updated!.external_allow_mode,
    internal_inbound_mode: updated!.internal_inbound_mode,
    allowlist: allowlist.map((e) => ({
      id: e.id,
      sender_pattern: e.sender_pattern,
      kind: e.kind,
      created_at: e.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/mailboxes/:id/policies/allowlist — add an allowlist entry
// ---------------------------------------------------------------------------
//
// body: { sender_pattern: string, kind: 'email' | 'domain' }
// Returns 201 + the new entry.

router.post("/:id/policies/allowlist", async (c) => {
  const ctx = c.var.authzContext!;
  const mailboxId = c.req.param("id");
  const orm = drizzle(c.env.DB, { schema });

  const mailbox = await resolveOwnedMailbox(orm, mailboxId, ctx.user_id);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  let body: { sender_pattern?: unknown; kind?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { sender_pattern, kind } = body;

  if (
    !sender_pattern ||
    typeof sender_pattern !== "string" ||
    sender_pattern.trim().length === 0
  ) {
    return c.json({ error: "sender_pattern is required" }, 400);
  }
  if (kind !== "email" && kind !== "domain") {
    return c.json({ error: "kind must be 'email' or 'domain'" }, 400);
  }

  const now = Date.now();
  const id = newId("al");

  await orm
    .insert(schema.inboxExternalAllowlist)
    .values({
      id,
      inbox_id: mailboxId,
      sender_pattern: sender_pattern.trim(),
      kind,
      created_at: now,
    })
    .run();

  const entry = await orm
    .select()
    .from(schema.inboxExternalAllowlist)
    .where(eq(schema.inboxExternalAllowlist.id, id))
    .get();

  return c.json(entry, 201);
});

// ---------------------------------------------------------------------------
// DELETE /api/mailboxes/:id/policies/allowlist/:entryId — remove an entry
// ---------------------------------------------------------------------------
//
// Hard-deletes the allowlist row. 404 if not found or belongs to a different
// mailbox. 200 + { deleted: true } on success.

router.delete("/:id/policies/allowlist/:entryId", async (c) => {
  const ctx = c.var.authzContext!;
  const mailboxId = c.req.param("id");
  const entryId = c.req.param("entryId");
  const orm = drizzle(c.env.DB, { schema });

  const mailbox = await resolveOwnedMailbox(orm, mailboxId, ctx.user_id);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const entry = await orm
    .select({ id: schema.inboxExternalAllowlist.id })
    .from(schema.inboxExternalAllowlist)
    .where(
      and(
        eq(schema.inboxExternalAllowlist.id, entryId),
        eq(schema.inboxExternalAllowlist.inbox_id, mailboxId),
      ),
    )
    .get();

  if (!entry) return c.json({ error: "Allowlist entry not found" }, 404);

  await orm
    .delete(schema.inboxExternalAllowlist)
    .where(eq(schema.inboxExternalAllowlist.id, entryId))
    .run();

  return c.json({ deleted: true });
});

export default router;
