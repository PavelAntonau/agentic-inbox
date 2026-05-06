// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Visibility filter for user autocomplete in invitation flows.
 *
 * Phase 3 implementation — honors `everyone` + self + co-members.
 * Phase 6 extends with full `contacts` and `nobody` enforcement.
 *
 * Decision D-V2U-VIS: Full rule set active from Phase 6:
 *   1. Always include self.
 *   2. Always include co-members (regardless of visibility).
 *   3. Always include actor's accepted contacts.
 *   4. Include users with visibility='everyone' AND status='active'.
 *   5. Exclude blocked users (either direction).
 *   6. Exclude visibility='nobody' for non-actor / non-co-member viewers (E15).
 */

export type VisibilityValue = "everyone" | "contacts" | "nobody";

export interface UserRef {
  id: string;
  email: string;
  display_name: string | null;
  visibility: VisibilityValue;
  status: "active" | "disabled";
}

export interface ActorRef {
  user_id: string;
  /** IDs of all groups the actor belongs to */
  group_ids: string[];
}

export interface GroupMemberRef {
  user_id: string;
  group_id: string;
}

export interface ContactRef {
  /** The contact's user id (already filtered to accepted status) */
  contact_user_id: string;
}

export interface VisibilityFilterOptions {
  actor: ActorRef;
  users: UserRef[];
  /** All group_members rows (used to determine co-membership) */
  groupMembers: GroupMemberRef[];
  /**
   * Phase 6+: accepted contacts of the actor.
   * When provided, users with visibility='contacts' who are in this list are included.
   */
  acceptedContactIds?: Set<string>;
  /**
   * Phase 6+: set of user IDs that are blocked in either direction
   * (actor blocked them OR they blocked actor).
   */
  blockedUserIds?: Set<string>;
  /**
   * Phase 6+: when true (the safe default), enforce `contacts` and `nobody`
   * rules. Pass `false` only on legacy Phase-3 paths that intentionally
   * surface every active user (V-2 / agentic-inbox-hardening Phase 2 — the
   * audit found the previous default-false silently re-introduced Phase 3
   * mode for any new caller that forgot to pass the flag).
   */
  enforceContactsAndNobody?: boolean;
}

/**
 * Filter a list of users to those visible to the actor for autocomplete.
 *
 * Phase 6+ rules (default — enforceContactsAndNobody = true):
 *   1. Always include self.
 *   2. Always include co-members (regardless of visibility).
 *   3. Always include actor's accepted contacts.
 *   4. Include users with visibility='everyone' AND status='active'.
 *   5. Exclude blocked users (either direction).
 *   6. Exclude visibility='nobody' for non-actor / non-co-member viewers (E15).
 *
 * Phase 3 rules (legacy — opt-in via enforceContactsAndNobody = false):
 *   1. Always include the actor themselves (self).
 *   2. Include any user whose visibility = 'everyone'.
 *   3. Include co-members (share at least one group with the actor).
 *
 * V-2 (audit, agentic-inbox-hardening Phase 2): default flipped from false
 * to true so omitting the flag yields the safe behaviour. Any future caller
 * that genuinely needs Phase-3 semantics must pass `false` explicitly,
 * making the unsafe path locally visible at the call site.
 */
export function filterVisibleUsers(opts: VisibilityFilterOptions): UserRef[] {
  const {
    actor,
    users,
    groupMembers,
    acceptedContactIds = new Set(),
    blockedUserIds = new Set(),
    enforceContactsAndNobody = true,
  } = opts;

  // Build a set of user IDs that share at least one group with the actor
  const actorGroupSet = new Set(actor.group_ids);
  const coMemberIds = new Set<string>(
    groupMembers
      .filter(
        (gm) => actorGroupSet.has(gm.group_id) && gm.user_id !== actor.user_id,
      )
      .map((gm) => gm.user_id),
  );

  return users.filter((u) => {
    // Skip disabled users
    if (u.status !== "active") return false;

    // Always include self
    if (u.id === actor.user_id) return true;

    if (enforceContactsAndNobody) {
      // Phase 6: Exclude blocked users (either direction)
      if (blockedUserIds.has(u.id)) return false;

      // Always include co-members (regardless of visibility)
      if (coMemberIds.has(u.id)) return true;

      // Always include actor's accepted contacts
      if (acceptedContactIds.has(u.id)) return true;

      // Apply visibility rules
      switch (u.visibility) {
        case "everyone":
          return true;
        case "contacts":
          // Only visible to actor's contacts — already handled above
          return false;
        case "nobody":
          // E15: never visible to non-co-member / non-self viewers
          return false;
        default:
          return false;
      }
    } else {
      // Phase 3: include all active users (enforcement deferred)
      // Always include co-members (regardless of visibility)
      if (coMemberIds.has(u.id)) return true;
      return true;
    }
  });
}

