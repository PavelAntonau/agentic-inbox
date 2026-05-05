// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Unit tests for admin/settings — F-AS2 per-key upper-bound caps.
//
// agentic-inbox-hardening Phase 2 (graph: CMyIbSkyuFhw9K1xVVwVi).
// The handler-level integration is covered by S-ADMIN-1 (task 2.8);
// this file pins the cap-table itself so a future edit to
// SETTINGS_MAX_VALUES triggers an explicit test failure rather than
// silently widening the surface.

import { describe, it, expect } from "vitest";
import { SETTINGS_MAX_VALUES } from "./settings";
import { SETTINGS_KEYS } from "../../lib/settings-cache";

describe("F-AS2 — SETTINGS_MAX_VALUES cap table", () => {
  it("matches the four explicit audit-named caps", () => {
    // These four caps are part of the audit's signed-off recommendation
    // (workers/.research/audit-report-agentic-inbox.md F-AS2). Changing
    // them is a policy decision, not a refactor — fail loud here so the
    // change has to walk through code review with intent.
    expect(SETTINGS_MAX_VALUES.max_regular_users).toBe(10000);
    expect(SETTINGS_MAX_VALUES.max_global_admins).toBe(20);
    expect(SETTINGS_MAX_VALUES.group_invitation_ttl_days).toBe(365);
    expect(SETTINGS_MAX_VALUES.agent_token_idle_prune_minutes).toBe(44640);
  });

  it("covers every integer-typed setting key (no silent gaps)", () => {
    // The enum key default_user_visibility is the only non-integer.
    // All other catalog keys must have a cap; a key without one
    // re-introduces the F-AS2 unbounded surface for new settings.
    const integerKeys = SETTINGS_KEYS.filter(
      (k) => k !== "default_user_visibility",
    );
    for (const k of integerKeys) {
      expect(
        SETTINGS_MAX_VALUES[k],
        `Setting key ${k} has no cap — F-AS2 regression`,
      ).toBeDefined();
    }
  });

  it("keeps every cap a positive integer", () => {
    for (const [key, cap] of Object.entries(SETTINGS_MAX_VALUES)) {
      expect(Number.isInteger(cap), `cap for ${key} not integer`).toBe(true);
      expect(cap, `cap for ${key} not positive`).toBeGreaterThan(0);
    }
  });
});
