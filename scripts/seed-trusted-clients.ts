#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * seed-trusted-clients.ts — T1.6 of the mcp-oauth action plan.
 *
 * Inserts (idempotent) the four pre-registered trusted MCP clients
 * — Claude Code, ChatGPT desktop, Cursor, ActionNowAI iOS — into the
 * `oauth_client` table on the production D1 database.
 *
 * Seeding strategy
 * ----------------
 * Direct `wrangler d1 execute --remote` SQL, NOT a session-bound
 * `auth.api.createOAuthClient(...)` call. Three reasons:
 *
 *   1. `auth.api.createOAuthClient` requires a logged-in user session
 *      (`use: [sessionMiddleware]` in
 *      `node_modules/@better-auth/oauth-provider/dist/index.mjs:1791`).
 *      A one-shot ops script has no session to forge.
 *   2. The API endpoint's Zod body schema does NOT expose `skip_consent`
 *      (it's intentionally stripped via `...rest` at line ~1312, then
 *      forbidden outright on the dynamic-registration path at line 3474:
 *      `z.never({ error: "skip_consent cannot be set during dynamic
 *      client registration" })`). Trusted-client semantics require setting
 *      `skip_consent = 1` on the row, so we MUST go around the public API.
 *   3. Once seeded, "trusted clients must be updated manually" per the
 *      plugin's three guards at lines 1479 / 1506 / 1554 — it'd be
 *      asymmetric to write through the API but require SQL for any
 *      future change.
 *
 * Idempotence
 * -----------
 * `INSERT OR IGNORE` keyed on the `client_id` UNIQUE constraint. Re-runs
 * are no-ops; rows are never silently overwritten. Update existing rows
 * via explicit SQL UPDATE if redirect URIs / logos / scopes change.
 *
 * Type mapping (TS metadata → SQLite column)
 * ------------------------------------------
 *   string[]  →  TEXT  (JSON.stringify, e.g. `["a","b"]`)
 *   boolean   →  INTEGER  (0 or 1)
 *   Date      →  INTEGER  (epoch ms — matches migration 0011 + better-auth's
 *                          drizzle adapter date mode)
 *
 * Usage
 * -----
 *   npx tsx scripts/seed-trusted-clients.ts            # seed prod (--remote)
 *   npx tsx scripts/seed-trusted-clients.ts --dry-run  # print SQL only
 *   npx tsx scripts/seed-trusted-clients.ts --local    # local D1 (--local)
 *
 * Exit codes
 *   0 — all 4 rows present (newly inserted or pre-existing)
 *   1 — wrangler subprocess failed
 *   2 — verification SELECT did not return all 4 expected rows
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRUSTED_CLIENTS,
  type TrustedClient,
} from "../app/lib/cached-trusted-clients.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SCRATCH_DIR = join(REPO_ROOT, ".scratch");
const D1_DATABASE = "agentic-inbox-control-plane";

interface CliFlags {
  dryRun: boolean;
  local: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  return {
    dryRun: argv.includes("--dry-run"),
    local: argv.includes("--local"),
  };
}

/**
 * SQL-escape a string by doubling embedded single quotes, then wrap in
 * single quotes. Sufficient for the constrained metadata we control;
 * intentionally not a general-purpose escaper.
 */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SQL representation of an array column (JSON-stringified TEXT). */
function sqlJsonArray(arr: readonly string[]): string {
  return sqlString(JSON.stringify(arr));
}

/**
 * Build the INSERT statement for a single trusted client. Mirrors the
 * exact column order in `oauth_client` (migration 0011) so that any
 * future column addition surfaces here as a compile / runtime hint.
 */
function buildInsert(client: TrustedClient, nowMs: number): string {
  const cols = [
    "id",
    "client_id",
    "client_secret",
    "disabled",
    "skip_consent",
    "scopes",
    "user_id",
    "created_at",
    "updated_at",
    "name",
    "uri",
    "icon",
    "redirect_uris",
    "token_endpoint_auth_method",
    "grant_types",
    "response_types",
    "public",
    "type",
    "require_pkce",
  ];

  // `id` is the row primary key; `client_id` is the OAuth-spec public ID.
  // We use `client_<clientId>` for `id` so the row identifier never
  // collides with a randomly-generated UUID from later DCR registrations.
  const values = [
    sqlString(`client_${client.clientId}`),
    sqlString(client.clientId),
    "NULL", // client_secret — public clients are PKCE-only
    "0", // disabled = false
    "1", // skip_consent = true (trusted)
    sqlJsonArray(client.scopes),
    "NULL", // user_id — trusted clients are not bound to a single user
    String(nowMs), // created_at
    String(nowMs), // updated_at
    sqlString(client.clientName),
    sqlString(client.clientUri),
    sqlString(client.logoUri),
    sqlJsonArray(client.redirectUris),
    sqlString("none"), // token_endpoint_auth_method = none (PKCE-only)
    sqlJsonArray(["authorization_code", "refresh_token"]),
    sqlJsonArray(["code"]),
    "1", // public = true
    sqlString(client.type),
    "1", // require_pkce = true (PKCE mandatory per OAuth 2.1 §4.1.1)
  ];

  return `INSERT OR IGNORE INTO oauth_client (\n  ${cols.join(", ")}\n) VALUES (\n  ${values.join(", ")}\n);`;
}

