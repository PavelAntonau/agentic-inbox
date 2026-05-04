// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.1 (mcp-oauth) — workers/auth/consent.ts unit tests.
//
// Coverage:
//   - verifyOAuthQuerySignature parity with the plugin's signParams output
//   - rejection: missing sig, missing exp, malformed exp, expired, tampered
//   - loadConsentClient: trusted-client lookup hits the SSOT cache

import { makeSignature } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { TRUSTED_CLIENTS } from "~/lib/cached-trusted-clients";
import { loadConsentClient, verifyOAuthQuerySignature } from "./consent";
import type { Env } from "../types";

const SECRET = "BETTER_AUTH_SECRET-test-fixture-32-bytes-min";

/**
 * Reproduce the plugin's signParams logic so we can build test fixtures
 * without importing private plugin internals. The plugin (index.mjs:3919):
 *
 *   const params = serializeAuthorizationQuery(ctx.query);
 *   params.set("exp", String(exp));
 *   const signature = await makeSignature(params.toString(), ctx.context.secret);
 *   params.append("sig", signature);
 *   return params.toString();
 */
async function buildSignedQuery(
  baseParams: Record<string, string>,
  ttlSec: number,
  secret = SECRET,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const params = new URLSearchParams(baseParams);
  params.set("exp", String(exp));
  const signature = await makeSignature(params.toString(), secret);
  params.append("sig", signature);
  return params.toString();
}

describe("verifyOAuthQuerySignature", () => {
  const baseQuery = {
    client_id: "claude-code",
    redirect_uri: "http://127.0.0.1/callback",
    response_type: "code",
    scope: "mcp:mailbox:read mcp:mailbox:write",
    state: "abc123",
    code_challenge: "deadbeef".repeat(8),
    code_challenge_method: "S256",
    resource: "https://mail.actionnow.ai/mcp",
  };

  it("accepts a freshly-signed query", async () => {
    const qs = await buildSignedQuery(baseQuery, 600);
    const result = await verifyOAuthQuerySignature(qs, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.get("client_id")).toBe("claude-code");
      // sig MUST have been stripped from the returned params.
      expect(result.params.has("sig")).toBe(false);
    }
  });

  it("rejects when sig is missing", async () => {
    const qs = await buildSignedQuery(baseQuery, 600);
    const params = new URLSearchParams(qs);
    params.delete("sig");
    const result = await verifyOAuthQuerySignature(params.toString(), SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("sig-missing");
  });

  it("rejects when exp is missing", async () => {
    const qs = await buildSignedQuery(baseQuery, 600);
    const params = new URLSearchParams(qs);
    params.delete("exp");
    const result = await verifyOAuthQuerySignature(params.toString(), SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("exp-missing");
  });

  it("rejects when exp is malformed", async () => {
    const params = new URLSearchParams(baseQuery);
    params.set("exp", "not-a-number");
    params.append("sig", "x");
    const result = await verifyOAuthQuerySignature(params.toString(), SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("exp-malformed");
  });

  it("rejects an expired query", async () => {
    const qs = await buildSignedQuery(baseQuery, -60); // exp 60 s ago
    const result = await verifyOAuthQuerySignature(qs, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a tampered client_id", async () => {
    const qs = await buildSignedQuery(baseQuery, 600);
    const params = new URLSearchParams(qs);
    params.set("client_id", "evil-client");
    const result = await verifyOAuthQuerySignature(params.toString(), SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("sig-mismatch");
  });

  it("rejects when verified under a different secret", async () => {
    const qs = await buildSignedQuery(baseQuery, 600, SECRET);
    const result = await verifyOAuthQuerySignature(qs, "wrong-secret");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("sig-mismatch");
  });

  it("rejects when secret is empty", async () => {
    const qs = await buildSignedQuery(baseQuery, 600);
    const result = await verifyOAuthQuerySignature(qs, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("secret-missing");
  });
});

describe("loadConsentClient (trusted)", () => {
  it.each(TRUSTED_CLIENTS.map((c) => c.clientId))(
    "resolves trusted client %s without touching D1",
    async (clientId) => {
      // No env.DB needed — the trusted path returns before the drizzle call.
      const view = await loadConsentClient({} as Env, clientId);
      expect(view).not.toBeNull();
      expect(view!.source).toBe("trusted");
      expect(view!.clientId).toBe(clientId);
      expect(view!.allowedScopes.length).toBeGreaterThan(0);
      // openid MUST NOT be in any trusted-client scope set per T1.1 finding B.
      expect(view!.allowedScopes).not.toContain("openid");
    },
  );

  it("returns trusted view for claude-code with stable display fields", async () => {
    const view = await loadConsentClient({} as Env, "claude-code");
    expect(view).not.toBeNull();
    expect(view!.clientName).toBe("Claude Code");
    expect(view!.clientUri).toBe("https://www.anthropic.com/claude-code");
    expect(view!.logoUri).toBe("https://www.anthropic.com/favicon.ico");
  });
});
