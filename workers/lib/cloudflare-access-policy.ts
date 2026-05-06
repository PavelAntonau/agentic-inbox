// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import type { Env } from "../types";
import { writeAudit } from "./audit-log";

/**
 * Phase C3 / TASK-C3.12 — bypass-mode audit signal (audit P2-6).
 *
 * `CF_ACCESS_DEV_MODE=bypass` is the explicit "skip CF Access JWT verify"
 * switch we use during local development and for the autonomous-local-testing
 * harness. It is structurally distinct from `mock` (which synthesises a JWT
 * shape via `mockAccessShim`); `bypass` simply lets every request through
 * with no auth. That's safe for `localhost` and acceptable for the test
 * harness, but a regression that turns it on in production would silently
 * disable the entire Access gate. Two layers of defence:
 *
 *   1. `assertBypassPermitted(c.req.url)` — refuses to bypass when the
 *      request hostname is `mail.actionnow.ai` (production), forcing the
 *      caller to fall through to real Access JWT verification regardless of
 *      what the env var says. The Worker still serves the request; CF
 *      Access just gets the chance to reject it.
 *   2. `writeBypassAudit(env, request)` — emits an `auth.cf_access_bypass`
 *      audit_log row for every bypassed request so a regression that DOES
 *      hit a non-prod hostname still leaves a forensic trail.
 *
 * `logBypassWarningOnce` is a process-wide one-shot warn (per isolate) so
 * the dev console doesn't get flooded — one line on first hit per cold-start
 * is enough signal that the bypass posture is active.
 */
const PROD_HOSTNAME = "mail.actionnow.ai";

let _bypassWarned = false;

export function logBypassWarningOnce(): void {
  if (_bypassWarned) return;
  _bypassWarned = true;
  console.warn(
    "auth.cf_access_dev_mode=bypass — Cloudflare Access JWT verification is DISABLED. " +
      "This must NEVER be set in production. See workers/lib/cloudflare-access-policy.ts.",
  );
}

/**
 * Returns `true` when the bypass is permitted for `requestUrl`, `false`
 * when bypass MUST be refused (production hostname).
 */
export function isBypassPermitted(requestUrl: string): boolean {
  try {
    const u = new URL(requestUrl);
    if (u.hostname === PROD_HOSTNAME) return false;
    return true;
  } catch {
    // Malformed URL — refuse to bypass (fail-CLOSED).
    return false;
  }
}

/**
 * Fire-and-forget audit row for every bypassed request. The row is the
 * forensic anchor that lets us prove (after the fact) which requests went
 * through the bypass and which paid the full Access verification cost.
 */
export async function writeBypassAudit(
  env: Env,
  request: Request,
): Promise<void> {
  const url = new URL(request.url);
  await writeAudit(env.DB, {
    action: "auth.cf_access_bypass",
    target: { kind: "request", id: url.pathname },
    actor_user_id: null,
    actor_token_id: null,
    meta: {
      method: request.method,
      hostname: url.hostname,
      // Useful when sifting logs: were we in dev or did someone hit the env
      // var directly on a non-prod custom domain?
      dev_mode_value: env.CF_ACCESS_DEV_MODE ?? null,
    },
    ip: request.headers.get("cf-connecting-ip"),
  });
}

// -----------------------------------------------------------------------
// Mock-mode predicate (Phase C2 / A-04)
// -----------------------------------------------------------------------
//
// The mock path silently swallows policy mutations into an in-memory Set,
// returning { ok: true, mocked: true }. That is essential for unit tests and
// `npm run dev` (no CF account credentials present), but it is also a
// silent-fail-OPEN in production: if the worker is deployed without
// CF_ACCOUNT_ID, every invite-list write would be eaten by the mock with no
// audit trail and no observable side effect.
//
// The previous implementation triggered mock mode on any of:
//   1. MOCK_MODE === "1"           — explicit unit-test override.
//   2. CF_ACCESS_DEV_MODE === "mock" — explicit dev override.
//   3. !env.CF_ACCOUNT_ID            — fallback, but ALSO matches a misdeploy.
//
// Branch (3) is the bug. If the operator forgets to provision CF_ACCOUNT_ID
// in production, branch (3) silently downgrades to mock mode and admin
// invites never reach Cloudflare Access. Drop the implicit disjunct: in
// non-dev, throw 503 instead of mocking.
//
// `import.meta.env.DEV` is true under Vite (`npm run dev`) and Vitest. In
// the deployed Worker it is undefined / false — the canonical signal.
const _mockEmailSet = new Set<string>();

function isDevEnv(): boolean {
  // Vite-injected; undefined in the Cloudflare Workers runtime.
  return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
}

