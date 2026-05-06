// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.6 (mcp-oauth) — OAuth flow per named client.
//
// Scope: this is a vitest-level integration suite, not a wrangler-dev scenario.
// The contract under test is "the bearer middleware accepts the access token
// each named client receives at the end of its OAuth flow, and exposes the
// expected scopes + client_id to downstream policy". The scenarios suite
// (scripts/scenarios/s-auth-*) covers the cookie-driven login UI; this file
// pins the post-token /mcp surface, parameterised over all four trusted
// clients shipped at `app/lib/cached-trusted-clients.ts`.
//
// Resolves OQ-mcp-auth-2 (CIMD adoption per client) and OQ-mcp-auth-4
// (Streamable HTTP per client) at the contract level — each TRUSTED_CLIENTS
// entry is exercised on the same /mcp transport and bearer schema.
//
// Coverage matrix per named client:
//   - happy path: signed bearer with the client's full scope set → ok,
//     client_id == clientId, scopes round-trip exactly.
//   - aud rejection: same client, aud="https://mail.actionnow.ai/api" →
//     wrong-audience.
//   - openid leak: same client, aud=array → array-audience.
//   - cookie-on-/mcp: same valid bearer + __Host-anai.session_token → 401
//     reason=session-cookie-on-mcp.
//   - missing client (azp absent) → missing-azp 401.
//   - scope subset rejection: client with no mcp:* scope → insufficient_scope.
//
// Cross-client (shared across all four):
//   - CSRF on the consent surface: tampered `client_id` in a signed query
//     fails verification before the user sees a consent dialog.

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it, beforeAll } from "vitest";
import {
  TRUSTED_CLIENTS,
  TRUSTED_CLIENT_IDS,
  type TrustedClient,
} from "~/lib/cached-trusted-clients";
import {
  REQUIRED_AUDIENCE,
  REQUIRED_ISSUER,
  validateBearer,
} from "../../workers/middleware/oauth-bearer";
import { verifyOAuthQuerySignature } from "../../workers/auth/consent";
import type { Env } from "../../workers/types";

const KID = "test-kid-e2e-T3.6";
const SECRET = "BETTER_AUTH_SECRET-test-fixture-32-bytes-min";

interface Keys {
  privateKey: CryptoKey;
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
    env: { OAUTH_JWT_SIGNING_KEY: wrapper } as unknown as Env,
  };
}

interface SignOpts {
  client: TrustedClient;
  scopes?: string[];
  aud?: string | string[];
  iss?: string;
  azp?: string | null;
  sub?: string;
  exp?: number;
}

async function signBearer(keys: Keys, opts: SignOpts): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: opts.sub ?? `user_${opts.client.clientId}`,
    scope: (opts.scopes ?? opts.client.scopes).join(" "),
  };
  if (opts.azp === null) {
    // Drop azp claim entirely.
  } else {
    payload.azp = opts.azp ?? opts.client.clientId;
  }
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: KID })
    .setIssuedAt(now)
    .setExpirationTime(opts.exp ?? now + 3600)
    .setIssuer(opts.iss ?? REQUIRED_ISSUER);
  if (opts.aud === undefined) {
    builder.setAudience(REQUIRED_AUDIENCE);
  } else {
    builder.setAudience(opts.aud);
  }
  return builder.sign(keys.privateKey);
}

/**
 * happy-dom strips the `Cookie` request header on `new Request(...)` because
 * the fetch spec marks it forbidden. Production Workers don't strip it. This
 * shim mirrors the production read path for `request.headers.get("cookie")`.
 * Same workaround used in workers/middleware/oauth-bearer.test.ts.
 */
