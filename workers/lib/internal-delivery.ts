// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Internal-delivery short-circuit and send-policy decision tree.
 *
 * When a mailbox sends to an address that resolves to another mailbox in our
 * D1 control-plane OR R2 v1 bucket, we MUST bypass Cloudflare Email Routing
 * and write straight into the destination MailboxDO's INBOX folder. This:
 *
 *   - eliminates the round-trip through external SMTP,
 *   - removes any chance of a real outbound email being sent for an
 *     intra-platform message,
 *   - lets us enforce the per-mailbox `external_send_enabled` flag (added
 *     in migration 0010) by gating only the actually-external branch.
 *
 * Inputs:
 *   * destinationBackend — output of resolveMailboxBackend(env, toAddress).
 *   * sourceExternalSendEnabled — read from the source mailbox's D1 row
 *     (or `false` if the source isn't in D1: v1 mailboxes default to
 *     internal-only and must be migrated to D1 before they can send out).
 *
 * Outputs:
 *   * { route: "internal" }   — call deliverInternal()
 *   * { route: "external" }   — call env.EMAIL.send()
 *   * { route: "denied" }     — return an error to the tool caller
 */

import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import { Folders } from "../../shared/folders";
import { getMailboxStub } from "./email-helpers";
import type { Env } from "../types";
import type { MailboxDO } from "../durableObject";

// ── Types ──────────────────────────────────────────────────────────

/** Backend resolution result for a destination address. */
export type MailboxBackend =
  | { kind: "d1"; row: typeof schema.mailboxes.$inferSelect }
  | { kind: "r2"; row: { id: string; address: string } };

export type SendPolicyDecision =
  | { route: "internal"; destinationBackend: MailboxBackend }
  | { route: "external" }
  | { route: "denied"; error: string };

/**
 * Inbound-policy gate result for an internal delivery (Phase C2 / D-01).
 *
 * Mirrors `accepted | bounced` from `receiveEmail` in workers/index.ts. When
 * `accepted=false`, the caller MUST return the audit-friendly `error` to the
 * tool caller and refuse to write into the destination's INBOX.
 */
export type InternalPolicyDecision =
  | { accepted: true }
  | { accepted: false; reason: InternalPolicyRejection; error: string };

export type InternalPolicyRejection =
  | "external-inbound-disabled"
  | "external-allowlist-miss"
  | "internal-inbound-none"
  | "internal-inbound-contacts-only";

export interface DeliverInternalParams {
  /** Lower-case email address of the source mailbox (matches DO id semantics). */
  fromMailboxId: string;
  /** Lower-case email address of the destination mailbox. */
  toAddress: string;
  subject: string;
  /** Pre-sanitized HTML body. */
  bodyHtml: string;
  /** RFC 2822 Message-ID for the outgoing message (no angle brackets). */
  outgoingMessageId: string;
  /** Internal database id for the outgoing message (UUID). */
  messageId: string;
  /** Optional threading metadata. */
  threading?: {
    in_reply_to?: string | null;
    email_references?: string | null;
    thread_id?: string | null;
  };
}

export interface DeliverInternalResult {
  messageId: string;
  deliveredVia: "internal";
}

// ── Pure decision function ────────────────────────────────────────

/**
 * Decide which delivery path applies given the destination resolution and the
 * source mailbox's outbound flag. Pure — no I/O — so the four-branch decision
 * tree is exhaustively unit-tested.
 *
 * Branches:
 *   1. destination resolves to a mailbox we own (D1 or R2) → internal.
 *      External flag is ignored for internal sends; intra-platform mail
 *      always short-circuits.
 *   2. destination is external + source has external_send_enabled=true → external.
 *   3. destination is external + source has external_send_enabled=false → denied.
 *   4. destination is external + source flag undefined (v1 mailbox without
 *      D1 row) → denied with v1-specific guidance.
 */
export function decideSendPolicy(args: {
  destinationBackend: MailboxBackend | null;
  sourceExternalSendEnabled: boolean | undefined;
}): SendPolicyDecision {
  const { destinationBackend, sourceExternalSendEnabled } = args;

  if (destinationBackend) {
    return { route: "internal", destinationBackend };
  }

  if (sourceExternalSendEnabled === true) {
    return { route: "external" };
  }

  if (sourceExternalSendEnabled === undefined) {
    return {
      route: "denied",
      error:
        "External sending requires a D1-managed mailbox. " +
        "Migrate this mailbox to the control plane and enable Outbound in settings.",
    };
  }

  return {
    route: "denied",
    error:
      "External sending is disabled for this mailbox. " +
      "Enable it in /mailbox/:id/settings → Outbound.",
  };
}

// ── Inbound-policy gate (Phase C2 / D-01) ─────────────────────────

/**
 * Apply destination's inbound policy to an internal-delivery candidate.
 *
 * Mirrors the gate stack in `receiveEmail` (workers/index.ts:646-749) so an
 * intra-platform send respects the same external-inbound, allowlist, and
 * internal-inbound-mode policies the recipient has configured. Without this
 * check, a workspace user could send to another mailbox even when the
 * recipient had set internal_inbound_mode='none' or
 * external_inbound_enabled=0 — internal-delivery short-circuits the entire
 * Cloudflare Email Routing pipeline, including its policy checks.
 *
 * Inputs:
 *   * destinationRow — the D1 row for the recipient mailbox (kind="d1"
 *     branch of MailboxBackend). v1-only mailboxes (kind="r2") have no
 *     policy columns and skip the gate, matching receiveEmail's semantics.
 *   * senderEmail — lower-cased sender address (the source mailbox id is
 *     itself an email address).
 *   * senderUserId — when the sender's email resolves to a `users` row,
 *     the sender is "internal" and the internal_inbound_mode applies. When
 *     undefined, the sender is treated as external and only the external
 *     gates run.
 *
 * Returns `{ accepted: true }` on pass; `{ accepted: false, reason, error }`
 * on rejection. The caller surfaces `error` to the tool caller verbatim.
 */
