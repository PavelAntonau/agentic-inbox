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
 */
function mockEmailBinding(env: Env): SendEmail {
  return {
    async send(message: unknown): Promise<{ messageId: string }> {
      const params = message as SendEmailParams;
      const id = await writeOutboxEntry(env, params);
      return { messageId: id };
    },
  } as unknown as SendEmail;
}
