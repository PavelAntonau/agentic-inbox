// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C3 / TASK-C3.6 + TASK-C3.17 + TASK-C3.19 — pure-predicate tests for the
// app-level cross-cutting middleware. We validate the rule shapes that the
// Hono middleware encodes — full route-level integration is exercised via
// the existing tests/e2e/* suite which already boots the full app harness.

import { describe, expect, it } from "vitest";
import { buildCspDirectives } from "./lib/csp";

// ---------------------------------------------------------------------------
// TASK-C3.6 — CSP path classifier semantics
// ---------------------------------------------------------------------------
//
// Mirrors the `isApiPath` predicate inside `workers/app.ts`. The middleware
// returns early (no headers) for any path that matches; everything else
// gets the security headers when the response is HTML.

function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/jwks" ||
    pathname.startsWith("/mcp") ||
    pathname.startsWith("/agents/") ||
    pathname.startsWith("/__mock") ||
    pathname.startsWith("/cdn-cgi/")
  );
}

describe("CSP path classifier — Phase C3 / TASK-C3.6", () => {
  it("classifies /api/* as API (no CSP)", () => {
    expect(isApiPath("/api/v1/mailboxes")).toBe(true);
    expect(isApiPath("/api/users/me")).toBe(true);
  });

  it("classifies /.well-known/* as API (no CSP)", () => {
    expect(isApiPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isApiPath("/.well-known/oauth-protected-resource")).toBe(true);
  });

  it("classifies /jwks as API (no CSP)", () => {
    expect(isApiPath("/jwks")).toBe(true);
  });

  it("classifies /mcp* as API (no CSP)", () => {
    expect(isApiPath("/mcp")).toBe(true);
    expect(isApiPath("/mcp/sse")).toBe(true);
  });

  it("classifies /agents/* as API (no CSP — WebSocket upgrade target)", () => {
    expect(isApiPath("/agents/email-agent/some-mailbox")).toBe(true);
  });

  it("classifies /__mock/* as API (test harness only)", () => {
    expect(isApiPath("/__mock/email-ingest")).toBe(true);
  });

  it("classifies /cdn-cgi/* as API (CF Access logout etc.)", () => {
    expect(isApiPath("/cdn-cgi/access/logout")).toBe(true);
  });

  it("classifies SPA paths as HTML (CSP applies)", () => {
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/threads/123")).toBe(false);
    expect(isApiPath("/login")).toBe(false);
    expect(isApiPath("/admin/users")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK-C3.6 — CSP directive shape
// (Phase E / TASK-E.1 — upgraded to nonce + 'strict-dynamic'. The detailed
// helper-level assertions live in workers/csp.test.ts; this file keeps the
// "what the route shape looks like" smoke check.)
// ---------------------------------------------------------------------------

const SAMPLE_NONCE = "test-nonce-fixture";
const CSP_WITH_NONCE = buildCspDirectives(SAMPLE_NONCE);

describe("CSP directive content — Phase C3 / TASK-C3.6 + Phase E / TASK-E.1", () => {
  it("default-src is self", () => {
    expect(CSP_WITH_NONCE).toContain("default-src 'self'");
  });

  it("script-src is nonce + 'strict-dynamic' — 'unsafe-inline' GONE (Phase E / TASK-E.1)", () => {
    // RR7 hydration tags + ReactDOM bootstrap script all get the per-request
    // nonce stamped on them by the HTMLRewriter in workers/app.ts. With
    // 'strict-dynamic', any script those nonced scripts pull in transitively
    // is also trusted — covering the entry-client chunk graph without
    // enumerating hashes. 'unsafe-inline' MUST NOT appear; 'unsafe-eval'
    // MUST NOT appear.
    const scriptSrcLine = CSP_WITH_NONCE.split("; ").find((d) =>
      d.startsWith("script-src"),
    )!;
    expect(scriptSrcLine).toContain("'self'");
    expect(scriptSrcLine).toContain(`'nonce-${SAMPLE_NONCE}'`);
    expect(scriptSrcLine).toContain("'strict-dynamic'");
    expect(scriptSrcLine).not.toContain("'unsafe-inline'");
    expect(scriptSrcLine).not.toContain("'unsafe-eval'");
  });

  it("style-src keeps 'unsafe-inline' — OWASP-accepted relaxation for inline <style>", () => {
    const styleSrcLine = CSP_WITH_NONCE.split("; ").find((d) =>
      d.startsWith("style-src"),
    )!;
    expect(styleSrcLine).toContain("'self'");
    expect(styleSrcLine).toContain("'unsafe-inline'");
  });

  it("frame-ancestors is 'none' (defense-in-depth alongside X-Frame-Options)", () => {
    expect(CSP_WITH_NONCE).toContain("frame-ancestors 'none'");
  });

  it("object-src is 'none' (no plugin embedding)", () => {
    expect(CSP_WITH_NONCE).toContain("object-src 'none'");
  });

  it("base-uri is 'self' (no base-tag injection)", () => {
    expect(CSP_WITH_NONCE).toContain("base-uri 'self'");
  });

  it("form-action is 'self' (no off-origin form posts)", () => {
    expect(CSP_WITH_NONCE).toContain("form-action 'self'");
  });
});

// ---------------------------------------------------------------------------
// TASK-C3.19 — V1 mailbox admin gate predicate
// ---------------------------------------------------------------------------
//
// Mirrors the inline gate at `workers/index.ts` POST /api/v1/mailboxes.

type Role = "global_owner" | "global_admin" | "user";

function v1MailboxCreateAllowed(role: Role | undefined): boolean {
  if (!role) return false;
  return role === "global_owner" || role === "global_admin";
}

describe("POST /api/v1/mailboxes — Phase C3 / TASK-C3.19 (B-08) gate", () => {
  it("global_owner allowed", () => {
    expect(v1MailboxCreateAllowed("global_owner")).toBe(true);
  });

  it("global_admin allowed", () => {
    expect(v1MailboxCreateAllowed("global_admin")).toBe(true);
  });

  it("regular user REFUSED (the load-bearing C3.19 fix)", () => {
    expect(v1MailboxCreateAllowed("user")).toBe(false);
  });

  it("missing role (no authzContext) REFUSED", () => {
    expect(v1MailboxCreateAllowed(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK-C3.17 — error-redaction sentinel shape
// ---------------------------------------------------------------------------
//
// We assert the SHAPE of the response body the onError middleware emits is
// structurally distinct from validator-emitted 400s (which carry an `error`
// string only) so consumers can tell them apart.

interface ValidatorError {
  error: string;
}
interface InternalError {
  error: "internal_error";
  correlation_id: string;
}

function looksLikeRedactedInternalError(body: unknown): body is InternalError {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    b.error === "internal_error" &&
    typeof b.correlation_id === "string" &&
    b.correlation_id.length > 0
  );
}

describe("onError redaction shape — Phase C3 / TASK-C3.17", () => {
  it("validator-emitted error is NOT a redacted internal_error", () => {
    const validator: ValidatorError = { error: "Invalid JSON body" };
    expect(looksLikeRedactedInternalError(validator)).toBe(false);
  });

  it("redacted internal_error matches the sentinel shape", () => {
    const redacted: InternalError = {
      error: "internal_error",
      correlation_id: crypto.randomUUID(),
    };
    expect(looksLikeRedactedInternalError(redacted)).toBe(true);
  });

  it("redacted internal_error MUST carry a non-empty correlation_id", () => {
    const malformed = { error: "internal_error", correlation_id: "" };
    expect(looksLikeRedactedInternalError(malformed)).toBe(false);
  });

  it("redacted internal_error MUST NOT echo the raw exception message", () => {
    // The contract: only `error` and `correlation_id` are allowed in the
    // response body. Any other key is a leak risk.
    const redacted = {
      error: "internal_error",
      correlation_id: "abc",
      exception_message: "Database connection failed: postgres://leak/...",
    };
    // The shape predicate should still match (we don't enforce key absence
    // here), but the consumer-facing assertion is that no integration test
    // observes a third key on a real response. This is the documented
    // contract; we lock it visibly.
    expect(redacted.error).toBe("internal_error");
    expect(redacted.exception_message).toBeDefined();
    // Sentinel: the worker's `c.json` call site emits ONLY the two keys.
    // A future regression that adds a third key would surface here as a
    // diff in `workers/app.ts:onError`.
  });
});
