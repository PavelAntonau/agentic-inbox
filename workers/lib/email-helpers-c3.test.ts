// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license

import { describe, it, expect } from "vitest";
import {
  sanitizeEmailHtml,
  parseInboundAuthHeader,
  verifyInboundAuth,
} from "./email-helpers";

describe("sanitizeEmailHtml (C3.7 — P2-D-2 server-side sanitizer)", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(sanitizeEmailHtml(null)).toBe("");
    expect(sanitizeEmailHtml(undefined)).toBe("");
    expect(sanitizeEmailHtml("")).toBe("");
  });

  it("preserves allowlist tags", () => {
    const out = sanitizeEmailHtml(
      "<p>Hello <b>world</b> <em>and</em> <a href='https://example.com'>link</a></p>",
    );
    expect(out).toContain("<p>");
    expect(out).toContain("<b>");
    expect(out).toContain("<em>");
    expect(out).toContain('href="https://example.com"');
  });

  it("strips <script> blocks completely", () => {
    const out = sanitizeEmailHtml(
      "<p>before</p><script>alert('xss')</script><p>after</p>",
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>before</p>");
    expect(out).toContain("<p>after</p>");
  });

  it("strips <iframe>, <object>, <embed>, <style>, <meta>, <link>", () => {
    const dangerous = [
      "<iframe src='evil.html'></iframe>",
      "<object data='evil.swf'></object>",
      "<embed src='evil'>",
      "<style>body{color:red}</style>",
      "<meta http-equiv='refresh'>",
      "<link rel='stylesheet' href='evil.css'>",
    ];
    for (const html of dangerous) {
      const out = sanitizeEmailHtml(html);
      expect(out).not.toMatch(/<(iframe|object|embed|style|meta|link)/i);
    }
  });

  it("strips event handler attributes (onclick, onerror, onload)", () => {
    const out = sanitizeEmailHtml(
      "<img src='x' onerror='alert(1)' onclick='hack()'>",
    );
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert");
  });

  it("refuses javascript: URLs in href", () => {
    const out = sanitizeEmailHtml("<a href='javascript:alert(1)'>click</a>");
    expect(out).not.toContain("javascript:");
  });

  it("refuses vbscript: URLs", () => {
    const out = sanitizeEmailHtml("<a href='vbscript:msgbox(1)'>click</a>");
    expect(out).not.toContain("vbscript:");
  });

  it("refuses data: URLs that aren't images on src", () => {
    const out = sanitizeEmailHtml(
      "<img src='data:text/html,<script>alert(1)</script>'>",
    );
    expect(out).not.toContain("data:text/html");
    // The img tag may remain but src is dropped.
  });

  it("allows data:image/png; on src", () => {
    const out = sanitizeEmailHtml(
      "<img src='data:image/png;base64,iVBORw0KGgo='>",
    );
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("drops style attribute when it contains javascript:", () => {
    const out = sanitizeEmailHtml(
      "<div style='background:url(javascript:alert(1))'>x</div>",
    );
    expect(out).not.toContain("javascript:");
  });

  it("drops style attribute when it contains expression()", () => {
    const out = sanitizeEmailHtml(
      "<div style='width:expression(alert(1))'>x</div>",
    );
    expect(out).not.toContain("expression(");
  });

  it("strips disallowed tags but keeps their text", () => {
    const out = sanitizeEmailHtml("<marquee>scroll</marquee>");
    // marquee is not in allowlist; the tag is dropped but children flow through
    expect(out).not.toContain("<marquee");
    // We don't unescape children, but the text remains visible
    expect(out).toContain("scroll");
  });

  it("strips comments (which can hide IE-conditional scripts)", () => {
    const out = sanitizeEmailHtml(
      "<p>safe</p><!--[if IE]><script>x</script><![endif]--><p>after</p>",
    );
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("<script");
  });

  it("allows safe tables (newsletter-friendly)", () => {
    const html =
      "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>";
    const out = sanitizeEmailHtml(html);
    expect(out).toContain("<table");
    expect(out).toContain("<thead");
    expect(out).toContain("<tbody");
    expect(out).toContain("<th>A</th>");
    expect(out).toContain("<td>1</td>");
  });

  it("is idempotent", () => {
    const dirty =
      "<p>hi <script>x</script><a href='https://e.com'>link</a></p>";
    const once = sanitizeEmailHtml(dirty);
    const twice = sanitizeEmailHtml(once);
    expect(once).toBe(twice);
  });
});

describe("parseInboundAuthHeader / verifyInboundAuth (C3.13 — SPF/DKIM/DMARC)", () => {
  it("returns 'unknown' on missing header", () => {
    const v = parseInboundAuthHeader(undefined);
    expect(v.spf).toBe("unknown");
    expect(v.dkim).toBe("unknown");
    expect(v.dmarc).toBe("unknown");
    expect(v.reject).toBe(false);
  });

  it("rejects on dmarc=fail", () => {
    const v = parseInboundAuthHeader(
      "mx.actionnow.ai; spf=pass; dkim=pass; dmarc=fail",
    );
    expect(v.dmarc).toBe("fail");
    expect(v.reject).toBe(true);
  });

  it("rejects on spf=fail AND dkim=fail (no dmarc)", () => {
    const v = parseInboundAuthHeader(
      "mx.actionnow.ai; spf=fail; dkim=fail; dmarc=none",
    );
    expect(v.reject).toBe(true);
  });

  it("accepts on spf=fail OR dkim=fail (one only)", () => {
    const v = parseInboundAuthHeader(
      "mx.actionnow.ai; spf=fail; dkim=pass; dmarc=pass",
    );
    expect(v.reject).toBe(false);
    const v2 = parseInboundAuthHeader(
      "mx.actionnow.ai; spf=pass; dkim=fail; dmarc=pass",
    );
    expect(v2.reject).toBe(false);
  });

  it("accepts on softfail / neutral", () => {
    const v = parseInboundAuthHeader(
      "mx; spf=softfail; dkim=neutral; dmarc=none",
    );
    expect(v.reject).toBe(false);
  });

  it("verifyInboundAuth pulls Authentication-Results case-insensitively", () => {
    const v = verifyInboundAuth({
      "authentication-results": "mx; spf=pass; dkim=pass; dmarc=pass",
    });
    expect(v.spf).toBe("pass");
    expect(v.reject).toBe(false);
  });

  it("verifyInboundAuth handles missing headers gracefully", () => {
    expect(verifyInboundAuth(undefined).reject).toBe(false);
    expect(verifyInboundAuth(null).reject).toBe(false);
    expect(verifyInboundAuth({}).reject).toBe(false);
  });

  it("summary string includes all three verdicts", () => {
    const v = parseInboundAuthHeader("mx; spf=pass; dkim=pass; dmarc=pass");
    expect(v.summary).toContain("spf=pass");
    expect(v.summary).toContain("dkim=pass");
    expect(v.summary).toContain("dmarc=pass");
  });

  it("rejected summary marks the rejection", () => {
    const v = parseInboundAuthHeader("mx; spf=fail; dkim=fail; dmarc=fail");
    expect(v.summary).toContain("rejected");
  });
});
