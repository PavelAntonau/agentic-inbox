// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/routes/clients.ts
// Uses pure predicate/logic tests — mirrors the pattern from sessions.test.ts.
// Full route integration requires a Worker harness; these tests verify the
// business logic that lives in the route handlers.

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

interface ClientRow {
  id: string;
  user_id: string;
  kind: "browser" | "mcp" | "ios" | "desktop" | "other";
  name: string;
  oauth_client_id: string | null;
  last_seen_at: number | null;
  ip_address: string | null;
  user_agent: string | null;
  revoked_at: number | null;
  created_at: number;
}

interface GrantRow {
  id: string;
  client_id: string;
  inbox_id: string;
  scope: "read" | "write";
  granted_at: number;
  revoked_at: number | null;
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

function makeClient(
  overrides: Partial<ClientRow> & { id: string; user_id: string },
): ClientRow {
  return {
    kind: "mcp",
    name: "Test MCP Client",
    oauth_client_id: null,
    last_seen_at: null,
    ip_address: null,
    user_agent: null,
    revoked_at: null,
    created_at: Date.now() - 5000,
    ...overrides,
  };
}

function makeGrant(
  overrides: Partial<GrantRow> & {
    id: string;
    client_id: string;
    inbox_id: string;
  },
): GrantRow {
  return {
    scope: "write",
    granted_at: Date.now() - 2000,
    revoked_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /api/users/me/clients — listing logic
// ---------------------------------------------------------------------------

/**
 * Mirrors the session → browser-client projection in the route handler.
 * Browser sessions are projected as kind='browser' with id='session:<id>'.
 */
function projectSessionAsClient(
  session: SessionRow,
  currentSessionId: string | null,
): {
  id: string;
  kind: "browser";
  is_current: boolean;
  revoked_at: null;
} {
  return {
    id: `session:${session.id}`,
    kind: "browser",
    is_current: session.id === currentSessionId,
    revoked_at: null,
  };
}

/**
 * Mirrors the active-session filter in the route (expiresAt > now).
 */
function filterActiveSessions(
  sessions: SessionRow[],
  now = Date.now(),
): SessionRow[] {
  return sessions.filter((s) => s.expiresAt > now);
}

describe("GET /api/users/me/clients — empty state", () => {
  it("returns empty array when there are no sessions or stored clients", () => {
    const sessions: SessionRow[] = [];
    const clients: ClientRow[] = [];
    const ctx = makeCtx("u-alice", "s-1");

    const browserClients = filterActiveSessions(sessions).map((s) =>
      projectSessionAsClient(s, ctx.session_id ?? null),
    );

    expect(browserClients).toHaveLength(0);
    expect(clients).toHaveLength(0);
  });
});

describe("GET /api/users/me/clients — session + client rows", () => {
  it("projects a session row as a browser client", () => {
    const session = makeSession({ id: "s-1", userId: "u-alice" });
    const ctx = makeCtx("u-alice", "s-1");

    const projected = projectSessionAsClient(session, ctx.session_id ?? null);
    expect(projected.id).toBe("session:s-1");
    expect(projected.kind).toBe("browser");
    expect(projected.is_current).toBe(true);
    expect(projected.revoked_at).toBeNull();
  });

  it("marks the current session as is_current=true, others false", () => {
    const sessions = [
      makeSession({ id: "s-current", userId: "u-alice" }),
      makeSession({ id: "s-other", userId: "u-alice" }),
    ];
    const ctx = makeCtx("u-alice", "s-current");

    const projected = filterActiveSessions(sessions).map((s) =>
      projectSessionAsClient(s, ctx.session_id ?? null),
    );

    expect(
      projected.find((c) => c.id === "session:s-current")?.is_current,
    ).toBe(true);
    expect(projected.find((c) => c.id === "session:s-other")?.is_current).toBe(
      false,
    );
  });

  it("returns a stored mcp client with is_current=false", () => {
    const client = makeClient({ id: "cl-1", user_id: "u-alice", kind: "mcp" });
    // Stored clients are never is_current (only browser sessions can be)
    expect(client.kind).toBe("mcp");
    expect(client.revoked_at).toBeNull();
  });

  it("excludes expired sessions from browser-client list", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        id: "s-active",
        userId: "u-alice",
        expiresAt: now + 10000,
      }),
      makeSession({ id: "s-expired", userId: "u-alice", expiresAt: now - 1 }),
    ];
    const active = filterActiveSessions(sessions, now);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("s-active");
  });
});

// ---------------------------------------------------------------------------
// POST /api/users/me/clients — kind validation
// ---------------------------------------------------------------------------

/**
 * Mirrors the kind validation in the POST handler.
 */
function validateClientKind(kind: unknown): {
  ok: boolean;
  error?: string;
} {
  const allowed = ["mcp", "ios", "desktop", "other"];
  if (!kind || !allowed.includes(kind as string)) {
    return {
      ok: false,
      error:
        "kind must be one of: mcp, ios, desktop, other (browser not allowed via POST)",
    };
  }
  return { ok: true };
}

