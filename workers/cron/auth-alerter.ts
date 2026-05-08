// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G / G-3 — Cron Worker: tier-1 auth alert detection.
//
// Triggered every 2 minutes by the cron schedule in wrangler.jsonc.
// Polls D1 for three burst-detection conditions and emails the admin
// when a threshold is crossed.
//
// Channel: a single email to `env.ADMIN_ALERT_EMAIL` via Resend (the same
// transactional-mail provider the app already uses for OTP sends and
// invitations). Slack/Teams/etc. are intentionally NOT supported — admin
// preference 2026-05-07: keep the alert channel limited to a reliable
// off-domain mailbox (e.g. pavel@digifirst.org) so a mail.actionnow.ai
// outage doesn't suppress alerts about itself.
//
// Dedup: a small in-memory map (keyed by alert fingerprint) suppresses
// re-alerting within a 5-minute window. Because Workers are stateless the
// map resets on each cold start, but for a 2-min cron the same isolate is
// typically reused, keeping the window effective. A durable dedup would
// require a separate KV/DO — rejected as over-engineered for tier-1
// alerting (false-positive duplicates every cold start are acceptable; a
// missed alert is not).
//
// Tier-1 conditions:
//   1. OTP burst        — ≥10 auth.otp_failed for the same IP in 5 min.
//   2. FreshAge denials — ≥5  auth.fresh_session_denied for the same user in 5 min.
//   3. Signup brute     — ≥20 auth.signup_gate_blocked for the same IP in 1 hr.
//
// Required env (production):
//   RESEND_API_KEY     — secret, set via `wrangler secret put RESEND_API_KEY`
//   ADMIN_ALERT_EMAIL  — non-secret, set in wrangler.jsonc `vars` (recipient)
//   ADMIN_ALERT_FROM   — non-secret, set in wrangler.jsonc `vars` (sender;
//                        must be on a Resend-verified domain — the established
//                        default is `noreply@actionnow.ai`)
// Any of the three absent → alerter skips silently (safe for dev / staging
// without alert wiring).

import type { Env } from "../types";
import { sendViaResend } from "../lib/resend-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ADMIN_ALERT_EMAIL and ADMIN_ALERT_FROM are inherited from Env (which
// inherits from Cloudflare.Env, where wrangler-typegen types them as the
// literal `vars` strings from wrangler.jsonc). AlerterEnv stays as a
// nominal alias so the cron handler signature reads as intent-tagged.
export type AlerterEnv = Env;

interface AlertCondition {
  /** Human-readable name for the email subject + body. */
  label: string;
  /** SQL to run. Returns rows with { key: string; count: number }. */
  sql: string;
  /** Values to bind to the SQL statement (positional). */
  bindings: unknown[];
  /** Minimum count that triggers an alert. */
  threshold: number;
}

/**
 * Channel-agnostic sink for delivered alerts. Throws on send failure so
 * `runAlertChecks` can skip the dedup-mark and retry on the next tick.
 */
export type AlertSink = (subject: string, body: string) => Promise<void>;

// ---------------------------------------------------------------------------
// In-memory dedup window (see module comment).
// ---------------------------------------------------------------------------

/** fingerprint → timestamp when we last sent the alert (epoch ms). */
const lastAlerted = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isDup(fingerprint: string, now: number): boolean {
  const prev = lastAlerted.get(fingerprint);
  return prev !== undefined && now - prev < DEDUP_WINDOW_MS;
}

function markAlerted(fingerprint: string, now: number): void {
  lastAlerted.set(fingerprint, now);
}

// ---------------------------------------------------------------------------
// Resend-backed AlertSink factory
// ---------------------------------------------------------------------------

/**
 * Build a sink that emails `env.ADMIN_ALERT_EMAIL` via Resend. Returns
 * `undefined` when any required field is absent — the alerter then skips
 * silently. Fail-loud at the binding boundary is intentional: a misconfigured
 * production deploy that thinks it has alerting wired up is worse than a
 * dev environment that quietly skips.
 */
