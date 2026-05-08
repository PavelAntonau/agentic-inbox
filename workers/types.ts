// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Most env vars (DOMAINS, EMAIL_ADDRESSES, BOOTSTRAP_OWNER_EMAIL,
// BOOTSTRAP_DEV_EMAIL, CF_ACCESS_DEV_MODE, MOCK_MODE, ADMIN_ALERT_*,
// TURNSTILE_*, BETTER_AUTH_SECRET, OAUTH_JWT_SIGNING_KEY, TOKEN_PEPPER,
// RESEND_API_KEY, all bindings) are generated into Cloudflare.Env by
// `wrangler types` from wrangler.jsonc + .dev.vars and inherited
// verbatim — do NOT redeclare them here, widening the wrangler-generated
// type (e.g. literal "pavel@digifirst.org" → string | undefined) violates
// the parent interface contract.
//
// This interface only adds env vars that wrangler-typegen cannot infer:
// CF Access policy mutators (set via `wrangler secret put`) and the
// bootstrap-owner second-factor token (likewise).
export interface Env extends Cloudflare.Env {
  POLICY_AUD: string;
  TEAM_DOMAIN: string;
  /** Cloudflare account ID — required for real Access policy mutations. */
  CF_ACCOUNT_ID?: string;
  /** Cloudflare Access policy ID for the workspace include-list. */
  CF_POLICY_ID?: string;
  /** Cloudflare API token with Access: Apps and Policies Write scope. */
  CF_ACCESS_API_TOKEN?: string;
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
   * Phase G / G-3 — Analytics Engine dataset for auth-event observability.
   * Binding declared in wrangler.jsonc under `analytics_engine_datasets`.
   * Pass to `writeAudit({ analyticsEngine: env.AUTH_ANALYTICS, ctx })` on
   * auth paths to mirror the D1 row to Analytics Engine (best-effort).
   * Absent in local dev unless explicitly bound via wrangler --local.
   */
  AUTH_ANALYTICS?: AnalyticsEngineDataset;
}
