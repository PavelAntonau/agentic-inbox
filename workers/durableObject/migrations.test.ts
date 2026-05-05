// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Migration-runner correctness + DB-1 (idx_emails_message_id) assertion.
//
// agentic-inbox-hardening Phase 2 (graph: CMyIbSkyuFhw9K1xVVwVi). The DO
// migrations run hand-written SQL against the per-mailbox SQLite store;
// this suite drives the runner against an in-memory better-sqlite3 backend
// shaped to the CF SqlStorage interface and asserts the schema invariants
// the audit cared about (DB-1).

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { applyMigrations, mailboxMigrations } from "./migrations";

// ---------------------------------------------------------------------------
// Minimal SqlStorage shim — adapts better-sqlite3 to the subset of the
// Cloudflare SqlStorage interface that applyMigrations() actually exercises.
// ---------------------------------------------------------------------------

function makeSqlStorage(db: Database.Database) {
  function execIter(query: string, ...params: unknown[]): Iterable<unknown> {
    // Multi-statement scripts (DDL with several `;`-separated stmts) cannot
    // be prepared individually — better-sqlite3 only accepts a single stmt
    // per prepare(). Detect and route through Database.exec() instead.
    const trimmed = query.trim();
    const looksMultiStatement =
      params.length === 0 && /;\s*[\s\S]*\S/.test(trimmed);

    if (looksMultiStatement) {
      db.exec(trimmed);
      return [][Symbol.iterator]();
    }

    const stmt = db.prepare(trimmed);
    if (stmt.reader) {
      const rows = stmt.all(...(params as never[]));
      return rows[Symbol.iterator]();
    }
    stmt.run(...(params as never[]));
    return [][Symbol.iterator]();
  }

  return {
    exec: execIter,
  } as unknown as SqlStorage;
}

function makeStorageStub(db: Database.Database) {
  return {
    transactionSync: <T>(closure: () => T): T => {
      const wrapped = db.transaction(closure);
      return wrapped();
    },
  };
}

interface IndexRow {
  name: string;
  tbl_name: string;
}

function listIndexes(db: Database.Database, tableName: string): IndexRow[] {
  return db
    .prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND tbl_name = ?",
    )
    .all(tableName) as IndexRow[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mailboxMigrations — runner + DB-1 assertions", () => {
  it("applies all migrations cleanly against a fresh database", () => {
    const db = new Database(":memory:");
    const sql = makeSqlStorage(db);
    const storage = makeStorageStub(db);

    // First apply: empty DB → run every migration once.
    applyMigrations(sql, mailboxMigrations, storage);

    // The runner records every applied migration in d1_migrations.
    const applied = db
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all() as { name: string }[];
    expect(applied.map((r) => r.name)).toEqual(
      mailboxMigrations.map((m) => m.name),
    );

    // Second apply: idempotent — every migration is skipped, no errors.
    expect(() =>
      applyMigrations(sql, mailboxMigrations, storage),
    ).not.toThrow();
  });

  it("registers migration 10_message_id_index in the export list", () => {
    const m10 = mailboxMigrations.find((m) => m.name === "10_message_id_index");
    expect(m10).toBeDefined();
    expect(m10!.sql).toMatch(/idx_emails_message_id/);
    expect(m10!.sql).toMatch(/CREATE INDEX IF NOT EXISTS/);

    // Migration 10 must run AFTER migration 9 (parent_id was added there);
    // ordering is the runner's only contract for re-runnability.
    const idx9 = mailboxMigrations.findIndex(
      (m) => m.name === "9_threads_and_email_parent_id",
    );
    const idx10 = mailboxMigrations.findIndex(
      (m) => m.name === "10_message_id_index",
    );
    expect(idx10).toBeGreaterThan(idx9);
  });

  it("creates idx_emails_message_id on the emails table (DB-1 fix)", () => {
    const db = new Database(":memory:");
    applyMigrations(makeSqlStorage(db), mailboxMigrations, makeStorageStub(db));

    const indexes = listIndexes(db, "emails").map((r) => r.name);
    expect(indexes).toContain("idx_emails_message_id");
  });

  it("preserves the indexes created by earlier migrations (regression guard)", () => {
    const db = new Database(":memory:");
    applyMigrations(makeSqlStorage(db), mailboxMigrations, makeStorageStub(db));

    const indexes = listIndexes(db, "emails").map((r) => r.name);
    // Migrations 2, 8, 9 — re-asserted because the DB-1 re-assessment relied on
    // these already existing. If any of them disappear, the audit-mediums
    // analysis silently flips and DB-1 expands back to multiple missing
    // indexes. Treat this list as an invariant.
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_emails_thread_id",
        "idx_emails_in_reply_to",
        "idx_emails_folder_id",
        "idx_emails_date",
        "idx_emails_folder_date",
        "idx_emails_parent",
        "idx_emails_message_id",
      ]),
    );
  });
});
