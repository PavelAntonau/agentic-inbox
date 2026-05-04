// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Resend transactional-mail adapter.
 *
 * Conforms to Cloudflare's `SendEmail` runtime shape (`.send(message)`) so it
 * is a drop-in replacement for `env.EMAIL` behind `getEmailBinding`. Calls
 * https://api.resend.com/emails directly via fetch — no SDK, no extra deps.
 *
 * Why this lives behind the same SendEmail interface: the existing helper
 * `sendEmail(binding, params)` and all 7 call sites (workers/auth, workers/
 * routes/invitations, workers/index, workers/routes/reply-forward, workers/
 * lib/tools — two sites) keep working unchanged. The adapter swap is the
 * only edit per call site, and it happens centrally in
 * workers/lib/mocks/email-binding.ts.
 *
 * Sender domain: callers pass `{ name, email }` for `from`; Resend requires
 * the sender domain to be verified in the dashboard. v0.1 expects
 * `actionnow.ai` (apex) verified, with both `noreply@actionnow.ai` (invites)
 * and `auth@actionnow.ai` (sign-in codes) usable from it.
 *
 * Errors: Resend returns 4xx with a JSON body `{ name, message, statusCode }`.
 * We surface the message in a thrown Error so callers (better-auth, the
 * invitation route, the reply/forward routes) can log + surface to the
 * inviter where appropriate.
 */

import type { Env } from "../types";
import type { SendEmailParams } from "../email-sender";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

interface ResendSuccess {
  id: string;
}

interface ResendError {
  name: string;
  message: string;
  statusCode?: number;
}

/**
 * Format a `from` field for Resend. Resend accepts either a bare email
 * (`noreply@actionnow.ai`) or RFC-5322 name-addr format
 * (`"Display Name" <noreply@actionnow.ai>`).
 */
function formatAddress(addr: string | { email: string; name: string }): string {
  if (typeof addr === "string") return addr;
  // Quote the display name to handle commas, quotes, and other RFC-5322
  // specials. Resend's parser is strict about this.
  const safeName = addr.name.replace(/"/g, '\\"');
  return `"${safeName}" <${addr.email}>`;
}

function formatAddressList(
  list: string | string[] | undefined,
): string[] | undefined {
  if (!list) return undefined;
  return Array.isArray(list) ? list : [list];
}

/**
 * Build the Resend request body from our internal SendEmailParams shape.
 */
export function buildResendPayload(
  params: SendEmailParams,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: formatAddress(params.from),
    to: formatAddressList(params.to as string | string[]),
    subject: params.subject,
  };

  if (params.html) payload.html = params.html;
  if (params.text) payload.text = params.text;
  if (params.cc) payload.cc = formatAddressList(params.cc);
  if (params.bcc) payload.bcc = formatAddressList(params.bcc);
  if (params.replyTo) payload.reply_to = formatAddress(params.replyTo);

  if (params.headers && Object.keys(params.headers).length > 0) {
    payload.headers = params.headers;
  }

  if (params.attachments && params.attachments.length > 0) {
    payload.attachments = params.attachments.map((att) => ({
      filename: att.filename,
      content: att.content, // Resend accepts base64
      content_type: att.type,
      ...(att.contentId ? { content_id: att.contentId } : {}),
    }));
  }

  return payload;
}

/**
 * Fire one Resend send. Throws on non-2xx with a message that includes the
 * Resend error name + message + status. Returns the messageId on success.
 */
export async function sendViaResend(
  apiKey: string,
  params: SendEmailParams,
): Promise<{ messageId: string }> {
  const payload = buildResendPayload(params);

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errBody: ResendError | null = null;
    try {
      errBody = (await response.json()) as ResendError;
    } catch {
      // ignore — fall back to status-line message below
    }
    const status = response.status;
    const name = errBody?.name ?? "resend_error";
    const msg = errBody?.message ?? response.statusText;
    throw new Error(`Resend send failed (${status} ${name}): ${msg}`);
  }

  const body = (await response.json()) as ResendSuccess;
  return { messageId: body.id };
}

/**
 * Build a SendEmail-shaped object backed by Resend. The returned object can
 * be passed anywhere `SendEmail` is expected (CF Email Routing's binding
 * shape), so callers that already use `sendEmail(binding, params)` keep
 * working with no code changes.
 */
export function getResendBinding(env: Env): SendEmail {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    // Fail loudly at the binding boundary so misconfiguration surfaces in
    // logs the first time a send is attempted, not silently from a downstream
    // call site.
    throw new Error(
      "RESEND_API_KEY is not configured. Set it via `wrangler secret put RESEND_API_KEY`.",
    );
  }
  return {
    async send(message: unknown): Promise<{ messageId: string }> {
      const params = message as SendEmailParams;
      return sendViaResend(apiKey, params);
    },
  } as unknown as SendEmail;
}
