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
import {
  ConsentForwardError,
  loadConsentClient,
  verifyOAuthQuerySignature,
} from "./consent";
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

  it("rejects an expired query (well past the skew window)", async () => {
    const qs = await buildSignedQuery(baseQuery, -120); // exp 120 s ago
    const result = await verifyOAuthQuerySignature(qs, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  // C-1 (audit, agentic-inbox-hardening Phase 2): allow ±30 s of clock skew
  // on the exp check. A query that expired 5 s ago must be accepted; one
  // that expired 60 s ago must still be rejected.
  it("C-1: tolerates a 5 s clock-skew on the expiry check", async () => {
    const qs = await buildSignedQuery(baseQuery, -5); // exp 5 s ago
    const result = await verifyOAuthQuerySignature(qs, SECRET);
    expect(result.ok).toBe(true);
  });

  it("C-1: still rejects a query that expired 60 s ago (beyond the skew)", async () => {
    const qs = await buildSignedQuery(baseQuery, -60);
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

  // C-3 (audit, agentic-inbox-hardening Phase 2): when requestedScopes is
  // supplied, allowedScopes is the intersection of registered ∩ requested.
  // The lib enforces this so a future caller cannot accidentally over-scope
  // the consent UI by forgetting to filter.
  it("C-3: full registered set when requestedScopes is omitted", async () => {
    const view = await loadConsentClient({} as Env, "claude-code");
    expect(view).not.toBeNull();
    // Trusted-client scopes for claude-code are non-empty.
    expect(view!.allowedScopes.length).toBeGreaterThan(0);
  });

  it("C-3: returns intersection when requestedScopes is supplied", async () => {
    const fullView = await loadConsentClient({} as Env, "claude-code");
    expect(fullView).not.toBeNull();
    const oneScope = fullView!.allowedScopes[0]!;
    const view = await loadConsentClient({} as Env, "claude-code", [oneScope]);
    expect(view).not.toBeNull();
    expect(view!.allowedScopes).toEqual([oneScope]);
  });

  it("C-3: drops requested scopes the client did NOT register for", async () => {
    const view = await loadConsentClient({} as Env, "claude-code", [
      "mcp:mailbox:read",
      "mcp:not-a-real-scope",
    ]);
    expect(view).not.toBeNull();
    expect(view!.allowedScopes).not.toContain("mcp:not-a-real-scope");
  });

  it("C-3: empty requestedScopes yields empty allowedScopes (verbatim honor)", async () => {
    const view = await loadConsentClient({} as Env, "claude-code", []);
    expect(view).not.toBeNull();
    expect(view!.allowedScopes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C-2 — ConsentForwardError MUST NOT leak the plugin's error body in `.message`.
// ---------------------------------------------------------------------------

describe("ConsentForwardError (C-2)", () => {
  it("keeps the user-facing message fixed and free of upstream detail", () => {
    const err = new ConsentForwardError(
      "Consent request could not be completed",
      502,
      "Internal: leaked CSRF token=foo or PII",
    );
    expect(err.message).toBe("Consent request could not be completed");
    expect(err.message).not.toMatch(/CSRF|PII|leaked/);
  });

  it("preserves upstream detail on .serverDetail for log emission", () => {
    const err = new ConsentForwardError("user-facing", 502, "internal-only");
    expect(err.serverDetail).toBe("internal-only");
  });

  it("works without an upstream detail (legacy paths)", () => {
    const err = new ConsentForwardError("user-facing", 502);
    expect(err.serverDetail).toBeUndefined();
  });
});
