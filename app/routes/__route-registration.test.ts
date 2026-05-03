// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase 7 T7.8 — route-registration sanity check.
//
// Phase 6 lesson: two route files (admin/observability + _app/contacts) shipped
// without being registered in app/routes.ts, then needed a follow-up commit
// (8058aff fix(shell,ui): MailboxNode Tokens nav…) to wire them in. This test
// fails fast at vitest time so the gap is caught before merge.
//
// Method: parse app/routes.ts as text (the @react-router/dev/routes API uses
// string-literal file paths, so a regex over the source is reliable). Compare
// against globbed `app/routes/**/*.tsx` minus test files and a documented
// exemption list.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const APP_DIR = join(__dirname, "..");
const ROUTES_DIR = __dirname;
const ROUTES_TS = join(APP_DIR, "routes.ts");

/**
 * Files under app/routes/ that are intentionally NOT referenced from
 * app/routes.ts. Add an entry here (with a one-line reason) before adding a
 * file you don't intend to register.
 */
const EXEMPT_FROM_REGISTRATION: ReadonlySet<string> = new Set<string>([
  // (none today — every .tsx file under app/routes/ is registered)
]);

function listRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listRouteFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".tsx") && !entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.tsx") || entry.endsWith(".test.ts")) continue;
    // Path relative to app/, e.g. "routes/admin/users.tsx" — matches the
    // string literals used in app/routes.ts.
    acc.push(relative(APP_DIR, full));
  }
  return acc;
}

function extractRegisteredPaths(source: string): Set<string> {
  // routes.ts entries look like: route("admin", "routes/admin/_layout.tsx", [...])
  //                              index("routes/home.tsx")
  //                              layout("routes/_app.tsx", [...])
  // The path is always the FIRST or SECOND string literal in the call. Match
  // any quoted string starting with "routes/" — that's the file-path slot.
  const matches = source.matchAll(
    /["']routes\/[A-Za-z0-9_$./-]+\.(?:tsx|ts)["']/g,
  );
  const out = new Set<string>();
  for (const m of matches) {
    out.add(m[0].slice(1, -1));
  }
  return out;
}

describe("Phase 7 T7.8 — route-registration sanity", () => {
  test("every app/routes/**/*.tsx file is referenced from app/routes.ts", () => {
    const onDisk = listRouteFiles(ROUTES_DIR).filter(
      (p) => !EXEMPT_FROM_REGISTRATION.has(p),
    );
    const registered = extractRegisteredPaths(readFileSync(ROUTES_TS, "utf8"));
    const missing = onDisk.filter((p) => !registered.has(p));

    if (missing.length > 0) {
      throw new Error(
        `Route files exist on disk but are NOT registered in app/routes.ts:\n` +
          missing.map((m) => `  - ${m}`).join("\n") +
          `\n\nFix: add a route(...) / index(...) / layout(...) entry in ` +
          `app/routes.ts, OR add an EXEMPT_FROM_REGISTRATION entry in ` +
          `app/routes/__route-registration.test.ts with a reason.`,
      );
    }
    expect(missing).toEqual([]);
  });

  test("every routes.ts file reference points to an existing file", () => {
    const onDisk = new Set(listRouteFiles(ROUTES_DIR));
    const registered = extractRegisteredPaths(readFileSync(ROUTES_TS, "utf8"));
    const missing = Array.from(registered).filter((p) => !onDisk.has(p));

    if (missing.length > 0) {
      throw new Error(
        `app/routes.ts references files that don't exist:\n` +
          missing.map((m) => `  - ${m}`).join("\n"),
      );
    }
    expect(missing).toEqual([]);
  });
});
