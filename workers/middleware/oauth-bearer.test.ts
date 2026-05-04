// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.2 (mcp-oauth) — oauth-bearer.ts unit tests.
//
// Coverage matrix (the spec MUSTs from T2.2 + D-mcp-auth-5):
//   - valid bearer with single-string aud + mcp:* scope → ok
//   - cookie-on-/mcp (any __Host-anai.session_token) → invalid_token 401
//   - missing Authorization header → invalid_token 401
//   - expired token → invalid_token 401
//   - wrong issuer → invalid_token 401
//   - wrong audience (string) → invalid_token 401
//   - array audience (openid leak signature) → invalid_token 401
//   - no mcp:* scope → insufficient_scope 403
//   - missing sub / azp → invalid_token 401
//   - challenge response shape: WWW-Authenticate header MUST carry realm,
//     resource_metadata, and (when present) error + error_description.

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, beforeAll } from "vitest";
import {
  REQUIRED_AUDIENCE,
  REQUIRED_ISSUER,
  RESOURCE_METADATA_URL,
  bearerChallengeResponse,
  validateBearer,
} from "./oauth-bearer";
import type { Env } from "../types";

const KID = "test-kid-cafef00d";

interface Keys {
  privateKey: CryptoKey;
  publicJwk: Record<string, string>;
  env: Env;
}

async function setupKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const publicJwk = (await exportJWK(publicKey)) as Record<string, string>;
  const privateJwk = (await exportJWK(privateKey)) as Record<string, string>;
  const wrapper = JSON.stringify({
    kid: KID,
    alg: "EdDSA",
    crv: "Ed25519",
    publicJwk,
    privateJwk,
  });
  return {
    privateKey,
    publicJwk,
    env: { OAUTH_JWT_SIGNING_KEY: wrapper } as unknown as Env,
  };
}

interface ClaimOverrides {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  // azp is `string | null` so callers can explicitly drop the claim with
  // `azp: null`. `undefined` keeps the default "claude-code" value (used by
  // happy-path tests).
  azp?: string | null;
  scope?: string;
  exp?: number;
  iat?: number;
}

async function signToken(
  keys: Keys,
  overrides: ClaimOverrides = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: overrides.sub ?? "user_abc",
    scope:
      overrides.scope ?? "mcp:mailbox:read mcp:mailbox:write mcp:contacts:read",
  };
  // azp default lives outside the spread so passing `azp: null` reliably
  // omits the claim instead of falling back via `??`.
  if (overrides.azp === null) {
    // Drop the claim entirely.
  } else {
    payload.azp = overrides.azp ?? "claude-code";
  }
  if (overrides.aud !== undefined) payload.aud = overrides.aud;

  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: KID })
    .setIssuedAt(overrides.iat ?? now)
    .setExpirationTime(overrides.exp ?? now + 3600)
    .setIssuer(overrides.iss ?? REQUIRED_ISSUER);

  // Set audience separately — when overrides.aud is undefined we want the
  // canonical single-string default; when explicitly null/array, jose's
  // .setAudience accepts both.
  if (overrides.aud === undefined) {
    builder.setAudience(REQUIRED_AUDIENCE);
  } else {
    builder.setAudience(overrides.aud);
  }
  return builder.sign(keys.privateKey);
}

/**
 * Build a Request-shaped object whose `headers.get` returns the values we
 * want. happy-dom (and the fetch spec) treats `Cookie` as a forbidden
 * request header and strips it from `new Request(..., { headers: {...} })`,
 * so we cannot drive cookie-based tests through a real Request constructor.
 * Production Workers do NOT strip incoming Cookie headers — the bearer
 * middleware reads `request.headers.get("cookie")` and gets the value
 * verbatim. This shim mirrors that behavior. Same workaround documented in
 * `workers/auth/consent.test.ts`.
 */
function makeRequest(
  authHeader: string | undefined,
  cookieHeader?: string,
): Request {
  const headerMap = new Map<string, string>();
  if (authHeader) headerMap.set("authorization", authHeader);
  if (cookieHeader) headerMap.set("cookie", cookieHeader);
  return {
    method: "POST",
    url: "https://mail.actionnow.ai/mcp",
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
  } as unknown as Request;
}

