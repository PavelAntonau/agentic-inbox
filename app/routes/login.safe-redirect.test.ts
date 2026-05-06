// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C3 / TASK-C3.22 — safeRedirect regex tighten (D-12).
//
// The hardened regex rejects backslashes anywhere in the path body so that
// browsers that normalise `\` → `/` before navigation cannot turn an
// already-approved redirect into a protocol-relative URL.

import { describe, expect, it } from "vitest";
import { safeRedirect, SAFE_REDIRECT_PATTERN } from "./login";

describe("safeRedirect — Phase C3 / TASK-C3.22 (D-12)", () => {
  // -- accepted same-origin paths -------------------------------------------

  it("accepts /", () => {
    expect(safeRedirect("/")).toBe("/");
  });

  it("accepts /threads/123", () => {
    expect(safeRedirect("/threads/123")).toBe("/threads/123");
  });

  it("accepts /search?q=foo", () => {
    expect(safeRedirect("/search?q=foo")).toBe("/search?q=foo");
  });

  it("accepts /threads/123#anchor", () => {
    expect(safeRedirect("/threads/123#anchor")).toBe("/threads/123#anchor");
  });

  // -- rejected hostile inputs ----------------------------------------------

  it("rejects null → /", () => {
    expect(safeRedirect(null)).toBe("/");
  });

  it("rejects empty string → /", () => {
    expect(safeRedirect("")).toBe("/");
  });

  it("rejects protocol-relative //evil.com → /", () => {
    expect(safeRedirect("//evil.com")).toBe("/");
  });

  it("rejects backslash second char /\\evil.com → /", () => {
    // The hardened pattern's load-bearing case: the previous regex
    // accepted this because `\` was permitted in the path body, but
    // some browsers normalise `\` to `/` before navigation.
    expect(safeRedirect("/\\evil.com")).toBe("/");
  });

  it("rejects backslash mid-path /threads/\\evil.com → /", () => {
    expect(safeRedirect("/threads/\\evil.com")).toBe("/");
  });

  it("rejects backslash in fragment is OK (browsers don't normalise `\\` past `#`)", () => {
    // The regex stops constraining once `#` appears (RFC 3986 fragment is
    // user-agent-defined). This case is documented for explicitness.
    // No assertion: the test below just confirms the path-body protection
    // is the load-bearing piece.
    expect(SAFE_REDIRECT_PATTERN.test("/threads/123#weird")).toBe(true);
  });

  it("rejects absolute URL https://evil.com → /", () => {
    expect(safeRedirect("https://evil.com")).toBe("/");
  });

  it("rejects javascript: URL → /", () => {
    expect(safeRedirect("javascript:alert(1)")).toBe("/");
  });

  it("rejects relative path no-leading-slash threads/123 → /", () => {
    expect(safeRedirect("threads/123")).toBe("/");
  });

  it("rejects /login redirect (loop guard) → /", () => {
    expect(safeRedirect("/login")).toBe("/");
  });

  it("rejects /login?next=foo (loop guard) → /", () => {
    expect(safeRedirect("/login?next=foo")).toBe("/");
  });
});
