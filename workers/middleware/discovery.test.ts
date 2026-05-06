// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.2 (mcp-oauth) — discovery.ts unit tests.

import { describe, expect, it } from "vitest";
import {
  ISSUER,
  RESOURCE,
  authorizationServerMetadata,
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
  handleJwks,
  protectedResourceMetadata,
  handleDiscoveryPreflight,
} from "./discovery";
import type { Env } from "../types";

const SAMPLE_KEY = JSON.stringify({
  kid: "test-kid-deadbeef",
  alg: "EdDSA",
  crv: "Ed25519",
  publicJwk: {
    kty: "OKP",
    crv: "Ed25519",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  },
  privateJwk: {
    kty: "OKP",
    crv: "Ed25519",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  },
});

const baseEnv = {
  OAUTH_JWT_SIGNING_KEY: SAMPLE_KEY,
} as unknown as Env;

describe("authorizationServerMetadata (RFC 8414)", () => {
  const meta = authorizationServerMetadata();

  it("issuer is the production root", () => {
    expect(meta.issuer).toBe(ISSUER);
  });

  it("endpoints all live under /api/auth/oauth2/* with one /jwks alias", () => {
    expect(meta.authorization_endpoint).toBe(
      `${ISSUER}/api/auth/oauth2/authorize`,
    );
    expect(meta.token_endpoint).toBe(`${ISSUER}/api/auth/oauth2/token`);
    expect(meta.introspection_endpoint).toBe(
      `${ISSUER}/api/auth/oauth2/introspect`,
    );
    expect(meta.revocation_endpoint).toBe(`${ISSUER}/api/auth/oauth2/revoke`);
    expect(meta.jwks_uri).toBe(`${ISSUER}/jwks`);
  });

  it("Phase C2 / P1-7: registration_endpoint NOT advertised (DCR off for v0.1)", () => {
    expect(meta.registration_endpoint).toBeUndefined();
  });

  it("Phase C2 / P1-6: token + introspection auth methods drop 'none'", () => {
    expect(meta.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
    ]);
    expect(meta.introspection_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
    ]);
    // Revocation keeps 'none' — RFC 7009 explicitly allows public clients
    // to revoke their own tokens, and the new tombstone makes that path
    // safely effective.
    expect(meta.revocation_endpoint_auth_methods_supported).toEqual([
      "none",
      "client_secret_basic",
    ]);
  });

  it("advertises only MCP scopes — no openid", () => {
    expect(meta.scopes_supported).toEqual([
      "mcp:mailbox:read",
      "mcp:mailbox:write",
      "mcp:contacts:read",
      "mcp:contacts:write",
      "mcp:profile:read",
    ]);
    expect(meta.scopes_supported as string[]).not.toContain("openid");
  });

  it("PKCE required, S256 only", () => {
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("RFC 8707 resource indicators advertised", () => {
    expect(meta.resource_indicators_supported).toBe(true);
  });

  it("response_types limited to authorization code", () => {
    expect(meta.response_types_supported).toEqual(["code"]);
  });

  it("handler returns JSON with public CORS headers", async () => {
    const r = await handleAuthorizationServerMetadata();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("protectedResourceMetadata (RFC 9728)", () => {
  const meta = protectedResourceMetadata();

  it("resource is the /mcp URL exactly", () => {
    expect(meta.resource).toBe(RESOURCE);
  });

  it("authorization_servers points to the issuer", () => {
    expect(meta.authorization_servers).toEqual([ISSUER]);
  });

  it("bearer methods are header-only (no query, no form)", () => {
    expect(meta.bearer_methods_supported).toEqual(["header"]);
  });

  it("EdDSA signing surfaced for token-verifying clients", () => {
    expect(meta.resource_signing_alg_values_supported).toEqual(["EdDSA"]);
  });

  it("handler returns JSON 200", async () => {
    const r = await handleProtectedResourceMetadata();
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.resource).toBe(RESOURCE);
  });
});

describe("handleJwks", () => {
  it("returns the public JWK with kid + alg + use:sig", async () => {
    const r = await handleJwks(baseEnv);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      kid: "test-kid-deadbeef",
      alg: "EdDSA",
      use: "sig",
    });
    // The PRIVATE key half MUST NOT be present.
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("503s when env is missing the signing key", async () => {
    const r = await handleJwks({} as Env);
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("signing_key_unavailable");
  });

  it("503s on malformed JSON wrapper", async () => {
    const r = await handleJwks({ OAUTH_JWT_SIGNING_KEY: "{not-json" } as Env);
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("signing_key_malformed");
  });

  it("served with public CORS headers", async () => {
    const r = await handleJwks(baseEnv);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cache-control")).toContain("public");
  });
});

describe("handleDiscoveryPreflight", () => {
  it("returns 204 with CORS headers", () => {
    const r = handleDiscoveryPreflight();
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });
});
