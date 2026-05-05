// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Unit tests for the admin/users route helpers.
//
// agentic-inbox-hardening Phase 2 (graph: CMyIbSkyuFhw9K1xVVwVi).
// F-AU3 — parseAdminCap fail-closed on NaN. The route handler test
// surface (full POST /promote integration) is exercised by the
// S-ADMIN-3 scenario; this file pins the predicate that guards it.

import { describe, it, expect } from "vitest";
import { parseAdminCap } from "./users";

describe("parseAdminCap (F-AU3)", () => {
  it("returns cap=undefined when the setting is missing", () => {
    expect(parseAdminCap(undefined)).toEqual({ ok: true, cap: undefined });
  });

  it("returns cap=undefined for an empty string", () => {
    expect(parseAdminCap("")).toEqual({ ok: true, cap: undefined });
  });

  it("parses a normal integer string", () => {
    expect(parseAdminCap("5")).toEqual({ ok: true, cap: 5 });
  });

  it("parses a leading-integer string the way canAct expects", () => {
    // parseInt(..., 10) tolerates a trailing whitespace/comment by design;
    // we mirror that — the predicate is permissive of "5 admins" → 5 — and
    // strict only on values that yield NaN. This matches the original
    // semantics; the F-AU3 fix is fail-closed on NaN, NOT a tightening of
    // the input grammar.
    expect(parseAdminCap("5 admins")).toEqual({ ok: true, cap: 5 });
  });

  it("FAILS CLOSED for a non-numeric string (the F-AU3 case)", () => {
    expect(parseAdminCap("abc")).toEqual({ ok: false, reason: "nan" });
  });

  it("FAILS CLOSED for a string that begins with non-digit characters", () => {
    // parseInt("admins-only", 10) → NaN; the cap check would otherwise
    // pass-through silently. The fix surfaces this as a 500.
    expect(parseAdminCap("admins-only")).toEqual({ ok: false, reason: "nan" });
  });

  it("parses zero (the genuine 'block all promotions' value)", () => {
    expect(parseAdminCap("0")).toEqual({ ok: true, cap: 0 });
  });
});
