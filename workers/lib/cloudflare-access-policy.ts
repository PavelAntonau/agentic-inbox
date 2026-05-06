// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import type { Env } from "../types";

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
