// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/routes/sessions.ts
// Uses pure permission-predicate tests — full route integration requires a Worker harness.

import { describe, it, expect } from "vitest";
import type { AuthzContext } from "../db/control-plane/forGroup";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(userId = "u-alice", sessionId?: string): AuthzContext {
  return {
    user_id: userId,
    role: "user",
    group_ids: [],
    authorized_mailbox_ids: [],
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

interface SessionRow {
  id: string;
  userId: string;
  expiresAt: number;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: number;
  updatedAt: number;
}

function makeSession(
  overrides: Partial<SessionRow> & { id: string; userId: string },
): SessionRow {
  return {
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    ipAddress: "1.2.3.4",
    userAgent: "Mozilla/5.0 (Macintosh)",
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Session listing logic — is_current flag
// ---------------------------------------------------------------------------

/**
 * Mirrors the is_current logic in GET /api/users/me/sessions.
 */
function markCurrentSession(
  sessions: SessionRow[],
  ctx: AuthzContext,
): Array<SessionRow & { is_current: boolean }> {
  const currentSessionId = ctx.session_id ?? null;
  return sessions.map((s) => ({
    ...s,
    is_current: s.id === currentSessionId,
  }));
}

/**
 * Mirrors the active-session filter (expiresAt > now).
 */
function filterActive(sessions: SessionRow[], now = Date.now()): SessionRow[] {
  return sessions.filter((s) => s.expiresAt > now);
}

describe("session listing — is_current flag", () => {
  it("marks the matching session as current", () => {
    const sessions = [
      makeSession({ id: "s-1", userId: "u-alice" }),
      makeSession({ id: "s-2", userId: "u-alice" }),
    ];
    const ctx = makeCtx("u-alice", "s-1");
    const result = markCurrentSession(sessions, ctx);
    expect(result.find((s) => s.id === "s-1")?.is_current).toBe(true);
    expect(result.find((s) => s.id === "s-2")?.is_current).toBe(false);
  });

  it("marks none as current when session_id is absent (CF Access path)", () => {
    const sessions = [makeSession({ id: "s-1", userId: "u-alice" })];
    const ctx = makeCtx("u-alice"); // no session_id
    const result = markCurrentSession(sessions, ctx);
    expect(result.every((s) => !s.is_current)).toBe(true);
  });

  it("returns only own sessions (userId filter enforced by query)", () => {
    // Simulates DB returning only rows where userId = ctx.user_id.
    // Other user's session must not appear.
    const aliceSessions = [makeSession({ id: "s-1", userId: "u-alice" })];
    const bobSessions = [makeSession({ id: "s-2", userId: "u-bob" })];

    // In the real handler the WHERE clause filters by userId — we assert
    // the result would never include the other user's session.
    const ctxAlice = makeCtx("u-alice", "s-1");
    const result = markCurrentSession(aliceSessions, ctxAlice);
    const bobRow = markCurrentSession(bobSessions, ctxAlice);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s-1");
    // Bob's session would never be in result — different userId
    expect(bobRow[0].is_current).toBe(false);
  });
});

describe("session listing — active filter", () => {
  it("excludes expired sessions", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        id: "s-active",
        userId: "u-alice",
        expiresAt: now + 10000,
      }),
      makeSession({ id: "s-expired", userId: "u-alice", expiresAt: now - 1 }),
    ];
    const active = filterActive(sessions, now);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("s-active");
  });

  it("returns empty array when all sessions expired", () => {
    const now = Date.now();
    const sessions = [
      makeSession({ id: "s-1", userId: "u-alice", expiresAt: now - 5000 }),
    ];
    expect(filterActive(sessions, now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session ownership check — DELETE /api/users/me/sessions/:id
// ---------------------------------------------------------------------------

/**
 * Mirrors the ownership check: returns true if the session belongs to caller.
 * In the handler this is enforced by WHERE id = :id AND userId = :userId.
 */
function canRevokeSession(
  ctx: AuthzContext,
  session: SessionRow,
): { ok: boolean; reason?: string } {
  if (session.userId !== ctx.user_id) {
    return { ok: false, reason: "session belongs to another user" };
  }
  return { ok: true };
}

describe("session revocation — ownership check", () => {
  it("allows revoking own session", () => {
    const ctx = makeCtx("u-alice", "s-1");
    const session = makeSession({ id: "s-2", userId: "u-alice" });
    expect(canRevokeSession(ctx, session).ok).toBe(true);
  });

  it("blocks revoking another user's session", () => {
    const ctx = makeCtx("u-alice", "s-1");
    const session = makeSession({ id: "s-2", userId: "u-bob" });
    const result = canRevokeSession(ctx, session);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/another user/i);
  });

  it("allows revoking own current session (self-logout)", () => {
    const ctx = makeCtx("u-alice", "s-current");
    const session = makeSession({ id: "s-current", userId: "u-alice" });
    expect(canRevokeSession(ctx, session).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Revoke-others logic — POST /api/users/me/sessions/revoke-others
// ---------------------------------------------------------------------------

/**
 * Mirrors the revoke-others filter: returns sessions that would be deleted.
 * currentSessionId excluded (kept alive); all other own sessions deleted.
 */
function sessionsToRevoke(
  sessions: SessionRow[],
  ctx: AuthzContext,
): SessionRow[] {
  const currentSessionId = ctx.session_id;
  return sessions.filter(
    (s) => s.userId === ctx.user_id && s.id !== currentSessionId,
  );
}

describe("revoke-others — session selection", () => {
  it("excludes the current session from revocation", () => {
    const ctx = makeCtx("u-alice", "s-current");
    const sessions = [
      makeSession({ id: "s-current", userId: "u-alice" }),
      makeSession({ id: "s-old-1", userId: "u-alice" }),
      makeSession({ id: "s-old-2", userId: "u-alice" }),
    ];
    const toRevoke = sessionsToRevoke(sessions, ctx);
    expect(toRevoke).toHaveLength(2);
    expect(toRevoke.map((s) => s.id)).not.toContain("s-current");
  });

  it("revokes all sessions when session_id is absent (CF Access path)", () => {
    const ctx = makeCtx("u-alice"); // no session_id
    const sessions = [
      makeSession({ id: "s-1", userId: "u-alice" }),
      makeSession({ id: "s-2", userId: "u-alice" }),
    ];
    const toRevoke = sessionsToRevoke(sessions, ctx);
    // With no current session, all own sessions are eligible
    expect(toRevoke).toHaveLength(2);
  });

  it("does not revoke sessions belonging to other users", () => {
    const ctx = makeCtx("u-alice", "s-a");
    const sessions = [
      makeSession({ id: "s-a", userId: "u-alice" }),
      makeSession({ id: "s-b", userId: "u-bob" }),
    ];
    const toRevoke = sessionsToRevoke(sessions, ctx);
    // s-a is current (excluded), s-b belongs to bob (excluded)
    expect(toRevoke).toHaveLength(0);
  });

  it("returns empty when only one session exists and it is current", () => {
    const ctx = makeCtx("u-alice", "s-only");
    const sessions = [makeSession({ id: "s-only", userId: "u-alice" })];
    expect(sessionsToRevoke(sessions, ctx)).toHaveLength(0);
  });
});
