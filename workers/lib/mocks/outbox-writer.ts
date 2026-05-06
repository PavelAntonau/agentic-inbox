// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Outbox writer — persists outgoing mail (in MOCK_MODE) to R2 + tees OTPs.
 *
 * Layout in R2 (BUCKET binding):
 *   __mock__/outbox/<unix-ms>-<uuid>.json    one row per send
 *   __mock__/otp/<email>.json                latest OTP per address (1 row each)
 *
 * Also emits a `console.log("[MOCK_EMAIL]", id)` correlation marker so the
 * smoke verifier can confirm without waiting on R2 list visibility.
 *
 * See `.research/mock-mode-architecture.md` § 4.1, 4.2.
 */

import type { Env } from "../../types";
import type { SendEmailParams } from "../../email-sender";

const OUTBOX_PREFIX = "__mock__/outbox/";
const OTP_PREFIX = "__mock__/otp/";

/**
 * Phase C3 / C3.14 (D-09): hostname-based hard-stop. The mock outbox
 * MUST refuse to write rows when running against the production
 * deployment. The MOCK_MODE flag is the primary gate (set ONLY in
 * `.dev.vars`), but a misconfigured rollback or env-injection bug
 * could leak it; this guard is the second line of defense — keyed on
 * the immutable production hostname instead of a flag value an
 * attacker could flip.
 */
const PRODUCTION_HOSTNAME = "mail.actionnow.ai";

/**
 * Detect production hostname from an optional URL string. Accepts
 * full URL forms (`https://mail.actionnow.ai/...`) and bare hostnames
 * (`mail.actionnow.ai`). Returns true when the resolved hostname
 * matches the production canonical hostname (case-insensitive).
 */
export function isProductionHostname(rawUrl: string | undefined): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === PRODUCTION_HOSTNAME;
  } catch {
    // Bare hostname or malformed URL — fall through to direct compare.
    return rawUrl.trim().toLowerCase() === PRODUCTION_HOSTNAME;
  }
}

/**
 * The hard-error class. Throwing (not silent skip) is intentional: if
 * MOCK_MODE leaks into production, every send must surface as a 5xx
 * so the operator notices immediately. A silent skip would leave the
 * caller thinking mail was queued when it never landed.
 */
export class MockOutboxProductionRefusalError extends Error {
  constructor() {
    super(
      "Mock outbox refused — running against the production hostname. " +
        "MOCK_MODE must be unset on the production deploy. " +
        "Investigate immediately: a leaked dev flag is the most likely cause.",
    );
    this.name = "MockOutboxProductionRefusalError";
  }
}

/** Best-effort 6-digit OTP extraction from subject + body. */
function extractOtp(
  subject: string,
  text?: string,
  html?: string,
): string | null {
  const isOtpEmail =
    /sign[-\s]?in code|verification code|verify your email|one[-\s]?time/i.test(
      subject,
    );
  if (!isOtpEmail) return null;
  const haystack = `${text ?? ""}\n${html ?? ""}`;
  const m = haystack.match(/\b(\d{6})\b/);
  return m?.[1] ?? null;
}

function firstRecipient(to: string | string[]): string | null {
  if (typeof to === "string") return to;
  return to[0] ?? null;
}

/**
 * Persist one outgoing email to the mock outbox. Returns the synthetic
 * messageId that the SendEmail-shaped binding hands back to the caller.
 *
 * Phase C3 / C3.14 (D-09): when `requestUrl` is provided AND its
 * hostname matches the production canonical, throw
 * `MockOutboxProductionRefusalError` immediately. The mock outbox is
 * a development-only artefact; running it against production is
 * always a configuration error.
 */
export async function writeOutboxEntry(
  env: Env,
  params: SendEmailParams,
  options?: { requestUrl?: string | undefined | null },
): Promise<string> {
  if (options?.requestUrl && isProductionHostname(options.requestUrl)) {
    throw new MockOutboxProductionRefusalError();
  }
  const id = crypto.randomUUID();
  const tsMs = Date.now();
  const recipient = firstRecipient(params.to);
  const otpCode = extractOtp(params.subject, params.text, params.html);

  const record = {
    _meta: {
      ts_ms: tsMs,
      id,
      to_first: recipient,
      is_otp: otpCode !== null,
      otp_code: otpCode,
    },
    ...params,
  };

  const objectKey = `${OUTBOX_PREFIX}${tsMs}-${id}.json`;

  // Best-effort R2 put. Failure is non-fatal — the smoke verifier can still
  // correlate via the console marker below.
  try {
    await env.BUCKET.put(objectKey, JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {
    console.error("[MOCK_EMAIL] R2 put failed:", (e as Error).message);
  }

  // OTP tee — one row per recipient, last-write-wins.
  if (otpCode && recipient) {
    const otpRecord = {
      email: recipient,
      code: otpCode,
      issued_at_ms: tsMs,
      outbox_id: id,
    };
    const otpKey = `${OTP_PREFIX}${recipient.toLowerCase()}.json`;
    try {
      await env.BUCKET.put(otpKey, JSON.stringify(otpRecord), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (e) {
      console.error(
        "[MOCK_EMAIL] OTP tee R2 put failed:",
        (e as Error).message,
      );
    }
  }

  // Correlation marker — scrapeable from wrangler dev stderr.
  console.log(
    "[MOCK_EMAIL]",
    JSON.stringify({
      id,
      ts_ms: tsMs,
      to: recipient,
      subject: params.subject,
      is_otp: otpCode !== null,
      otp: otpCode,
    }),
  );

  return id;
}

/** Used by GET /__mock/outbox to enumerate recent sends. */
export async function listOutboxEntries(
  env: Env,
  opts: { limit?: number } = {},
): Promise<Array<{ key: string; size: number; uploaded: Date }>> {
  const list = await env.BUCKET.list({
    prefix: OUTBOX_PREFIX,
    limit: opts.limit ?? 100,
  });
  return list.objects.map((o) => ({
    key: o.key,
    size: o.size,
    uploaded: o.uploaded,
  }));
}

/** Used by GET /__mock/otp-latest?email=... */
export async function getLatestOtp(
  env: Env,
  email: string,
): Promise<{
  email: string;
  code: string;
  issued_at_ms: number;
  outbox_id: string;
} | null> {
  const key = `${OTP_PREFIX}${email.toLowerCase()}.json`;
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const text = await obj.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Used by POST /__mock/reset to clear all outbox + OTP state. */
export async function clearOutbox(env: Env): Promise<{ deleted: number }> {
  let deleted = 0;
  for (const prefix of [OUTBOX_PREFIX, OTP_PREFIX]) {
    let cursor: string | undefined;
    do {
      const list = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
      if (list.objects.length === 0) break;
      await Promise.all(list.objects.map((o) => env.BUCKET.delete(o.key)));
      deleted += list.objects.length;
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
  return { deleted };
}
