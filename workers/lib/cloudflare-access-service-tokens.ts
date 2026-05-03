// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// cloudflare-access-service-tokens.ts — thin wrapper around the Cloudflare
// Access Service Tokens API.
//
// Required token scope: Access: Service Tokens Write (already pinned in DEPLOY_STATE.md)
//
// In dev (CF_ACCESS_API_TOKEN absent or CF_ACCESS_DEV_MODE set), create() and
// deleteToken() return mock data so the local flow works without real CF creds.

export interface ServiceTokenCreateParams {
  /** Human-readable name — convention: '<mailbox-id>:<user-id>:<label>' */
  name: string;
  /**
   * Token duration as a free-form string (e.g. "2160h", "720h", "8760h").
   * Cloudflare passes this verbatim. Default: "2160h" (90 days).
   */
  duration?: string;
}

export interface ServiceTokenCreateResult {
  /** Cloudflare service-token UUID */
  id: string;
  /** client_id (the "username" for mcp-remote --header) */
  client_id: string;
  /** ONE-TIME plaintext client_secret — never stored; return to caller immediately */
  client_secret: string;
  name: string;
  expires_at: string;
}

export interface ServiceTokenDeleteResult {
  id: string;
}

/**
 * Create a Cloudflare Access service token.
 *
 * Returns client_id + ONE-TIME client_secret. Caller must store only a hash.
 */
export async function createServiceToken(
  accountId: string,
  apiToken: string,
  params: ServiceTokenCreateParams,
): Promise<ServiceTokenCreateResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens`;
  const body = {
    name: params.name,
    duration: params.duration ?? "2160h",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Cloudflare Access service token create failed: ${res.status} ${text}`,
    );
  }

  const data = (await res.json()) as {
    success: boolean;
    result: {
      id: string;
      client_id: string;
      client_secret: string;
      name: string;
      expires_at: string;
    };
  };

  if (!data.success || !data.result) {
    throw new Error(
      "Cloudflare Access service token create: unexpected response",
    );
  }

  return data.result;
}

/**
 * Delete a Cloudflare Access service token by its CF-side UUID.
 * Called as step 2 of revocation (after RevocationCache.revoke).
 */
export async function deleteServiceToken(
  accountId: string,
  apiToken: string,
  cfServiceTokenId: string,
): Promise<ServiceTokenDeleteResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens/${cfServiceTokenId}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Cloudflare Access service token delete failed: ${res.status} ${text}`,
    );
  }

  const data = (await res.json()) as {
    success: boolean;
    result: { id: string };
  };
  if (!data.success) {
    throw new Error(
      "Cloudflare Access service token delete: unexpected response",
    );
  }

  return data.result;
}

// ---------------------------------------------------------------------------
// Dev-mode mocks (no real CF credentials required)
// ---------------------------------------------------------------------------

export function mockCreateServiceToken(
  params: ServiceTokenCreateParams,
): ServiceTokenCreateResult {
  const id = crypto.randomUUID();
  const client_id = `${id}.access`;
  const client_secret = `mock-secret-${crypto.randomUUID().replace(/-/g, "")}`;
  const duration = params.duration ?? "2160h";
  // Parse duration string ("2160h") → ms, derive expires_at
  const hours = parseInt(duration, 10) || 2160;
  const expires_at = new Date(Date.now() + hours * 3_600_000).toISOString();
  return { id, client_id, client_secret, name: params.name, expires_at };
}

export function mockDeleteServiceToken(
  cfServiceTokenId: string,
): ServiceTokenDeleteResult {
  return { id: cfServiceTokenId };
}