/**
 * Phase C3 / TASK-C3.5 — single-user visibility predicate.
 *
 * Closes audit P2-4 + B-07 — `/avatars/:userId{,/original}` was leaking the
 * R2 object body of any user the caller could enumerate (any authenticated
 * user could fetch any other user's avatar regardless of their visibility
 * setting). This predicate runs the same rule set as `filterVisibleUsers`
 * but for one (actor, target) pair, returning `true` iff the actor is
 * permitted to see the target.
 *
 * Same Phase 6+ rules apply:
 *   1. Self → always visible.
 *   2. Co-members (share at least one group) → always visible.
 *   3. Accepted contacts → always visible.
 *   4. visibility='everyone' AND status='active' → visible.
 *   5. Blocked in either direction → never visible.
 *   6. visibility='nobody' for non-self / non-co-member → never visible.
 *   7. Disabled accounts → never visible.
 *
 * Inputs are pre-resolved by the caller so this predicate is pure (no I/O).
 */
export function canSeeUser(opts: {
  actor: ActorRef;
  target: UserRef;
  /** Group_members rows for the target (caller pre-filters to target's rows). */
  targetGroupIds: string[];
  /** Accepted contacts of the actor (mirrors `acceptedContactIds` in the list filter). */
  acceptedContactIds: Set<string>;
  /** Blocked-either-direction set (mirrors `blockedUserIds` in the list filter). */
  blockedUserIds: Set<string>;
}): boolean {
  const { actor, target, targetGroupIds, acceptedContactIds, blockedUserIds } =
    opts;

  // Self always visible — never blocked by visibility rules.
  if (target.id === actor.user_id) return true;

  // Disabled accounts: hidden from everyone except self (above).
  if (target.status !== "active") return false;

  // Blocked → never (either direction).
  if (blockedUserIds.has(target.id)) return false;

  // Co-members: any group overlap → visible.
  const actorGroupSet = new Set(actor.group_ids);
  if (targetGroupIds.some((g) => actorGroupSet.has(g))) return true;

  // Accepted contacts: visible regardless of visibility setting.
  if (acceptedContactIds.has(target.id)) return true;

  // Visibility-driven decision for non-co-member, non-contact viewers.
  switch (target.visibility) {
    case "everyone":
      return true;
    case "contacts":
      // Already excluded above (they would have been in acceptedContactIds).
      return false;
    case "nobody":
      return false;
    default:
      return false;
  }
}

/**
 * Score and sort users for autocomplete relevance.
 * Co-members rank higher than strangers; exact email prefix ranks highest.
 */
export function sortByRelevance(
  users: UserRef[],
  query: string,
  coMemberIds: Set<string>,
): UserRef[] {
  const q = query.toLowerCase();
  return [...users].sort((a, b) => {
    const aEmail = a.email.toLowerCase();
    const bEmail = b.email.toLowerCase();
    const aName = (a.display_name ?? "").toLowerCase();
    const bName = (b.display_name ?? "").toLowerCase();

    // Exact email-prefix match wins
    const aExact = aEmail.startsWith(q) || aName.startsWith(q) ? 1 : 0;
    const bExact = bEmail.startsWith(q) || bName.startsWith(q) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;

    // Co-members rank above strangers
    const aCo = coMemberIds.has(a.id) ? 1 : 0;
    const bCo = coMemberIds.has(b.id) ? 1 : 0;
    if (aCo !== bCo) return bCo - aCo;

    return aEmail.localeCompare(bEmail);
  });
}
