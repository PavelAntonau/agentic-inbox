// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import { forGroup, type AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";
import { writeAudit } from "../lib/audit-log";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// -----------------------------------------------------------------------
// Auth guard — all group routes require authenticated user
// -----------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function isGlobal(role: AuthzContext["role"]): boolean {
  return role === "global_owner" || role === "global_admin";
}

function isGroupOwner(ctx: AuthzContext, groupOwnerId: string): boolean {
  return ctx.user_id === groupOwnerId;
}

function canManageGroup(ctx: AuthzContext, groupOwnerId: string): boolean {
  return isGlobal(ctx.role) || isGroupOwner(ctx, groupOwnerId);
}

function canEditGroup(
  ctx: AuthzContext,
  groupOwnerId: string,
  memberRole: string | null,
): boolean {
  return canManageGroup(ctx, groupOwnerId) || memberRole === "admin";
}

// -----------------------------------------------------------------------
// GET / — list groups visible to actor
// -----------------------------------------------------------------------

router.get("/", async (c) => {
  const ctx = c.var.authzContext!;
  const { db } = forGroup(c.env.DB, ctx);

  let rows;
  if (isGlobal(ctx.role)) {
    // Global admins see all groups
    rows = await db.select().from(schema.groups).all();
  } else {
    // Regular users see only groups they're members of
    if (ctx.group_ids.length === 0) {
      return c.json({ groups: [] });
    }
    rows = await db
      .select()
      .from(schema.groups)
      .where(inArray(schema.groups.id, ctx.group_ids))
      .all();
  }

  // Enrich with member count and actor's role in each group
  const enriched = await Promise.all(
    rows.map(async (g) => {
      const members = await db
        .select()
        .from(schema.group_members)
        .where(eq(schema.group_members.group_id, g.id))
        .all();
      const actorMember = members.find((m) => m.user_id === ctx.user_id);
      return {
        ...g,
        member_count: members.length,
        actor_role_in_group: isGroupOwner(ctx, g.owner_user_id)
          ? "owner"
          : (actorMember?.role_in_group ?? null),
      };
    }),
  );

  return c.json({ groups: enriched });
});

// -----------------------------------------------------------------------
// POST / — create a group
// -----------------------------------------------------------------------

router.post("/", async (c) => {
  const ctx = c.var.authzContext!;
  const { db } = forGroup(c.env.DB, ctx);

  let body: { name?: unknown; description?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : null;
  if (!name || name.length < 1 || name.length > 100) {
    return c.json({ error: "Group name must be 1–100 characters" }, 400);
  }
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, 500)
      : null;

  const id = crypto.randomUUID();
  const now = Date.now();

  await db
    .insert(schema.groups)
    .values({
      id,
      name,
      description,
      owner_user_id: ctx.user_id,
      created_at: now,
      created_by: ctx.user_id,
    })
    .run();

  // Insert creator as a group member (owner track)
  await db
    .insert(schema.group_members)
    .values({
      group_id: id,
      user_id: ctx.user_id,
      role_in_group: "admin",
      joined_at: now,
    })
    .run();

  await writeAudit(c.env.DB, {
    action: "group.created",
    target: { kind: "group", id },
    actor: ctx,
    meta: {
      name,
    },
  });

  return c.json(
    { id, name, description, owner_user_id: ctx.user_id, created_at: now },
    201,
  );
});

// -----------------------------------------------------------------------
// GET /:groupId — get group details
// -----------------------------------------------------------------------

router.get("/:groupId", async (c) => {
  const ctx = c.var.authzContext!;
  const { groupId } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();

  if (!group) return c.json({ error: "Not found" }, 404);

  // Access check: must be member or global
  const isMember = ctx.group_ids.includes(groupId);
  if (
    !isGlobal(ctx.role) &&
    !isMember &&
    !isGroupOwner(ctx, group.owner_user_id)
  ) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const members = await db
    .select()
    .from(schema.group_members)
    .where(eq(schema.group_members.group_id, groupId))
    .all();

  const actorMember = members.find((m) => m.user_id === ctx.user_id);

  return c.json({
    ...group,
    members,
    actor_role_in_group: isGroupOwner(ctx, group.owner_user_id)
      ? "owner"
      : (actorMember?.role_in_group ?? null),
  });
});

// -----------------------------------------------------------------------
// PATCH /:groupId — rename / edit description
// -----------------------------------------------------------------------

