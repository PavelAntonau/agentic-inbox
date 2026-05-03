// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import type { Env } from "../types";

// -----------------------------------------------------------------------
// In-memory mock set — consistent within a single worker invocation
// -----------------------------------------------------------------------

const _mockEmailSet = new Set<string>();

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
  const isMock = env.CF_ACCESS_DEV_MODE === "mock" || !env.CF_ACCOUNT_ID;
  if (isMock) {
    _mockEmailSet.add(email.toLowerCase());
    return { ok: true, mocked: true };
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
  const isMock = env.CF_ACCESS_DEV_MODE === "mock" || !env.CF_ACCOUNT_ID;
  if (isMock) {
    _mockEmailSet.delete(email.toLowerCase());
    return { ok: true, mocked: true };
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