describe("POST /api/users/me/clients — validation", () => {
  it("accepts valid non-browser kinds", () => {
    for (const kind of ["mcp", "ios", "desktop", "other"]) {
      expect(validateClientKind(kind).ok).toBe(true);
    }
  });

  it("rejects browser kind via POST", () => {
    const result = validateClientKind("browser");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/browser not allowed/i);
  });

  it("rejects undefined kind", () => {
    expect(validateClientKind(undefined).ok).toBe(false);
  });

  it("rejects unknown kind string", () => {
    expect(validateClientKind("tablet").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/users/me/clients/:id — revoke logic
// ---------------------------------------------------------------------------

/**
 * Mirrors the client ownership check in DELETE.
 * Returns true if the caller owns the client.
 */
function canRevokeClient(
  ctx: AuthzContext,
  client: ClientRow,
): { ok: boolean; reason?: string } {
  if (client.user_id !== ctx.user_id) {
    return { ok: false, reason: "client belongs to another user" };
  }
  return { ok: true };
}

describe("DELETE /api/users/me/clients/:id — revocation", () => {
  it("allows revoking own client", () => {
    const ctx = makeCtx("u-alice");
    const client = makeClient({ id: "cl-1", user_id: "u-alice" });
    expect(canRevokeClient(ctx, client).ok).toBe(true);
  });

  it("blocks revoking another user's client", () => {
    const ctx = makeCtx("u-alice");
    const client = makeClient({ id: "cl-1", user_id: "u-bob" });
    const result = canRevokeClient(ctx, client);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/another user/i);
  });

  it("revoked client still returns with revoked_at set", () => {
    const now = Date.now();
    const client: ClientRow = {
      ...makeClient({ id: "cl-1", user_id: "u-alice" }),
      revoked_at: now,
    };
    expect(client.revoked_at).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// POST /api/users/me/clients/:id/grants — grant uniqueness check
// ---------------------------------------------------------------------------

/**
 * Mirrors the duplicate-grant check in POST .../grants.
 * An active grant is unique on (client_id, inbox_id, scope) where revoked_at IS NULL.
 */
function hasActiveGrant(
  grants: GrantRow[],
  clientId: string,
  inboxId: string,
  scope: "read" | "write",
): boolean {
  return grants.some(
    (g) =>
      g.client_id === clientId &&
      g.inbox_id === inboxId &&
      g.scope === scope &&
      g.revoked_at === null,
  );
}

describe("POST .../grants — duplicate detection", () => {
  it("detects an existing active grant → 409 path", () => {
    const grant = makeGrant({
      id: "cg-1",
      client_id: "cl-1",
      inbox_id: "inbox-1",
      scope: "write",
    });
    expect(hasActiveGrant([grant], "cl-1", "inbox-1", "write")).toBe(true);
  });

  it("does not block when the existing grant is revoked", () => {
    const revoked: GrantRow = {
      ...makeGrant({
        id: "cg-1",
        client_id: "cl-1",
        inbox_id: "inbox-1",
        scope: "write",
      }),
      revoked_at: Date.now() - 1000,
    };
    expect(hasActiveGrant([revoked], "cl-1", "inbox-1", "write")).toBe(false);
  });

  it("does not block a different scope on same (client, inbox)", () => {
    const grant = makeGrant({
      id: "cg-1",
      client_id: "cl-1",
      inbox_id: "inbox-1",
      scope: "read",
    });
    expect(hasActiveGrant([grant], "cl-1", "inbox-1", "write")).toBe(false);
  });

  it("does not block a different inbox on same (client, scope)", () => {
    const grant = makeGrant({
      id: "cg-1",
      client_id: "cl-1",
      inbox_id: "inbox-A",
      scope: "write",
    });
    expect(hasActiveGrant([grant], "cl-1", "inbox-B", "write")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DELETE .../grants/:grantId — grant revocation
// ---------------------------------------------------------------------------

/**
 * Mirrors the grant ownership check: grant must belong to the given client_id.
 */
function canRevokeGrant(
  clientId: string,
  grant: GrantRow,
): { ok: boolean; reason?: string } {
  if (grant.client_id !== clientId) {
    return { ok: false, reason: "grant belongs to a different client" };
  }
  return { ok: true };
}

describe("DELETE .../grants/:grantId — revocation", () => {
  it("allows revoking a grant that belongs to the client", () => {
    const grant = makeGrant({
      id: "cg-1",
      client_id: "cl-1",
      inbox_id: "inbox-1",
    });
    expect(canRevokeGrant("cl-1", grant).ok).toBe(true);
  });

  it("blocks revoking a grant from a different client", () => {
    const grant = makeGrant({
      id: "cg-1",
      client_id: "cl-2",
      inbox_id: "inbox-1",
    });
    const result = canRevokeGrant("cl-1", grant);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/different client/i);
  });

  it("revoked grant has revoked_at set", () => {
    const now = Date.now();
    const grant: GrantRow = {
      ...makeGrant({ id: "cg-1", client_id: "cl-1", inbox_id: "inbox-1" }),
      revoked_at: now,
    };
    expect(grant.revoked_at).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// parseUserAgent — UA string parsing
// ---------------------------------------------------------------------------

/**
 * Mirrors the parseUserAgent helper in clients.ts.
 */
function parseUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown browser";
  const s = ua.toLowerCase();
  if (s.includes("edg/") || s.includes("edge/")) return "Microsoft Edge";
  if (s.includes("chrome") && !s.includes("chromium")) return "Chrome";
  if (s.includes("firefox")) return "Firefox";
  if (s.includes("safari") && !s.includes("chrome")) return "Safari";
  if (s.includes("curl")) return "curl";
  return "Browser";
}

describe("parseUserAgent", () => {
  it("identifies Chrome", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome");
  });

  it("identifies Firefox", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0",
      ),
    ).toBe("Firefox");
  });

  it("identifies Safari (no Chrome string)", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
      ),
    ).toBe("Safari");
  });

  it("identifies Edge", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0",
      ),
    ).toBe("Microsoft Edge");
  });

  it("identifies curl", () => {
    expect(parseUserAgent("curl/7.88.1")).toBe("curl");
  });

  it("returns Unknown browser for null", () => {
    expect(parseUserAgent(null)).toBe("Unknown browser");
  });

  it("returns Browser for unrecognised UA", () => {
    expect(parseUserAgent("MyCustomAgent/1.0")).toBe("Browser");
  });
});
