// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.7 (mcp-oauth) — Security regression: consent CSRF synchronizer-token.
//
// MCP-spec MUST: state-changing requests on the consent surface MUST
// require a CSRF token. We use the synchronizer-token pattern with
// HMAC-SHA-256 binding to `userId`, with the cookie name pinned to
// `__Host-CSRF_TOKEN` and a 30-minute expiry. Implementation in
// `app/lib/csrf.ts`.
//
// The invariants under test:
//
//   1. POST without the __Host-CSRF_TOKEN cookie is rejected.
//   2. POST without the form-field token is rejected.
//   3. POST with cookie ≠ form-field is rejected (synchronizer mismatch).
//   4. POST with a valid token bound to user A but the session is user B
//      is rejected (HMAC binding to userId).
//   5. POST with an expired token is rejected.
//   6. POST with a malformed token (wrong shape) is rejected.
//   7. POST with a token signed with a different secret is rejected.
//   8. The cookie shape (name, attributes) matches the __Host- prefix
//      requirement: no Domain, Path=/, Secure, HttpOnly, SameSite=Lax.
//   9. burnCsrfCookie clears the cookie unconditionally with Max-Age=0.

import { describe, expect, it } from "vitest";
import {
  CSRF_COOKIE_NAME,
  CSRF_FORM_FIELD,
  burnCsrfCookie,
  issueCsrfToken,
  verifyCsrfFromRequest,
  verifyCsrfToken,
} from "../../app/lib/csrf";

const SECRET = "test-secret-T3.7-consent-csrf-32-bytes-min-len";
const SECRET_ALT = "different-secret-T3.7-must-not-collide-32+chars";

const USER_A = "user_aaa_T3.7";
const USER_B = "user_bbb_T3.7";

/** Build a Request whose `Cookie` header is preserved (happy-dom strips them
 *  when going through `new Request(...)`, so we mock the headers map). */
function makeConsentPostRequest(cookieHeader: string | undefined): Request {
  const headerMap = new Map<string, string>();
  if (cookieHeader) headerMap.set("cookie", cookieHeader);
  return {
    method: "POST",
    url: "https://mail.actionnow.ai/consent",
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
  } as unknown as Request;
}

function buildCookieHeader(
  name: string,
  value: string,
  extras?: string,
): string {
  return extras ? `${name}=${value}; ${extras}` : `${name}=${value}`;
}

