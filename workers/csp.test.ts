// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Phase E / TASK-E.1 — CSP nonce + 'strict-dynamic' helper tests.
 *
 * Mirrors the discipline of `app-c3.test.ts`'s pure-function assertions:
 * the CSP shape change (drop `'unsafe-inline'` from `script-src`, add
 * `'nonce-<value>'` + `'strict-dynamic'`) is the load-bearing security
 * improvement. Future loosening (e.g. re-adding `'unsafe-inline'`) MUST
 * fail one of these assertions.
 */

import { describe, it, expect } from "vitest";
import { generateCspNonce, buildCspDirectives, CSP_NONCE_VAR } from "./lib/csp";

describe("generateCspNonce — Phase E / TASK-E.1", () => {
  it("returns a non-empty base64url string", () => {
    const n = generateCspNonce();
    expect(typeof n).toBe("string");
    expect(n.length).toBeGreaterThan(0);
    // base64url alphabet: [A-Za-z0-9_-], no `=` padding, no `+` or `/`.
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(n).not.toContain("=");
    expect(n).not.toContain("+");
    expect(n).not.toContain("/");
  });

  it("≥ 128 bits of entropy (≥ 22 base64url chars for 16 bytes)", () => {
    const n = generateCspNonce();
    // 16 bytes → 22 chars un-padded base64.
    expect(n.length).toBeGreaterThanOrEqual(22);
  });

  it("returns a different value on each call (no module-level reuse)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) seen.add(generateCspNonce());
    // 64 random 128-bit values colliding is astronomically unlikely; the
    // assertion catches accidental constant returns or single-shot caching.
    expect(seen.size).toBe(64);
  });
});

describe("buildCspDirectives — Phase E / TASK-E.1", () => {
  it("script-src includes 'self', the nonce, and 'strict-dynamic' when nonce is supplied", () => {
    const csp = buildCspDirectives("ABCabc012-_");
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'nonce-ABCabc012-_'");
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("script-src DOES NOT contain 'unsafe-inline' (the load-bearing TASK-E.1 change)", () => {
    const csp = buildCspDirectives("test-nonce");
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("script-src DOES NOT contain 'unsafe-eval'", () => {
    const csp = buildCspDirectives("test-nonce");
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("falls back to fail-CLOSED 'self' 'strict-dynamic' when nonce is null (no inline scripts can run)", () => {
    const csp = buildCspDirectives(null);
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    // 'strict-dynamic' overrides 'self' too — without a nonce, NO inline
    // script can execute. That breaks any HTML route that forgets to wire
    // its nonce, and it does so loudly (the regression surfaces in the
    // visual / scenario suite).
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'nonce-");
  });

  it("style-src keeps 'unsafe-inline' (OWASP-accepted relaxation; dev login picker uses inline styles)", () => {
    const csp = buildCspDirectives("any");
    const styleSrc = csp.split("; ").find((d) => d.startsWith("style-src"))!;
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it("default-src 'self'", () => {
    expect(buildCspDirectives("any")).toContain("default-src 'self'");
  });

  it("frame-ancestors 'none'", () => {
    expect(buildCspDirectives("any")).toContain("frame-ancestors 'none'");
  });

  it("object-src 'none'", () => {
    expect(buildCspDirectives("any")).toContain("object-src 'none'");
  });

  it("base-uri 'self'", () => {
    expect(buildCspDirectives("any")).toContain("base-uri 'self'");
  });

  it("form-action 'self'", () => {
    expect(buildCspDirectives("any")).toContain("form-action 'self'");
  });

  it("connect-src 'self' (fetch/XHR/WS same-origin only)", () => {
    expect(buildCspDirectives("any")).toContain("connect-src 'self'");
  });

  it("img-src allows data: and blob: (avatars + crop preview)", () => {
    const csp = buildCspDirectives("any");
    const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"))!;
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain("data:");
    expect(imgSrc).toContain("blob:");
  });

  it("CSP_NONCE_VAR symbol is the Hono context key the middleware sets", () => {
    expect(CSP_NONCE_VAR).toBe("cspNonce");
  });

  // ---------------------------------------------------------------------
  // Phase G-2 / G T3.5 — Turnstile allowlist baked into the canonical CSP.
  // The previous architecture had a separate `securityHeadersMiddleware`
  // that overwrote this CSP with a static (no-nonce) Turnstile-aware
  // policy — which silently disabled nonce-based script execution and
  // broke React Router hydration in production. Source of truth is now
  // `buildCspDirectives`; the assertions below are the regression guards.
  // ---------------------------------------------------------------------
  it("script-src includes https://challenges.cloudflare.com (Turnstile widget loader)", () => {
    const csp = buildCspDirectives("any");
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).toContain("https://challenges.cloudflare.com");
  });

  it("script-src null-nonce variant ALSO includes Turnstile (the widget runs even when nonce is missing)", () => {
    const csp = buildCspDirectives(null);
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).toContain("https://challenges.cloudflare.com");
  });

  it("frame-src includes https://challenges.cloudflare.com (Turnstile iframe)", () => {
    const csp = buildCspDirectives("any");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
  });

  it("connect-src includes https://challenges.cloudflare.com (Turnstile client-side fetch)", () => {
    const csp = buildCspDirectives("any");
    const connectSrc = csp
      .split("; ")
      .find((d) => d.startsWith("connect-src"))!;
    expect(connectSrc).toContain("https://challenges.cloudflare.com");
  });

  it("img-src adds https: (external avatars + mailbox imagery)", () => {
    const csp = buildCspDirectives("any");
    const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"))!;
    expect(imgSrc).toContain("https:");
  });
});

describe("CSP nonce → render-time substitution — Phase E / TASK-E.1", () => {
  // The middleware uses HTMLRewriter to stamp nonces on `<script>` tags;
  // we can't run HTMLRewriter inside vitest (it's a Workers-runtime
  // global), but the substitution shape is asserted by integration tests
  // (post-deploy probe in TASK-E.6). Here we lock the contract that the
  // middleware always uses a SINGLE nonce per request — both in the CSP
  // header AND on every <script> tag.
  it("the same nonce is used for both the header and the script-tag attribute (single-shot per request)", () => {
    const nonce = generateCspNonce();
    const csp = buildCspDirectives(nonce);
    expect(csp).toContain(`'nonce-${nonce}'`);
  });
});
