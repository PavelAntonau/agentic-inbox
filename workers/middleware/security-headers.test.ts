// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-2 — unit tests for the standalone security-headers middleware.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  securityHeadersMiddleware,
  CSP_TURNSTILE,
  HSTS_VALUE,
} from "./security-headers";

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

describe("CSP_TURNSTILE constant — Phase G-2", () => {
  it("starts with default-src 'self'", () => {
    expect(CSP_TURNSTILE).toMatch(/^default-src 'self'/);
  });

  it("allows Cloudflare Turnstile origin in script-src", () => {
    const scriptSrc = CSP_TURNSTILE.split("; ").find((d) =>
      d.startsWith("script-src"),
    )!;
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("https://challenges.cloudflare.com");
  });

  it("allows Cloudflare Turnstile iframe in frame-src", () => {
    const frameSrc = CSP_TURNSTILE.split("; ").find((d) =>
      d.startsWith("frame-src"),
    )!;
    expect(frameSrc).toContain("https://challenges.cloudflare.com");
  });

  it("allows Cloudflare Turnstile verify in connect-src", () => {
    const connectSrc = CSP_TURNSTILE.split("; ").find((d) =>
      d.startsWith("connect-src"),
    )!;
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain("https://challenges.cloudflare.com");
  });

  it("style-src keeps 'unsafe-inline' (OWASP-accepted for Tailwind)", () => {
    const styleSrc = CSP_TURNSTILE.split("; ").find((d) =>
      d.startsWith("style-src"),
    )!;
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it("script-src does NOT contain 'unsafe-inline'", () => {
    const scriptSrc = CSP_TURNSTILE.split("; ").find((d) =>
      d.startsWith("script-src"),
    )!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("img-src allows 'self', data:, and https:", () => {
    const imgSrc = CSP_TURNSTILE.split("; ").find((d) =>
      d.startsWith("img-src"),
    )!;
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain("data:");
    expect(imgSrc).toContain("https:");
  });

  it("font-src 'self'", () => {
    expect(CSP_TURNSTILE).toContain("font-src 'self'");
  });

  it("base-uri 'self'", () => {
    expect(CSP_TURNSTILE).toContain("base-uri 'self'");
  });

  it("form-action 'self'", () => {
    expect(CSP_TURNSTILE).toContain("form-action 'self'");
  });

  it("frame-ancestors 'none'", () => {
    expect(CSP_TURNSTILE).toContain("frame-ancestors 'none'");
  });

  it("is string-equal to the exact specified value", () => {
    expect(CSP_TURNSTILE).toBe(
      "default-src 'self'; " +
        "script-src 'self' https://challenges.cloudflare.com; " +
        "frame-src https://challenges.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self' https://challenges.cloudflare.com; " +
        "font-src 'self'; " +
        "base-uri 'self'; " +
        "form-action 'self'; " +
        "frame-ancestors 'none'",
    );
  });
});

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
  it("sets Content-Security-Policy on HTML responses", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP_TURNSTILE);
  });

  it("sets Content-Security-Policy on JSON/API responses", async () => {
    const app = buildApp();
    const res = await app.request("/api/data");
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP_TURNSTILE);
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

  it("all five headers are present on every response", async () => {
    const app = buildApp();
    for (const path of ["/", "/api/data"]) {
      const res = await app.request(path);
      expect(
        res.headers.get("Content-Security-Policy"),
        `CSP missing on ${path}`,
      ).not.toBeNull();
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
