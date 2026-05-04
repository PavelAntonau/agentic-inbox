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
  // BETTER_AUTH_URL is declared in wrangler.jsonc and inherited via Cloudflare.Env.
  /**
   * Autonomous-local-testing umbrella switch. Set to `"1"` in `.dev.vars`
   * (gitignored) to enable: mock CF Access shim, canned AI replies, R2-backed
   * outbox, fixture data for CF management API, /__mock/* router. Production
   * deploys must NEVER set this. See workers/lib/mock-mode.ts.
   */
  MOCK_MODE?: string;
}
