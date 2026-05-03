// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// contact-permissions.ts — permission predicates for contacts operations.
//
// Mirrors the Phase-4 mailbox-permissions.ts pattern:
//   - Pure exported functions (no side-effects, no DB calls)
//   - All predicates return PermResult { ok: boolean; reason?: string }

import type { AuthzContext } from "../db/control-plane/forGroup";

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
