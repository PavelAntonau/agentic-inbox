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

    await signOut(ctx);
    const after = await currentUrl(ctx);
    if (!/\/login(\?|#|$)/.test(after)) {
      throw new Error(`expected /login after sign-out, got ${after}`);
    }

    // Hitting / now should redirect back to /login (cookie cleared).
    await ctx.browser.call("browser_navigate", { url: `${ctx.baseUrl}/` });
    const reAfter = await currentUrl(ctx);
    if (!/\/login/.test(reAfter)) {
      throw new Error(`expected redirect to /login on /, got ${reAfter}`);
    }

    // And we can log in again with a fresh OTP.
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