export async function evaluateInternalDeliveryPolicy(
  env: Env,
  destinationRow: typeof schema.mailboxes.$inferSelect,
  senderEmail: string,
  senderUserId: string | undefined,
): Promise<InternalPolicyDecision> {
  const senderEmailLc = senderEmail.toLowerCase();

  // External path: senderUserId === undefined means the sender is external.
  // Apply the same external_inbound_enabled + external_allow_mode gates as
  // receiveEmail. Internal senders skip these gates per the existing
  // receiveEmail semantics (an internal sender's email is always allowed
  // through the external check; the internal_inbound_mode below governs
  // them instead).
  if (!senderUserId) {
    if (!destinationRow.external_inbound_enabled) {
      return {
        accepted: false,
        reason: "external-inbound-disabled",
        error: `Recipient has disabled external inbound mail.`,
      };
    }
    if (destinationRow.external_allow_mode === "allowlist") {
      if (!senderEmailLc) {
        return {
          accepted: false,
          reason: "external-allowlist-miss",
          error: `Recipient is in allowlist mode and sender address is unknown.`,
        };
      }
      const senderDomain = senderEmailLc.includes("@")
        ? senderEmailLc.split("@").pop()!
        : "";
      const allowlist = await env.DB.prepare(
        "SELECT sender_pattern, kind FROM inbox_external_allowlist WHERE inbox_id = ?1",
      )
        .bind(destinationRow.id)
        .all<{ sender_pattern: string; kind: string }>();
      const matched = (allowlist.results ?? []).some((entry) => {
        const pattern = entry.sender_pattern.toLowerCase().trim();
        if (entry.kind === "email") return pattern === senderEmailLc;
        if (entry.kind === "domain") {
          const dom = pattern.startsWith("@") ? pattern.slice(1) : pattern;
          return senderDomain === dom;
        }
        return false;
      });
      if (!matched) {
        return {
          accepted: false,
          reason: "external-allowlist-miss",
          error: `Sender ${senderEmailLc} is not on the recipient's allowlist.`,
        };
      }
    }
    return { accepted: true };
  }

  // Internal path: sender resolved to a users row. Apply
  // internal_inbound_mode the same way receiveEmail does.
  const mode = destinationRow.internal_inbound_mode;
  if (mode === "none") {
    return {
      accepted: false,
      reason: "internal-inbound-none",
      error: `Recipient has disabled internal mail (internal_inbound_mode=none).`,
    };
  }
  if (mode === "contacts_only") {
    const contact = await env.DB.prepare(
      "SELECT 1 FROM contacts WHERE owner_user_id = ?1 AND contact_user_id = ?2 AND status = 'accepted' AND declined_at IS NULL",
    )
      .bind(destinationRow.owner_user_id, senderUserId)
      .first<{ "1": number }>();
    if (!contact) {
      return {
        accepted: false,
        reason: "internal-inbound-contacts-only",
        error: `Recipient accepts internal mail only from contacts; sender is not an accepted contact.`,
      };
    }
  }
  return { accepted: true };
}

// ── Internal delivery ─────────────────────────────────────────────

/**
 * Short-circuit a message into a destination mailbox's INBOX.
 *
 * Mirrors the inbound flow at workers/index.ts (the catch-all email handler)
 * which also writes via createEmail. Does NOT call env.EMAIL.send().
 *
 * Phase C2 / D-01: the inbound-policy gate (`evaluateInternalDeliveryPolicy`)
 * is applied by the caller (the tool layer) BEFORE invoking deliverInternal,
 * so the gate's rejection becomes a tool-caller-visible error rather than a
 * silent INBOX write. deliverInternal itself remains pure-write — splitting
 * the gate from the write keeps the test surface flat.
 *
 * Best-effort audit log: failures are swallowed so an audit-row write
 * never blocks delivery (matches appendAudit's contract).
 */
export async function deliverInternal(
  env: Env,
  params: DeliverInternalParams,
): Promise<DeliverInternalResult> {
  const stub: DurableObjectStub<MailboxDO> = getMailboxStub(
    env,
    params.toAddress,
  );

  await stub.createEmail(
    Folders.INBOX,
    {
      id: params.messageId,
      subject: params.subject,
      sender: params.fromMailboxId,
      recipient: params.toAddress,
      date: new Date().toISOString(),
      body: params.bodyHtml,
      in_reply_to: params.threading?.in_reply_to ?? null,
      email_references: params.threading?.email_references ?? null,
      thread_id: params.threading?.thread_id ?? params.messageId,
      message_id: params.outgoingMessageId,
    },
    [],
  );

  await writeInternalDeliveryAudit(env, params).catch((e) => {
    console.error(
      "internal-delivery audit_log write failed:",
      (e as Error).message,
    );
  });

  return { messageId: params.messageId, deliveredVia: "internal" };
}

async function writeInternalDeliveryAudit(
  env: Env,
  params: DeliverInternalParams,
): Promise<void> {
  if (!env.DB) return;
  const orm = drizzle(env.DB, { schema });
  await orm
    .insert(schema.audit_log)
    .values({
      at: Date.now(),
      actor_user_id: null,
      actor_token_id: null,
      action: "email.internal_deliver",
      target_type: "email",
      target_id: params.messageId,
      scope_group_id: null,
      meta_json: JSON.stringify({
        from: params.fromMailboxId,
        to: params.toAddress,
        outgoing_message_id: params.outgoingMessageId,
      }),
      ip: null,
    })
    .run();
}