function buildSeedSql(nowMs: number): string {
  const banner =
    "-- T1.6 — pre-register trusted MCP OAuth clients.\n" +
    "-- Generated by scripts/seed-trusted-clients.ts. Idempotent via INSERT OR IGNORE.\n" +
    `-- Generated at: ${new Date(nowMs).toISOString()} (epoch ms ${nowMs})\n`;

  const inserts = TRUSTED_CLIENTS.map((c) => buildInsert(c, nowMs)).join(
    "\n\n",
  );

  // Verification SELECT — printed in the same SQL file so wrangler reports
  // the row count immediately. Names are filtered to our trusted IDs so
  // the count is exactly 4 in the green case.
  const ids = TRUSTED_CLIENTS.map((c) => sqlString(c.clientId)).join(", ");
  const verify = `SELECT client_id, name, skip_consent, public, require_pkce\nFROM oauth_client\nWHERE client_id IN (${ids})\nORDER BY client_id;`;

  return `${banner}\n${inserts}\n\n-- Verification\n${verify}\n`;
}

function runWrangler(flags: CliFlags, sqlPath: string): number {
  const args = [
    "wrangler",
    "d1",
    "execute",
    D1_DATABASE,
    flags.local ? "--local" : "--remote",
    `--file=${sqlPath}`,
  ];

  // Use `npx -y` so wrangler is resolved from the project's node_modules,
  // matching the version the deploy script runs.
  const result = spawnSync("npx", ["-y", ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });

  return result.status ?? 1;
}

function runVerify(flags: CliFlags): {
  status: number;
  rowCount: number;
} {
  const ids = TRUSTED_CLIENTS.map((c) => `'${c.clientId}'`).join(", ");
  const command = `SELECT COUNT(*) AS n FROM oauth_client WHERE client_id IN (${ids});`;

  const result = spawnSync(
    "npx",
    [
      "-y",
      "wrangler",
      "d1",
      "execute",
      D1_DATABASE,
      flags.local ? "--local" : "--remote",
      "--json",
      `--command=${command}`,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: process.env },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    return { status: result.status ?? 1, rowCount: 0 };
  }

  // wrangler --json emits an array of result envelopes. The COUNT(*) value
  // lives at results[0].results[0].n. Be defensive about the shape since
  // wrangler's JSON contract has shifted historically.
  let rowCount = 0;
  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      results?: Array<{ n?: number }>;
    }>;
    rowCount = parsed[0]?.results?.[0]?.n ?? 0;
  } catch (e) {
    process.stderr.write(`Failed to parse wrangler --json output: ${e}\n`);
    process.stderr.write(`Raw stdout:\n${result.stdout}\n`);
    return { status: 1, rowCount: 0 };
  }

  return { status: 0, rowCount };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const nowMs = Date.now();
  const sql = buildSeedSql(nowMs);

  if (flags.dryRun) {
    process.stdout.write(sql);
    process.stdout.write(
      `\n-- DRY RUN — ${TRUSTED_CLIENTS.length} clients would be seeded.\n`,
    );
    process.exit(0);
  }

  mkdirSync(SCRATCH_DIR, { recursive: true });
  const sqlPath = join(SCRATCH_DIR, `seed-trusted-clients-${nowMs}.sql`);
  writeFileSync(sqlPath, sql, { encoding: "utf8" });
  process.stdout.write(`[STEP 1/2] SQL written → ${sqlPath}\n`);

  const target = flags.local ? "--local" : "--remote";
  process.stdout.write(
    `[STEP 1/2] Running: npx wrangler d1 execute ${D1_DATABASE} ${target} --file=${sqlPath}\n`,
  );

  const wranglerStatus = runWrangler(flags, sqlPath);
  if (wranglerStatus !== 0) {
    process.stderr.write(
      `[FAIL] wrangler exited ${wranglerStatus}. Aborting before verification.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`[STEP 2/2] Verifying row count\n`);
  const { status, rowCount } = runVerify(flags);
  if (status !== 0) {
    process.stderr.write(`[FAIL] verification SELECT failed.\n`);
    process.exit(1);
  }

  if (rowCount !== TRUSTED_CLIENTS.length) {
    process.stderr.write(
      `[FAIL] Expected ${TRUSTED_CLIENTS.length} trusted-client rows, ` +
        `found ${rowCount}. Inspect oauth_client manually.\n`,
    );
    process.exit(2);
  }

  process.stdout.write(
    `[OK] ${rowCount}/${TRUSTED_CLIENTS.length} trusted clients present in oauth_client.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[FAIL] Unhandled error: ${err}\n`);
  process.exit(1);
});
