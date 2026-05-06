// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Hono } from "hono";
import { eq, and, sql, or } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import { forGroup, type AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";
import { writeAudit } from "../lib/audit-log";
import { upsertEmail } from "../lib/cloudflare-access-policy";
import { getEmailBinding } from "../lib/mocks/email-binding";
import { getSettings } from "../lib/settings-cache";
import { plainTextInvite } from "../lib/email-templates";
import {
  filterVisibleUsers,
  sortByRelevance,
  type UserRef,
  type GroupMemberRef,
} from "../lib/visibility-filter";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// -----------------------------------------------------------------------
// Auth guard
// -----------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// -----------------------------------------------------------------------
// POST / — send invitation (privacy-preserving)
// -----------------------------------------------------------------------

router.post("/", async (c) => {
  const ctx = c.var.authzContext!;
  const { db } = forGroup(c.env.DB, ctx);

  let body: { group_id?: unknown; email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const groupId =
    typeof body.group_id === "string" ? body.group_id.trim() : null;
  const rawEmail =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : null;

  // Validate email format
  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    return c.json({ error: "That doesn't look like an email." }, 400);
  }

  if (!groupId) {
    return c.json({ error: "group_id required" }, 400);
  }

  // Load group — must exist and actor must be a member/admin/owner/global
  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();

  if (!group) return c.json({ error: "Group not found" }, 404);

  const isGlobal = ctx.role === "global_owner" || ctx.role === "global_admin";
  const isMember = ctx.group_ids.includes(groupId);
  const isOwner = ctx.user_id === group.owner_user_id;

  if (!isGlobal && !isMember && !isOwner) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Only group admin/owner or global can send invitations
  const actorMember = await db
    .select()
    .from(schema.group_members)
    .where(
      and(
        eq(schema.group_members.group_id, groupId),
        eq(schema.group_members.user_id, ctx.user_id),
      ),
    )
    .get();

  const canInvite =
    isGlobal || isOwner || actorMember?.role_in_group === "admin";

  if (!canInvite) {
    return c.json({ error: "Forbidden — group_admin or owner required" }, 403);
  }

  // Check settings cap for max_regular_users
  const settings = await getSettings(c.env.DB);
  const maxUsersRow = settings.find((s) => s.key === "max_regular_users");
  const maxUsers = maxUsersRow ? parseInt(maxUsersRow.value, 10) : 100;

  // Count current users
  const userCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.users)
    .get();
  const currentUserCount = Number(userCountResult?.count ?? 0);

  // Load inviter display info
  const inviter = await db
    .select({
      display_name: schema.users.display_name,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.user_id))
    .get();

  // TTL from settings
  const ttlRow = settings.find((s) => s.key === "group_invitation_ttl_days");
  const ttlDays = ttlRow ? parseInt(ttlRow.value, 10) : 7;
  const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;

  // Look up if email matches existing user
  const existingUser = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, rawEmail))
    .get();

  const inviteeUserId = existingUser?.id ?? null;

  // Upsert invitation (unique on group_id+email WHERE status='pending')
  const invitationId = crypto.randomUUID();
  const now = Date.now();

  // Check for existing pending invitation — if exists, re-use it
  const existing = await db
    .select()
    .from(schema.group_invitations)
    .where(
      and(
        eq(schema.group_invitations.group_id, groupId),
        eq(schema.group_invitations.invitee_email, rawEmail),
        eq(schema.group_invitations.status, "pending"),
      ),
    )
    .get();

  const finalInvitationId = existing?.id ?? invitationId;

  if (!existing) {
    await db
      .insert(schema.group_invitations)
      .values({
        id: invitationId,
        group_id: groupId,
        invitee_email: rawEmail,
        invitee_user_id: inviteeUserId,
        invited_by: ctx.user_id,
        status: "pending",
        created_at: now,
        expires_at: expiresAt,
      })
      .run();
  }

  // If email matches existing user, the in-app notification is the invitation row itself
  // (GET /api/notifications/unseen picks up pending rows by invitee_user_id).
  // Nothing extra needed — the bell polls the invitations table.

  // If no match, extend Cloudflare Access include-list (subject to cap)
  if (!inviteeUserId && currentUserCount < maxUsers) {
    await upsertEmail(c.env, rawEmail);
  }

  // Build the login URL — the plain-text invite spec routes recipients
  // straight to /login?email=<urlencoded> and lets the OTP flow take over.
  //
  // (Audit fix F-I2 2026-05-05, graph BxkKD9WEOHZGp0PJrRM8N): an HMAC-token
  // `/i/<id>?t=<token>` deep-link variant lived here, including a
  // `makeHmacToken` helper, a type-unsafe `INVITATION_HMAC_KEY` env read with
  // a literal "dev-fallback-hmac-key" string default, and an `app/routes/i.$id.tsx`
  // landing page. The whole pipeline was dead: the helper's return value was
  // never assigned, the URL was never sent in any email body, and the verifier
  // expected hex while the helper produced base64url. Removed end-to-end —
  // including the route file and registration — to eliminate the silent
  // auth-bypass surface a future "wire it up" change would have introduced.
  const host = new URL(c.req.url).host;
  const loginUrl = `https://${host}/login?email=${encodeURIComponent(rawEmail)}`;

  // Send the invitation email. We log structured failures but DO NOT swallow
  // them silently — that was the round-1 bug that hid mail-delivery problems
  // for weeks. The privacy contract (don't leak whether the address belongs
  // to an existing user) is preserved by the unconditional `sent: true`
  // success response below; that does not require silencing actual errors.
  let sendError: string | null = null;
  try {
    const emailBinding = getEmailBinding(c.env);
    const textBody = plainTextInvite({ loginUrl });
    await emailBinding.send({
      to: rawEmail,
      from: { name: "ActionNow", email: "noreply@actionnow.ai" },
      subject: "You've been invited to ActionNow",
      text: textBody,
    });
  } catch (e) {
    sendError = (e as Error).message;
    console.error(
      "[invitations] send failed",
      JSON.stringify({
        invitation_id: finalInvitationId,
        group_id: groupId,
        recipient: rawEmail,
        error: sendError,
      }),
    );
  }

  await writeAudit(c.env.DB, {
    action: "workspace.invite-via-group",
    target: { kind: "invitation", id: finalInvitationId },
    actor: ctx,
    meta: {
      group_id: groupId,
      target: rawEmail,
      invitee_user_id_or_null: inviteeUserId,
      mail_send_status: sendError ? "failed" : "sent",
      mail_send_error: sendError,
    },
  });

  // Privacy contract: ALWAYS return { sent: true } so callers cannot probe
  // whether the address corresponds to an existing user. Mail-send failures
  // are surfaced via the audit log + console.error, not the response.
  return c.json({ sent: true });
});

