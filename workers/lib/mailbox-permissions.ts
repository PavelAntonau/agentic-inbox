// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// mailbox-permissions.ts — permission predicates for mailbox operations.
// Encodes Footnotes 10/11/12/13 from the Phase 4 spec.
//
// All predicates return { ok: boolean; reason?: string }.
// These are the ONLY place that encodes mailbox ACL logic — endpoints MUST
// import from here and must NOT fork the predicates.

import type { AuthzContext } from "../db/control-plane/forGroup";

export interface PermResult {
  ok: boolean;
  reason?: string;
}

export interface MailboxRow {
  id: string;
  address: string;
  display_name: string | null;
  owner_user_id: string;
  created_at: number;
}

export interface GroupRow {
  id: string;
  owner_user_id: string;
}

function isGlobal(role: AuthzContext["role"]): boolean {
  return role === "global_owner" || role === "global_admin";
}

/**
 * canShare — actor can add mailbox to a group.
 *
 * Footnote 10: actor must be mailbox owner OR global.
 * The group must exist and the actor must be a member (or global).
 * Caller must separately enforce the E7 cap (max_groups_per_mailbox).
 */
export function canShare(
  actor: AuthzContext,
  mailbox: MailboxRow,
  group: GroupRow,
): PermResult {
  if (isGlobal(actor.role)) return { ok: true };
  if (mailbox.owner_user_id !== actor.user_id) {
    return { ok: false, reason: "Only the mailbox owner can share it." };
  }
  // Actor must be a member of the target group (or global — already handled above)
  if (!actor.group_ids.includes(group.id)) {
    return { ok: false, reason: "You are not a member of that group." };
  }
  return { ok: true };
}

/**
 * canUnshare — actor can remove mailbox from a group.
 *
 * Footnote 11: mailbox owner OR group owner/admin OR global.
 * Either side can initiate removal.
 */
export function canUnshare(
  actor: AuthzContext,
  mailbox: MailboxRow,
  group: GroupRow,
  actorRoleInGroup: "admin" | "member" | null,
): PermResult {
  if (isGlobal(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  if (group.owner_user_id === actor.user_id) return { ok: true };
  if (actorRoleInGroup === "admin") return { ok: true };
  return {
    ok: false,
    reason:
      "Only the mailbox owner or a group admin/owner can remove this mailbox from the group.",
  };
}

/**
 * canTransfer — actor can transfer mailbox ownership.
 *
 * Footnote 12: mailbox owner OR global.
 * The receiver visibility constraint is enforced separately in the handler.
 */
export function canTransfer(
  actor: AuthzContext,
  mailbox: MailboxRow,
): PermResult {
  if (isGlobal(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  return {
    ok: false,
    reason: "Only the mailbox owner can transfer ownership.",
  };
}

/**
 * canDelete — actor can delete a mailbox.
 *
 * Footnote 13: mailbox owner OR global.
 */
export function canDelete(
  actor: AuthzContext,
  mailbox: MailboxRow,
): PermResult {
  if (isGlobal(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  return {
    ok: false,
    reason: "Only the mailbox owner can delete it.",
  };
}
