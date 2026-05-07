// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/db/queries/mcp-inbox-binding.ts.
//
// Pure-predicate / SQL-shape tests over the F.2 sentinel-table queries.
// End-to-end behavior (PAT mint with binding, OAuth bind-at-first-call,
// and the cascade on hard-delete) is covered at the scenario layer once
// migration 0017 lands in MOCK_MODE.

import { describe, it, expect } from "vitest";
import {
  buildPatBindingInsertStmt,
  isInboxBindingPkConflict,
} from "./mcp-inbox-binding";

// ---------------------------------------------------------------------------
// isInboxBindingPkConflict — error-text classifier
// ---------------------------------------------------------------------------

describe("isInboxBindingPkConflict", () => {
  it("matches a SQLITE_CONSTRAINT_PRIMARYKEY error on mcp_inbox_binding", () => {
    const err = new Error(
      "D1_ERROR: UNIQUE constraint failed: mcp_inbox_binding.user_id, mcp_inbox_binding.mailbox_id",
    );
    expect(isInboxBindingPkConflict(err)).toBe(true);
  });

  it("matches the alternate 'PRIMARY KEY' phrasing", () => {
    const err = new Error(
      "D1_ERROR: PRIMARY KEY must be unique on mcp_inbox_binding",
    );
    expect(isInboxBindingPkConflict(err)).toBe(true);
  });

  it("returns false for a UNIQUE failure on a different table", () => {
    const err = new Error(
      "D1_ERROR: UNIQUE constraint failed: oauth_personal_access_token.token_hash",
    );
    expect(isInboxBindingPkConflict(err)).toBe(false);
  });

  it("returns false for non-constraint errors that mention the table", () => {
    // Defensive: a stack trace that happens to mention mcp_inbox_binding
    // but doesn't contain "primary key" or "unique" must not be classified
    // as a 409. (Hypothetical, but the predicate should be precise.)
    const err = new Error(
      "Internal database connection lost while reading mcp_inbox_binding",
    );
    expect(isInboxBindingPkConflict(err)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isInboxBindingPkConflict(null)).toBe(false);
    expect(isInboxBindingPkConflict(undefined)).toBe(false);
    expect(isInboxBindingPkConflict("not an error")).toBe(false);
    expect(isInboxBindingPkConflict({})).toBe(false);
    expect(isInboxBindingPkConflict({ message: "" })).toBe(false);
  });

  it("is case-insensitive across the whole match (D1 versions vary)", () => {
    const variants = [
      "UNIQUE CONSTRAINT FAILED: MCP_INBOX_BINDING.USER_ID",
      "unique constraint failed: mcp_inbox_binding",
      "Primary Key violation on mcp_inbox_binding",
    ];
    for (const msg of variants) {
      expect(isInboxBindingPkConflict(new Error(msg))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPatBindingInsertStmt — SQL shape + bind ordering
// ---------------------------------------------------------------------------

describe("buildPatBindingInsertStmt", () => {
  it("issues an INSERT into mcp_inbox_binding with kind='pat' and the supplied bindings", () => {
    type Captured = { sql: string; binds: unknown[] };
    let captured: Captured | null = null;
    const fakeStmt = { _kind: "stmt" } as unknown as D1PreparedStatement;

    const fakeDb = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            captured = { sql, binds: args };
            return fakeStmt;
          },
        };
      },
    } as unknown as D1Database;

    const result = buildPatBindingInsertStmt(fakeDb, {
      userId: "u-alice",
      mailboxId: "m-1",
      patId: "pat_xyz",
      now: 1_700_000_000_000,
    });

    expect(result).toBe(fakeStmt);
    expect(captured).not.toBeNull();
    const cap = captured as unknown as Captured;
    // Statement targets the right table and pins kind='pat' as a literal
    // (no risk of typo'd kind), with NULL for oauth_client_id (XOR rule).
    expect(cap.sql).toContain("mcp_inbox_binding");
    expect(cap.sql).toContain("'pat'");
    expect(cap.sql.toLowerCase()).toContain("insert into");
    // Bind order matches the ?1..?4 placeholders: userId, mailboxId, patId, now
    expect(cap.binds).toEqual(["u-alice", "m-1", "pat_xyz", 1_700_000_000_000]);
  });
});
