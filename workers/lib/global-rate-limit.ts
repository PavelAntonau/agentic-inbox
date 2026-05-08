// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase v1.1 G-5 / aggregate-umbrella — global rate-limit + daily quota.
//
// Adds two backstop layers ON TOP OF the per-IP / per-email defenses:
//
//   1. enforceGlobalOtpEdgeLimit(env)
//      Workers Rate Limit binding `env.RL_LOGIN_GLOBAL` called with a
//      CONSTANT key, so every OTP-send request increments the same
//      counter. Catches mass spray that bypasses per-email and per-IP
//      caps (e.g. 10k different (email, IP) tuples each just under
//      their own caps but together swamping Resend / D1 / our budget).
//      Per-colo (Cloudflare data center), not truly global; for
//      realistic distributed-attacker scenarios this is sufficient
//      because Cloudflare's anycast routes traffic to nearest-colo.
//
//   2. checkAndIncrementDailyOtpQuota(env)
//      D1-backed counter on the existing `rate_limit` table, keyed
//      `global:otp-send-daily`. Caps total OTP-emails-sent-per-24-h
//      regardless of source. Truly global (D1 is a single-region DB).
//      The bill protector: an attacker burning Resend quota gets
//      cut off here even if they evade all the upstream gates.
//
// Both helpers ENFORCE (return a 429 Response on block). They are
// deliberately distinct from the observation-mode per-IP / per-email
// helpers (`observeRateLimit`, `authRateLimitByEmail`) — the per-key
// caps stay in shadow mode until the v1.1 G-5 / TASK-2.5 enforce-flip
// after the 48-h soak; the aggregate caps are hard backstops live
// from day one.
//
// Both helpers fail OPEN on infrastructure errors (missing binding,
// D1 outage). The cost of false-rejecting a legit user during a D1
// blip outweighs the benefit of catching one extra attacker request.

import type { Env } from "../types";

// ── Aggregate edge counter (Workers RL binding, constant key) ──────────

/** Constant key — every OTP-send request increments the same counter. */
const GLOBAL_LIMIT_KEY = "global:otp-send";

/**
 * Enforce the aggregate edge rate-limit on OTP-send.
 *
 * Returns null on allow, or a 429 Response on block. Caller short-circuits:
 *
 *     const blocked = await enforceGlobalOtpEdgeLimit(c.env);
 *     if (blocked) return blocked;
 *
 * Best-effort: missing binding (tests / pre-binding deploy) → null.
 * Throwing binding (transient infra) → null. The gate path stays
 * available even when edge RL is degraded.
 */
export async function enforceGlobalOtpEdgeLimit(
  env: Env,
): Promise<Response | null> {
  const rl = env.RL_LOGIN_GLOBAL;
  if (!rl) return null;
  try {
    const result = await rl.limit({ key: GLOBAL_LIMIT_KEY });
    if (!result.success) {
      return new Response(
        JSON.stringify({
          code: "GLOBAL_RATE_LIMITED",
          message: "Service is rate-limited. Please try again shortly.",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "10",
          },
        },
      );
    }
  } catch {
    // best-effort — never propagate
  }
  return null;
}

// ── Daily quota (D1, sliding 24-h window) ──────────────────────────────

/** Stable D1 row key used in the existing `rate_limit` table. */
const DAILY_QUOTA_KEY = "global:otp-send-daily";

/**
 * Maximum OTP emails sent per rolling 24-h window. Above this, the
 * worker rejects new sends with 429 until the window slides forward.
 *
 * 5,000 chosen as a 100 × headroom over realistic legitimate traffic
 * (single-tenant pre-launch). Tune via wrangler.jsonc or a follow-up
 * config entry once real traffic data is available; for now the value
 * is a constant in this module.
 */
export const DAILY_OTP_QUOTA = 5000;

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Atomically increment + check the daily OTP-send quota.
 *
 * Returns null on allow, or a 429 Response on block (with `Retry-After`
 * set to seconds-until-window-resets).
 *
 * Reuses the existing `rate_limit` D1 table — same shape as the
 * per-email middleware, just a different key namespace. On conflict the
 * existing window's counter is incremented; on first call after the
 * 24-h window expires, the counter resets to 1.
 *
 * Fails OPEN on D1 errors. Logged via console.warn for observability.
 */
export async function checkAndIncrementDailyOtpQuota(
  env: Env,
): Promise<Response | null> {
  const db = env.DB;
  if (!db) return null;
  const now = Date.now();
  const windowStart = now - DAILY_WINDOW_MS;
  try {
    const existing = await db
      .prepare("SELECT count, last_request FROM rate_limit WHERE key = ?1")
      .bind(DAILY_QUOTA_KEY)
      .first<{ count: number; last_request: number }>();

    let count: number;
    let windowAnchor: number;
    if (!existing || existing.last_request < windowStart) {
      // No row OR window expired — reset.
      count = 1;
      windowAnchor = now;
      await db
        .prepare(
          "INSERT INTO rate_limit (id, key, count, last_request) VALUES (?1, ?2, 1, ?3) " +
            "ON CONFLICT(key) DO UPDATE SET count = 1, last_request = ?3",
        )
        .bind(crypto.randomUUID(), DAILY_QUOTA_KEY, now)
        .run();
    } else {
      count = existing.count + 1;
      windowAnchor = existing.last_request;
      await db
        .prepare(
          "UPDATE rate_limit SET count = ?1, last_request = ?2 WHERE key = ?3",
        )
        .bind(count, now, DAILY_QUOTA_KEY)
        .run();
    }

    if (count > DAILY_OTP_QUOTA) {
      const resetIn = Math.max(
        1,
        Math.ceil((windowAnchor + DAILY_WINDOW_MS - now) / 1000),
      );
      return new Response(
        JSON.stringify({
          code: "DAILY_QUOTA_EXCEEDED",
          message:
            "Daily sign-in email quota reached. Please try again tomorrow.",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(resetIn),
          },
        },
      );
    }
  } catch (err) {
    // Fail open on D1 error.
    console.warn(
      "daily-otp-quota: D1 read/write failed; falling open",
      (err as Error).message,
    );
  }
  return null;
}
