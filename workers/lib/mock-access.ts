// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/**
 * Loose JWT claim shape — the union of what production Access JWTs and the
 * dev mock JWT may carry. `sub` is the only field always present; everything
 * else is optional because the discriminator path in (Phase 2) authzContext
 * branches on `sub === ""` vs `email` presence anyway.
 */
export type JwtClaims = {
  /** Empty for service tokens; UUID-shaped for humans. */
  sub: string;
  email?: string;
  common_name?: string;
  type?: string;
  iss?: string;
};

/** Strict shape the mock shim writes — narrows JwtClaims for dev. */
export type MockAccessClaims = JwtClaims & {
  email: string;
  type: "app";
  iss: "mock-access";
};

/**
 * Synthesizes a JWT-shaped claim object in dev when CF_ACCESS_DEV_MODE='mock'.
 * Stored on c.var.jwt for the (Phase 2) authzContext middleware to consume.
 *
 * Uses a deterministic uuid derived from the email address so multiple
 * requests from the same mock user produce a stable `sub` — important for
 * the BOOTSTRAP_OWNER_EMAIL first-login-promotion flow in Phase 2.
 */
export function mockAccessShim(): MiddlewareHandler<{
  Bindings: Env;
  Variables: { jwt?: JwtClaims };
}> {
  return async (c, next) => {
    const email =
      c.req.header("x-mock-user-email") ??
      c.env.BOOTSTRAP_DEV_EMAIL ??
      c.env.BOOTSTRAP_OWNER_EMAIL;

    if (!email) {
      return c.text(
        "Mock-Access shim requires X-Mock-User-Email header or BOOTSTRAP_DEV_EMAIL env var",
        500,
      );
    }

    c.set("jwt", {
      sub: deterministicUuid(email),
      email,
      type: "app",
      iss: "mock-access",
    });
    return next();
  };
}

/** Stable, deterministic v5-shaped UUID derived from email — pure function. */
function deterministicUuid(email: string): string {
  // FNV-1a-ish 32-bit hash → render as 8-4-4-4-12 UUID. Deterministic across
  // restarts, which is what Phase 2's BOOTSTRAP_OWNER_EMAIL flow expects.
  let h = 0x811c9dc5;
  for (let i = 0; i < email.length; i++) {
    h = Math.imul(h ^ email.charCodeAt(i), 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `${hex}-mock-4dev-8ock-${hex}${"0".repeat(4)}`;
}
