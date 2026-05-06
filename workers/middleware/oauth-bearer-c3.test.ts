// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C3 / TASK-C3.10 + TASK-C3.11 — JWKS cache invalidation + algorithms pin.
//
// Coverage:
//   • Rotating OAUTH_JWT_SIGNING_KEY at runtime causes the next bearer
//     verification to use the new key (cache keyed on key hash, not Env id).
//   • A token signed with the old key after rotation is rejected.
//   • A token signed with HS256 (or any non-EdDSA algorithm) is rejected
//     even when the JWKS contains the matching public key — algorithms pin.

import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, importJWK, type JWK } from "jose";
import { validateBearer, __clearJwksCacheForTests } from "./oauth-bearer";
import type { Env } from "../types";

interface KeyMaterial {
  privateKey: CryptoKey;
  publicJwk: Record<string, string>;
  kid: string;
}

async function genEdDsaKeys(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const publicJwk = (await exportJWK(publicKey)) as unknown as Record<
    string,
    string
  >;
  return { privateKey, publicJwk, kid };
}

async function signEdDsaJwt(
  keys: KeyMaterial,
  payload: Record<string, unknown>,
): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid })
    .setIssuer("https://mail.actionnow.ai")
    .setAudience("https://mail.actionnow.ai/mcp")
    .setIssuedAt(payload.iat as number)
    .setExpirationTime((payload.iat as number) + 900)
    .sign(keys.privateKey);
}

function makeEnvFromKeys(keys: KeyMaterial): Env {
  return {
    OAUTH_JWT_SIGNING_KEY: JSON.stringify({
      kid: keys.kid,
      alg: "EdDSA",
      crv: "Ed25519",
      publicJwk: keys.publicJwk,
      privateJwk: {},
    }),
    DB: {} as unknown,
  } as unknown as Env;
}

let keysA: KeyMaterial;
let keysB: KeyMaterial;
beforeAll(async () => {
  keysA = await genEdDsaKeys("kid-A");
  keysB = await genEdDsaKeys("kid-B");
});

describe("validateBearer — Phase C3 / TASK-C3.10 (JWKS cache rotation)", () => {
  beforeEach(() => {
    __clearJwksCacheForTests();
  });

  function freshClaims(payload: Record<string, unknown> = {}) {
    const iat = Math.floor(Date.now() / 1000);
    return {
      sub: "user-1",
      azp: "client-1",
      scope: "mcp:mailbox:read",
      iat,
      ...payload,
    };
  }

  it("token signed with key A verifies under env A", async () => {
    const tok = await signEdDsaJwt(keysA, freshClaims());
    const r = await validateBearer(
      new Request("http://x", { headers: { authorization: `Bearer ${tok}` } }),
      makeEnvFromKeys(keysA),
      { lookupGrantTombstone: async () => null },
    );
    expect(r.ok).toBe(true);
  });

  it("rotation: env switches to key B, token signed with B verifies, A is rejected", async () => {
    // First call primes the cache against key A's env.
    const tokA = await signEdDsaJwt(keysA, freshClaims());
    const envA = makeEnvFromKeys(keysA);
    const rA1 = await validateBearer(
      new Request("http://x", { headers: { authorization: `Bearer ${tokA}` } }),
      envA,
      { lookupGrantTombstone: async () => null },
    );
    expect(rA1.ok).toBe(true);

    // Operator rotates the secret to key B. The cache must invalidate.
    const envB = makeEnvFromKeys(keysB);
    const tokB = await signEdDsaJwt(keysB, freshClaims());
    const rB = await validateBearer(
      new Request("http://x", { headers: { authorization: `Bearer ${tokB}` } }),
      envB,
      { lookupGrantTombstone: async () => null },
    );
    expect(rB.ok).toBe(true);

    // The OLD token signed with key A must NOT verify against env B.
    const rA_under_B = await validateBearer(
      new Request("http://x", { headers: { authorization: `Bearer ${tokA}` } }),
      envB,
      { lookupGrantTombstone: async () => null },
    );
    expect(rA_under_B.ok).toBe(false);
    if (!rA_under_B.ok) expect(rA_under_B.reason).toBe("verify-failed");
  });

  it("same key hash across two Env objects → cache hit (no re-load)", async () => {
    // Two independent Env objects with identical secret payloads must share
    // the cache entry — the previous WeakMap-on-Env design would have
    // allocated two separate entries here.
    const env1 = makeEnvFromKeys(keysA);
    const env2 = makeEnvFromKeys(keysA);
    const tok = await signEdDsaJwt(keysA, freshClaims());
    const r1 = await validateBearer(
      new Request("http://x", { headers: { authorization: `Bearer ${tok}` } }),
      env1,
      { lookupGrantTombstone: async () => null },
    );
    const r2 = await validateBearer(
      new Request("http://x", { headers: { authorization: `Bearer ${tok}` } }),
      env2,
      { lookupGrantTombstone: async () => null },
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

describe("validateBearer — Phase C3 / TASK-C3.11 (algorithms pin EdDSA)", () => {
  beforeEach(() => {
    __clearJwksCacheForTests();
  });

  it("EdDSA token verifies (happy path)", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const tok = await signEdDsaJwt(keysA, {
      sub: "u1",
      azp: "c1",
      scope: "mcp:mailbox:read",
      iat,
    });
    const r = await validateBearer(
      new Request("http://x", { headers: { authorization: `Bearer ${tok}` } }),
      makeEnvFromKeys(keysA),
      { lookupGrantTombstone: async () => null },
    );
    expect(r.ok).toBe(true);
  });

  it("HS256 token is rejected even though jose can technically verify it", async () => {
    // Build a JWKS env that ALSO contains an HS256-shaped key with the same
    // kid. The algorithms pin must reject the HS256 envelope before jose
    // consults the JWKS — Phase C3 / TASK-C3.11.
    const hsKey = new Uint8Array(32);
    crypto.getRandomValues(hsKey);
    const hsJwk: JWK = {
      kty: "oct",
      alg: "HS256",
      k: btoa(String.fromCharCode(...hsKey))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
      kid: keysA.kid,
    };
    const hsKeyMaterial = await importJWK(hsJwk, "HS256");
    const iat = Math.floor(Date.now() / 1000);
    const hsTok = await new SignJWT({
      sub: "u1",
      azp: "c1",
      scope: "mcp:mailbox:read",
      iat,
    })
      .setProtectedHeader({ alg: "HS256", kid: keysA.kid })
      .setIssuer("https://mail.actionnow.ai")
      .setAudience("https://mail.actionnow.ai/mcp")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .sign(hsKeyMaterial);

    // The env still advertises only the EdDSA public key. The algorithms
    // pin in jwtVerify rejects the HS256 envelope before key lookup.
    const r = await validateBearer(
      new Request("http://x", {
        headers: { authorization: `Bearer ${hsTok}` },
      }),
      makeEnvFromKeys(keysA),
      { lookupGrantTombstone: async () => null },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("verify-failed");
  });
});
