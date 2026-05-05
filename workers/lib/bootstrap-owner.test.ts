// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license

import { describe, it, expect } from "vitest";
import { isBootstrapEmail } from "./bootstrap-owner";
import type { Env } from "../types";

// Minimal Env shape — only BOOTSTRAP_OWNER_EMAIL is exercised here. Cast
// through unknown so we don't have to construct the full Env interface.
const mkEnv = (bootstrapEmail: string | undefined): Env =>
  ({ BOOTSTRAP_OWNER_EMAIL: bootstrapEmail }) as unknown as Env;

describe("isBootstrapEmail (audit A-1 — shared predicate)", () => {
  it("matches an exact email", () => {
    expect(
      isBootstrapEmail("owner@actionnow.ai", mkEnv("owner@actionnow.ai")),
    ).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    expect(
      isBootstrapEmail("Owner@ActionNow.AI", mkEnv("owner@actionnow.ai")),
    ).toBe(true);
    expect(
      isBootstrapEmail("owner@actionnow.ai", mkEnv("OWNER@ACTIONNOW.AI")),
    ).toBe(true);
  });

  it("tolerates leading/trailing whitespace on the env value", () => {
    // This was the bug A-1 actually caught: better-auth hook compared
    // without `.trim()` so a BOOTSTRAP_OWNER_EMAIL of "  owner@a.io " would
    // never match a normal login email "owner@a.io".
    expect(isBootstrapEmail("owner@a.io", mkEnv("  owner@a.io  "))).toBe(true);
    expect(isBootstrapEmail("owner@a.io", mkEnv("\towner@a.io\n"))).toBe(true);
  });

  it("tolerates leading/trailing whitespace on the login side", () => {
    // Symmetry: defensive against upstream paths that don't pre-trim.
    expect(isBootstrapEmail("  owner@a.io  ", mkEnv("owner@a.io"))).toBe(true);
  });

  it("rejects a non-matching email", () => {
    expect(isBootstrapEmail("intruder@a.io", mkEnv("owner@a.io"))).toBe(false);
  });

  it("returns false when BOOTSTRAP_OWNER_EMAIL is unset", () => {
    expect(isBootstrapEmail("anyone@a.io", mkEnv(undefined))).toBe(false);
  });

  it("returns false when BOOTSTRAP_OWNER_EMAIL is whitespace-only", () => {
    // Whitespace after trim collapses to empty → fail-closed.
    expect(isBootstrapEmail("owner@a.io", mkEnv("   "))).toBe(false);
    expect(isBootstrapEmail("owner@a.io", mkEnv(""))).toBe(false);
  });

  it("returns false on partial match (substring is not enough)", () => {
    expect(isBootstrapEmail("notowner@a.io", mkEnv("owner@a.io"))).toBe(false);
    expect(isBootstrapEmail("owner@a.io.evil.com", mkEnv("owner@a.io"))).toBe(
      false,
    );
  });
});
