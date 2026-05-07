// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-2 — standalone security-headers middleware (Free-plan scope).
//
// Applies non-CSP security headers globally. The nonce-based CSP lives in
// workers/lib/csp.ts (Phase E / TASK-E.1) and now bakes the Turnstile
// allowlist directly into `buildCspDirectives` — so this middleware
// intentionally does NOT touch Content-Security-Policy.
//
// Phase G T3.5 cutover (2026-05-07) — the prior version of this file
// overwrote the Phase E nonce-stamped CSP with a static `script-src
// 'self' https://challenges.cloudflare.com` policy. Browsers then
// blocked every nonce-attributed inline script (React Router boot,
// theme-detection, hydration manifest), the React app failed to
// hydrate, and the Turnstile widget never mounted on the production
// /login page. The CSP responsibility now lives entirely in
// workers/lib/csp.ts; this middleware sets only the auxiliary headers.
//
// Free-plan scope: no Pro/Business features. All headers are set at the
// application layer via Hono.

import type { MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// Header values
// ---------------------------------------------------------------------------

/** 2-year HSTS.  `preload` opts into the browser preload list once submitted. */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * securityHeadersMiddleware — set non-CSP security headers on every response.
 *
 * Headers applied:
 *   Strict-Transport-Security       — 2-year HSTS with preload
 *   X-Frame-Options                 — DENY
 *   X-Content-Type-Options          — nosniff
 *   Referrer-Policy                 — strict-origin-when-cross-origin
 *
 * Content-Security-Policy is intentionally NOT set here — see workers/lib/csp.ts
 * `buildCspDirectives` for the canonical nonce-based CSP that includes
 * Turnstile allowlists.
 *
 * The middleware DOES NOT skip API paths. The headers are universally
 * applicable.
 *
 * Usage (workers/app.ts):
 *
 *   import { securityHeadersMiddleware } from "./middleware/security-headers";
 *   app.use("*", securityHeadersMiddleware());
 */
export function securityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    c.res.headers.set("Strict-Transport-Security", HSTS_VALUE);
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  };
}