describe("security regression — consent CSRF (synchronizer + binding)", () => {
  it("control: cookie + form-field match + correct user → accepts", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, issued.token),
    );
    const ok = await verifyCsrfFromRequest(req, issued.token, SECRET, USER_A);
    expect(ok).toBe(true);
  });

  it("rejects POST with NO __Host-CSRF_TOKEN cookie", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    const req = makeConsentPostRequest(undefined);
    const ok = await verifyCsrfFromRequest(req, issued.token, SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("rejects POST when only OTHER cookies are present", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    const req = makeConsentPostRequest(
      "theme=dark; locale=en; __Host-anai.session_token=opaque",
    );
    const ok = await verifyCsrfFromRequest(req, issued.token, SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("rejects POST with NO form-field token", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, issued.token),
    );
    const ok = await verifyCsrfFromRequest(req, null, SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("rejects POST with empty-string form-field token", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, issued.token),
    );
    const ok = await verifyCsrfFromRequest(req, "", SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("rejects POST when cookie value ≠ form-field value (synchronizer mismatch)", async () => {
    const cookieIssue = await issueCsrfToken(SECRET, USER_A);
    const formIssue = await issueCsrfToken(SECRET, USER_A);
    // Two valid tokens for the same user — but cookie-and-form must MATCH,
    // not merely be individually valid. Synchronizer-pattern enforces this.
    expect(cookieIssue.token).not.toBe(formIssue.token);
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, cookieIssue.token),
    );
    const ok = await verifyCsrfFromRequest(
      req,
      formIssue.token,
      SECRET,
      USER_A,
    );
    expect(ok).toBe(false);
  });

  it("rejects POST with cross-user replay: token issued for A, session is B (HMAC binding)", async () => {
    const issuedForA = await issueCsrfToken(SECRET, USER_A);
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, issuedForA.token),
    );
    // The token's HMAC binds it to USER_A; verifying against USER_B fails.
    const ok = await verifyCsrfFromRequest(
      req,
      issuedForA.token,
      SECRET,
      USER_B,
    );
    expect(ok).toBe(false);
  });

  it("rejects expired token", async () => {
    // Issue a token with a 60-second TTL and clock the verification 120s
    // forward. Both `issueCsrfToken` and `verifyCsrfToken` accept a clock
    // override, so this is deterministic.
    const t0 = 1_700_000_000; // arbitrary fixed unix-seconds
    const issued = await issueCsrfToken(SECRET, USER_A, {
      ttlSec: 60,
      nowSec: () => t0,
    });
    expect(issued.exp).toBe(t0 + 60);

    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, issued.token),
    );
    const ok = await verifyCsrfFromRequest(req, issued.token, SECRET, USER_A, {
      nowSec: () => t0 + 120,
    });
    expect(ok).toBe(false);
  });

  it("rejects malformed token (one part)", async () => {
    const malformed = "not-a-valid-token";
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, malformed),
    );
    const ok = await verifyCsrfFromRequest(req, malformed, SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("rejects malformed token (two parts)", async () => {
    const malformed = "nonce.exp_only_no_sig";
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, malformed),
    );
    const ok = await verifyCsrfFromRequest(req, malformed, SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("rejects malformed token (four parts)", async () => {
    const malformed = "nonce.123.sig.extra";
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, malformed),
    );
    const ok = await verifyCsrfFromRequest(req, malformed, SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("rejects token whose `exp` is non-numeric", async () => {
    const malformed = "abcdef.notanumber.signature";
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, malformed),
    );
    const ok = await verifyCsrfFromRequest(req, malformed, SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("rejects token signed with a different secret (cross-environment confusion)", async () => {
    const issuedWithAlt = await issueCsrfToken(SECRET_ALT, USER_A);
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, issuedWithAlt.token),
    );
    const ok = await verifyCsrfFromRequest(
      req,
      issuedWithAlt.token,
      SECRET,
      USER_A,
    );
    expect(ok).toBe(false);
  });

  it("rejects when the secret is empty (defensive: misconfig surface)", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, issued.token),
    );
    const ok = await verifyCsrfFromRequest(req, issued.token, "", USER_A);
    expect(ok).toBe(false);
  });

  it("rejects when the bound userId is empty", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, issued.token),
    );
    const ok = await verifyCsrfFromRequest(req, issued.token, SECRET, "");
    expect(ok).toBe(false);
  });

  it("rejects when sig is base64url-tampered", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    // Flip a single byte in the signature — token still parses as 3 parts
    // but constant-time comparison fails.
    const [nonce, exp, sig] = issued.token.split(".");
    const flipped = sig.startsWith("A")
      ? `B${sig.slice(1)}`
      : `A${sig.slice(1)}`;
    const tampered = `${nonce}.${exp}.${flipped}`;
    const req = makeConsentPostRequest(
      buildCookieHeader(CSRF_COOKIE_NAME, tampered),
    );
    const ok = await verifyCsrfFromRequest(req, tampered, SECRET, USER_A);
    expect(ok).toBe(false);
  });

  it("verifyCsrfToken refuses tokens with a fractional exp (integer-only contract)", async () => {
    const malformed = "abc123.1700000000.5.sig";
    const ok = await verifyCsrfToken(malformed, SECRET, USER_A);
    expect(ok).toBe(false);
  });
});

describe("security regression — CSRF cookie shape (__Host- prefix contract)", () => {
  it("issued cookie name is exactly __Host-CSRF_TOKEN", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    expect(CSRF_COOKIE_NAME).toBe("__Host-CSRF_TOKEN");
    expect(issued.cookie.startsWith(`${CSRF_COOKIE_NAME}=`)).toBe(true);
  });

  it("issued cookie carries Path=/, Secure, HttpOnly, SameSite=Lax — and NO Domain", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A);
    const c = issued.cookie;
    expect(c).toContain("; Path=/");
    expect(c).toContain("; Secure");
    expect(c).toContain("; HttpOnly");
    expect(c).toContain("; SameSite=Lax");
    // __Host- prefix forbids Domain.
    expect(c.toLowerCase()).not.toContain("; domain=");
  });

  it("issued cookie has positive Max-Age matching the TTL", async () => {
    const issued = await issueCsrfToken(SECRET, USER_A, { ttlSec: 600 });
    expect(issued.cookie).toContain("; Max-Age=600");
  });

  it("burnCsrfCookie emits Max-Age=0 with the same attribute set", () => {
    const burned = burnCsrfCookie();
    expect(burned.startsWith(`${CSRF_COOKIE_NAME}=`)).toBe(true);
    // Empty value, Max-Age=0 → browser drops the cookie immediately.
    expect(burned).toContain("=;");
    expect(burned).toContain("; Max-Age=0");
    expect(burned).toContain("; Path=/");
    expect(burned).toContain("; Secure");
    expect(burned).toContain("; HttpOnly");
    expect(burned).toContain("; SameSite=Lax");
    expect(burned.toLowerCase()).not.toContain("; domain=");
  });

  it("CSRF_FORM_FIELD constant is csrf_token (locked)", () => {
    // Pinned so any rename forces an explicit security review.
    expect(CSRF_FORM_FIELD).toBe("csrf_token");
  });

  it("two issues of the same (secret, user) produce DIFFERENT tokens (nonce entropy)", async () => {
    const a = await issueCsrfToken(SECRET, USER_A);
    const b = await issueCsrfToken(SECRET, USER_A);
    expect(a.token).not.toBe(b.token);
  });
});
