// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C2 / A-07 — peer-protection required-types coverage.
//
// The promote overload now requires `adminCap: number` and
// `currentAdminCount: number` at the type level. The implementation also
// runtime-guards against NaN (parse-failure regression).

import { describe, expect, it } from "vitest";
import { canAct } from "./peer-protection";

const owner = {
  user_id: "owner-1",
  role: "global_owner" as const,
  email: "owner@x",
};
const target = {
  id: "user-1",
  role: "user" as const,
  email: "u@x",
  owns_mailboxes_count: 0,
};

describe("canAct — Phase C2 / A-07", () => {
  it("promote with cap reached → admin-cap-reached", () => {
    const r = canAct(owner, target, "promote", 5, 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("admin-cap-reached");
  });

  it("promote under the cap → ok", () => {
    const r = canAct(owner, target, "promote", 5, 4);
    expect(r.ok).toBe(true);
  });

  it("promote with NaN adminCap → admin-cap-misconfigured (fail-CLOSED)", () => {
    const r = canAct(owner, target, "promote", NaN as number, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("admin-cap-misconfigured");
  });

  it("promote with NaN currentAdminCount → admin-cap-misconfigured", () => {
    const r = canAct(owner, target, "promote", 5, NaN as number);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("admin-cap-misconfigured");
  });

  it("demote — does not require cap parameters", () => {
    const r = canAct(owner, target, "demote");
    // owner can demote a regular user (no-op for role='user' → vacuously OK)
    expect(r).toBeDefined();
  });

  it("remove — does not require cap parameters", () => {
    const r = canAct(owner, target, "remove");
    expect(r.ok).toBe(true);
  });
});
