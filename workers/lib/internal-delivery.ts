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

// ── Internal delivery ─────────────────────────────────────────────

/**
 * Short-circuit a message into a destination mailbox's INBOX.
 *
 * Mirrors the inbound flow at workers/index.ts (the catch-all email handler)
 * which also writes via createEmail. Does NOT call env.EMAIL.send().
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
