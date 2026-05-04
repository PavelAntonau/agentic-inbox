// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.1 (mcp-oauth) — sanitize.ts unit tests.

import { describe, expect, it } from "vitest";
import {
  clampLength,
  escapeHtmlText,
  safeHttpsHref,
  sanitizeHttpsUrl,
} from "./sanitize";

describe("sanitizeHttpsUrl", () => {
  it("accepts a normal HTTPS URL", () => {
    const url = sanitizeHttpsUrl("https://chatgpt.com/favicon.ico");
    expect(url).not.toBeNull();
    expect(url?.protocol).toBe("https:");
    expect(url?.hostname).toBe("chatgpt.com");
  });

  it("trims whitespace", () => {
    const url = sanitizeHttpsUrl("   https://example.com/   ");
    expect(url).not.toBeNull();
    expect(url?.hostname).toBe("example.com");
  });

  it("preserves path, query, and fragment", () => {
    const url = sanitizeHttpsUrl("https://a.example.com/p?q=1#frag");
    expect(url?.pathname).toBe("/p");
    expect(url?.search).toBe("?q=1");
    expect(url?.hash).toBe("#frag");
  });

  it.each([
    ["javascript:alert(1)"],
    ["JAVASCRIPT:alert(1)"], // case-insensitive scheme
    ["data:text/html,<script>alert(1)</script>"],
    ["data:image/svg+xml;base64,PHN2ZyAuLi4="],
    ["vbscript:msgbox(1)"],
    ["file:///etc/passwd"],
    ["blob:https://evil.example.com/abc"],
    ["about:blank"],
    ["chrome://flags"],
  ])("rejects scheme %s", (input) => {
    expect(sanitizeHttpsUrl(input)).toBeNull();
  });

  it("rejects HTTP (mixed-content)", () => {
    expect(sanitizeHttpsUrl("http://example.com/")).toBeNull();
  });

  it("rejects ftp / wss / custom schemes", () => {
    expect(sanitizeHttpsUrl("ftp://example.com/file")).toBeNull();
    expect(sanitizeHttpsUrl("wss://example.com/socket")).toBeNull();
    expect(sanitizeHttpsUrl("cursor://anysphere/foo")).toBeNull();
  });

  it("rejects empty / whitespace / non-string input", () => {
    expect(sanitizeHttpsUrl("")).toBeNull();
    expect(sanitizeHttpsUrl("   ")).toBeNull();
    expect(sanitizeHttpsUrl(undefined)).toBeNull();
    expect(sanitizeHttpsUrl(null)).toBeNull();
    expect(sanitizeHttpsUrl(42)).toBeNull();
    expect(sanitizeHttpsUrl({})).toBeNull();
  });

  it("rejects unparseable URLs", () => {
    expect(sanitizeHttpsUrl("not a url at all")).toBeNull();
    expect(sanitizeHttpsUrl("https://")).toBeNull();
    expect(sanitizeHttpsUrl("https://[::z::]")).toBeNull();
  });

  it("rejects literal IPv4 hosts", () => {
    expect(sanitizeHttpsUrl("https://1.2.3.4/foo")).toBeNull();
    expect(sanitizeHttpsUrl("https://127.0.0.1/x")).toBeNull();
  });

  it("rejects literal IPv6 hosts", () => {
    expect(sanitizeHttpsUrl("https://[::1]/x")).toBeNull();
    expect(sanitizeHttpsUrl("https://[2001:db8::1]/y")).toBeNull();
  });

  it("rejects hosts longer than 253 chars", () => {
    const tooLong = "a".repeat(254) + ".com";
    expect(sanitizeHttpsUrl(`https://${tooLong}/`)).toBeNull();
  });
});

describe("safeHttpsHref", () => {
  it("returns the canonical string for a valid URL", () => {
    expect(safeHttpsHref("https://example.com/")).toBe("https://example.com/");
  });

  it("returns undefined for invalid input (so JSX drops the attr)", () => {
    expect(safeHttpsHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpsHref(undefined)).toBeUndefined();
    expect(safeHttpsHref("")).toBeUndefined();
  });
});

describe("escapeHtmlText", () => {
  it("escapes the five universally-unsafe chars", () => {
    expect(escapeHtmlText("&")).toBe("&amp;");
    expect(escapeHtmlText("<")).toBe("&lt;");
    expect(escapeHtmlText(">")).toBe("&gt;");
    expect(escapeHtmlText('"')).toBe("&quot;");
    expect(escapeHtmlText("'")).toBe("&#39;");
  });

  it("escapes a script-tag injection payload", () => {
    expect(escapeHtmlText("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
    );
  });

  it("escapes ampersand BEFORE other replacements (idempotent on raw &)", () => {
    expect(escapeHtmlText("a & b")).toBe("a &amp; b");
    // "&amp;" is itself escaped further to "&amp;amp;" — that's the price
    // of true idempotence: we don't try to detect already-escaped input.
    expect(escapeHtmlText("a &amp; b")).toBe("a &amp;amp; b");
  });

  it("returns empty string for null / undefined", () => {
    expect(escapeHtmlText(null)).toBe("");
    expect(escapeHtmlText(undefined)).toBe("");
  });

  it("coerces non-string scalars to string before escaping", () => {
    expect(escapeHtmlText(42)).toBe("42");
    expect(escapeHtmlText(true)).toBe("true");
  });

  it("preserves plain ASCII", () => {
    expect(escapeHtmlText("Claude Code")).toBe("Claude Code");
  });
});

describe("clampLength", () => {
  it("returns the input unchanged when under the cap", () => {
    expect(clampLength("hello", 10)).toBe("hello");
  });

  it("returns the input unchanged at exactly the cap", () => {
    expect(clampLength("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis when over the cap", () => {
    expect(clampLength("hello world", 8)).toBe("hello w…");
    expect(clampLength("hello world", 8).length).toBe(8);
  });

  it("returns empty string for non-string input", () => {
    expect(clampLength(undefined, 10)).toBe("");
    expect(clampLength(null, 10)).toBe("");
    expect(clampLength(42, 10)).toBe("");
  });
});