function evaluateMockMode(env: Env): {
  mock: boolean;
  reason?: "explicit-mock" | "dev-mode" | "no-account-id-prod";
} {
  if (env.MOCK_MODE === "1") return { mock: true, reason: "explicit-mock" };
  if (env.CF_ACCESS_DEV_MODE === "mock")
    return { mock: true, reason: "explicit-mock" };
  if (!env.CF_ACCOUNT_ID) {
    if (isDevEnv()) return { mock: true, reason: "dev-mode" };
    return { mock: false, reason: "no-account-id-prod" };
  }
  return { mock: false };
}

function unavailableResponse(): {
  ok: false;
  error: string;
} {
  return {
    ok: false,
    error:
      "Cloudflare Access policy unavailable: CF_ACCOUNT_ID is not provisioned",
  };
}

// -----------------------------------------------------------------------
// Cloudflare Access API helpers
// -----------------------------------------------------------------------

type AccessPolicy = {
  id: string;
  name: string;
  decision: string;
  include: Array<{ email?: { email: string } }>;
  [key: string]: unknown;
};

type AccessApiResult = {
  result: AccessPolicy;
  success: boolean;
  errors: Array<{ message: string }>;
  messages: Array<string>;
};

function accessApiHeaders(env: Env): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  // CF_ACCESS_API_TOKEN is the Access Apps and Policies Write token.
  // Optional: falls through to mock if unset alongside CF_ACCOUNT_ID.
  if (env.CF_ACCESS_API_TOKEN) {
    headers.set("Authorization", `Bearer ${env.CF_ACCESS_API_TOKEN}`);
  }
  return headers;
}

async function fetchPolicy(env: Env): Promise<AccessPolicy> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/policies/${env.CF_POLICY_ID}`;
  const res = await fetch(url, { headers: accessApiHeaders(env) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      errors?: Array<{ message: string; request_id?: string }>;
    };
    const msg = body.errors?.[0]?.message ?? `HTTP ${res.status}`;
    const reqId = body.errors?.[0]?.request_id;
    throw Object.assign(new Error(`CF Access GET failed: ${msg}`), {
      request_id: reqId,
    });
  }
  const data = (await res.json()) as AccessApiResult;
  return data.result;
}

async function putPolicy(env: Env, policy: AccessPolicy): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/policies/${env.CF_POLICY_ID}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: accessApiHeaders(env),
    body: JSON.stringify(policy),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      errors?: Array<{ message: string; request_id?: string }>;
    };
    const msg = body.errors?.[0]?.message ?? `HTTP ${res.status}`;
    const reqId = body.errors?.[0]?.request_id;
    throw Object.assign(new Error(`CF Access PUT failed: ${msg}`), {
      request_id: reqId,
    });
  }
}

// -----------------------------------------------------------------------
// Exported functions
// -----------------------------------------------------------------------

/**
 * Add an email to the Cloudflare Access policy include-list.
 *
 * Mock mode: triggered when env.CF_ACCESS_DEV_MODE === 'mock' OR when
 * env.CF_ACCOUNT_ID is unset. In mock mode, the email is tracked in a
 * module-level Set and the call returns { ok: true, mocked: true }.
 *
 * Real mode: read-modify-write via GET then PUT (PATCH not supported for
 * include-list mutation on token-auth). Wraps errors in { ok: false, error }.
 */
export async function upsertEmail(
  env: Env,
  email: string,
): Promise<{ ok: boolean; mocked?: boolean; error?: string }> {
  const decision = evaluateMockMode(env);
  if (decision.mock) {
    _mockEmailSet.add(email.toLowerCase());
    return { ok: true, mocked: true };
  }
  if (decision.reason === "no-account-id-prod") {
    return unavailableResponse();
  }

  try {
    const policy = await fetchPolicy(env);

    // Build deduplicated email list
    const existing = new Set(
      policy.include
        .filter((r) => r.email?.email)
        .map((r) => r.email!.email.toLowerCase()),
    );
    if (!existing.has(email.toLowerCase())) {
      policy.include.push({ email: { email: email.toLowerCase() } });
      await putPolicy(env, policy);
    }
    return { ok: true };
  } catch (err: unknown) {
    const e = err as Error & { request_id?: string };
    return { ok: false, error: e.message };
  }
}

/**
 * Remove an email from the Cloudflare Access policy include-list.
 *
 * Mock mode: removes from the module-level Set.
 * Real mode: read-modify-write via GET then PUT.
 */
export async function removeEmail(
  env: Env,
  email: string,
): Promise<{ ok: boolean; mocked?: boolean; error?: string }> {
  const decision = evaluateMockMode(env);
  if (decision.mock) {
    _mockEmailSet.delete(email.toLowerCase());
    return { ok: true, mocked: true };
  }
  if (decision.reason === "no-account-id-prod") {
    return unavailableResponse();
  }

  try {
    const policy = await fetchPolicy(env);
    const lc = email.toLowerCase();
    policy.include = policy.include.filter(
      (r) => !r.email || r.email.email.toLowerCase() !== lc,
    );
    await putPolicy(env, policy);
    return { ok: true };
  } catch (err: unknown) {
    const e = err as Error & { request_id?: string };
    return { ok: false, error: e.message };
  }
}
