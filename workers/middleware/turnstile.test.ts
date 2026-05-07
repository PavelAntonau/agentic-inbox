// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-2 — unit tests for the Turnstile server-side verification middleware.
//
// All outbound fetch calls are mocked via vitest's `vi.spyOn(globalThis, "fetch")`.
// No real network calls are made.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { requireTurnstile, isChallengeRecent } from "./turnstile";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake Env with the secret set. */
function makeEnv(secret = "test-secret"): Record<string, unknown> {
  return { TURNSTILE_SECRET_KEY: secret };
}

/** ISO timestamp `offsetMs` milliseconds in the past. */
function tsAgo(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

/** Build a siteverify success response payload. */
function successPayload(challenge_ts: string = tsAgo(0)): object {
  return { success: true, challenge_ts, hostname: "localhost" };
}

/** Build a siteverify failure response payload. */
function failurePayload(codes: string[] = ["invalid-input-response"]): object {
  return { success: false, error_codes: codes };
}

/** Stub globalThis.fetch to return a JSON body with a given HTTP status. */
function mockFetch(body: object, status = 200): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/**
 * Build a minimal Hono app with the turnstile middleware protecting a POST
 * route that returns 200 when reached.
 */
function buildApp(secret = "test-secret") {
  const app = new Hono<{
    Bindings: { TURNSTILE_SECRET_KEY: string };
  }>();

  // Inject fake env
  app.use("*", async (c, next) => {
    // @ts-expect-error — test-only env injection
    c.env = makeEnv(secret);
    await next();
  });

  app.post(
    "/api/auth/email-otp/send-verification-otp",
    requireTurnstile(),
    (c) => c.json({ ok: true }),
  );

  return app;
}

/** POST to the OTP endpoint with a JSON body including the turnstile token. */
async function postOtp(
  app: ReturnType<typeof buildApp>,
  token: string | null,
  bodyExtra?: Record<string, unknown>,
): Promise<Response> {
  const body = token
    ? { email: "test@example.com", cf_turnstile_response: token, ...bodyExtra }
    : { email: "test@example.com", ...bodyExtra };
  return app.request("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// isChallengeRecent — pure function tests
// ---------------------------------------------------------------------------

describe("isChallengeRecent — Phase G-2", () => {
  it("returns true for a timestamp just issued (< 5 min)", () => {
    expect(isChallengeRecent(tsAgo(0))).toBe(true);
    expect(isChallengeRecent(tsAgo(1000))).toBe(true); // 1 s ago
    expect(isChallengeRecent(tsAgo(4 * 60 * 1000 + 59_000))).toBe(true); // 4 min 59 s
  });

  it("returns false for a timestamp exactly 5 minutes old", () => {
    // 5 min + 1 ms over budget
    expect(isChallengeRecent(tsAgo(5 * 60 * 1000 + 1))).toBe(false);
  });

  it("returns false for a timestamp 10 minutes old", () => {
    expect(isChallengeRecent(tsAgo(10 * 60 * 1000))).toBe(false);
  });

  it("returns false for an invalid / empty timestamp string", () => {
    expect(isChallengeRecent("")).toBe(false);
    expect(isChallengeRecent("not-a-date")).toBe(false);
  });

  it("accepts a custom nowMs parameter (testability)", () => {
    const fixedNow = 1_000_000_000_000;
    const recent = new Date(fixedNow - 1000).toISOString(); // 1 s ago
    const stale = new Date(fixedNow - 6 * 60 * 1000).toISOString(); // 6 min ago
    expect(isChallengeRecent(recent, fixedNow)).toBe(true);
    expect(isChallengeRecent(stale, fixedNow)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireTurnstile middleware — integration tests
// ---------------------------------------------------------------------------

describe("requireTurnstile middleware — Phase G-2", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── success path ──────────────────────────────────────────────────────────

  it("passes through to the route handler on a valid token with a recent challenge", async () => {
    const app = buildApp();
    mockFetch(successPayload(tsAgo(30_000))); // 30 s ago — well within window

    const res = await postOtp(app, "valid-token");
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  // ── expired challenge ──────────────────────────────────────────────────────

  it("returns 403 TURNSTILE_FAILED when challenge_ts is older than 5 minutes", async () => {
    const app = buildApp();
    // challenge_ts = 6 minutes ago — over the 5-min window
    mockFetch(successPayload(tsAgo(6 * 60 * 1000)));

    const res = await postOtp(app, "old-token");
    expect(res.status).toBe(403);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("TURNSTILE_FAILED");
  });

  // ── siteverify reports failure ─────────────────────────────────────────────

  it("returns 403 TURNSTILE_FAILED when siteverify returns success=false", async () => {
    const app = buildApp();
    mockFetch(failurePayload(["invalid-input-response"]));

    const res = await postOtp(app, "bad-token");
    expect(res.status).toBe(403);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("TURNSTILE_FAILED");
  });

  // ── hostname mismatch reported as failure ─────────────────────────────────

  it("returns 403 TURNSTILE_FAILED when siteverify returns success=false for hostname mismatch", async () => {
    const app = buildApp();
    mockFetch({
      success: false,
      error_codes: ["hostname-mismatch"],
    });

    const res = await postOtp(app, "wrong-host-token");
    expect(res.status).toBe(403);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("TURNSTILE_FAILED");
  });

  // ── missing token ──────────────────────────────────────────────────────────

  it("returns 403 TURNSTILE_FAILED when no token is present in the request", async () => {
    const app = buildApp();
    const spy = vi.spyOn(globalThis, "fetch");

    const res = await postOtp(app, null);
    expect(res.status).toBe(403);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("TURNSTILE_FAILED");
    // fetch should NOT have been called — we rejected before any network call
    expect(spy).not.toHaveBeenCalled();
  });

  // ── token via X-Turnstile-Token header ────────────────────────────────────

  it("reads the token from X-Turnstile-Token header when body has no token", async () => {
    const app = buildApp();
    mockFetch(successPayload(tsAgo(1000)));

    const res = await app.request("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Turnstile-Token": "header-token",
      },
      body: JSON.stringify({ email: "test@example.com" }),
    });
    expect(res.status).toBe(200);
  });

  // ── network error → retry → eventual success ──────────────────────────────

  it("retries on network error (TypeError) and succeeds on third attempt", async () => {
    const app = buildApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // First two calls throw network errors; third succeeds
    fetchSpy
      .mockRejectedValueOnce(new TypeError("network failure 1"))
      .mockRejectedValueOnce(new TypeError("network failure 2"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(successPayload(tsAgo(1000))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const res = await postOtp(app, "retry-token");
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // ── exhausted retries ──────────────────────────────────────────────────────

  it("returns 403 TURNSTILE_FAILED when all retries are exhausted", async () => {
    const app = buildApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Three calls all fail with network error (attempt 0 + 2 retries)
    fetchSpy
      .mockRejectedValueOnce(new TypeError("network failure"))
      .mockRejectedValueOnce(new TypeError("network failure"))
      .mockRejectedValueOnce(new TypeError("network failure"));

    const res = await postOtp(app, "exhausted-token");
    expect(res.status).toBe(403);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("TURNSTILE_FAILED");
    // All three attempts fired
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // ── 5xx from siteverify → retry ───────────────────────────────────────────

  it("retries on 5xx from siteverify and succeeds on retry", async () => {
    const app = buildApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(new Response("upstream error", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(successPayload(tsAgo(1000))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const res = await postOtp(app, "retry-5xx-token");
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ── missing secret ─────────────────────────────────────────────────────────

  it("returns 403 TURNSTILE_FAILED when TURNSTILE_SECRET_KEY is not configured", async () => {
    const app = buildApp(""); // empty secret → fail closed
    const spy = vi.spyOn(globalThis, "fetch");

    const res = await postOtp(app, "any-token");
    expect(res.status).toBe(403);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("TURNSTILE_FAILED");
    expect(spy).not.toHaveBeenCalled();
  });

  // ── response shape is consistent on all 403 branches ─────────────────────

  it("all 403 branches return the same { code: TURNSTILE_FAILED } shape (constant timing)", async () => {
    const app = buildApp();

    // Branch A — missing token
    const resA = await postOtp(app, null);
    expect(resA.status).toBe(403);
    expect(await resA.json()).toEqual({ code: "TURNSTILE_FAILED" });

    // Branch B — siteverify failure
    mockFetch(failurePayload());
    const resB = await postOtp(app, "bad");
    expect(resB.status).toBe(403);
    expect(await resB.json()).toEqual({ code: "TURNSTILE_FAILED" });

    // Branch C — expired challenge
    mockFetch(successPayload(tsAgo(10 * 60 * 1000)));
    const resC = await postOtp(app, "stale");
    expect(resC.status).toBe(403);
    expect(await resC.json()).toEqual({ code: "TURNSTILE_FAILED" });
  });
});
