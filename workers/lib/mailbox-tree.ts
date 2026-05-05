// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// mailbox-tree.ts — assembles the rail tree payload.
//
// Returns { groups: [{ group, mailboxes }], private: Mailbox[], followed: Mailbox[] }
//
// Group isolation: only groups the actor is a member of (or all groups for global).
// "private" = mailboxes owned by actor with zero mailbox_groups rows.
// "followed" = mailboxes in actor.authorized_mailbox_ids that actor does NOT own
//              and that are not already shown under a visible group.

import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import { forGroup } from "../db/control-plane/forGroup";

export interface MailboxNodePayload {
  id: string;
  address: string;
  display_name: string | null;
  owner_user_id: string;
  created_at: number;
}

export interface GroupNodePayload {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  actor_role: "owner" | "admin" | "member" | null;
}

export interface MailboxTreePayload {
  groups: Array<{ group: GroupNodePayload; mailboxes: MailboxNodePayload[] }>;
  private: MailboxNodePayload[];
  followed: MailboxNodePayload[];
}

function isGlobal(role: AuthzContext["role"]): boolean {
  return role === "global_owner" || role === "global_admin";
}

export async function buildMailboxTree(
  db: D1Database,
  ctx: AuthzContext,
): Promise<MailboxTreePayload> {
  // Audit fix CC-1: route through forGroup so this caller is governed by the
  // chokepoint (D-V2F-3) rather than calling drizzle() directly.
  const { db: orm } = forGroup(db, ctx);

  // 1. Determine which groups to show
  let visibleGroupIds: string[] = ctx.group_ids;
  let allGroupRows = await (isGlobal(ctx.role)
    ? orm.select().from(schema.groups).all()
    : ctx.group_ids.length > 0
      ? orm
          .select()
          .from(schema.groups)
          .where(inArray(schema.groups.id, ctx.group_ids))
          .all()
      : Promise.resolve([]));

  if (isGlobal(ctx.role)) {
    visibleGroupIds = allGroupRows.map((g) => g.id);
  }

  // 2. Load all mailbox_groups for visible groups
  const mailboxGroupLinks =
    visibleGroupIds.length > 0
      ? await orm
          .select()
          .from(schema.mailbox_groups)
          .where(inArray(schema.mailbox_groups.group_id, visibleGroupIds))
          .all()
      : [];

  // 3. Load all mailboxes that appear in those links (plus actor's own mailboxes)
  const linkedMailboxIds = mailboxGroupLinks.map((l) => l.mailbox_id);
  const ownMailboxRows = await orm
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.owner_user_id, ctx.user_id))
    .all();

  const allRelevantIds = Array.from(
    new Set([...linkedMailboxIds, ...ownMailboxRows.map((m) => m.id)]),
  );

  // Fetch any linked mailboxes not yet loaded (shared mailboxes owned by others)
  const foreignIds = linkedMailboxIds.filter(
    (id) => !ownMailboxRows.some((m) => m.id === id),
  );
  const foreignMailboxRows =
    foreignIds.length > 0
      ? await orm
          .select()
          .from(schema.mailboxes)
          .where(inArray(schema.mailboxes.id, foreignIds))
          .all()
      : [];

  const allMailboxRows = [...ownMailboxRows, ...foreignMailboxRows];
  const mailboxById = new Map(allMailboxRows.map((m) => [m.id, m]));

  // 4. Load actor's group memberships for role annotation
  const membershipRows =
    ctx.group_ids.length > 0
      ? await orm
          .select()
          .from(schema.group_members)
          .where(eq(schema.group_members.user_id, ctx.user_id))
          .all()
      : [];
  const membershipByGroupId = new Map(
    membershipRows.map((m) => [m.group_id, m.role_in_group]),
  );

  // 5. Build per-group sections
  const groupSections = allGroupRows.map((g) => {
    const links = mailboxGroupLinks.filter((l) => l.group_id === g.id);
    const mailboxes = links
      .map((l) => mailboxById.get(l.mailbox_id))
      .filter((m): m is NonNullable<typeof m> => m != null)
      .map(toPayload);

    const isOwnerOfGroup = g.owner_user_id === ctx.user_id;
    const memberRole = membershipByGroupId.get(g.id) ?? null;
    let actorRole: GroupNodePayload["actor_role"] = null;
    if (isGlobal(ctx.role) || isOwnerOfGroup) {
      actorRole = "owner";
    } else if (memberRole === "admin") {
      actorRole = "admin";
    } else if (memberRole === "member") {
      actorRole = "member";
    }

    return {
      group: {
        id: g.id,
        name: g.name,
        description: g.description,
        owner_user_id: g.owner_user_id,
        actor_role: actorRole,
      } satisfies GroupNodePayload,
      mailboxes,
    };
  });

  // 6. Determine "private" mailboxes:
  //    Owned by actor AND not present in ANY mailbox_groups row (not just visible groups)
  const allMailboxGroupLinks =
    ownMailboxRows.length > 0
      ? await orm
          .select()
          .from(schema.mailbox_groups)
          .where(
            inArray(
              schema.mailbox_groups.mailbox_id,
              ownMailboxRows.map((m) => m.id),
            ),
          )
          .all()
      : [];
  const sharedMailboxIds = new Set(
    allMailboxGroupLinks.map((l) => l.mailbox_id),
  );
  const privateMailboxes = ownMailboxRows
    .filter((m) => !sharedMailboxIds.has(m.id))
    .map(toPayload);

  // 7. "Followed" = authorized mailboxes the actor does NOT own and that
  //    are not shown in any visible group section.
  const shownInGroups = new Set(linkedMailboxIds);
  const followedIds = ctx.authorized_mailbox_ids.filter(
    (id) => id !== ctx.user_id && !shownInGroups.has(id),
  );
  const followedMailboxRows =
    followedIds.length > 0
      ? await orm
          .select()
          .from(schema.mailboxes)
          .where(inArray(schema.mailboxes.id, followedIds))
          .all()
      : [];
  // Filter to only mailboxes NOT owned by actor (those appear in private/groups)
  const followed = followedMailboxRows
    .filter((m) => m.owner_user_id !== ctx.user_id)
    .map(toPayload);

  return {
    groups: groupSections,
    private: privateMailboxes,
    followed,
  };
}

function toPayload(
  m: typeof schema.mailboxes.$inferSelect,
): MailboxNodePayload {
  return {
    id: m.id,
    address: m.address,
    display_name: m.display_name,
    owner_user_id: m.owner_user_id,
    created_at: m.created_at,
  };
}
