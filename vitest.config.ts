// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // Stub the CF runtime module so Durable Object classes can be unit-tested
      // in the happy-dom environment without a real Workers runtime.
      "cloudflare:workers": new URL(
        "./test/stubs/cloudflare-workers.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["app/**/*.test.{ts,tsx}", "workers/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
