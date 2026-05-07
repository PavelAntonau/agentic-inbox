// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Phase G-2 — Turnstile widget site key.  Inlined at build time so the
// React login form can mount the widget without an extra fetch.  In
// production this is set in `wrangler.jsonc` `vars`; locally export it
// before `pnpm dev` (Cloudflare publishes a "always-passes" test key
// `1x00000000000000000000AA` for development).
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY ?? "";

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
