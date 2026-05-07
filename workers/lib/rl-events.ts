// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase v1.1 G-5 / TASK-1.4 — Analytics Engine emit helper for the
// `rate_limit_events` dataset. One module, one schema, one comment block —
// the agent's solution to "AE has no enforced schema" (D-G5-EMIT-PROVENANCE
// `uoMZ8W6h0qozp_Q2251jT`).
//
// Schema (FIXED — DO NOT REORDER OR REPURPOSE FIELDS):
//   blobs   = [route, actor, outcome]
//   doubles = [count, latency_ms]
//   indexes = [ip_or_session_id]
//
// Where:
//   * route               — stable string ID of the gate, e.g.
//                           "auth-rate-limit-by-email", "/api/auth/email-otp/send",
//                           "/api/auth/sign-in/email-otp", "/api/messages".
//   * actor               — pre-auth: lower-cased email or "unknown";
//                           post-auth: user_id.
//   * outcome             — "ALLOW" | "RATE_LIMITED_EMAIL" | "OTP_SEND_OK" |
//                           "OTP_SEND_FAIL" | "OTP_VERIFY_OK" | "OTP_VERIFY_FAIL" |
//                           "MESSAGE_OK" | "MESSAGE_FAIL" | "WOULD_LIMIT" (Phase 2
//                           shadow mode).
//   * count               — request weight, normally 1; reserved for future
//                           batched-emit folding.
//   * latency_ms          — wall-clock from gate-entry to gate-exit, where the
//                           caller can measure it; pass 0 if not measured.
//   * ip_or_session_id    — pre-auth: CF-Connecting-IP; post-auth: user_id /
//                           session id. Drives AE shard selection.
//
// Best-effort: AE writes are non-blocking and never propagate. The binding
// may be undefined in tests or local-dev — guard with `if (env.AE)` and
// silently skip. ctx.waitUntil() is INTENTIONALLY NOT used here per the
// plan ("ctx.waitUntil ONLY for audit-critical events"); rate-limit
// observability is loose, not audit-critical.

import type { Env } from "../types";

export type RateLimitOutcome =
  | "ALLOW"
  | "RATE_LIMITED_EMAIL"
  | "OTP_SEND_OK"
  | "OTP_SEND_FAIL"
  | "OTP_VERIFY_OK"
  | "OTP_VERIFY_FAIL"
  | "MESSAGE_OK"
  | "MESSAGE_FAIL"
  | "WOULD_LIMIT";

export interface RateLimitEvent {
  /** Stable string ID of the gate; see module-header schema. */
  route: string;
  /** Pre-auth: lower-cased email or "unknown". Post-auth: user_id. */
  actor: string;
  /** Outcome label per RateLimitOutcome union. */
  outcome: RateLimitOutcome;
  /**
   * AE shard key. Pre-auth: CF-Connecting-IP. Post-auth: user_id / session id.
   * Empty string is acceptable (AE buckets all under one shard).
   */
  ipOrSessionId: string;
  /** Request weight; default 1. */
  count?: number;
  /** Gate-entry → gate-exit wall-clock; default 0. */
  latencyMs?: number;
}

/**
 * Emit one rate-limit observability event to the AE binding `env.AE`.
 *
 * Synchronous best-effort. Never throws. Never propagates. No-ops when the
 * binding is absent (tests / local-dev / pre-dashboard-click prod).
 */
export function emitRateLimitEvent(env: Env, event: RateLimitEvent): void {
  const ae = env.AE;
  if (!ae) return;
  try {
    // Schema: blobs=[route,actor,outcome] / doubles=[count,latency_ms] / indexes=[ip_or_session_id]
    ae.writeDataPoint({
      blobs: [event.route, event.actor, event.outcome],
      doubles: [event.count ?? 1, event.latencyMs ?? 0],
      indexes: [event.ipOrSessionId],
    });
  } catch {
    // Intentionally swallowed — AE write must not propagate to the gate path.
  }
}

/**
 * Phase v1.1 G-5 / TASK-2.1 — Workers Rate Limit binding observation mode.
 *
 * Calls `rl.limit({ key })` as the first edge-defense layer, but does NOT
 * reject on `!success`. Instead, emits a `WOULD_LIMIT` event to AE so we
 * can shape thresholds during the 48-h shadow soak (TASK-2.2). The flip
 * to enforce mode happens in TASK-2.5 — at that point, callers replace
 * this helper with a direct `result.success ? next() : 429` branch.
 *
 * Best-effort: never throws, never propagates. Missing binding (tests /
 * local-dev) → silent no-op. Throwing binding (transient infra issue) →
 * silent swallow. The gate path must remain available even when edge RL
 * is degraded.
 *
 * Composite key convention (set by the caller):
 *   pre-auth  → `${ip}:${route}`
 *   post-auth → `${user_id}:${route}`
 */
export async function observeRateLimit(
  rl: RateLimit | undefined,
  key: string,
  env: Env,
  emitBase: Omit<RateLimitEvent, "outcome">,
): Promise<void> {
  if (!rl) return;
  try {
    const result = await rl.limit({ key });
    if (!result.success) {
      emitRateLimitEvent(env, { ...emitBase, outcome: "WOULD_LIMIT" });
    }
  } catch {
    // Intentionally swallowed — RL probe must not propagate to the gate path.
  }
}
