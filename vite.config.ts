// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Phase G-2 — Turnstile widget site key.  Inlined at build time so the
// React login form can mount the widget without an extra fetch.
//
// Resolution order (highest priority first):
//   1. `process.env.TURNSTILE_SITE_KEY` (explicit override at build invocation)
//   2. `wrangler.jsonc` `vars.TURNSTILE_SITE_KEY` (the canonical source —
//      same value the deployed Worker reads at runtime)
//   3. empty string (the React login form falls back to no Turnstile;
//      Worker-side siteverify still fail-closes on POST without a token)
//
// Phase G T3.5 cutover (2026-05-07) — the previous version of this file
// only checked `process.env`, which is empty during `npm run build` /
// `npm run deploy` because wrangler.jsonc `vars` are RUNTIME, not
// build-time. That silently shipped a `TURNSTILE_SITE_KEY = ""` constant
// to the React bundle, the login page never mounted the widget, and the
// OTP-send fetch hit the Worker without a Turnstile token → 403
// TURNSTILE_FAILED. Reading wrangler.jsonc here gives Vite the same
// truth the Worker sees, eliminating the env-var-coupling failure mode.
function readTurnstileSiteKeyFromWranglerJsonc(): string {
  if (process.env.TURNSTILE_SITE_KEY) return process.env.TURNSTILE_SITE_KEY;
  try {
    const path = resolve(__dirname, "wrangler.jsonc");
    const raw = readFileSync(path, "utf8");
    // Strip JSONC comments before JSON.parse. Order matters: block first,
    // then line comments. The patterns are deliberately conservative — we
    // own this file and don't put `//` inside string literals.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .replace(/[ \t]+\/\/.*$/gm, "");
    const config = JSON.parse(stripped) as {
      vars?: { TURNSTILE_SITE_KEY?: string };
    };
    return config.vars?.TURNSTILE_SITE_KEY ?? "";
  } catch (e) {
    // Fall back to empty string; Worker-side fail-closed siteverify still
    // protects the OTP-send endpoint.
    console.warn(
      "[vite.config] failed to read TURNSTILE_SITE_KEY from wrangler.jsonc:",
      (e as Error).message,
    );
    return "";
  }
}

const TURNSTILE_SITE_KEY = readTurnstileSiteKeyFromWranglerJsonc();

export default defineConfig({
  define: {
    TURNSTILE_SITE_KEY: JSON.stringify(TURNSTILE_SITE_KEY),
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" }, remoteBindings: false }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
