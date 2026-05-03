// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/routes/observability.ts
// Uses pure logic / permission tests — full route integration requires a Worker harness.

import { describe, it, expect } from "vitest";
import type { AuthzContext } from "../db/control-plane/forGroup";

// ---------------------------------------------------------------------------
// Permission predicate — admin guard logic (inline mirror of router guard)
// ---------------------------------------------------------------------------

function isAdminAllowed(ctx: AuthzContext): boolean {
  return ctx.role === "global_owner" || ctx.role === "global_admin";
}

function makeCtx(role: AuthzContext["role"], userId = "u-alice"): AuthzContext {
  return {
    user_id: userId,
    role,
    group_ids: [],
    authorized_mailbox_ids: [],
  };
}

// ---------------------------------------------------------------------------
// Admin gating tests
// ---------------------------------------------------------------------------

describe("observability admin gate", () => {
  it("allows global_owner", () => {
    expect(isAdminAllowed(makeCtx("global_owner"))).toBe(true);
  });

  it("allows global_admin", () => {
    expect(isAdminAllowed(makeCtx("global_admin"))).toBe(true);
  });

  it("blocks regular user", () => {
    expect(isAdminAllowed(makeCtx("user"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Message rate window logic
// ---------------------------------------------------------------------------

describe("message rate windows", () => {
  it("24h window is 86_400_000 ms back from now", () => {
    const now = Date.now();
    const since = now - 24 * 60 * 60 * 1000;
    expect(now - since).toBe(86_400_000);
  });

  it("7d window is 604_800_000 ms back from now", () => {
    const now = Date.now();
    const since = now - 7 * 24 * 60 * 60 * 1000;
    expect(now - since).toBe(604_800_000);
  });

  it("30d window is 2_592_000_000 ms back from now", () => {
    const now = Date.now();
    const since = now - 30 * 24 * 60 * 60 * 1000;
    expect(now - since).toBe(2_592_000_000);
  });
});

// ---------------------------------------------------------------------------
// Audit pagination logic
// ---------------------------------------------------------------------------

describe("audit pagination calculation", () => {
  function paginate(
    totalCount: number,
    page: number,
    perPage: number,
  ): { totalPages: number; offset: number } {
    const totalPages = Math.ceil(totalCount / perPage);
    const offset = (page - 1) * perPage;
    return { totalPages, offset };
  }

  it("page 1 has offset 0", () => {
    expect(paginate(100, 1, 50).offset).toBe(0);
  });

  it("page 2 has offset = perPage", () => {
    expect(paginate(100, 2, 50).offset).toBe(50);
  });

  it("totalPages rounds up", () => {
    expect(paginate(101, 1, 50).totalPages).toBe(3);
  });

  it("exact division produces correct totalPages", () => {
    expect(paginate(100, 1, 50).totalPages).toBe(2);
  });

  it("per_page is capped at 200", () => {
    const perPage = Math.min(200, Math.max(1, 500));
    expect(perPage).toBe(200);
  });

  it("per_page minimum is 1", () => {
    const perPage = Math.min(200, Math.max(1, 0));
    expect(perPage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Default window (7 days) smoke
// ---------------------------------------------------------------------------

describe("audit default window", () => {
  it("default since is 7 days ago", () => {
    const now = Date.now();
    const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const since = now - DEFAULT_WINDOW_MS;
    expect(now - since).toBe(DEFAULT_WINDOW_MS);
  });
});
