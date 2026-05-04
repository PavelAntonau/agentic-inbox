// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-AUTH-1 — First-time login via OTP.
 *
 * Branches covered: new user, OTP send, OTP verify, dashboard render.
 *
 * Steps:
 *   1. /__mock/reset (auto by runner) — clean slate.
 *   2. Navigate /login.
 *   3. Enter alice@actionnow.ai → "Send code".
 *   4. Wait for OTP step → fetch OTP from /__mock/otp-latest.
 *   5. Enter OTP → "Verify".
 *   6. Assert URL leaves /login.
 *   7. Assert no console errors.
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs, currentUrl } from "./_helpers";

const scenario: Scenario = {
  id: "S-AUTH-1",
  description: "First-time login via OTP",
  covers: "new user, OTP send, OTP verify, dashboard render",
  smoke: true,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    const url = await currentUrl(ctx);
    if (/\/login(\?|#|$)/.test(url)) {
      throw new Error(`expected to leave /login, still at ${url}`);
    }

    await ctx.screenshot("home");
    const console = await ctx.captureConsole("after-login");
    if (console.errors > 0) {
      throw new Error(
        `${console.errors} console error(s) after login (see ${console.path})`,
      );
    }
  },
};

export default scenario;
