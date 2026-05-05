// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.7 (mcp-oauth) — Security regression: audience binding.
//
// MCP spec MUST: an access token issued for surface A MUST NOT validate
// against surface B. We enforce this with exact-string comparison against
// `REQUIRED_AUDIENCE = "https://mail.actionnow.ai/mcp"` — explicitly NOT
// jose's `audience:` option (which accepts arrays and intersects on
// membership). The "openid leak" signature is an array-shaped aud
// containing the right value alongside extras; that MUST be rejected
// outright per D-mcp-auth-5 and the T1.1 finding B.
//
// The invariant under test:
//
//   "validateBearer accepts iff payload.aud === 'https://mail.actionnow.ai/mcp'.
//    Anything else — wrong host, wrong path, array shape, missing claim,
//    casing variants — MUST reject with reason in
//    {wrong-audience, array-audience}."

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  REQUIRED_AUDIENCE,
  REQUIRED_ISSUER,
  validateBearer,
} from "../../workers/middleware/oauth-bearer";
import type { Env } from "../../workers/types";

const KID = "test-kid-T3.7-wrong-aud";

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
  aud?: string | string[] | undefined;
  /** When true, omit the aud claim entirely. */
  omitAud?: boolean;
}

async function signWithAudience(
  keys: Keys,
  opts: SignOpts = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    sub: "user_T3.7_aud",
    azp: "claude-code",
    scope: "mcp:mailbox:read",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: KID })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setIssuer(REQUIRED_ISSUER);
  if (opts.omitAud !== true) {
    builder.setAudience(opts.aud ?? REQUIRED_AUDIENCE);
  }
  return builder.sign(keys.privateKey);
}

function makeMcpRequest(authHeader: string): Request {
  const headerMap = new Map<string, string>();
  headerMap.set("authorization", authHeader);
  return {
    method: "POST",
    url: "https://mail.actionnow.ai/mcp",
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
  } as unknown as Request;
}

describe("security regression — audience binding", () => {
  let keys: Keys;
  beforeAll(async () => {
    keys = await setupKeys();
  });

  it("control: exact aud match accepts", async () => {
    const token = await signWithAudience(keys, { aud: REQUIRED_AUDIENCE });
    const r = await validateBearer(makeMcpRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["completely different host", "https://attacker.example.com/mcp"],
    ["sibling path same host", "https://mail.actionnow.ai/api"],
    ["userinfo path", "https://mail.actionnow.ai/oauth2/userinfo"],
    ["root path", "https://mail.actionnow.ai/"],
    ["origin only (no path)", "https://mail.actionnow.ai"],
    [
      "trailing slash on /mcp (exact-string is strict)",
      "https://mail.actionnow.ai/mcp/",
    ],
    ["path-prefix attack", "https://mail.actionnow.ai/mcp/../api"],
    ["http downgrade", "http://mail.actionnow.ai/mcp"],
    ["uppercase host", "https://MAIL.ACTIONNOW.AI/mcp"],
    ["uppercase path", "https://mail.actionnow.ai/MCP"],
    ["lookalike host (mail.actionnow.al)", "https://mail.actionnow.al/mcp"],
    [
      "punycode lookalike (xn--actinnow)",
      "https://mail.xn--actinnow-h0a.ai/mcp",
    ],
  ])("rejects wrong-aud variant: %s", async (_label, aud) => {
    const token = await signWithAudience(keys, { aud });
    const r = await validateBearer(makeMcpRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("wrong-audience");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("rejects when aud claim is absent entirely", async () => {
    const token = await signWithAudience(keys, { omitAud: true });
    const r = await validateBearer(makeMcpRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong-audience");
  });

  it("rejects array-aud even when REQUIRED_AUDIENCE is the only entry", async () => {
    // The "single-entry array" case is the most insidious: most JWT libraries
    // accept it as equivalent to a string. We do NOT — array-shape itself
    // is the openid-leak signature regardless of contents.
    const token = await signWithAudience(keys, { aud: [REQUIRED_AUDIENCE] });
    const r = await validateBearer(makeMcpRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("array-audience");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("rejects array-aud containing REQUIRED_AUDIENCE plus a sibling", async () => {
    const token = await signWithAudience(keys, {
      aud: [REQUIRED_AUDIENCE, "https://mail.actionnow.ai/oauth2/userinfo"],
    });
    const r = await validateBearer(makeMcpRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("array-audience");
  });

  it("rejects array-aud containing only foreign audiences", async () => {
    const token = await signWithAudience(keys, {
      aud: ["https://attacker.com/mcp", "https://mail.actionnow.ai/api"],
    });
    const r = await validateBearer(makeMcpRequest(`Bearer ${token}`), keys.env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("array-audience");
  });

  it("REQUIRED_AUDIENCE constant is locked to the production /mcp surface", () => {
    // Anchored regression: any change to REQUIRED_AUDIENCE must be
    // accompanied by a deliberate update of this assertion AND the
    // corresponding `.well-known/oauth-protected-resource` document.
    expect(REQUIRED_AUDIENCE).toBe("https://mail.actionnow.ai/mcp");
    expect(REQUIRED_ISSUER).toBe("https://mail.actionnow.ai");
    // Path is NOT just an origin — the audience binds the resource, not
    // the authorization server.
    expect(REQUIRED_AUDIENCE).not.toBe(REQUIRED_ISSUER);
    expect(REQUIRED_AUDIENCE.startsWith(REQUIRED_ISSUER)).toBe(true);
  });
});
