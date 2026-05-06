// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C2 / TASK-C2.12 — JWT revocation Path 2 (D1 tombstone) coverage.

import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { validateBearer } from "./oauth-bearer";
import type { Env } from "../types";

interface KeyMaterial {
  privateKey: CryptoKey;
  publicJwk: Record<string, string>;
  kid: string;
}

async function genKeys(): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const publicJwk = (await exportJWK(publicKey)) as unknown as Record<
    string,
    string
  >;
  return { privateKey, publicJwk, kid: "kid-c2" };
}

async function signJwt(
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

function makeEnv(keys: KeyMaterial): Env {
  return {
    OAUTH_JWT_SIGNING_KEY: JSON.stringify({
      kid: keys.kid,
      alg: "EdDSA",
      crv: "Ed25519",
      publicJwk: keys.publicJwk,
      privateJwk: {}, // unused in verify path
    }),
    DB: {} as unknown,
  } as unknown as Env;
}

let keys: KeyMaterial;
beforeAll(async () => {
  keys = await genKeys();
});

describe("validateBearer — Phase C2 / TASK-C2.12 (tombstone)", () => {
  // Use a fresh iat each test so the JWT isn't expired by jose.
  function freshClaims() {
    const iat = Math.floor(Date.now() / 1000);
    return {
      sub: "user-1",
      azp: "client-1",
      scope: "mcp:mailbox:read",
      iat,
    };
  }

  it("no tombstone → bearer accepted", async () => {
    const claims = freshClaims();
    const token = await signJwt(keys, claims);
    const r = await validateBearer(
      new Request("http://x", {
        headers: { authorization: `Bearer ${token}` },
      }),
      makeEnv(keys),
      { lookupGrantTombstone: async () => null },
    );
    expect(r.ok).toBe(true);
  });

  it("tombstone AFTER iat → bearer rejected with grant-revoked", async () => {
    const claims = freshClaims();
    const token = await signJwt(keys, claims);
    // Tombstone is in epoch ms; iat*1000 + 5_000 means revoked 5 s after
    // the JWT was issued → reject (iat * 1000 <= revoked_at).
    const r = await validateBearer(
      new Request("http://x", {
        headers: { authorization: `Bearer ${token}` },
      }),
      makeEnv(keys),
      {
        lookupGrantTombstone: async () => claims.iat * 1000 + 5_000,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("grant-revoked");
      expect(r.bearer_error).toBe("invalid_token");
    }
  });

  it("tombstone EQUAL to iat (boundary) → rejected (iat <= revoked_at)", async () => {
    const claims = freshClaims();
    const token = await signJwt(keys, claims);
    const r = await validateBearer(
      new Request("http://x", {
        headers: { authorization: `Bearer ${token}` },
      }),
      makeEnv(keys),
      {
        lookupGrantTombstone: async () => claims.iat * 1000,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("grant-revoked");
  });

  it("tombstone BEFORE iat → bearer accepted (re-grant after revoke)", async () => {
    const claims = freshClaims();
    const token = await signJwt(keys, claims);
    // Tombstone written 1 s BEFORE the JWT was issued — the user
    // re-granted after the revoke; the new JWT must work.
    const r = await validateBearer(
      new Request("http://x", {
        headers: { authorization: `Bearer ${token}` },
      }),
      makeEnv(keys),
      {
        lookupGrantTombstone: async () => claims.iat * 1000 - 1_000,
      },
    );
    expect(r.ok).toBe(true);
  });
});
