// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// mailbox-token-permissions.ts — permission predicates for agent-token operations.
//
// `canIssueToken` and `canRevokeToken` live in shared/permissions/agent-tokens.ts
// (Phase 7 T7.7) so the client (MailboxNode rail) and the worker enforce the
// same rule. `canListTokens` stays here — it depends on the worker-only
// `authorized_mailbox_ids` set.

import type { AuthzContext } from "../db/control-plane/forGroup";
import {
  canIssueToken as sharedCanIssueToken,
  canRevokeToken as sharedCanRevokeToken,
  isGlobalRole,
  type AgentTokenRow,
  type MailboxRow,
  type PermResult,
} from "shared/permissions/agent-tokens";

export type { PermResult, MailboxRow, AgentTokenRow };

/**
 * canIssueToken — re-export of the shared predicate. AuthzContext
 * structurally satisfies ActorIdentity ({ user_id, role }).
 */
export const canIssueToken = (
  actor: AuthzContext,
  mailbox: MailboxRow,
): PermResult => sharedCanIssueToken(actor, mailbox);

/**
 * canRevokeToken — re-export of the shared predicate.
 */
export const canRevokeToken = (
  actor: AuthzContext,
  mailbox: MailboxRow,
  token: AgentTokenRow,
): PermResult => sharedCanRevokeToken(actor, mailbox, token);

/**
 * canListTokens — actor can view the token list for a given mailbox.
 *
 * Allowed: mailbox owner, any authorized group member, OR global. Worker-only
 * because authorized_mailbox_ids is a server-resolved set.
 */
export function canListTokens(
  actor: AuthzContext,
  mailbox: MailboxRow,
): PermResult {
  if (isGlobalRole(actor.role)) return { ok: true };
  if (mailbox.owner_user_id === actor.user_id) return { ok: true };
  if (actor.authorized_mailbox_ids.includes(mailbox.id)) return { ok: true };
  return {
    ok: false,
    reason: "You do not have access to this mailbox.",
  };
}
