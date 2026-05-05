// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.7 (mcp-oauth) — Security regression: XSS sanitization on the
// consent surface, AND redirect_uri scheme allowlist.
//
// Two cross-cutting invariants live here because both are about what
// the consent page is permitted to render or honor:
//
//   (d) HTML injection in client_name / description on the consent screen
//       MUST render escaped. Free-text is attacker-controlled (DCR clients
//       can pick any name), so escapeHtmlText is the canonical guardrail.
//
//   (e) javascript: / data: / file: / vbscript: / blob: / about: schemes
//       in `redirect_uri` MUST be rejected. The trusted-clients SSOT MUST
//       NOT register any such URI; the URL sanitizer MUST refuse them at
//       the consent-render boundary.

import { describe, expect, it } from "vitest";
import {
  escapeHtmlText,
  safeHttpsHref,
  sanitizeHttpsUrl,
} from "../../app/lib/sanitize";
import { TRUSTED_CLIENTS } from "../../app/lib/cached-trusted-clients";

/* -------------------------------------------------------------------------- */
/* (d) HTML injection in client_name / description renders escaped            */
/* -------------------------------------------------------------------------- */

describe("security regression — XSS in attacker-controlled consent text", () => {
  // OWASP XSS Filter Evasion Cheat Sheet — payloads that have caused real
  // bypasses in HTML-context renderers. We assert each escapes such that
  // the dangerous character is no longer parseable as HTML.

  it.each([
    ["script tag", "<script>alert('xss')</script>"],
    ["img onerror", `<img src="x" onerror="alert(1)">`],
    ["svg onload", `<svg/onload=alert(1)>`],
    ["iframe javascript:", `<iframe src="javascript:alert(1)"></iframe>`],
    ["attribute breakout", `"><script>alert(1)</script>`],
    ["double-quote breakout", `foo" onmouseover="alert(1)`],
    ["single-quote breakout", `foo' onmouseover='alert(1)`],
    ["mixed-case tag", `<ScRiPt>alert(1)</ScRiPt>`],
    ["entity-encoded ampersand", `Tom & Jerry`],
    ["leading whitespace + tag", `  <script>alert(1)</script>`],
    ["unicode payload", `<script>alert('☃')</script>`],
    ["greater-than only", "5 > 3"],
    ["less-than only", "3 < 5"],
  ])("escapes XSS payload: %s", (_label, payload) => {
    const escaped = escapeHtmlText(payload);
    // None of the dangerous raw characters survive.
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain("'");
    // The named entities ARE present.
    if (payload.includes("<")) expect(escaped).toContain("&lt;");
    if (payload.includes(">")) expect(escaped).toContain("&gt;");
    if (payload.includes('"')) expect(escaped).toContain("&quot;");
    if (payload.includes("'")) expect(escaped).toContain("&#39;");
    if (payload.includes("&")) expect(escaped).toContain("&amp;");
  });

  it("escapeHtmlText is idempotent (already-escaped → stable, but & re-escapes)", () => {
    // Repeated escaping doubles `&amp;` → `&amp;amp;`; this is documented
    // and acceptable as long as the resulting text never re-introduces
    // the raw `<` / `>` / `"` / `'` characters.
    const once = escapeHtmlText("<b>hi</b>");
    const twice = escapeHtmlText(once);
    expect(twice).not.toContain("<");
    expect(twice).not.toContain(">");
    expect(twice).toContain("&amp;lt;");
  });

  it("handles non-string inputs without throwing", () => {
    expect(escapeHtmlText(null)).toBe("");
    expect(escapeHtmlText(undefined)).toBe("");
    expect(escapeHtmlText(42)).toBe("42");
    expect(escapeHtmlText(true)).toBe("true");
  });

  it("preserves benign text exactly", () => {
    expect(escapeHtmlText("Claude Code")).toBe("Claude Code");
    expect(escapeHtmlText("ChatGPT Desktop (macOS)")).toBe(
      "ChatGPT Desktop (macOS)",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* (e) Dangerous redirect_uri / logo_uri schemes are rejected                 */
/* -------------------------------------------------------------------------- */

describe("security regression — dangerous URI schemes rejected", () => {
  // These payloads correspond directly to the schemes the OWASP HTML5
  // Security Cheat Sheet calls out as XSS vectors when interpolated into
  // `<a href>` or `<img src>` on a primary auth surface.
  it.each([
    ["javascript bare", "javascript:alert(1)"],
    [
      "javascript with whitespace bypass",
      "javascript://example.com/%0Aalert(1)",
    ],
    ["JaVaScRiPt mixed-case", "JaVaScRiPt:alert(1)"],
    ["data:text/html", "data:text/html,<script>alert(1)</script>"],
    ["data:image/svg+xml", "data:image/svg+xml;base64,PHN2Zy8+"],
    ["file:///etc/passwd", "file:///etc/passwd"],
    ["vbscript", "vbscript:msgbox(1)"],
    ["blob:", "blob:https://attacker.example/uuid"],
    ["about:blank", "about:blank"],
    ["ftp:", "ftp://attacker.example/secret"],
    ["http downgrade", "http://attacker.example/cb"],
    ["leading whitespace + javascript", "   javascript:alert(1)"],
    ["control-char prefix", "	javascript:alert(1)"],
  ])("sanitizeHttpsUrl rejects: %s", (_label, payload) => {
    expect(sanitizeHttpsUrl(payload)).toBeNull();
    expect(safeHttpsHref(payload)).toBeUndefined();
  });

  it("rejects empty / whitespace-only / non-string inputs", () => {
    expect(sanitizeHttpsUrl("")).toBeNull();
    expect(sanitizeHttpsUrl("   ")).toBeNull();
    expect(sanitizeHttpsUrl(null)).toBeNull();
    expect(sanitizeHttpsUrl(undefined)).toBeNull();
    expect(sanitizeHttpsUrl(42)).toBeNull();
    expect(sanitizeHttpsUrl({})).toBeNull();
  });

  it("rejects HTTPS URLs that are technically schemed but malformed", () => {
    // `https://` with no authority cannot parse — URL constructor throws.
    // (Note: `https:///foo` is NOT included here because the URL parser
    // greedily takes `foo` as the hostname; that's URL-parser behavior we
    // do not try to second-guess. The IP / loopback / scheme guards below
    // are the real boundaries.)
    expect(sanitizeHttpsUrl("https://")).toBeNull();
    expect(sanitizeHttpsUrl("https:")).toBeNull();
  });

  it("rejects literal IPv4 / IPv6 hosts (logo trust signal requires a domain)", () => {
    expect(sanitizeHttpsUrl("https://127.0.0.1/logo.png")).toBeNull();
    expect(sanitizeHttpsUrl("https://10.0.0.1/")).toBeNull();
    expect(sanitizeHttpsUrl("https://[::1]/")).toBeNull();
    expect(sanitizeHttpsUrl("https://[2001:db8::1]/")).toBeNull();
  });

  it("accepts a normal HTTPS URL (control)", () => {
    const u = sanitizeHttpsUrl("https://chatgpt.com/favicon.ico");
    expect(u).not.toBeNull();
    expect(u?.protocol).toBe("https:");
  });
});

/* -------------------------------------------------------------------------- */
/* (e) Trusted-client SSOT integrity — no dangerous redirect_uri              */
/* -------------------------------------------------------------------------- */

describe("security regression — TRUSTED_CLIENTS data integrity", () => {
  // The redirect_uri allowlist is what better-auth's plugin matches against
  // at /oauth2/authorize. If the SSOT itself ever ships a dangerous-scheme
  // URI, the plugin would happily issue a code redirect to it. This test
  // is the structural gate that prevents such a regression slipping in
  // alongside an unrelated client edit.

  const FORBIDDEN_SCHEMES = [
    "javascript:",
    "data:",
    "vbscript:",
    "file:",
    "blob:",
    "about:",
    "ftp:",
  ] as const;

  it("ships at least one trusted client (sanity)", () => {
    expect(TRUSTED_CLIENTS.length).toBeGreaterThan(0);
  });

  it("no trusted client has a dangerous-scheme redirect_uri", () => {
    for (const client of TRUSTED_CLIENTS) {
      for (const uri of client.redirectUris) {
        const lower = uri.toLowerCase().trimStart();
        for (const scheme of FORBIDDEN_SCHEMES) {
          expect(
            lower.startsWith(scheme),
            `Client ${client.clientId} has forbidden scheme ${scheme} in redirect_uri: ${uri}`,
          ).toBe(false);
        }
      }
    }
  });

  it("every redirect_uri is either https://, a custom app scheme, or http://localhost|127.0.0.1 (RFC 8252 §7.3 native loopback)", () => {
    // RFC 8252 explicitly permits http loopback (127.0.0.1, [::1], localhost)
    // for native apps. Anything else MUST be HTTPS or a custom app scheme.
    const RFC_8252_LOOPBACK =
      /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(\/.*)?$/i;
    const HTTPS = /^https:\/\//i;
    // Custom app schemes are alpha-led, contain `:` but not `://` for
    // schemes like `mailto:`; for OAuth native callbacks they are typically
    // `appname://` or `appname.bundle.id://path`. We accept any alpha-led
    // scheme that ISN'T one of the forbidden list (which is checked above).
    const CUSTOM_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

    for (const client of TRUSTED_CLIENTS) {
      for (const uri of client.redirectUris) {
        const ok =
          HTTPS.test(uri) ||
          RFC_8252_LOOPBACK.test(uri) ||
          (CUSTOM_SCHEME.test(uri) && !uri.toLowerCase().startsWith("http"));
        expect(
          ok,
          `Client ${client.clientId}: redirect_uri ${uri} is neither HTTPS nor RFC-8252 loopback nor a custom app scheme`,
        ).toBe(true);
      }
    }
  });

  it("no trusted client has a literal-IP HTTPS redirect (mixed-domain trust signal)", () => {
    // 127.0.0.1 / ::1 ARE allowed for HTTP loopback per the previous test.
    // For HTTPS redirects, however, a literal IP is a misconfiguration —
    // the trust signal is supposed to be a registered domain.
    const HTTPS_LITERAL_IP =
      /^https:\/\/((\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i;
    for (const client of TRUSTED_CLIENTS) {
      for (const uri of client.redirectUris) {
        expect(
          HTTPS_LITERAL_IP.test(uri),
          `Client ${client.clientId}: HTTPS redirect with literal IP host: ${uri}`,
        ).toBe(false);
      }
    }
  });
});
