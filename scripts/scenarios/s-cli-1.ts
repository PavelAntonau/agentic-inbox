// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-CLI-1 — Connected Agents panel renders.
 *
 * Branches covered: /account route loads, ClientsPanel mounts, header
 * "Connected Agents" visible, no console errors.
 *
 * Doesn't yet exercise per-kind rows (browser / mcp / ios) — those need
 * fixture seed data. This scenario verifies the render path.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs, assertText } from "./_helpers";

const scenario: Scenario = {
  id: "S-CLI-1",
  description: "Connected Agents panel renders on /account",
  covers: "/account → ClientsPanel mount → header visible",
  smoke: true,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    await ctx.browser.call("browser_navigate", {
      url: `${ctx.baseUrl}/account`,
    });
    await ctx.screenshot("account-loading");

    await assertText(ctx, "Connected Agents", 8_000);
    await ctx.screenshot("account-loaded");

    const console = await ctx.captureConsole("account-page");
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) on /account (see ${console.path})`,
      );
    }
  },
};

export default scenario;
