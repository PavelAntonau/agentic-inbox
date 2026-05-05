// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.7 (mcp-oauth) — Security regression: session cookies MUST NOT
// authenticate /mcp.
//
// MCP spec MUST: bearer-only on /mcp. The session cookie surface
// (`__Host-anai.session_token`) is the browser's identity for the
// React app routes; it MUST be structurally rejected at /mcp regardless
// of whether a Bearer token is also present. This rule is anchored in
// research §6.1 and decision D-mcp-auth anti-pattern `0olzaspBOKxkzjp2AZRkV`.
//
// This file is a dedicated regression audit. The invariant under test:
//
//   "If the request to /mcp carries a __Host-anai.session_token cookie,
//    validateBearer MUST return ok:false with reason='session-cookie-on-mcp'
//    OR (when Bearer is also missing) reason='missing-bearer' — under no
//    circumstance ok:true."
//
// Coverage extends beyond the unit-level tests in
// workers/middleware/oauth-bearer.test.ts to assert positional independence
// (session cookie at start, middle, end of the Cookie header) and parity
// across both bearer surfaces (JWT and PAT).

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  REQUIRED_AUDIENCE,
  REQUIRED_ISSUER,
  SESSION_COOKIE_PREFIX,
  validateBearer,
  type BearerDeps,
} from "../../workers/middleware/oauth-bearer";
import type { Env } from "../../workers/types";
import type { ActivePatRow } from "../../workers/db/queries/pats";

const KID = "test-kid-T3.7-cookie-not-mcp";

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
    env: {
      OAUTH_JWT_SIGNING_KEY: wrapper,
      TOKEN_PEPPER: "test-pepper-T3.7",
    } as unknown as Env,
  };
}

async function signValidBearer(keys: Keys): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: "user_T3.7",
    azp: "claude-code",
    scope: "mcp:mailbox:read",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: KID })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setIssuer(REQUIRED_ISSUER)
    .setAudience(REQUIRED_AUDIENCE)
    .sign(keys.privateKey);
}

/**
 * happy-dom strips `Cookie` request headers via `new Request(...)`. This
 * mirrors the production-Worker read path that
 * `workers/middleware/oauth-bearer.test.ts` already uses — the helper is
 * duplicated here to keep the security regression file self-contained.
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

const SESSION_COOKIE = `${SESSION_COOKIE_PREFIX}=session-value-T3.7`;

describe("security regression — session cookie cannot authenticate /mcp", () => {
  let keys: Keys;
  beforeAll(async () => {
    keys = await setupKeys();
  });

  it("session cookie alone (no Bearer) → 401 missing-bearer", async () => {
    const r = await validateBearer(
      makeMcpRequest(undefined, SESSION_COOKIE),
      keys.env,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The cookie guard fires first: present session cookie → reject
      // before Bearer parsing. This is intentional; cookie-only requests
      // get the most-specific reason.
      expect(r.reason).toBe("session-cookie-on-mcp");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("session cookie + valid JWT Bearer → 401 session-cookie-on-mcp", async () => {
    const token = await signValidBearer(keys);
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${token}`, SESSION_COOKIE),
      keys.env,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("session-cookie-on-mcp");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("session cookie + valid PAT Bearer → 401 session-cookie-on-mcp", async () => {
    const patRow: ActivePatRow = {
      id: "pat_T3.7",
      user_id: "user_T3.7",
      scopes: ["mcp:mailbox:read"],
      expires_at: null,
      mailbox_id: null,
      ip_allowlist: null,
    };
    const deps: BearerDeps = {
      lookupPatByHash: async () => patRow,
      touchPatLastUsed: async () => {},
    };
    const r = await validateBearer(
      makeMcpRequest(`Bearer pat_arbitrary_secret_value`, SESSION_COOKIE),
      keys.env,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Cookie guard fires before PAT-prefix dispatch — both bearer surfaces
      // are equally rejected when a session cookie rides alongside.
      expect(r.reason).toBe("session-cookie-on-mcp");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("session cookie at the START of the Cookie header → still rejected", async () => {
    const token = await signValidBearer(keys);
    const cookieHeader = `${SESSION_COOKIE}; theme=dark; locale=en`;
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${token}`, cookieHeader),
      keys.env,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("session-cookie-on-mcp");
  });

  it("session cookie in the MIDDLE of the Cookie header → still rejected", async () => {
    const token = await signValidBearer(keys);
    const cookieHeader = `theme=dark; ${SESSION_COOKIE}; locale=en`;
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${token}`, cookieHeader),
      keys.env,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("session-cookie-on-mcp");
  });

  it("session cookie at the END of the Cookie header → still rejected", async () => {
    const token = await signValidBearer(keys);
    const cookieHeader = `theme=dark; locale=en; ${SESSION_COOKIE}`;
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${token}`, cookieHeader),
      keys.env,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("session-cookie-on-mcp");
  });

  it("unrelated cookies WITHOUT the session cookie → bearer evaluated normally", async () => {
    const token = await signValidBearer(keys);
    const cookieHeader = "theme=dark; __Host-CSRF_TOKEN=anything; locale=en";
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${token}`, cookieHeader),
      keys.env,
    );
    // Confirms the guard isn't over-aggressive: only the session cookie
    // triggers the rejection, everything else passes through.
    expect(r.ok).toBe(true);
  });

  it("a cookie whose NAME contains the session prefix as a substring is NOT a false-positive", async () => {
    // The guard uses `c.startsWith(SESSION_COOKIE_PREFIX)` after splitting on
    // `;\s*`, so a cookie like `not__Host-anai.session_token=foo` (which
    // *contains* the prefix mid-name) starts with `not__Host-` and is correctly
    // ignored. This pins the prefix-matching boundary.
    const token = await signValidBearer(keys);
    const cookieHeader = `not${SESSION_COOKIE}; theme=dark`;
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${token}`, cookieHeader),
      keys.env,
    );
    expect(r.ok).toBe(true);
  });

  it("session cookie WITH NO VALUE (`__Host-anai.session_token=`) is still rejected", async () => {
    // Browsers can emit empty-valued cookies post-burn; the guard should
    // still reject because the *name* is what carries the trust signal.
    const token = await signValidBearer(keys);
    const cookieHeader = `${SESSION_COOKIE_PREFIX}=`;
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${token}`, cookieHeader),
      keys.env,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("session-cookie-on-mcp");
  });

  it("missing both Bearer and session cookie → 401 missing-bearer (control)", async () => {
    const r = await validateBearer(makeMcpRequest(undefined), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("missing-bearer");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });
});
