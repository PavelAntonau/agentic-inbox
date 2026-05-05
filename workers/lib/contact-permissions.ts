// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// contact-permissions.ts — permission predicates for contacts operations.
//
// Mirrors the Phase-4 mailbox-permissions.ts pattern:
//   - Pure exported functions (no side-effects, no DB calls)
//   - All predicates return PermResult { ok: boolean; reason?: string }

import type { AuthzContext } from "../db/control-plane/forGroup";
import type { VisibilityValue } from "./visibility-filter";

export interface PermResult {
  ok: boolean;
  reason?: string;
}

export interface ContactRow {
  owner_user_id: string;
  contact_user_id: string;
  status: "pending" | "accepted" | "blocked";
  initiated_by: string;
}

/**
 * Is the target reachable for a contact request from the actor under D-aim-12?
 *
 * Audit fix F-C2 (graph: HejuxD6Ia0YOZP805meVV). The privacy contract:
 *   - `everyone` and `contacts` tier: always reachable for a request (per-user
 *     accept/decline still gates whether the relationship completes).
 *   - `nobody` tier: reachable ONLY by co-members (someone in any of the
 *     actor's groups) OR by users the actor has already accepted as a contact.
 *     Otherwise the route MUST return 404 with the same shape as "user not
 *     found" so a caller cannot probe for the user_id's existence.
 *   - Self: always reachable (callers separately reject self-as-target via
 *     canSendContactRequest, but the visibility gate alone passes self).
 *
 * This predicate is purely mechanical — the caller is responsible for fetching
 * the target's visibility, the target's group memberships, and whether the
 * actor has an accepted-contact row pointing at the target.
 */
export function isReachableForContactRequest(args: {
  actor: AuthzContext;
  targetUserId: string;
  targetVisibility: VisibilityValue;
  targetGroupIds: string[];
  actorHasAcceptedContact: boolean;
}): boolean {
  const {
    actor,
    targetUserId,
    targetVisibility,
    targetGroupIds,
    actorHasAcceptedContact,
  } = args;

  // Self always passes the visibility gate. canSendContactRequest's separate
  // self-check is what prevents self-requests; this predicate doesn't double
  // up that policy.
  if (targetUserId === actor.user_id) return true;

  // Non-nobody tiers don't gate at the request layer (per D-aim-12 — the
  // protection for `contacts` tier is at the autocomplete / discovery layer
  // via filterVisibleUsers; once a user_id is known, requests can flow).
  if (targetVisibility !== "nobody") return true;

  // Nobody tier: must be a co-member or already an accepted contact.
  const actorGroups = new Set(actor.group_ids);
  const isCoMember = targetGroupIds.some((g) => actorGroups.has(g));
  return isCoMember || actorHasAcceptedContact;
}

/**
 * canSendContactRequest — actor can send a contact request to target.
 *
 * Blocked if the target has blocked the actor, or actor has blocked target.
 * Cannot send to self.
 */
export function canSendContactRequest(
  actor: AuthzContext,
  targetUserId: string,
  blockedByTarget: boolean,
  actorBlockedTarget: boolean,
): PermResult {
  if (actor.user_id === targetUserId) {
    return { ok: false, reason: "Cannot send contact request to yourself." };
  }
  if (blockedByTarget) {
    return { ok: false, reason: "Unable to send contact request." };
  }
  if (actorBlockedTarget) {
    return {
      ok: false,
      reason: "Unblock this user before sending a contact request.",
    };
  }
  return { ok: true };
}

/**
 * canAcceptContactRequest — actor can accept a pending contact request.
 *
 * The request must be addressed to the actor (contact_user_id = actor).
 */
export function canAcceptContactRequest(
  actor: AuthzContext,
  request: ContactRow,
): PermResult {
  if (request.contact_user_id !== actor.user_id) {
    return {
      ok: false,
      reason: "This contact request is not addressed to you.",
    };
  }
  if (request.status !== "pending") {
    return { ok: false, reason: `Request is already ${request.status}.` };
  }
  return { ok: true };
}

/**
 * canDeclineContactRequest — actor can decline a pending contact request.
 *
 * The request must be addressed to the actor.
 */
export function canDeclineContactRequest(
  actor: AuthzContext,
  request: ContactRow,
): PermResult {
  if (request.contact_user_id !== actor.user_id) {
    return {
      ok: false,
      reason: "This contact request is not addressed to you.",
    };
  }
  if (request.status !== "pending") {
    return { ok: false, reason: `Request is already ${request.status}.` };
  }
  return { ok: true };
}

/**
 * canBlockUser — actor can block any other user.
 *
 * Cannot block self. No other restriction.
 */
export function canBlockUser(
  actor: AuthzContext,
  targetUserId: string,
): PermResult {
  if (actor.user_id === targetUserId) {
    return { ok: false, reason: "Cannot block yourself." };
  }
  return { ok: true };
}