function makeMcpRequest(
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

// ---------------------------------------------------------------------------
// Per-named-client coverage — parameterised over TRUSTED_CLIENTS
// ---------------------------------------------------------------------------

describe("OAuth flow — trusted client roster", () => {
  it("ships exactly four pre-registered clients", () => {
    expect(TRUSTED_CLIENTS).toHaveLength(4);
    expect([...TRUSTED_CLIENT_IDS]).toEqual([
      "claude-code",
      "chatgpt-desktop",
      "cursor",
      "actionnow-ios",
    ]);
  });

  it("every trusted client opts out of the `openid` scope (T1.1 finding B)", () => {
    for (const client of TRUSTED_CLIENTS) {
      expect(client.scopes).not.toContain("openid");
    }
  });

  it("every trusted client requests at least one mcp:* scope", () => {
    for (const client of TRUSTED_CLIENTS) {
      expect(client.scopes.some((s) => s.startsWith("mcp:"))).toBe(true);
    }
  });
});

describe.each(TRUSTED_CLIENTS)(
  "OAuth flow — $clientId",
  (client: TrustedClient) => {
    let keys: Keys;
    beforeAll(async () => {
      keys = await setupKeys();
    });

    it("accepts the access token issued at the end of the OAuth flow", async () => {
      const token = await signBearer(keys, { client });
      const r = await validateBearer(
        makeMcpRequest(`Bearer ${token}`),
        keys.env,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.source).toBe("jwt");
        expect(r.client_id).toBe(client.clientId);
        expect(r.user_id).toBe(`user_${client.clientId}`);
        // The full scope set the client requested round-trips through the
        // bearer middleware unchanged.
        expect(r.scopes).toEqual(client.scopes);
        // azp set, jti synthesised from token bytes (Phase C2 / A-08:
        // widened from 8 to 16 hex chars, 64-bit collision space).
        expect(r.jti).toMatch(/^[0-9a-f]{16}$/);
      }
    });

    it("rejects a token whose aud points at a different surface (per-client wrong-aud)", async () => {
      const token = await signBearer(keys, {
        client,
        aud: "https://mail.actionnow.ai/api",
      });
      const r = await validateBearer(
        makeMcpRequest(`Bearer ${token}`),
        keys.env,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("wrong-audience");
        expect(r.bearer_error).toBe("invalid_token");
      }
    });

    it("rejects an array-shaped aud (openid leak signature, T1.1 finding B)", async () => {
      const token = await signBearer(keys, {
        client,
        aud: [REQUIRED_AUDIENCE, "https://mail.actionnow.ai/oauth2/userinfo"],
      });
      const r = await validateBearer(
        makeMcpRequest(`Bearer ${token}`),
        keys.env,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("array-audience");
      }
    });

    it("rejects a session cookie alongside the bearer (D-mcp-auth anti-pattern)", async () => {
      const token = await signBearer(keys, { client });
      const r = await validateBearer(
        makeMcpRequest(
          `Bearer ${token}`,
          "__Host-anai.session_token=cookieleak",
        ),
        keys.env,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("session-cookie-on-mcp");
        expect(r.bearer_error).toBe("invalid_token");
      }
    });

    it("rejects when azp claim is absent", async () => {
      const token = await signBearer(keys, { client, azp: null });
      const r = await validateBearer(
        makeMcpRequest(`Bearer ${token}`),
        keys.env,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("missing-azp");
    });

    it("rejects when no scope is mcp:* (insufficient_scope, 403)", async () => {
      const token = await signBearer(keys, {
        client,
        scopes: ["profile:read", "email:read"],
      });
      const r = await validateBearer(
        makeMcpRequest(`Bearer ${token}`),
        keys.env,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("no-mcp-scope");
        expect(r.bearer_error).toBe("insufficient_scope");
      }
    });
  },
);

// ---------------------------------------------------------------------------
// CSRF + tampering on the consent redirect (cross-client)
// ---------------------------------------------------------------------------

describe("OAuth flow — consent CSRF + tampering", () => {
  /**
   * Reproduce the better-auth oauth-provider's `signParams` so the consent
   * redirect URL can be built deterministically. Same construction used in
   * workers/auth/consent.test.ts; lifted here so each named client's full
   * authorize→consent→token chain has its own contract assertion.
   */
  async function buildSignedAuthorizeQuery(
    client: TrustedClient,
    overrides: Record<string, string> = {},
    ttlSec = 600,
    secret = SECRET,
  ): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0],
      response_type: "code",
      scope: client.scopes.join(" "),
      state: "csrf-test-state",
      code_challenge: "deadbeef".repeat(8),
      code_challenge_method: "S256",
      resource: REQUIRED_AUDIENCE,
      ...overrides,
    });
    params.set("exp", String(exp));
    const signature = await makeSignature(params.toString(), secret);
    params.append("sig", signature);
    return params.toString();
  }

  it.each(TRUSTED_CLIENTS)(
    "$clientId — accepts a fresh signed authorize redirect",
    async (client) => {
      const qs = await buildSignedAuthorizeQuery(client);
      const r = await verifyOAuthQuerySignature(qs, SECRET);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.params.get("client_id")).toBe(client.clientId);
        // sig stripped before the params reach the consent loader.
        expect(r.params.has("sig")).toBe(false);
      }
    },
  );

  it.each(TRUSTED_CLIENTS)(
    "$clientId — rejects when client_id is tampered between sign + verify",
    async (client) => {
      const qs = await buildSignedAuthorizeQuery(client);
      const params = new URLSearchParams(qs);
      // Swap the legitimate client_id for another trusted client's id —
      // looks plausible to a casual observer, fails HMAC verification.
      const otherClient = TRUSTED_CLIENTS.find(
        (c) => c.clientId !== client.clientId,
      )!;
      params.set("client_id", otherClient.clientId);
      const r = await verifyOAuthQuerySignature(params.toString(), SECRET);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("sig-mismatch");
    },
  );

  it.each(TRUSTED_CLIENTS)(
    "$clientId — rejects an expired signed redirect (replay window closed)",
    async (client) => {
      const qs = await buildSignedAuthorizeQuery(client, {}, -60);
      const r = await verifyOAuthQuerySignature(qs, SECRET);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("expired");
    },
  );

  it.each(TRUSTED_CLIENTS)(
    "$clientId — rejects when sig is stripped (CSRF without HMAC)",
    async (client) => {
      const qs = await buildSignedAuthorizeQuery(client);
      const params = new URLSearchParams(qs);
      params.delete("sig");
      const r = await verifyOAuthQuerySignature(params.toString(), SECRET);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("sig-missing");
    },
  );
});
