// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-AUTH-2 — Sign-out + re-login.
 *
 * Branches covered: signOut() flow, /login redirect, cookie clear, second
 * OTP can be requested for the same email.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs, signOut, currentUrl } from "./_helpers";

const scenario: Scenario = {
  id: "S-AUTH-2",
  description: "Sign out, then sign back in",
  covers: "signOut, /login redirect, cookie clear, OTP rotation",
  smoke: true,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);
    await ctx.screenshot("home-1");

    // Verify pre-signout cookie state.
    const beforeCookie = (await ctx.browser.call("browser_evaluate", {
      expression: `document.cookie`,
    })) as string;
    ctx.log(`pre-signout cookies: ${beforeCookie}`);

    await signOut(ctx);
    const after = await currentUrl(ctx);
    if (!/\/login(\?|#|$)/.test(after)) {
      throw new Error(`expected /login after sign-out, got ${after}`);
    }

    // Verify the x-mock-user-email cookie was actually cleared. NOTE: in
    // MOCK_MODE the BOOTSTRAP_DEV_EMAIL env var falls back to re-auth on
    // the next request, so a / fetch after sign-out lands on home. The
    // cookie-clear is the durable behavior to assert here. (Finding
    // F-PHASE2-003 — sign-out is effectively a no-op for protected pages
    // when BOOTSTRAP_DEV_EMAIL is set.)
    const afterCookie = (await ctx.browser.call("browser_evaluate", {
      expression: `document.cookie`,
    })) as string;
    ctx.log(`post-signout cookies: ${afterCookie}`);
    if (afterCookie.includes("x-mock-user-email=")) {
      throw new Error(
        `expected x-mock-user-email cookie cleared, still present: ${afterCookie}`,
      );
    }

    // And we can log back in.
    await loginAs(ctx, TEST_USERS.alice);
    await ctx.screenshot("home-2");

    const console = await ctx.captureConsole("after-relogin");
    // Be tolerant of pre-existing benign warnings — only fail on >0 errors.
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) after relogin (see ${console.path})`,
      );
    }
  },
};

export default scenario;
