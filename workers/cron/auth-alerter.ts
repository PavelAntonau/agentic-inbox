// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G / G-3 — Cron Worker: tier-1 auth alert detection.
//
// Triggered every 2 minutes by the cron schedule in wrangler.jsonc.
// Polls D1 for three burst-detection conditions and POSTs a Slack
// notification when a threshold is crossed.
//
// Dedup: a small in-memory map (keyed by alert fingerprint) suppresses
// re-alerting within a 5-minute window.  Because Workers are stateless the
// map resets on each cold start, but for a 2-min cron the same isolate is
// typically reused, keeping the window effective.  A durable dedup would
// require a separate KV/DO — rejected as over-engineered for tier-1 alerting
// (false-positive duplicates every cold start are acceptable; a missed alert
// is not).
//
// Tier-1 conditions:
//   1. OTP burst        — ≥10 auth.otp_failed for the same IP in 5 min.
//   2. FreshAge denials — ≥5  auth.fresh_session_denied for the same user in 5 min.
//   3. Signup brute     — ≥20 auth.signup_gate_blocked for the same IP in 1 hr.
//
// Slack webhook URL must be provisioned by the operator:
//   wrangler secret put SLACK_ALERT_WEBHOOK_URL
// The secret value is stored in Key MCP at:
//   service="slack"  account="phase-g-alerts"
// Retrieve with: mcp__key__tool_get_secret(service="slack", account="phase-g-alerts")

import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlerterEnv extends Env {
  /** Set via `wrangler secret put SLACK_ALERT_WEBHOOK_URL`. */
  SLACK_ALERT_WEBHOOK_URL?: string;
}

interface AlertCondition {
  /** Human-readable name for Slack message. */
  label: string;
  /** SQL to run. Returns rows with { key: string; count: number }. */
  sql: string;
  /** Values to bind to the SQL statement (positional). */
  bindings: unknown[];
  /** Minimum count that triggers an alert. */
  threshold: number;
}

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
// Slack posting
// ---------------------------------------------------------------------------

export async function postSlack(
  webhookUrl: string,
  text: string,
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    console.error("auth_alerter.slack_failed", res.status, await res.text());
  }
}

// ---------------------------------------------------------------------------
// Core polling logic (exported for testability)
// ---------------------------------------------------------------------------

export async function runAlertChecks(
  db: D1Database,
  webhookUrl: string | undefined,
  now: number = Date.now(),
): Promise<void> {
  if (!webhookUrl) {
    // No webhook configured — skip silently (e.g., dev environments).
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

      const text =
        `*[Phase G / Auth Alert]* ${condition.label}\n` +
        `Key: \`${row.key}\`  Count: *${row.count}*  ` +
        `(window ending ${new Date(now).toISOString()})`;

      try {
        await postSlack(webhookUrl, text);
        markAlerted(fingerprint, now);
      } catch (e) {
        console.error("auth_alerter.post_failed", (e as Error).message);
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
  await runAlertChecks(env.DB, env.SLACK_ALERT_WEBHOOK_URL);
};

// Default export expected by wrangler when this is the cron worker's main.
export default {
  scheduled,
} satisfies ExportedHandler<AlerterEnv>;
