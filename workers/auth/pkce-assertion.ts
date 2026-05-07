// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-1 / Task 9 — fail-closed PKCE assertion.
//
// Workers don't have a true startup hook; the closest equivalent is "first
// request handled in this isolate".  This module exposes a once-per-isolate
// guard that scans the `oauth_client` table for any row with
// `require_pkce = 0` (or NULL — same risk).  If any are found the guard
// throws, which surfaces as a 500 from the calling handler — fail-closed
// over silently allowing PKCE-less clients to authorize.
//
// Mounted from workers/app.ts in front of the better-auth catch-all so
// every /api/auth/* request that lands in this isolate has run the check.
//
// The result is cached at module scope: once a check passes, subsequent
// requests skip the D1 round-trip.  If the check fails, it remains failed
// (re-thrown on every call) until the isolate is torn down — operators
// must fix the row, then redeploy / kick the isolate.
//
// Mirrored: a parallel `clearPkceAssertionCache()` export resets the
// module-scope flag for unit tests, so individual cases can prove
// pass/fail behaviour without reaching for vi.resetModules.

import type { Env } from "../types";

type AssertionState = "unchecked" | "passed" | "failed";

let state: AssertionState = "unchecked";
let lastError: Error | null = null;

/**
 * Run the PKCE-required assertion once per isolate.  Throws when any
 * `oauth_client` row has `require_pkce` falsy (0 or NULL).
 */
export async function assertOauthClientsRequirePkce(env: Env): Promise<void> {
  if (state === "passed") return;
  if (state === "failed" && lastError) throw lastError;

  const result = await env.DB.prepare(
    "SELECT client_id FROM oauth_client WHERE require_pkce IS NOT 1",
  ).all<{ client_id: string }>();

  const offenders = result.results ?? [];
  if (offenders.length > 0) {
    const ids = offenders.map((r) => r.client_id).join(", ");
    const err = new Error(
      `PKCE assertion failed: oauth_client rows with require_pkce!=1: ${ids}. ` +
        "Fail-closed startup check — fix the rows or revoke the clients before retrying.",
    );
    state = "failed";
    lastError = err;
    throw err;
  }

  state = "passed";
}

/** Test-only — reset the module-scope cache. */
export function clearPkceAssertionCache(): void {
  state = "unchecked";
  lastError = null;
}
