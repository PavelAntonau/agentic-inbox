// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Production-only secrets that `wrangler types` cannot generate (they're set
// via `wrangler secret put`, not in wrangler.jsonc or .dev.vars). Everything
// else — DOMAINS, EMAIL_ADDRESSES, BOOTSTRAP_OWNER_EMAIL, BOOTSTRAP_DEV_EMAIL,
// CF_ACCESS_DEV_MODE, all bindings — is generated into Cloudflare.Env by
// `wrangler types` from wrangler.jsonc + .dev.vars and is inherited.
//
// CF_ACCESS_DEV_MODE: present in .dev.vars (gitignored), absent in prod. Type
// is widened to `string` by wrangler-typegen — runtime checks compare to
// "mock" / "bypass" literals.
export interface Env extends Cloudflare.Env {
  POLICY_AUD: string;
  TEAM_DOMAIN: string;
  /** Cloudflare account ID — required for real Access policy mutations. */
  CF_ACCOUNT_ID?: string;
  /** Cloudflare Access policy ID for the workspace include-list. */
  CF_POLICY_ID?: string;
  /** Cloudflare API token with Access: Apps and Policies Write scope. */
  CF_ACCESS_API_TOKEN?: string;
  /** HMAC pepper for agent token secret hashing. Set via wrangler secret put. */
  TOKEN_PEPPER?: string;
  /** better-auth signing secret — set via `wrangler secret put BETTER_AUTH_SECRET`. */
  BETTER_AUTH_SECRET: string;
  /**
   * Static OAuth JWT signing key for the better-auth `jwt()` plugin. Stringified
   * JSON of `{ kid, alg, crv, publicJwk, privateJwk }` (Ed25519). Set via
   * `wrangler secret put OAUTH_JWT_SIGNING_KEY`; mirrored in macOS Keychain at
   * `cloudflare/OAUTH_JWT_SIGNING_KEY` (Key MCP). Provisioned in T1.4 of the
   * mcp-oauth plan.
   */
  OAUTH_JWT_SIGNING_KEY: string;
  /**
   * Resend API key (transactional outbound mail). Set via
   * `wrangler secret put RESEND_API_KEY`. Required in production —
   * `getResendBinding` throws on first send if absent. Not needed in
   * MOCK_MODE (outbound is captured to the R2 outbox).
   */
  RESEND_API_KEY?: string;
  // BETTER_AUTH_URL is declared in wrangler.jsonc and inherited via Cloudflare.Env.
  /**
   * Phase E / TASK-E.2 (OQ-P0-7) — defense-in-depth second factor on the
   * bootstrap-owner signup path. When set, the better-auth signup hook
   * requires both `email == BOOTSTRAP_OWNER_EMAIL` AND a matching
   * `x-bootstrap-token` header. When unset, the bootstrap path falls back
   * to email-match only (Phase C1 / A-01 baseline).
   *
   * Set via `wrangler secret put BOOTSTRAP_OWNER_TOKEN`. Once the
   * BOOTSTRAP_OWNER user has been created, the bootstrap path is single-use:
   * additional global-owner signups are refused even with a matching token.
   */
  BOOTSTRAP_OWNER_TOKEN?: string;
  /**
   * Autonomous-local-testing umbrella switch. Set to `"1"` in `.dev.vars`
   * (gitignored) to enable: mock CF Access shim, canned AI replies, R2-backed
   * outbox, fixture data for CF management API, /__mock/* router. Production
   * deploys must NEVER set this. See workers/lib/mock-mode.ts.
   */
  MOCK_MODE?: string;
  /**
   * Phase G / G-3 — Analytics Engine dataset for auth-event observability.
   * Binding declared in wrangler.jsonc under `analytics_engine_datasets`.
   * Pass to `writeAudit({ analyticsEngine: env.AUTH_ANALYTICS, ctx })` on
   * auth paths to mirror the D1 row to Analytics Engine (best-effort).
   * Absent in local dev unless explicitly bound via wrangler --local.
   */
  AUTH_ANALYTICS?: AnalyticsEngineDataset;
  /**
   * Phase G / G-3 — Slack webhook URL for the tier-1 auth alerter cron.
   * Set via `wrangler secret put SLACK_ALERT_WEBHOOK_URL`.
   * Secret value provisioned from Key MCP:
   *   service="slack"  account="phase-g-alerts"
   * Absent → alerter skips silently (safe for dev/staging).
   */
  SLACK_ALERT_WEBHOOK_URL?: string;
  /**
   * Phase G / G-2 — Cloudflare Turnstile server-side secret key.
   * Used by workers/middleware/turnstile.ts to verify tokens submitted by
   * the login form before sending an OTP.
   * Set via `wrangler secret put TURNSTILE_SECRET_KEY`.
   * Obtain the value from the Cloudflare dashboard → Turnstile → your widget
   * → Secret Key (see docs/phase-g-dashboard-config.md §4).
   * Absent → Turnstile middleware fails closed (returns 403 TURNSTILE_FAILED).
   */
  TURNSTILE_SECRET_KEY?: string;
}
