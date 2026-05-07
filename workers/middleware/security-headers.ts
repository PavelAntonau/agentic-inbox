// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-2 — standalone security-headers middleware (Free-plan scope).
//
// This module exports a self-contained Hono middleware that applies a
// standard security-header baseline on every response.  It is intentionally
// decoupled from the nonce-based CSP already present in workers/app.ts
// (Phase E / TASK-E.1).  The two middleware instances compose cleanly:
//
//   Phase E CSP  — HTML-only, nonce-stamped, HTMLRewriter-based, complex.
//   This file     — global, simple header set, Turnstile-aware.
//
// The headers defined here supersede or complement Phase E's on HTML
// responses; on API responses they are the only headers applied.
//
// IMPORTANT — integrator note (do NOT modify workers/app.ts yourself;
// Teammate A owns that file):
//
//   Mount this middleware BEFORE route handlers, AFTER the Phase E CSP
//   middleware (or independently — it is idempotent).  Recommended placement
//   in workers/app.ts, after the existing `app.use("*", ...)` CSP block:
//
//     import { securityHeadersMiddleware } from "./middleware/security-headers";
//     app.use("*", securityHeadersMiddleware());
//
// CSP note: the Content-Security-Policy emitted here is the Phase G-2
// "Turnstile-aware" variant that adds `https://challenges.cloudflare.com`
// to the allowlists for script-src, frame-src, and connect-src.  On HTML
// responses the Phase E HTMLRewriter will overwrite the CSP header with its
// nonce-stamped version; this file's CSP therefore applies on API and non-HTML
// responses where Phase E is a no-op.  That is the correct behaviour — API
// responses don't need nonces, and HTML responses get the stronger nonce form.
//
// Free-plan scope: no Pro/Business features.  All headers are set at the
// application layer via Hono; nothing depends on the Cloudflare dashboard or
// zone-level rulesets.

import type { MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// Header values
// ---------------------------------------------------------------------------

/**
 * Content-Security-Policy for Turnstile-aware responses.
 *
 * Additions over the Phase E baseline:
 *   • `script-src` — allow Turnstile widget loader from challenges.cloudflare.com
 *   • `frame-src`  — allow the Turnstile iframe
 *   • `connect-src` — allow the Turnstile verify fetch from the client side
 *   • `img-src` — adds https: for externally-hosted images (avatars etc.)
 *
 * `'unsafe-inline'` is intentionally kept in `style-src` (OWASP-accepted
 * relaxation; Tailwind + inline style declarations).
 * `'unsafe-inline'` is intentionally ABSENT from `script-src` — the
 * Phase E nonce or Turnstile's own `strict-dynamic` chain handles that.
 */
export const CSP_TURNSTILE =
  "default-src 'self'; " +
  "script-src 'self' https://challenges.cloudflare.com; " +
  "frame-src https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self' https://challenges.cloudflare.com; " +
  "font-src 'self'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'";

/** 2-year HSTS.  `preload` opts into the browser preload list once submitted. */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * securityHeadersMiddleware — set standard security headers on every response.
 *
 * Headers applied:
 *   Content-Security-Policy         — Turnstile-aware allowlist (see CSP_TURNSTILE)
 *   Strict-Transport-Security       — 2-year HSTS with preload
 *   X-Frame-Options                 — DENY
 *   X-Content-Type-Options          — nosniff
 *   Referrer-Policy                 — strict-origin-when-cross-origin
 *
 * The middleware DOES NOT skip API paths.  On API responses the CSP is still
 * a useful defence-in-depth (browsers honour it on pre-rendered responses),
 * and the other headers are universally applicable.
 *
 * The Phase E HTMLRewriter will overwrite Content-Security-Policy on HTML
 * responses with its nonce-stamped form, which is strictly stronger.  On API
 * responses the header set here is the final value.
 *
 * Usage (workers/app.ts):
 *
 *   import { securityHeadersMiddleware } from "./middleware/security-headers";
 *   app.use("*", securityHeadersMiddleware());
 */
export function securityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    c.res.headers.set("Content-Security-Policy", CSP_TURNSTILE);
    c.res.headers.set("Strict-Transport-Security", HSTS_VALUE);
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  };
}
