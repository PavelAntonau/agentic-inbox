// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import { forGroup, type AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

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
// GET /unseen — pending group invitations for the current user
// -----------------------------------------------------------------------

router.get("/unseen", async (c) => {
  const ctx = c.var.authzContext!;
  const { db } = forGroup(c.env.DB, ctx);

  // Fetch pending invitations where invitee_user_id = actor
  const invitations = await db
    .select({
      id: schema.group_invitations.id,
      group_id: schema.group_invitations.group_id,
      invitee_email: schema.group_invitations.invitee_email,
      invitee_user_id: schema.group_invitations.invitee_user_id,
      invited_by: schema.group_invitations.invited_by,
      status: schema.group_invitations.status,
      created_at: schema.group_invitations.created_at,
      expires_at: schema.group_invitations.expires_at,
      // Joined group info
      group_name: schema.groups.name,
      group_description: schema.groups.description,
      // Joined inviter info
      inviter_display_name: schema.users.display_name,
      inviter_email: schema.users.email,
    })
    .from(schema.group_invitations)
    .leftJoin(
      schema.groups,
      eq(schema.group_invitations.group_id, schema.groups.id),
    )
    .leftJoin(
      schema.users,
      eq(schema.group_invitations.invited_by, schema.users.id),
    )
    .where(
      and(
        eq(schema.group_invitations.invitee_user_id, ctx.user_id),
        eq(schema.group_invitations.status, "pending"),
      ),
    )
    .all();

  // Filter out expired ones (don't delete — let a cron or cleanup job handle that)
  const now = Date.now();
  const active = invitations.filter((inv) => inv.expires_at > now);

  return c.json({ invitations: active });
});

export default router;
