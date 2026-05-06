// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license

import { describe, it, expect } from "vitest";
import { normalizeEmail, isEmailLike } from "./email";

describe("normalizeEmail (C3.3 — single source of truth)", () => {
  it("lowercases the entire address", () => {
    expect(normalizeEmail("ALICE@ActionNow.AI")).toBe("alice@actionnow.ai");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeEmail("  bob@example.com  ")).toBe("bob@example.com");
    expect(normalizeEmail("\tcarol@x.io\n")).toBe("carol@x.io");
  });

  it("returns empty string for null / undefined / non-string", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(123 as unknown as string)).toBe("");
    expect(normalizeEmail({} as unknown as string)).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeEmail("   ")).toBe("");
    expect(normalizeEmail("\n\t")).toBe("");
  });

  it("preserves valid characters (dots, plus, dashes)", () => {
    expect(normalizeEmail("First.Last+Tag@DOMAIN.example.com")).toBe(
      "first.last+tag@domain.example.com",
    );
    expect(normalizeEmail("a-b_c@sub.host.io")).toBe("a-b_c@sub.host.io");
  });

  it("is idempotent (normalize(normalize(x)) === normalize(x))", () => {
    const inputs = ["ALICE@HOST", "  Bob@x.io  ", "\nCarol@y.io\t", "", "x"];
    for (const input of inputs) {
      expect(normalizeEmail(normalizeEmail(input))).toBe(normalizeEmail(input));
    }
  });
});

describe("isEmailLike (cheap shape check)", () => {
  it("returns true for normal emails", () => {
    expect(isEmailLike("alice@example.com")).toBe(true);
    expect(isEmailLike("ALICE@EXAMPLE.COM")).toBe(true);
    expect(isEmailLike("  alice+tag@x.io  ")).toBe(true);
  });

  it("returns false for missing @", () => {
    expect(isEmailLike("alice")).toBe(false);
    expect(isEmailLike("notanemail.com")).toBe(false);
  });

  it("returns false for empty / null / non-string", () => {
    expect(isEmailLike("")).toBe(false);
    expect(isEmailLike("   ")).toBe(false);
    expect(isEmailLike(null)).toBe(false);
    expect(isEmailLike(undefined)).toBe(false);
  });

  it("returns false when @ is at start or end", () => {
    expect(isEmailLike("@example.com")).toBe(false);
    expect(isEmailLike("alice@")).toBe(false);
    expect(isEmailLike("@")).toBe(false);
  });
});