// -----------------------------------------------------------------------
// POST /:id/accept — accept invitation
// -----------------------------------------------------------------------

router.post("/:id/accept", async (c) => {
  const ctx = c.var.authzContext!;
  const { id } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const invitation = await db
    .select()
    .from(schema.group_invitations)
    .where(eq(schema.group_invitations.id, id))
    .get();

  if (!invitation) return c.json({ error: "Invitation not found" }, 404);

  // Verify this invitation belongs to the actor
  if (invitation.invitee_user_id !== ctx.user_id) {
    // Could be email-only invite; check email match
    const actorUser = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, ctx.user_id))
      .get();
    if (!actorUser || actorUser.email !== invitation.invitee_email) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  if (invitation.status !== "pending") {
    return c.json({ error: `Invitation already ${invitation.status}` }, 409);
  }

  if (invitation.expires_at < Date.now()) {
    return c.json({ error: "Invitation expired" }, 410);
  }

  const now = Date.now();

  // Idempotent: INSERT OR IGNORE into group_members
  await db
    .insert(schema.group_members)
    .values({
      group_id: invitation.group_id,
      user_id: ctx.user_id,
      role_in_group: "member",
      joined_at: now,
    })
    .onConflictDoNothing()
    .run();

  await db
    .update(schema.group_invitations)
    .set({
      status: "accepted",
      decided_at: now,
      decided_by: ctx.user_id,
      invitee_user_id: ctx.user_id,
    })
    .where(eq(schema.group_invitations.id, id))
    .run();

  await writeAudit(c.env.DB, {
    action: "group.member-joined",
    target: { kind: "group_member", id: ctx.user_id },
    actor: ctx,
    meta: { group_id: invitation.group_id, invitation_id: id },
  });

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// POST /:id/decline — decline invitation
// -----------------------------------------------------------------------

router.post("/:id/decline", async (c) => {
  const ctx = c.var.authzContext!;
  const { id } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const invitation = await db
    .select()
    .from(schema.group_invitations)
    .where(eq(schema.group_invitations.id, id))
    .get();

  if (!invitation) return c.json({ error: "Invitation not found" }, 404);

  if (invitation.invitee_user_id !== ctx.user_id) {
    const actorUser = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, ctx.user_id))
      .get();
    if (!actorUser || actorUser.email !== invitation.invitee_email) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  if (invitation.status !== "pending") {
    return c.json({ error: `Invitation already ${invitation.status}` }, 409);
  }

  const now = Date.now();

  await db
    .update(schema.group_invitations)
    .set({
      status: "declined",
      decided_at: now,
      decided_by: ctx.user_id,
    })
    .where(eq(schema.group_invitations.id, id))
    .run();

  await writeAudit(c.env.DB, {
    action: "group.invite-declined",
    target: { kind: "invitation", id },
    actor: ctx,
    meta: { group_id: invitation.group_id },
  });

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// POST /:id/cancel — cancel invitation (inviter or global)
// -----------------------------------------------------------------------

router.post("/:id/cancel", async (c) => {
  const ctx = c.var.authzContext!;
  const { id } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const invitation = await db
    .select()
    .from(schema.group_invitations)
    .where(eq(schema.group_invitations.id, id))
    .get();

  if (!invitation) return c.json({ error: "Invitation not found" }, 404);

  const isGlobal = ctx.role === "global_owner" || ctx.role === "global_admin";
  const isInviter = invitation.invited_by === ctx.user_id;

  if (!isGlobal && !isInviter) {
    return c.json(
      { error: "Forbidden — only inviter or global can cancel" },
      403,
    );
  }

  if (invitation.status !== "pending") {
    return c.json({ error: `Invitation already ${invitation.status}` }, 409);
  }

  const now = Date.now();

  await db
    .update(schema.group_invitations)
    .set({
      status: "cancelled",
      decided_at: now,
      decided_by: ctx.user_id,
    })
    .where(eq(schema.group_invitations.id, id))
    .run();

  await writeAudit(c.env.DB, {
    action: "group.invite-cancelled",
    target: { kind: "invitation", id },
    actor: ctx,
    meta: { group_id: invitation.group_id },
  });

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// GET /api/invitations/autocomplete?q=&groupId= — visibility-filtered user search
// Used by InviteToGroupDialog to suggest workspace members for autocomplete.
// -----------------------------------------------------------------------

router.get("/autocomplete", async (c) => {
  const ctx = c.var.authzContext!;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const { db } = forGroup(c.env.DB, ctx);

  // Load all active users
  const allUsers = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      display_name: schema.users.display_name,
      visibility: schema.users.visibility,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(eq(schema.users.status, "active"))
    .all();

  // Load group memberships for co-member calculation
  const groupMembers: GroupMemberRef[] = await db
    .select({
      user_id: schema.group_members.user_id,
      group_id: schema.group_members.group_id,
    })
    .from(schema.group_members)
    .all();

  // Load accepted contacts
  const contactRows = await db
    .select({ contact_user_id: schema.contacts.contact_user_id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, ctx.user_id),
        eq(schema.contacts.status, "accepted"),
      ),
    )
    .all();
  const acceptedContactIds = new Set(contactRows.map((r) => r.contact_user_id));

  // Load blocked users (both directions)
  const blockedRows = await db
    .select({
      owner_user_id: schema.contacts.owner_user_id,
      contact_user_id: schema.contacts.contact_user_id,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.status, "blocked"),
        or(
          eq(schema.contacts.owner_user_id, ctx.user_id),
          eq(schema.contacts.contact_user_id, ctx.user_id),
        ),
      ),
    )
    .all();
  const blockedUserIds = new Set<string>();
  for (const row of blockedRows) {
    if (row.owner_user_id === ctx.user_id)
      blockedUserIds.add(row.contact_user_id);
    else blockedUserIds.add(row.owner_user_id);
  }

  const userRefs: UserRef[] = allUsers.map((u) => ({
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    visibility: u.visibility as UserRef["visibility"],
    status: u.status as UserRef["status"],
  }));

  const actorGroupSet = new Set(ctx.group_ids);
  const coMemberIds = new Set<string>(
    groupMembers
      .filter(
        (gm) => actorGroupSet.has(gm.group_id) && gm.user_id !== ctx.user_id,
      )
      .map((gm) => gm.user_id),
  );

  const filtered = filterVisibleUsers({
    actor: { user_id: ctx.user_id, group_ids: ctx.group_ids },
    users: userRefs,
    groupMembers,
    acceptedContactIds,
    blockedUserIds,
    enforceContactsAndNobody: true,
  });

  // Filter by query string
  const matched = q
    ? filtered.filter(
        (u) =>
          u.email.toLowerCase().includes(q) ||
          (u.display_name ?? "").toLowerCase().includes(q),
      )
    : filtered;

  const sorted = sortByRelevance(matched, q, coMemberIds);

  return c.json({ users: sorted.slice(0, 20) });
});

export default router;
