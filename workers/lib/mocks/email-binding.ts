// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Mock SendEmail binding for MOCK_MODE.
 *
 * Why a binding swap instead of helper-level branching?
 * The existing `sendEmail()` helper in `workers/email-sender.ts` takes the
 * binding as a parameter (not env). Producing a mock binding lets every call
 * site keep the helper unchanged — the only edit is `env.EMAIL` → `getEmailBinding(env)`.
 *
 * Direct `env.EMAIL.send(...)` callers (e.g. workers/routes/invitations.ts:243)
 * also benefit: the swap captures their messages through the same outbox.
 *
 * See `.research/mock-mode-architecture.md` § 5.
 */

import type { Env } from "../../types";
import { isMockMode } from "../mock-mode";
import { writeOutboxEntry } from "./outbox-writer";
import type { SendEmailParams } from "../../email-sender";

/**
 * Resolve the SendEmail binding to use for outbound mail.
 * Returns the real `env.EMAIL` in production; a mock binding in MOCK_MODE.
 */
export function getEmailBinding(env: Env): SendEmail {
  if (!isMockMode(env)) return env.EMAIL;
  return mockEmailBinding(env);
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
