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
   * Phase 6+ only: when true, enforce `contacts` and `nobody` rules.
   * In Phase 3 this is always false — kept here so Phase 6 can flip it.
   */
  enforceContactsAndNobody?: boolean;
}

/**
 * Filter a list of users to those visible to the actor for autocomplete.
 *
 * Phase 3 rules (enforceContactsAndNobody = false):
 *   1. Always include the actor themselves (self).
 *   2. Include any user whose visibility = 'everyone'.
 *   3. Include co-members (share at least one group with the actor).
 *
 * Phase 6+ rules (enforceContactsAndNobody = true):
 *   1. Always include self.
 *   2. Always include co-members (regardless of visibility).
 *   3. Always include actor's accepted contacts.
 *   4. Include users with visibility='everyone' AND status='active'.
 *   5. Exclude blocked users (either direction).
 *   6. Exclude visibility='nobody' for non-actor / non-co-member viewers (E15).
 */
export function filterVisibleUsers(opts: VisibilityFilterOptions): UserRef[] {
  const {
    actor,
    users,
    groupMembers,
    acceptedContactIds = new Set(),
    blockedUserIds = new Set(),
    enforceContactsAndNobody = false,
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