describe("validateBearer — happy path", () => {
  let keys: Keys;
  beforeAll(async () => {
    keys = await setupKeys();
  });

  it("accepts a freshly-signed bearer with single-string aud and mcp:* scope", async () => {
    const token = await signToken(keys);
    const r = await validateBearer(makeRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user_id).toBe("user_abc");
      expect(r.client_id).toBe("claude-code");
      expect(r.scopes).toEqual([
        "mcp:mailbox:read",
        "mcp:mailbox:write",
        "mcp:contacts:read",
      ]);
      // Synthetic jti is 8 hex chars.
      expect(r.jti).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe("validateBearer — rejection paths", () => {
  let keys: Keys;
  beforeAll(async () => {
    keys = await setupKeys();
  });

  it("rejects when Authorization header is absent", async () => {
    const r = await validateBearer(makeRequest(undefined), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("missing-bearer");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("rejects when Authorization header is not bearer", async () => {
    const r = await validateBearer(makeRequest("Basic dXNlcjpwYXNz"), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-bearer");
  });

  it("rejects bearer with empty token", async () => {
    const r = await validateBearer(makeRequest("Bearer "), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-bearer");
  });

  it("rejects when an __Host-anai.session_token cookie is present", async () => {
    const token = await signToken(keys);
    const r = await validateBearer(
      makeRequest(`Bearer ${token}`, "__Host-anai.session_token=abc123"),
      keys.env,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("session-cookie-on-mcp");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("ignores unrelated cookies (does NOT reject on csrf cookie alone)", async () => {
    const token = await signToken(keys);
    const r = await validateBearer(
      makeRequest(
        `Bearer ${token}`,
        "__Host-CSRF_TOKEN=abc.123; other_cookie=foo",
      ),
      keys.env,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await signToken(keys, { exp: past, iat: past - 600 });
    const r = await validateBearer(makeRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("expired");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("rejects wrong issuer", async () => {
    const token = await signToken(keys, { iss: "https://evil.example.com" });
    const r = await validateBearer(makeRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("wrong-issuer");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("rejects wrong audience (string)", async () => {
    const token = await signToken(keys, {
      aud: "https://mail.actionnow.ai/api",
    });
    const r = await validateBearer(makeRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("wrong-audience");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("rejects array-shaped audience (openid leak signature)", async () => {
    const token = await signToken(keys, {
      aud: [
        "https://mail.actionnow.ai/mcp",
        "https://mail.actionnow.ai/oauth2/userinfo",
      ],
    });
    const r = await validateBearer(makeRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("array-audience");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("rejects token with no mcp:* scope (insufficient_scope, 403)", async () => {
    const token = await signToken(keys, { scope: "profile email" });
    const r = await validateBearer(makeRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-mcp-scope");
      expect(r.bearer_error).toBe("insufficient_scope");
    }
  });

  it("rejects token missing azp claim", async () => {
    // `azp: null` drops the claim entirely (see signToken default-handling).
    const token = await signToken(keys, { azp: null });
    const r = await validateBearer(makeRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-azp");
  });
});

describe("bearerChallengeResponse", () => {
  it("401 with realm + resource_metadata + invalid_token error", () => {
    const r = bearerChallengeResponse("missing-bearer", "invalid_token");
    expect(r.status).toBe(401);
    const wa = r.headers.get("www-authenticate") ?? "";
    expect(wa).toContain('realm="mcp"');
    expect(wa).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);
    expect(wa).toContain('error="invalid_token"');
    expect(wa).toContain('error_description="missing-bearer"');
  });

  it("403 when bearer_error is insufficient_scope", () => {
    const r = bearerChallengeResponse("no-mcp-scope", "insufficient_scope");
    expect(r.status).toBe(403);
    expect(r.headers.get("www-authenticate") ?? "").toContain(
      'error="insufficient_scope"',
    );
  });

  it("401 with bare challenge when bearer_error is null", () => {
    const r = bearerChallengeResponse("missing-bearer", null);
    expect(r.status).toBe(401);
    const wa = r.headers.get("www-authenticate") ?? "";
    expect(wa).toContain('realm="mcp"');
    expect(wa).not.toContain("error=");
  });

  it("Cache-Control: no-store on every challenge", () => {
    const r = bearerChallengeResponse("expired", "invalid_token");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
