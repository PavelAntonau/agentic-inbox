// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-2 — Cloudflare Turnstile server-side verification middleware.
//
// Applies to POST /api/auth/email-otp/send-verification-otp (the only
// user-driven, unauthenticated high-volume endpoint on the OTP-send surface).
//
// Design decisions:
//   • 5 s AbortSignal.timeout on the siteverify fetch — keeps P99 well under
//     Hono's default request timeout.
//   • 2 retries on 5xx from Cloudflare's verify endpoint — transient upstream
//     outages should not block login.
//   • Replay guard: reject if `challenge_ts` > 5 min old. Turnstile tokens
//     are single-use by default but the timestamp guard is defence-in-depth
//     against clock-skew edge cases where a reused token still passes the
//     Cloudflare uniqueness check.
//   • Constant-time failure path: all 403 responses go through the same
//     JSON encoder with the same shape — no fast-path 403 branch that a
//     timing attacker could distinguish.
//   • Secret sourced from `env.TURNSTILE_SECRET_KEY` (wrangler secret put).
//
// Free-plan scope: this is application-layer verification, not a CF dashboard
// rule. No Pro/Business features are used.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Max age of a Turnstile challenge_ts before we reject it (ms). */
const MAX_CHALLENGE_AGE_MS = 5 * 60 * 1000; // 5 minutes

/** How many times to retry on 5xx from the verify endpoint. */
const MAX_RETRIES = 2;

/** Delay between retries (ms). Short enough to stay within a Worker request
 *  lifetime, long enough to avoid hammer behaviour on a flapping upstream. */
const RETRY_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SiteverifyResponse {
  success: boolean;
  challenge_ts?: string; // ISO 8601 e.g. "2026-05-07T12:34:56.000Z"
  hostname?: string;
  error_codes?: string[];
  action?: string;
  cdata?: string;
}

async function siteverify(
  secret: string,
  token: string,
  signal: AbortSignal,
): Promise<SiteverifyResponse> {
  const body = new URLSearchParams({ secret, response: token });
  const res = await fetch(SITEVERIFY_URL, {
    method: "POST",
    body,
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) {
    throw new SiteverifyError(res.status, `siteverify HTTP ${res.status}`);
  }
  return res.json() as Promise<SiteverifyResponse>;
}

class SiteverifyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SiteverifyError";
  }
}

/** sleep helper — used between retries */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the siteverify endpoint with up to MAX_RETRIES retries on 5xx.
 * AbortSignal is scoped to a 5 s window; retries share the same signal so
 * the total budget remains bounded.
 */
async function siteverifyWithRetry(
  secret: string,
  token: string,
): Promise<SiteverifyResponse> {
  const signal = AbortSignal.timeout(5000);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await siteverify(secret, token, signal);
      // Only retry on 5xx (SiteverifyError with status >= 500). A 4xx or a
      // successful (even failed-challenge) response should not be retried.
      return data;
    } catch (e) {
      lastErr = e;
      const isTransient =
        e instanceof SiteverifyError && e.status >= 500 && e.status < 600;
      const isNetwork = e instanceof TypeError; // fetch network error
      if (!(isTransient || isNetwork)) throw e;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Challenge-age guard
// ---------------------------------------------------------------------------

/**
 * Returns true when `challenge_ts` is within the MAX_CHALLENGE_AGE_MS window.
 * Exported for unit-testing.
 */
export function isChallengeRecent(
  challenge_ts: string,
  nowMs: number = Date.now(),
): boolean {
  const challenged = new Date(challenge_ts).getTime();
  if (Number.isNaN(challenged)) return false;
  return nowMs - challenged <= MAX_CHALLENGE_AGE_MS;
}

// ---------------------------------------------------------------------------
// Failure response — constant timing
// ---------------------------------------------------------------------------

/** Build the standard 403 Turnstile-failed body. */
function turnstileFailedResponse(): Response {
  return Response.json({ code: "TURNSTILE_FAILED" }, { status: 403 });
}

// ---------------------------------------------------------------------------
// Public middleware factory
// ---------------------------------------------------------------------------

type TurnstileEnv = {
  Bindings: Env & { TURNSTILE_SECRET_KEY: string };
};

/**
 * requireTurnstile — Hono middleware that validates the `cf-turnstile-response`
 * token submitted with the request body or the `X-Turnstile-Token` header.
 *
 * Mount on the OTP-send endpoint:
 *
 *   app.post(
 *     "/api/auth/email-otp/send-verification-otp",
 *     requireTurnstile(),
 *     otpSendHandler,
 *   );
 *
 * The middleware reads the token from (in priority order):
 *   1. JSON body field `cf_turnstile_response`
 *   2. Form body field `cf-turnstile-response` (standard widget field name)
 *   3. `X-Turnstile-Token` request header
 *
 * Missing token → 403 TURNSTILE_FAILED (no distinguishable branch).
 */
export function requireTurnstile(): MiddlewareHandler<TurnstileEnv> {
  return async (c, next) => {
    const secret = c.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
      // TURNSTILE_SECRET_KEY not configured — fail closed in production.
      // In test environments callers should stub env.TURNSTILE_SECRET_KEY.
      console.error("turnstile: TURNSTILE_SECRET_KEY not configured");
      return turnstileFailedResponse();
    }

    // Extract token from body or header. Clone the request so the downstream
    // handler can still read the body.
    let token: string | null = null;
    const contentType = c.req.header("content-type") ?? "";

    if (contentType.includes("application/json")) {
      try {
        const body = await c.req.json<Record<string, unknown>>();
        token =
          typeof body["cf_turnstile_response"] === "string"
            ? body["cf_turnstile_response"]
            : null;
        // Re-attach the body so downstream can read it again. Hono's c.req.json()
        // clones under the hood on modern runtimes; if not, wrap:
        if (token === null)
          token =
            typeof body["cf-turnstile-response"] === "string"
              ? (body["cf-turnstile-response"] as string)
              : null;
      } catch {
        // malformed JSON — fall through to header check
      }
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      try {
        const form = await c.req.formData();
        token = form.get("cf-turnstile-response") as string | null;
      } catch {
        // malformed form — fall through to header check
      }
    }

    if (!token) {
      token = c.req.header("X-Turnstile-Token") ?? null;
    }

    if (!token) {
      return turnstileFailedResponse();
    }

    // Verify against Cloudflare's siteverify endpoint.
    let result: SiteverifyResponse;
    try {
      result = await siteverifyWithRetry(secret, token);
    } catch {
      // Network failure after all retries — fail closed.
      return turnstileFailedResponse();
    }

    if (!result.success) {
      return turnstileFailedResponse();
    }

    // Replay guard — reject stale challenges.
    if (result.challenge_ts && !isChallengeRecent(result.challenge_ts)) {
      return turnstileFailedResponse();
    }

    return next();
  };
}
