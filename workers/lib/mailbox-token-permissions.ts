// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// mailbox-token-permissions.ts — permission predicates for agent-token operations.
//
// Mirrors the Phase-4 mailbox-permissions.ts pattern:
//   - Pure exported functions (no side-effects, no DB calls)
//   - All predicates return PermResult { ok: boolean; reason?: string }
//   - ONLY place that encodes token ACL logic — endpoints MUST import from here

import type { AuthzContext } from "../db/control-plane/forGroup";

export interface PermResult {
  ok: boolean;
  reason?: string;
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

function isGlobal(role: AuthzContext["role"]): boolean {
  return role === "global_owner" || role === "global_admin";
}

/**
 * canIssueToken — actor can create an agent token for a given mailbox.
 *
 * Allowed: mailbox owner OR global admin/owner.
 */
export function canIssueToken(
  actor: AuthzContext,
  mailbox: MailboxRow,
): PermResult {
  if (isGlobal(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  return {
    ok: false,
    reason: "Only the mailbox owner or a global admin can issue tokens.",
  };
}

/**
 * canListTokens — actor can view the token list for a given mailbox.
 *
 * Allowed: mailbox owner, any authorized group member, OR global.
 */
export function canListTokens(
  actor: AuthzContext,
  mailbox: MailboxRow,
): PermResult {
  if (isGlobal(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  if (actor.authorized_mailbox_ids.includes(mailbox.id)) return { ok: true };
  return {
    ok: false,
    reason: "You do not have access to this mailbox.",
  };
}

/**
 * canRevokeToken — actor can revoke a specific agent token.
 *
 * Allowed: the user the token was issued to, mailbox owner, OR global.
 */
export function canRevokeToken(
  actor: AuthzContext,
  mailbox: MailboxRow,
  token: AgentTokenRow,
): PermResult {
  if (isGlobal(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  if (token.issued_to_user === actor.user_id) return { ok: true };
  return {
    ok: false,
    reason: "Only the mailbox owner or the token's owner can revoke it.",
  };
}
