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
import { writeAudit } from "../lib/audit-log";
import {
  canSendContactRequest,
  canAcceptContactRequest,
  canDeclineContactRequest,
  canBlockUser,
  isReachableForContactRequest,
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
    .select({
      id: schema.users.id,
      status: schema.users.status,
      visibility: schema.users.visibility,
    })
    .from(schema.users)
    .where(eq(schema.users.id, targetUserId))
    .get();
  if (!targetUser || targetUser.status !== "active") {
    return c.json({ error: "User not found" }, 404);
  }

  // Audit fix F-C2 (graph: HejuxD6Ia0YOZP805meVV) — D-aim-12 visibility gate.
  //
  // A `visibility='nobody'` user must be unreachable for contact requests from
  // anyone who is not already a co-member or an accepted contact. Without this
  // gate, any authenticated caller who learns the target's user_id (e.g. from
  // another surface) can send them a contact request, defeating the privacy
  // tier the user explicitly chose.
  //
  // Privacy-preserving: return 404 (the same shape as `User not found`) so the
  // response cannot be used to probe whether the user_id exists at all.
  // Fetch target's group memberships + actor's accepted-contact relationship
  // to feed isReachableForContactRequest. We always run these queries
  // (regardless of visibility tier) because contact-block detection below also
  // uses the contacts table — running them up front keeps the call sites
  // close together and avoids re-querying when the predicate needs them.
  const targetGroupRows = await db
    .select({ group_id: schema.group_members.group_id })
    .from(schema.group_members)
    .where(eq(schema.group_members.user_id, targetUserId))
    .all();
  const targetGroupIds = targetGroupRows.map((g) => g.group_id);
  const acceptedRow = await db
    .select({ status: schema.contacts.status })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, ctx.user_id),
        eq(schema.contacts.contact_user_id, targetUserId),
        eq(schema.contacts.status, "accepted"),
      ),
    )
    .get();
  const actorHasAcceptedContact = !!acceptedRow;

  if (
    !isReachableForContactRequest({
      actor: ctx,
      targetUserId,
      targetVisibility: targetUser.visibility,
      targetGroupIds,
      actorHasAcceptedContact,
    })
  ) {
    // Privacy-preserving: same shape as "User not found" — a caller that
    // probes random user_ids cannot distinguish "doesn't exist" from
    // "exists but visibility=nobody". (Audit fix F-C2.)
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

  // Sender's row — visible in sender's "Sent" tab. Stays 'pending' forever per D12.
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

  // F-PHASE3-009 — recipient mirror row at request time so /contacts UI's
  // "Incoming" tab can render the pending request. Without this, the
  // recipient has no row where they are owner_user_id and GET /api/contacts
  // returns empty for them, even though /accept can still complete via API.
  // declined_at is reset so a previously-declined request can be re-sent.
  await db
    .insert(schema.contacts)
    .values({
      owner_user_id: targetUserId,
      contact_user_id: ctx.user_id,
      status: "pending",
      initiated_by: ctx.user_id,
      created_at: now,
      accepted_at: null,
    })
    .onConflictDoUpdate({
      target: [schema.contacts.owner_user_id, schema.contacts.contact_user_id],
      set: {
        status: "pending",
        initiated_by: ctx.user_id,
        created_at: now,
        accepted_at: null,
        declined_at: null,
      },
    })
    .run();

  await writeAudit(c.env.DB, {
    action: "contact.request",
    target: { kind: "contact", id: targetUserId },
    actor: ctx,
    meta: { target_user_id: targetUserId },
  });

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

  // F-PHASE3-010 — D12 sender-blind. The sender's row (owner=requesterId,
  // contact=ctx.user_id) is INTENTIONALLY left as 'pending'. The sender's
  // GET /api/contacts continues to read 'pending' forever, with no visible
  // status flip. Acceptance is implicit through the existence of the
  // recipient's mirror row in 'accepted' state — the UI surfaces "mutual
  // contact" by joining against contacts from the recipient's side.
  //
  // Update the recipient's mirror row (created at /request time per
  // F-PHASE3-009) from 'pending' → 'accepted'. ON CONFLICT keeps the call
  // idempotent and tolerates legacy rows from before F-PHASE3-009 landed.
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
      set: { status: "accepted", accepted_at: now, declined_at: null },
    })
    .run();

  await writeAudit(c.env.DB, {
    action: "contact.accept",
    target: { kind: "contact", id: requesterId },
    actor: ctx,
    meta: { requester_user_id: requesterId },
  });

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
  // F-PHASE3-010: declined_at is set on the RECIPIENT's mirror row
  // (owner=ctx.user_id, contact=requesterId) — created at /request time per
  // F-PHASE3-009. The recipient's GET filters the row out (declined_at IS
  // NOT NULL guard at line ~89). The sender's row (owner=requesterId,
  // contact=ctx.user_id) is left untouched — their GET continues to read
  // status='pending' forever with no audit-log surface (gated to
  // global_owner / global_admin per workers/routes/observability.ts).
  //
  // Insert-on-conflict guards against legacy data: if the recipient mirror
  // row is missing (request was created before F-PHASE3-009 landed), seed
  // it directly into a declined state so future GETs filter it correctly.
  await db
    .insert(schema.contacts)
    .values({
      owner_user_id: ctx.user_id,
      contact_user_id: requesterId,
      status: "pending",
      initiated_by: requesterId,
      created_at: Date.now(),
      accepted_at: null,
      declined_at: Date.now(),
    })
    .onConflictDoUpdate({
      target: [schema.contacts.owner_user_id, schema.contacts.contact_user_id],
      set: { declined_at: Date.now() },
    })
    .run();

  await writeAudit(c.env.DB, {
    action: "contact.decline",
    target: { kind: "contact", id: requesterId },
    actor: ctx,
    meta: { requester_user_id: requesterId },
  });

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

  await writeAudit(c.env.DB, {
    action: "contact.block",
    target: { kind: "contact", id: targetUserId },
    actor: ctx,
    meta: { target_user_id: targetUserId },
  });

  return c.json({ ok: true });
});

export default router;
