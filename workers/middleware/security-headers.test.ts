// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-2 — unit tests for the standalone security-headers middleware.
//
// Phase G T3.5 cutover (2026-05-07): CSP responsibility moved fully into
// workers/lib/csp.ts (`buildCspDirectives`). This middleware now sets
// only the auxiliary headers (HSTS, X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy). CSP coverage lives in workers/csp.test.ts.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeadersMiddleware, HSTS_VALUE } from "./security-headers";

// ---------------------------------------------------------------------------
// Test app helper
// ---------------------------------------------------------------------------

function buildApp() {
  const app = new Hono();
  app.use("*", securityHeadersMiddleware());
  app.get("/", (c) => c.text("hello"));
  app.get("/api/data", (c) => c.json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// Header value constants — correctness assertions
// ---------------------------------------------------------------------------

describe("HSTS_VALUE constant — Phase G-2", () => {
  it("has max-age of 63072000 (2 years)", () => {
    expect(HSTS_VALUE).toContain("max-age=63072000");
  });

  it("includes includeSubDomains", () => {
    expect(HSTS_VALUE).toContain("includeSubDomains");
  });

  it("includes preload", () => {
    expect(HSTS_VALUE).toContain("preload");
  });
});

// ---------------------------------------------------------------------------
// Middleware on responses — header presence
// ---------------------------------------------------------------------------

describe("securityHeadersMiddleware — response headers — Phase G-2", () => {
  it("does NOT set Content-Security-Policy (now owned by workers/lib/csp.ts)", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("sets Strict-Transport-Security with correct value", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.headers.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
  });

  it("sets X-Frame-Options: DENY", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets Referrer-Policy: strict-origin-when-cross-origin", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("all four auxiliary headers are present on every response", async () => {
    const app = buildApp();
    for (const path of ["/", "/api/data"]) {
      const res = await app.request(path);
      expect(
        res.headers.get("Strict-Transport-Security"),
        `HSTS missing on ${path}`,
      ).not.toBeNull();
      expect(
        res.headers.get("X-Frame-Options"),
        `X-Frame-Options missing on ${path}`,
      ).not.toBeNull();
      expect(
        res.headers.get("X-Content-Type-Options"),
        `X-Content-Type-Options missing on ${path}`,
      ).not.toBeNull();
      expect(
        res.headers.get("Referrer-Policy"),
        `Referrer-Policy missing on ${path}`,
      ).not.toBeNull();
    }
  });

  it("does not block the route handler from returning its own body", async () => {
    const app = buildApp();
    const res = await app.request("/api/data");
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });
});
