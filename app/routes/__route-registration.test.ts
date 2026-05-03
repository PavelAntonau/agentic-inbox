// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase 7 T7.8 — route-registration sanity check.
//
// Phase 6 lesson: two route files (admin/observability + _app/contacts)
// shipped without being registered in app/routes.ts and needed a follow-up
// commit (8058aff fix(shell,ui): MailboxNode Tokens nav…) to wire them in.
// This vitest fails fast so the gap is caught before merge.
//
// Method: pull every app/routes/**/*.{ts,tsx} via Vite's `import.meta.glob`
// and compare against the string literals in app/routes.ts (the
// @react-router/dev/routes API takes string paths). Cloudflare tsconfig
// doesn't expose `node:fs`, so we use the Vite-native glob — already typed
// via `vite/client`.

import { describe, expect, test } from "vitest";

// All sibling .tsx/.ts files under app/routes/ — keys are paths relative
// to THIS file (./_app/contacts.tsx etc.). Test files are excluded so the
// "every file is registered" assertion only sees real routes.
const onDiskGlob = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?url",
  import: "default",
});

// app/routes.ts source as raw text — regex over it is reliable because the
// router API uses string literals for paths.
const routesSourceGlob = import.meta.glob("../routes.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Files under app/routes/ that are intentionally NOT referenced from
 * app/routes.ts. Add an entry here (with a one-line reason) before adding
 * a file you don't intend to register.
 */
const EXEMPT_FROM_REGISTRATION: ReadonlySet<string> = new Set<string>([
  // (none today — every .tsx file under app/routes/ is registered)
]);

function normalizeRouteRelative(relPath: string): string {
  // glob keys look like "./admin/users.tsx" — strip the leading "./" and
  // prefix with "routes/" to match how routes.ts references them.
  return "routes/" + relPath.replace(/^\.\//, "");
}

function listRouteFiles(): string[] {
  return Object.keys(onDiskGlob)
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .filter((p) => !p.startsWith("./__")) // skip this test (it starts with __)
    .map(normalizeRouteRelative);
}

function extractRegisteredPaths(source: string): Set<string> {
  // Match any quoted string starting with "routes/" — that's the file-path
  // slot in route()/index()/layout() calls.
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
  const routesSource = Object.values(routesSourceGlob)[0];
  if (!routesSource) {
    throw new Error(
      "import.meta.glob('../routes.ts') returned no entries — vitest config drift?",
    );
  }
  const registered = extractRegisteredPaths(routesSource);

  test("every app/routes/**/*.{ts,tsx} file is registered in app/routes.ts", () => {
    const onDisk = listRouteFiles().filter(
      (p) => !EXEMPT_FROM_REGISTRATION.has(p),
    );
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
    const onDisk = new Set(listRouteFiles());
    const missing = Array.from(registered).filter((p) => !onDisk.has(p));

    if (missing.length > 0) {
      throw new Error(
        `app/routes.ts references files that don't exist on disk:\n` +
          missing.map((m) => `  - ${m}`).join("\n"),
      );
    }
    expect(missing).toEqual([]);
  });
});
