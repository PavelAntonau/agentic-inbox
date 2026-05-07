// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G / TASK-1.8 (OQ-PG-8) — node:crypto.timingSafeEqual smoke.
//
// wrangler.jsonc sets `"compatibility_flags": ["nodejs_compat"]`, which
// exposes `node:crypto`'s `timingSafeEqual` to Workers. The brief §4.2
// recommends wrapping better-auth's OTP compare in `timingSafeEqual` if
// it isn't already constant-time. This test merely proves the API is
// reachable from the test runtime so Phase 2 Teammate A can rely on it.
//
// Web Crypto's `subtle` does NOT have a timingSafe primitive (Phase 3b's
// claim was directionally right, technically wrong on the API name);
// node:crypto's `timingSafeEqual` is the correct hook.

import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "node:crypto";

describe("OQ-PG-8 — node:crypto.timingSafeEqual is reachable", () => {
  it("returns true for identical buffers and false for non-identical buffers of the same length", () => {
    const a = Buffer.from("123456");
    const b = Buffer.from("123456");
    const c = Buffer.from("123457");
    expect(timingSafeEqual(a, b)).toBe(true);
    expect(timingSafeEqual(a, c)).toBe(false);
  });

  it("throws RangeError on mismatched lengths (forces caller to pre-check)", () => {
    const a = Buffer.from("1234");
    const b = Buffer.from("12345");
    expect(() => timingSafeEqual(a, b)).toThrow(RangeError);
  });
});
