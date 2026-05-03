// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Peer-protection predicate — encodes Permission Matrix footnotes 2, 3, 5.
 *
 * Pure inputs → pure outputs. No I/O. Safe to unit-test directly.
 */

export type ActionKind = "demote" | "remove" | "promote";

export interface ActorRef {
  user_id: string;
  role: "global_owner" | "global_admin" | "user";
  email: string;
}

export interface TargetUser {
  id: string;
  role: "global_owner" | "global_admin" | "user";
  email: string;
  owns_mailboxes_count: number;
}

export interface CanActResult {
  ok: boolean;
  reason?: string;
}

/**
 * Determine whether `actor` may perform `action` on `target`.
 *
 * @param actor   Reduced auth context for the requesting user
 * @param target  D1 user row (with owns_mailboxes_count pre-joined)
 * @param action  One of 'promote' | 'demote' | 'remove'
 * @param adminCap  Current max_global_admins setting (for promote cap check)
 * @param currentAdminCount  Current count of global_admin users in workspace
 */
export function canAct(
  actor: ActorRef,
  target: TargetUser,
  action: ActionKind,
  adminCap?: number,
  currentAdminCount?: number,
): CanActResult {
  // Footnote 2: regular users cannot perform admin actions
  if (actor.role === "user") {
    return { ok: false, reason: "forbidden" };
  }

  // The global_owner seat is immutable via UI (only BOOTSTRAP_OWNER_EMAIL env changes it)
  if (target.role === "global_owner") {
    return { ok: false, reason: "cannot-modify-owner" };
  }

  switch (action) {
    case "promote": {
      // Only global_owner or global_admin can promote a user → global_admin
      if (actor.role !== "global_owner" && actor.role !== "global_admin") {
        return { ok: false, reason: "forbidden" };
      }
      // Cap check
      if (
        adminCap !== undefined &&
        currentAdminCount !== undefined &&
        currentAdminCount >= adminCap
      ) {
        return { ok: false, reason: "admin-cap-reached" };
      }
      return { ok: true };
    }

    case "demote": {
      // global_owner can demote any global_admin
      if (actor.role === "global_owner") {
        return { ok: true };
      }
      // Self-demote: a global_admin may demote themselves
      if (actor.role === "global_admin" && actor.user_id === target.id) {
        return { ok: true };
      }
      // Peer protection: global_admin cannot demote another global_admin
      return { ok: false, reason: "peer-protected" };
    }

    case "remove": {
      // Block removal if user owns mailboxes (E4 — transfer first)
      if (target.owns_mailboxes_count > 0) {
        return { ok: false, reason: "owns-mailboxes" };
      }
      if (actor.role === "global_owner") {
        // global_owner can remove anyone except global_owner (handled above)
        return { ok: true };
      }
      if (actor.role === "global_admin") {
        // global_admin can only remove regular users
        if (target.role === "user") {
          return { ok: true };
        }
        // Cannot remove another global_admin (peer-protected)
        return { ok: false, reason: "peer-protected" };
      }
      return { ok: false, reason: "forbidden" };
    }
  }
}
