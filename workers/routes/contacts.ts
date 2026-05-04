// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/contacts.ts — contacts CRUD endpoints.
//
// Mounts at /api/contacts (see app.ts).
//
// Endpoints:
//   POST /api/contacts/request           { target_user_id } — send request
//   POST /api/contacts/:id/accept        — accept a pending request
//   POST /api/contacts/:id/decline       — decline a pending request
//   POST /api/contacts/:user_id/block    — block a user (one-direction)
//
// Schema: contacts table (owner_user_id, contact_user_id, status, initiated_by).
// Symmetric handshake: request inserts ONE row (status='pending').
// Accept inserts mirror row + flips both to 'accepted'.
// Decline removes the original row.
// Block is a one-direction 'blocked' row.

import { Hono } from "hono";
import { eq, and, or, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";
import { appendAudit } from "../lib/audit-log";
import {
  canSendContactRequest,
  canAcceptContactRequest,
  canDeclineContactRequest,
  canBlockUser,
} from "../lib/contact-permissions";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDb(env: Env) {
  return drizzle(env.DB, { schema });
}

// ---------------------------------------------------------------------------
// GET /api/contacts — list actor's contacts (all statuses)
// ---------------------------------------------------------------------------

router.get("/", async (c) => {
  const ctx = c.var.authzContext!;
  const db = getDb(c.env);

  // D12: hide rows the actor (recipient) declined. Sender-side rows
  // (owner=actor, declined_at IS NOT NULL on the recipient's mirror row that
  // doesn't yet exist) remain visible to the sender as-is — their outgoing
  // request continues to read 'pending' indefinitely.
  const rows = await db
    .select({
      owner_user_id: schema.contacts.owner_user_id,
      contact_user_id: schema.contacts.contact_user_id,
      status: schema.contacts.status,
      initiated_by: schema.contacts.initiated_by,
      created_at: schema.contacts.created_at,
      accepted_at: schema.contacts.accepted_at,
      email: schema.users.email,
      display_name: schema.users.display_name,
    })
    .from(schema.contacts)
    .leftJoin(
      schema.users,
      eq(schema.contacts.contact_user_id, schema.users.id),
    )
    .where(
      and(
        eq(schema.contacts.owner_user_id, ctx.user_id),
        isNull(schema.contacts.declined_at),
      ),
    )
    .all();

  return c.json({ contacts: rows });
});

// ---------------------------------------------------------------------------
// POST /api/contacts/request — send a contact request
// ---------------------------------------------------------------------------

router.post("/request", async (c) => {
  const ctx = c.var.authzContext!;
  const db = getDb(c.env);

  let body: { target_user_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const targetUserId =
    typeof body.target_user_id === "string" ? body.target_user_id.trim() : null;
  if (!targetUserId) {
    return c.json({ error: "target_user_id required" }, 400);
  }

  // Verify target exists
  const targetUser = await db
    .select({ id: schema.users.id, status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, targetUserId))
    .get();
  if (!targetUser || targetUser.status !== "active") {
    return c.json({ error: "User not found" }, 404);
  }

  // Check blocks (both directions)
  const blockRows = await db
    .select({
      owner_user_id: schema.contacts.owner_user_id,
      contact_user_id: schema.contacts.contact_user_id,
      status: schema.contacts.status,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.status, "blocked"),
        or(
          and(
            eq(schema.contacts.owner_user_id, ctx.user_id),
            eq(schema.contacts.contact_user_id, targetUserId),
          ),
          and(
            eq(schema.contacts.owner_user_id, targetUserId),
            eq(schema.contacts.contact_user_id, ctx.user_id),
          ),
        ),
      ),
    )
    .all();

  const actorBlockedTarget = blockRows.some(
    (r) => r.owner_user_id === ctx.user_id,
  );
  const blockedByTarget = blockRows.some(
    (r) => r.owner_user_id === targetUserId,
  );

  const perm = canSendContactRequest(
    ctx,
    targetUserId,
    blockedByTarget,
    actorBlockedTarget,
  );
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  // Check for existing relationship row (actor → target)
  const existing = await db
    .select()
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, ctx.user_id),
        eq(schema.contacts.contact_user_id, targetUserId),
      ),
    )
    .get();

  if (existing) {
    if (existing.status === "accepted") {
      return c.json({ error: "Already contacts" }, 409);
    }
    if (existing.status === "pending") {
      return c.json({ error: "Request already pending" }, 409);
    }
  }

  const now = Date.now();

  await db
    .insert(schema.contacts)
    .values({
      owner_user_id: ctx.user_id,
      contact_user_id: targetUserId,
      status: "pending",
      initiated_by: ctx.user_id,
      created_at: now,
      accepted_at: null,
    })
    .onConflictDoUpdate({
      target: [schema.contacts.owner_user_id, schema.contacts.contact_user_id],
      set: { status: "pending", initiated_by: ctx.user_id, created_at: now },
    })
    .run();

  await appendAudit(
    c.env.DB,
    ctx,
    "contact.request",
    { kind: "contact", id: targetUserId },
    { target_user_id: targetUserId },
  );

  return c.json({ ok: true }, 201);
});

