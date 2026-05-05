// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * SendEmail binding resolver — production uses Resend, MOCK_MODE uses an
 * R2-backed outbox.
 *
 * Why a binding swap instead of helper-level branching?
 * The existing `sendEmail()` helper in `workers/email-sender.ts` takes the
 * binding as a parameter (not env). Producing the right binding here lets
 * every call site keep the helper unchanged — the only edit per call site
 * is `env.EMAIL` → `getEmailBinding(env)`.
 *
 * Production path was originally Cloudflare Email Routing's `send_email`
 * binding (`env.EMAIL`). That binding is reply-only / verified-destination-
 * only and cannot deliver invitations to fresh recipient addresses; see
 * `.research/mail-delivery-diagnosis.md` for the full root-cause analysis.
 * Production now routes through `getResendBinding(env)`, which conforms to
 * the same SendEmail shape and dispatches via Resend's HTTP API.
 *
 * MOCK_MODE keeps the R2-backed outbox so local + scenario tests don't
 * require a real Resend key.
 */

import type { Env } from "../../types";
import { isMockMode } from "../mock-mode";
import { writeOutboxEntry } from "./outbox-writer";
import { getResendBinding } from "../resend-client";
import type { SendEmailParams } from "../../email-sender";
import { addressIsPrimaryDomain } from "../../../shared/mail-domain";

/**
 * Resolve the SendEmail binding to use for outbound mail.
 * Returns a Resend-backed adapter in production; a mock binding in MOCK_MODE.
 */
export function getEmailBinding(env: Env): SendEmail {
  if (isMockMode(env)) return mockEmailBinding(env);
  return getResendBinding(env);
}

/**
 * Produce a SendEmail-shaped object whose `.send()` writes to the outbox
 * instead of dispatching real mail. Returns a synthetic messageId so callers
 * that log it (e.g. for audit) keep working.
 *
 * Local-domain loopback (F-PHASE6-001 / E2E messaging): any recipient on
 * the primary mail domain gets the message synthesized as RFC-822 and fed
 * into `receiveEmail()` so it lands in the recipient's DO INBOX. This is
 * what makes user-to-user messaging actually testable end-to-end in
 * MOCK_MODE; without it the send only ever writes to the outbox and the
 * recipient never sees anything.
 */
function mockEmailBinding(env: Env): SendEmail {
  return {
    async send(message: unknown): Promise<{ messageId: string }> {
      const params = message as SendEmailParams;
      const id = await writeOutboxEntry(env, params);
      await deliverLocalLoopback(env, params).catch((e: unknown) => {
        console.error(
          "[MOCK_EMAIL] local loopback failed:",
          (e as Error)?.message ?? String(e),
        );
      });
      return { messageId: id };
    },
  } as unknown as SendEmail;
}

function fromAddress(from: SendEmailParams["from"]): string {
  return typeof from === "string" ? from : from.email;
}

function collectRecipients(params: SendEmailParams): string[] {
  const out: string[] = [];
  const push = (v: string | string[] | undefined) => {
    if (!v) return;
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  };
  push(params.to);
  push(params.cc);
  push(params.bcc);
  return out;
}

async function deliverLocalLoopback(
  env: Env,
  params: SendEmailParams,
): Promise<void> {
  const local = collectRecipients(params).filter(addressIsPrimaryDomain);
  if (local.length === 0) return;
  const fromAddr = fromAddress(params.from);
  const { receiveEmail } = await import("../../index");
  for (const to of local) {
    const blob = new Blob([
      `From: ${fromAddr}\r\n`,
      `To: ${to}\r\n`,
      `Subject: ${params.subject}\r\n`,
      `\r\n`,
      params.text ?? params.html ?? "",
    ]);
    await receiveEmail(
      {
        raw: blob.stream(),
        rawSize: blob.size,
      } as unknown as ForwardableEmailMessage,
      env,
      // executionCtx is not strictly needed by receiveEmail; pass a noop shim.
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
  }
}
