// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-1 / Task 4 — per-email rate-limit middleware.
//
// Complements better-auth's per-IP rate-limit (workers/auth/index.ts
// `rateLimit.customRules`) by also keying on the submitted email so that a
// single attacker rotating IPs cannot enumerate addresses faster than the
// per-IP cap allows.  Mounted in front of high-value auth endpoints:
//
//   POST /api/auth/email-otp/send-verification-otp     (5 / 15 min / email)
//   POST /api/auth/sign-in/email-otp                   (5 / 15 min / email)
//
// Storage: the same `rate_limit` D1 table better-auth uses, with a
// dedicated key namespace (`email:<sha256(lower(email))>:<path>`) so the
// per-email rows never collide with the per-IP rows the better-auth
// runtime owns.  We hash the email so the table never carries plaintext
// addresses (defence-in-depth — D1 dumps shouldn't expose enumeration
// targets).  Reads/writes go through drizzle on the per-request `env.DB`
// connection — no extra binding required.
//
// On exceed: returns a 429 with the same JSON shape better-auth emits, so
// client code already wired for better-auth's 429 handles both layers
// transparently.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/** Rate-limit window — 15 minutes in seconds. */
const WINDOW_SECONDS = 60 * 15;

/** Max requests per window per (email, path) pair. */
const MAX_PER_WINDOW = 5;

/** SHA-256 hex of the lower-cased trimmed email. */
async function hashEmail(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Best-effort email extraction from the request body.  We clone the body
 * (Hono's c.req.json() reads-and-discards on older runtimes — we re-stuff
 * it via Request reconstruction in the middleware below).  Returns null
 * when the body has no parseable email; callers fall through to better-auth
 * (which will reject with 400 BAD_REQUEST anyway).
 */
async function readEmailFromJson(
  raw: Request,
): Promise<{ email: string | null; replay: Request }> {
  let bodyText = "";
  try {
    bodyText = await raw.clone().text();
  } catch {
    return { email: null, replay: raw };
  }
  let email: string | null = null;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof parsed["email"] === "string") email = parsed["email"];
    } catch {
      // Fall through to null — body wasn't JSON.
    }
  }
  return { email, replay: raw };
}

/** Build a 429-style response shape consistent with better-auth. */
function tooManyRequestsResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests for this email — try again later.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

/**
 * authRateLimitByEmail — Hono middleware that gates auth requests on
 * (email, path) using the shared `rate_limit` D1 table.  Failures fall open
 * (next()) so a transient DB blip never makes login impossible — the
 * better-auth per-IP rule still applies.  The chokepoint is logged via
 * `console.warn` for observability.
 */
export function authRateLimitByEmail(): MiddlewareHandler<{
  Bindings: Env;
}> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const { email, replay } = await readEmailFromJson(c.req.raw);
    if (replay !== c.req.raw) {
      // Currently a no-op (clone() preserves the original body) but kept
      // explicit so a future runtime change cannot silently lose the body.
    }
    if (!email) {
      // No email in body — let better-auth reject with its own 400.
      return next();
    }
    const emailHash = await hashEmail(email);
    const key = `email:${emailHash}:${path}`;
    const now = Date.now();
    const windowStart = now - WINDOW_SECONDS * 1000;

    const db = c.env.DB;
    try {
      const existing = await db
        .prepare("SELECT count, last_request FROM rate_limit WHERE key = ?1")
        .bind(key)
        .first<{ count: number; last_request: number }>();

      let count: number;
      if (!existing || existing.last_request < windowStart) {
        // No row OR window expired — start fresh.
        count = 1;
        await db
          .prepare(
            "INSERT INTO rate_limit (id, key, count, last_request) VALUES (?1, ?2, 1, ?3) " +
              "ON CONFLICT(key) DO UPDATE SET count = 1, last_request = ?3",
          )
          .bind(crypto.randomUUID(), key, now)
          .run();
      } else {
        count = existing.count + 1;
        await db
          .prepare(
            "UPDATE rate_limit SET count = ?1, last_request = ?2 WHERE key = ?3",
          )
          .bind(count, now, key)
          .run();
      }

      if (count > MAX_PER_WINDOW) {
        const retryAfter = Math.max(
          1,
          Math.ceil(
            (existing!.last_request + WINDOW_SECONDS * 1000 - now) / 1000,
          ),
        );
        return tooManyRequestsResponse(retryAfter);
      }
    } catch (err) {
      // Fail open on DB error — the better-auth per-IP rule is still in
      // play.  Surface for observability.
      console.warn(
        "auth-rate-limit: D1 read/write failed; falling open",
        (err as Error).message,
      );
    }

    return next();
  };
}
