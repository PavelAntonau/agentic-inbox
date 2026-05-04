// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-AUTH-3 — Two browser sessions + revoke other.
 *
 * Branches covered: Devices/Clients panel render, revoke another session,
 * the revoked session's next API call returns 401.
 *
 * Currently a SKELETON: the underlying revoke-other-session UI lives in the
 * ClientsPanel/AccountRoute work that's still landing. We exercise as much
 * as possible (open second session, log in twice, navigate /account in
 * session A, verify Connected Agents panel renders) and mark the revoke
 * step as a known gap to wire up once the UI is finalised.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs, assertText } from "./_helpers";

const scenario: Scenario = {
  id: "S-AUTH-3",
  description: "Two browser sessions + revoke another (partial — UI gap)",
  covers: "multi-session, /account ClientsPanel render",
  smoke: true,

  async run(ctx) {
    // Session A — primary, opened by the runner.
    await loginAs(ctx, TEST_USERS.alice);
    await ctx.screenshot("session-a-home");

    // Session B — open a second alias against the same worker, log in same
    // user. Different cookie jar → independent session.
    const aliasB = `${await ctx.browser.call("browser_evaluate", { function: "() => 'session-b'" })}-${Date.now() % 1_000_000}`;
    await ctx.browser.call("session_create", {
      alias: aliasB,
      viewport_width: 1280,
      viewport_height: 800,
      device_scale_factor: 2,
    });
    try {
      // Now session B is the active one.
      await loginAs(ctx, TEST_USERS.alice);
      await ctx.screenshot("session-b-home");

      // Switch back to session A and open /account.
      await ctx.browser.call("session_connect", {
        id_or_alias: (await ctx.browser.call(
          "session_list",
        )) /* find session a alias */ as unknown,
      });
    } catch (e) {
      // session_connect signature: best-effort. If it fails, we still
      // captured both sessions' login screenshots — log the gap.
      ctx.log(`session-switch deferred: ${(e as Error).message}`);
    } finally {
      // Always clean up session B explicitly.
      await ctx.browser
        .call("session_close", { id_or_alias: aliasB })
        .catch(() => {});
    }

    await ctx.browser.call("browser_navigate", {
      url: `${ctx.baseUrl}/account`,
    });

    // The Connected Agents panel header must appear.
    try {
      await assertText(ctx, "Connected Agents", 8_000);
    } catch (e) {
      throw new Error(
        `/account did not render Connected Agents header: ${(e as Error).message}`,
      );
    }
    await ctx.screenshot("account-page");

    ctx.log(
      "S-AUTH-3 partial: revoke-other-session step not yet wired (UI in flight). Captured /account render as proxy.",
    );
  },
};

export default scenario;