router.patch("/:groupId", async (c) => {
  const ctx = c.var.authzContext!;
  const { groupId } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();

  if (!group) return c.json({ error: "Not found" }, 404);

  // Check actor's membership role
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

  if (
    !canEditGroup(ctx, group.owner_user_id, actorMember?.role_in_group ?? null)
  ) {
    return c.json(
      { error: "Forbidden — group_owner or group_admin required" },
      403,
    );
  }

  let body: { name?: unknown; description?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates: Partial<typeof schema.groups.$inferInsert> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name.length < 1 || name.length > 100) {
      return c.json({ error: "Name must be 1–100 characters" }, 400);
    }
    updates.name = name;
  }
  if (typeof body.description === "string") {
    updates.description = body.description.trim().slice(0, 500);
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No updatable fields provided" }, 400);
  }

  await db
    .update(schema.groups)
    .set(updates)
    .where(eq(schema.groups.id, groupId))
    .run();

  await writeAudit(c.env.DB, {
    action: "group.updated",
    target: { kind: "group", id: groupId },
    actor: ctx,
    meta: updates,
  });

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// DELETE /:groupId — delete group (owner or global only)
// -----------------------------------------------------------------------

router.delete("/:groupId", async (c) => {
  const ctx = c.var.authzContext!;
  const { groupId } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();

  if (!group) return c.json({ error: "Not found" }, 404);

  if (!canManageGroup(ctx, group.owner_user_id)) {
    return c.json({ error: "Forbidden — group_owner or global required" }, 403);
  }

  // Cascade: mailbox_groups is ON DELETE CASCADE on group, group_members likewise.
  // We still delete explicit for auditability.
  await db
    .delete(schema.mailbox_groups)
    .where(eq(schema.mailbox_groups.group_id, groupId))
    .run();

  await db
    .delete(schema.group_members)
    .where(eq(schema.group_members.group_id, groupId))
    .run();

  await db.delete(schema.groups).where(eq(schema.groups.id, groupId)).run();

  await writeAudit(c.env.DB, {
    action: "group.deleted",
    target: { kind: "group", id: groupId },
    actor: ctx,
    meta: {
      name: group.name,
    },
  });

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// POST /:groupId/transfer — transfer ownership
// -----------------------------------------------------------------------

router.post("/:groupId/transfer", async (c) => {
  const ctx = c.var.authzContext!;
  const { groupId } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();

  if (!group) return c.json({ error: "Not found" }, 404);

  if (!canManageGroup(ctx, group.owner_user_id)) {
    return c.json({ error: "Forbidden — group_owner or global required" }, 403);
  }

  let body: { new_owner_user_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const newOwnerId =
    typeof body.new_owner_user_id === "string"
      ? body.new_owner_user_id.trim()
      : null;
  if (!newOwnerId) {
    return c.json({ error: "new_owner_user_id required" }, 400);
  }

  // New owner must be a member
  const newOwnerMember = await db
    .select()
    .from(schema.group_members)
    .where(
      and(
        eq(schema.group_members.group_id, groupId),
        eq(schema.group_members.user_id, newOwnerId),
      ),
    )
    .get();

  if (!newOwnerMember) {
    return c.json({ error: "New owner must already be a group member" }, 400);
  }

  await db
    .update(schema.groups)
    .set({ owner_user_id: newOwnerId })
    .where(eq(schema.groups.id, groupId))
    .run();

  await writeAudit(c.env.DB, {
    action: "group.ownership-transferred",
    target: { kind: "group", id: groupId },
    actor: ctx,
    meta: { from: group.owner_user_id, to: newOwnerId },
  });

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// GET /:groupId/members — list members with user info
// -----------------------------------------------------------------------

router.get("/:groupId/members", async (c) => {
  const ctx = c.var.authzContext!;
  const { groupId } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();

  if (!group) return c.json({ error: "Not found" }, 404);

  const isMember = ctx.group_ids.includes(groupId);
  if (
    !isGlobal(ctx.role) &&
    !isMember &&
    !isGroupOwner(ctx, group.owner_user_id)
  ) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const members = await db
    .select({
      user_id: schema.group_members.user_id,
      role_in_group: schema.group_members.role_in_group,
      joined_at: schema.group_members.joined_at,
      email: schema.users.email,
      display_name: schema.users.display_name,
      status: schema.users.status,
    })
    .from(schema.group_members)
    .leftJoin(schema.users, eq(schema.group_members.user_id, schema.users.id))
    .where(eq(schema.group_members.group_id, groupId))
    .all();

  return c.json({
    group_id: groupId,
    owner_user_id: group.owner_user_id,
    members: members.map((m) => ({
      ...m,
      is_owner: m.user_id === group.owner_user_id,
    })),
  });
});

// -----------------------------------------------------------------------
// POST /:groupId/members/:userId/role — promote / demote member
// -----------------------------------------------------------------------

router.post("/:groupId/members/:userId/role", async (c) => {
  const ctx = c.var.authzContext!;
  const { groupId, userId } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();

  if (!group) return c.json({ error: "Not found" }, 404);

  let body: { role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const newRole = body.role;
  if (newRole !== "admin" && newRole !== "member") {
    return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  }

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

  const actorIsOwner = isGroupOwner(ctx, group.owner_user_id);
  const actorIsAdmin = actorMember?.role_in_group === "admin";
  const actorCanManage = isGlobal(ctx.role) || actorIsOwner || actorIsAdmin;

  if (!actorCanManage) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Peer-immutable: admin cannot change another admin's role (only owner or global can)
  const targetMember = await db
    .select()
    .from(schema.group_members)
    .where(
      and(
        eq(schema.group_members.group_id, groupId),
        eq(schema.group_members.user_id, userId),
      ),
    )
    .get();

  if (!targetMember) {
    return c.json({ error: "Member not found" }, 404);
  }

  if (
    targetMember.role_in_group === "admin" &&
    !actorIsOwner &&
    !isGlobal(ctx.role)
  ) {
    return c.json(
      {
        error: "Peer-protected: only owner or global can modify another admin",
      },
      403,
    );
  }

  // Owner cannot be demoted via this endpoint — use transfer
  if (userId === group.owner_user_id) {
    return c.json({ error: "Use transfer endpoint to change owner role" }, 400);
  }

  await db
    .update(schema.group_members)
    .set({ role_in_group: newRole })
    .where(
      and(
        eq(schema.group_members.group_id, groupId),
        eq(schema.group_members.user_id, userId),
      ),
    )
    .run();

  const action =
    newRole === "admin" ? "group.member-promoted" : "group.member-demoted";
  await writeAudit(c.env.DB, {
    action,
    target: { kind: "group_member", id: userId },
    actor: ctx,
    meta: {
      group_id: groupId,
      new_role: newRole,
    },
  });

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// DELETE /:groupId/members/:userId — remove member
// -----------------------------------------------------------------------

router.delete("/:groupId/members/:userId", async (c) => {
  const ctx = c.var.authzContext!;
  const { groupId, userId } = c.req.param();
  const { db } = forGroup(c.env.DB, ctx);

  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();

  if (!group) return c.json({ error: "Not found" }, 404);

  const targetMember = await db
    .select()
    .from(schema.group_members)
    .where(
      and(
        eq(schema.group_members.group_id, groupId),
        eq(schema.group_members.user_id, userId),
      ),
    )
    .get();

  if (!targetMember) {
    return c.json({ error: "Member not found" }, 404);
  }

  // Self-leave: handled here — owner self-leave is blocked
  if (userId === ctx.user_id) {
    if (isGroupOwner(ctx, group.owner_user_id)) {
      return c.json(
        {
          error: "Owner must transfer or delete group before leaving",
          code: "owner-must-transfer",
        },
        400,
      );
    }
    // Non-owner can always leave
    await db
      .delete(schema.group_members)
      .where(
        and(
          eq(schema.group_members.group_id, groupId),
          eq(schema.group_members.user_id, userId),
        ),
      )
      .run();
    await writeAudit(c.env.DB, {
      action: "group.member-left",
      target: { kind: "group_member", id: userId },
      actor: ctx,
      meta: {
        group_id: groupId,
      },
    });
    return c.json({ ok: true });
  }

  // Peer-immutable: admin cannot remove another admin
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

  const actorIsOwner = isGroupOwner(ctx, group.owner_user_id);
  const actorIsAdmin = actorMember?.role_in_group === "admin";

  if (
    targetMember.role_in_group === "admin" &&
    !actorIsOwner &&
    !isGlobal(ctx.role)
  ) {
    return c.json(
      { error: "Peer-protected: cannot remove another admin" },
      403,
    );
  }

  if (!isGlobal(ctx.role) && !actorIsOwner && !actorIsAdmin) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Owner cannot be removed without transfer
  if (userId === group.owner_user_id) {
    return c.json({ error: "Owner must transfer ownership first" }, 400);
  }

  await db
    .delete(schema.group_members)
    .where(
      and(
        eq(schema.group_members.group_id, groupId),
        eq(schema.group_members.user_id, userId),
      ),
    )
    .run();

  await writeAudit(c.env.DB, {
    action: "group.member-removed",
    target: { kind: "group_member", id: userId },
    actor: ctx,
    meta: { group_id: groupId, removed_by: ctx.user_id },
  });

  return c.json({ ok: true });
});

export default router;
