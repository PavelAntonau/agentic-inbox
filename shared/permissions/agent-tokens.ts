// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// shared/permissions/agent-tokens.ts — agent-token permission predicates.
//
// Single source of truth for "who can issue / revoke an agent token for a
// given mailbox". Imported by:
//   - workers/lib/mailbox-token-permissions.ts (server-side enforcement)
//   - app/components/shell/MailboxNode.tsx     (client-side UI gating)
//
// Phase 7 T7.7 carve-out: previously the client had a copy-paste of the
// `canIssueToken` predicate (`isOwner || isGlobal`). Drift risk eliminated
// by colocating both consumers on this module.
//
// `canListTokens` stays in workers/lib because it depends on the
// authorized_mailbox_ids set that's only resolved server-side; the client
// already gates the token route by role.

export interface PermResult {
  ok: boolean;
  reason?: string;
}

export type ActorRole = "global_owner" | "global_admin" | "user";

/**
 * Minimal actor shape — both worker `AuthzContext` and the client's
 * `(actorUserId, actorRole)` pair satisfy this structurally.
 */
export interface ActorIdentity {
  user_id: string;
  role: ActorRole;
}

export interface MailboxRow {
  id: string;
  owner_user_id: string;
}

export interface AgentTokenRow {
  id: string;
  mailbox_id: string;
  issued_to_user: string;
  revoked_at: number | null;
}

export function isGlobalRole(role: ActorRole): boolean {
  return role === "global_owner" || role === "global_admin";
}

/**
 * canIssueToken — actor can create an agent token for a given mailbox.
 *
 * Allowed: mailbox owner OR global admin/owner.
 */
export function canIssueToken(
  actor: ActorIdentity,
  mailbox: MailboxRow,
): PermResult {
  if (isGlobalRole(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  return {
    ok: false,
    reason: "Only the mailbox owner or a global admin can issue tokens.",
  };
}

/**
 * canRevokeToken — actor can revoke a specific agent token.
 *
 * Allowed: the user the token was issued to, mailbox owner, OR global.
 */
export function canRevokeToken(
  actor: ActorIdentity,
  mailbox: MailboxRow,
  token: AgentTokenRow,
): PermResult {
  if (isGlobalRole(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  if (token.issued_to_user === actor.user_id) return { ok: true };
  return {
    ok: false,
    reason: "Only the mailbox owner or the token's owner can revoke it.",
  };
}