// ---------------------------------------------------------------------------
// POST /api/contacts/:id/accept — accept a pending request
// The :id here is the contact_user_id who sent the request (they are the
// owner_user_id of the pending row; the actor is the contact_user_id).
// ---------------------------------------------------------------------------

router.post("/:id/accept", async (c) => {
  const ctx = c.var.authzContext!;
  const requesterId = c.req.param("id");
  const db = getDb(c.env);

  // The pending row: requesterId → actor
  const request = await db
    .select()
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, requesterId),
        eq(schema.contacts.contact_user_id, ctx.user_id),
      ),
    )
    .get();

  if (!request) return c.json({ error: "Contact request not found" }, 404);

  const perm = canAcceptContactRequest(ctx, request);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  const now = Date.now();

  // Flip the original row to 'accepted'
  await db
    .update(schema.contacts)
    .set({ status: "accepted", accepted_at: now })
    .where(
      and(
        eq(schema.contacts.owner_user_id, requesterId),
        eq(schema.contacts.contact_user_id, ctx.user_id),
      ),
    )
    .run();

  // Insert mirror row (actor → requester), accepted immediately
  await db
    .insert(schema.contacts)
    .values({
      owner_user_id: ctx.user_id,
      contact_user_id: requesterId,
      status: "accepted",
      initiated_by: requesterId,
      created_at: now,
      accepted_at: now,
    })
    .onConflictDoUpdate({
      target: [schema.contacts.owner_user_id, schema.contacts.contact_user_id],
      set: { status: "accepted", accepted_at: now },
    })
    .run();

  await appendAudit(
    c.env.DB,
    ctx,
    "contact.accept",
    { kind: "contact", id: requesterId },
    { requester_user_id: requesterId },
  );

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/contacts/:id/decline — decline a pending request
// The :id is the contact_user_id who sent the request.
// ---------------------------------------------------------------------------

router.post("/:id/decline", async (c) => {
  const ctx = c.var.authzContext!;
  const requesterId = c.req.param("id");
  const db = getDb(c.env);

  const request = await db
    .select()
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, requesterId),
        eq(schema.contacts.contact_user_id, ctx.user_id),
      ),
    )
    .get();

  if (!request) return c.json({ error: "Contact request not found" }, 404);

  const perm = canDeclineContactRequest(ctx, request);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  // D12 — sender-blind decline.
  // The row is NOT deleted and NOT flipped to a visible 'declined' state.
  // Status stays 'pending'; declined_at is set so the recipient (this actor)
  // filters the row out of GET /api/contacts. The sender's view of their
  // outgoing request — which is the same physical row, just queried by
  // owner_user_id from the sender's session — continues to read 'pending'
  // forever, with no audit trail visible to the sender (audit-log reads are
  // gated to global_owner / global_admin only — see workers/routes/observability.ts).
  await db
    .update(schema.contacts)
    .set({ declined_at: Date.now() })
    .where(
      and(
        eq(schema.contacts.owner_user_id, requesterId),
        eq(schema.contacts.contact_user_id, ctx.user_id),
      ),
    )
    .run();

  await appendAudit(
    c.env.DB,
    ctx,
    "contact.decline",
    { kind: "contact", id: requesterId },
    { requester_user_id: requesterId },
  );

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/contacts/:user_id/block — block a user (one-direction)
// ---------------------------------------------------------------------------

router.post("/:userId/block", async (c) => {
  const ctx = c.var.authzContext!;
  const targetUserId = c.req.param("userId");
  const db = getDb(c.env);

  // Verify target exists
  const targetUser = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, targetUserId))
    .get();
  if (!targetUser) return c.json({ error: "User not found" }, 404);

  const perm = canBlockUser(ctx, targetUserId);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  const now = Date.now();

  // Upsert a 'blocked' row (actor → target)
  await db
    .insert(schema.contacts)
    .values({
      owner_user_id: ctx.user_id,
      contact_user_id: targetUserId,
      status: "blocked",
      initiated_by: ctx.user_id,
      created_at: now,
      accepted_at: null,
    })
    .onConflictDoUpdate({
      target: [schema.contacts.owner_user_id, schema.contacts.contact_user_id],
      set: { status: "blocked" },
    })
    .run();

  // Also remove any mirror row (target → actor) that might be 'accepted' or 'pending'
  // so the contact no longer appears on either side.
  await db
    .delete(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, targetUserId),
        eq(schema.contacts.contact_user_id, ctx.user_id),
        // Only remove non-blocked rows — don't stomp on target's own blocks
        or(
          eq(schema.contacts.status, "accepted"),
          eq(schema.contacts.status, "pending"),
        ),
      ),
    )
    .run();

  await appendAudit(
    c.env.DB,
    ctx,
    "contact.block",
    { kind: "contact", id: targetUserId },
    { target_user_id: targetUserId },
  );

  return c.json({ ok: true });
});

export default router;