export function makeResendSink(env: AlerterEnv): AlertSink | undefined {
  const recipient = env.ADMIN_ALERT_EMAIL?.trim();
  const sender = env.ADMIN_ALERT_FROM?.trim();
  const apiKey = env.RESEND_API_KEY;
  if (!recipient || !sender || !apiKey) return undefined;

  return async (subject: string, body: string): Promise<void> => {
    await sendViaResend(apiKey, {
      from: { email: sender, name: "ActionNowAI Auth Alerts" },
      to: recipient,
      subject,
      text: body,
    });
  };
}

// ---------------------------------------------------------------------------
// Core polling logic (exported for testability).
// ---------------------------------------------------------------------------

export async function runAlertChecks(
  db: D1Database,
  sink: AlertSink | undefined,
  now: number = Date.now(),
): Promise<void> {
  if (!sink) {
    // No sink configured — skip silently (e.g., dev without alert wiring).
    return;
  }

  const fiveMinAgo = now - 5 * 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;

  const conditions: AlertCondition[] = [
    {
      label: "OTP burst (auth.otp_failed ≥10 / IP / 5 min)",
      sql: `SELECT ip AS key, COUNT(*) AS count
              FROM audit_log
             WHERE action = 'auth.otp_failed'
               AND ip IS NOT NULL
               AND at >= ?1
             GROUP BY ip
            HAVING COUNT(*) >= ?2`,
      bindings: [fiveMinAgo, 10],
      threshold: 10,
    },
    {
      label:
        "Fresh-session denial burst (auth.fresh_session_denied ≥5 / user / 5 min)",
      sql: `SELECT actor_user_id AS key, COUNT(*) AS count
              FROM audit_log
             WHERE action = 'auth.fresh_session_denied'
               AND actor_user_id IS NOT NULL
               AND at >= ?1
             GROUP BY actor_user_id
            HAVING COUNT(*) >= ?2`,
      bindings: [fiveMinAgo, 5],
      threshold: 5,
    },
    {
      label:
        "Signup-gate brute force (auth.signup_gate_blocked ≥20 / IP / 1 hr)",
      sql: `SELECT ip AS key, COUNT(*) AS count
              FROM audit_log
             WHERE action = 'auth.signup_gate_blocked'
               AND ip IS NOT NULL
               AND at >= ?1
             GROUP BY ip
            HAVING COUNT(*) >= ?2`,
      bindings: [oneHourAgo, 20],
      threshold: 20,
    },
  ];

  for (const condition of conditions) {
    let rows: { key: string; count: number }[];
    try {
      const stmt = db.prepare(condition.sql);
      const bound = stmt.bind(...condition.bindings);
      const result = await bound.all<{ key: string; count: number }>();
      rows = result.results ?? [];
    } catch (e) {
      console.error(
        "auth_alerter.query_failed",
        condition.label,
        (e as Error).message,
      );
      continue;
    }

    for (const row of rows) {
      const fingerprint = `${condition.label}::${row.key}`;
      if (isDup(fingerprint, now)) continue;

      const subject = `[ActionNowAI / Phase G] ${condition.label}`;
      const body =
        `${condition.label}\n\n` +
        `Key:    ${row.key}\n` +
        `Count:  ${row.count}\n` +
        `Window: rolling, ending ${new Date(now).toISOString()}\n\n` +
        `This alert was generated by the cron auth-alerter at\n` +
        `workers/cron/auth-alerter.ts. The alerter polls every 2 minutes;\n` +
        `the same fingerprint is suppressed for 5 minutes after delivery.\n`;

      try {
        await sink(subject, body);
        markAlerted(fingerprint, now);
      } catch (e) {
        // Sink throw → keep fingerprint un-marked so the next tick retries.
        console.error("auth_alerter.send_failed", (e as Error).message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cron handler — exported as named export so wrangler can wire it.
// ---------------------------------------------------------------------------

export const scheduled: ExportedHandlerScheduledHandler<AlerterEnv> = async (
  _event,
  env,
  _ctx,
) => {
  const sink = makeResendSink(env);
  await runAlertChecks(env.DB, sink);
};

// Default export expected by wrangler when this is the cron worker's main.
export default {
  scheduled,
} satisfies ExportedHandler<AlerterEnv>;
