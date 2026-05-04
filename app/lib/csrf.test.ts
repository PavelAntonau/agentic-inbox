// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.1 (mcp-oauth) — csrf.ts unit tests.
//
// Coverage:
//   - issue/verify roundtrip (happy path)
//   - cookie shape: __Host- prefix, attributes
//   - rejection: expired, forged sig, wrong user, wrong secret
//   - synchronizer-token check: cookie != form
//   - burnCsrfCookie shape
//   - readCsrfCookie parser

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  burnCsrfCookie,
  CSRF_COOKIE_NAME,
  issueCsrfToken,
  readCsrfCookie,
  verifyCsrfFromRequest,
  verifyCsrfToken,
} from "./csrf";

const SECRET = "test-secret-do-not-ship-in-prod-32-bytes";
const USER_A = "user-aaa";
const USER_B = "user-bbb";

describe("issueCsrfToken", () => {
  it("returns a token, a Set-Cookie value, and an exp", async () => {
    const issue = await issueCsrfToken(SECRET, USER_A);
    expect(issue.token.split(".")).toHaveLength(3);
    expect(issue.cookie).toContain(`${CSRF_COOKIE_NAME}=${issue.token}`);
    expect(typeof issue.exp).toBe("number");
    expect(issue.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("emits all __Host- prefix invariants in the cookie", async () => {
    const { cookie } = await issueCsrfToken(SECRET, USER_A);
    expect(cookie.startsWith(`${CSRF_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toMatch(/;\s*Path=\/(?:;|$)/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toMatch(/Max-Age=\d+/);
    // No Domain attribute — __Host- forbids it.
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("issues unique tokens across calls (nonce entropy)", async () => {
    const a = await issueCsrfToken(SECRET, USER_A);
    const b = await issueCsrfToken(SECRET, USER_A);
    expect(a.token).not.toBe(b.token);
  });

  it("rejects empty secret or userId", async () => {
    await expect(issueCsrfToken("", USER_A)).rejects.toThrow(/secret/);
    await expect(issueCsrfToken(SECRET, "")).rejects.toThrow(/userId/);
  });

  it("rejects non-positive ttl", async () => {
    await expect(issueCsrfToken(SECRET, USER_A, { ttlSec: 0 })).rejects.toThrow(
      /ttlSec/,
    );
    await expect(
      issueCsrfToken(SECRET, USER_A, { ttlSec: -1 }),
    ).rejects.toThrow(/ttlSec/);
  });

  it("encodes ttl in Max-Age and exp", async () => {
    const fixedNow = 1_700_000_000;
    const issue = await issueCsrfToken(SECRET, USER_A, {
      ttlSec: 300,
      nowSec: () => fixedNow,
    });
    expect(issue.exp).toBe(fixedNow + 300);
    expect(issue.cookie).toContain("Max-Age=300");
  });
});

describe("verifyCsrfToken", () => {
  it("accepts a freshly-issued token bound to the same user", async () => {
    const { token } = await issueCsrfToken(SECRET, USER_A);
    expect(await verifyCsrfToken(token, SECRET, USER_A)).toBe(true);
  });

  it("rejects a token bound to a different user", async () => {
    const { token } = await issueCsrfToken(SECRET, USER_A);
    expect(await verifyCsrfToken(token, SECRET, USER_B)).toBe(false);
  });

  it("rejects a token verified under a different secret", async () => {
    const { token } = await issueCsrfToken(SECRET, USER_A);
    expect(await verifyCsrfToken(token, "different-secret", USER_A)).toBe(
      false,
    );
  });

  it("rejects an expired token", async () => {
    let now = 1_700_000_000;
    const { token } = await issueCsrfToken(SECRET, USER_A, {
      ttlSec: 60,
      nowSec: () => now,
    });
    now += 120; // 2 minutes later — past the 60-second TTL.
    expect(
      await verifyCsrfToken(token, SECRET, USER_A, { nowSec: () => now }),
    ).toBe(false);
  });

  it("rejects a token whose sig has been tampered", async () => {
    const { token } = await issueCsrfToken(SECRET, USER_A);
    // Flip the last char of the signature segment.
    const parts = token.split(".");
    const lastChar = parts[2].slice(-1);
    const flipped = lastChar === "A" ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${flipped}`;
    expect(await verifyCsrfToken(tampered, SECRET, USER_A)).toBe(false);
  });

  it("rejects a token whose exp has been tampered (HMAC binds it)", async () => {
    const { token } = await issueCsrfToken(SECRET, USER_A);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${Number(parts[1]) + 999_999}.${parts[2]}`;
    expect(await verifyCsrfToken(tampered, SECRET, USER_A)).toBe(false);
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyCsrfToken("", SECRET, USER_A)).toBe(false);
    expect(
      await verifyCsrfToken("not.a.token.too.many.parts", SECRET, USER_A),
    ).toBe(false);
    expect(await verifyCsrfToken("only.two", SECRET, USER_A)).toBe(false);
    expect(await verifyCsrfToken("nonce.notnum.sig", SECRET, USER_A)).toBe(
      false,
    );
  });
});

describe("readCsrfCookie", () => {
  it("returns null on missing or empty header", () => {
    expect(readCsrfCookie(null)).toBeNull();
    expect(readCsrfCookie("")).toBeNull();
  });

  it("extracts our cookie when alone", () => {
    expect(readCsrfCookie(`${CSRF_COOKIE_NAME}=abc.def.ghi`)).toBe(
      "abc.def.ghi",
    );
  });

  it("extracts our cookie when interleaved with others", () => {
    const header = `__Host-anai.session_token=session-x; ${CSRF_COOKIE_NAME}=abc.def.ghi; foo=bar`;
    expect(readCsrfCookie(header)).toBe("abc.def.ghi");
  });

  it("returns null when our cookie is absent", () => {
    expect(readCsrfCookie("foo=bar; baz=qux")).toBeNull();
  });

  it("ignores cookies with no `=`", () => {
    expect(readCsrfCookie("just-a-flag; foo=bar")).toBeNull();
  });
});

describe("verifyCsrfFromRequest", () => {
  // happy-dom (and the fetch spec) treat `Cookie` as a forbidden request
  // header and strip it from a Request constructed via `new Request(...)`.
  // In Cloudflare Workers the incoming Request DOES carry it, so production
  // code path works — we just need a test fixture that bypasses the strip.
  // We cast a minimal shape to Request: the verify helper only reads
  // `request.headers.get("cookie")`.
  function makeRequest(cookieHeader: string | null): Request {
    const headers = new Map<string, string>();
    if (cookieHeader != null) headers.set("cookie", cookieHeader);
    const fakeHeaders: Pick<Headers, "get"> = {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null;
      },
    };
    return { headers: fakeHeaders } as unknown as Request;
  }

  it("accepts a request whose cookie value matches the form value", async () => {
    const { token, cookie } = await issueCsrfToken(SECRET, USER_A);
    // Strip down to just `name=value` for the Cookie header (Set-Cookie has
    // attributes the request-side Cookie header MUST not).
    const cookieValueOnly = cookie.split(";")[0];
    const req = makeRequest(cookieValueOnly);
    expect(await verifyCsrfFromRequest(req, token, SECRET, USER_A)).toBe(true);
  });

  it("rejects when cookie != form (synchronizer mismatch)", async () => {
    const a = await issueCsrfToken(SECRET, USER_A);
    const b = await issueCsrfToken(SECRET, USER_A);
    const req = makeRequest(`${CSRF_COOKIE_NAME}=${a.token}`);
    expect(await verifyCsrfFromRequest(req, b.token, SECRET, USER_A)).toBe(
      false,
    );
  });

  it("rejects when cookie is missing", async () => {
    const { token } = await issueCsrfToken(SECRET, USER_A);
    const req = makeRequest(null);
    expect(await verifyCsrfFromRequest(req, token, SECRET, USER_A)).toBe(false);
  });

  it("rejects when form value is missing", async () => {
    const { token } = await issueCsrfToken(SECRET, USER_A);
    const req = makeRequest(`${CSRF_COOKIE_NAME}=${token}`);
    expect(await verifyCsrfFromRequest(req, null, SECRET, USER_A)).toBe(false);
    expect(await verifyCsrfFromRequest(req, "", SECRET, USER_A)).toBe(false);
  });

  it("rejects a token bound to user A when the session is user B", async () => {
    const { token } = await issueCsrfToken(SECRET, USER_A);
    const req = makeRequest(`${CSRF_COOKIE_NAME}=${token}`);
    expect(await verifyCsrfFromRequest(req, token, SECRET, USER_B)).toBe(false);
  });
});

describe("burnCsrfCookie", () => {
  it("emits a Max-Age=0 clear with __Host- invariants", () => {
    const cookie = burnCsrfCookie();
    expect(cookie.startsWith(`${CSRF_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toMatch(/Domain=/i);
  });
});
