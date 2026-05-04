// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Common scenario helpers — sign-in, sign-out, navigation primitives.
 *
 * These wrap the low-level ScenarioContext API in flow-shaped functions so
 * each scenario reads as a story, not a sequence of clicks.
 */

import type { ScenarioContext } from "./_types";

/** Default test users seeded by /__mock/reset (when fixtures land in T1.4+). */
export const TEST_USERS = {
  alice: "alice@actionnow.ai",
  bob: "bob@actionnow.ai",
} as const;

/**
 * Drive the OTP login flow end-to-end for `email`. Lands on the home view.
 *
 * Steps:
 *   1. Navigate to /login.
 *   2. Fill the email input + click "Send code".
 *   3. Wait for the OTP step to render.
 *   4. Read the OTP from /__mock/otp-latest.
 *   5. Fill it + click "Verify".
 *   6. Wait for the URL to leave /login.
 */
export async function loginAs(
  ctx: ScenarioContext,
  email: string,
): Promise<void> {
  ctx.log(`login as ${email}`);
  await ctx.browser.call("browser_navigate", {
    url: `${ctx.baseUrl}/login`,
  });
  await ctx.screenshot("login-empty");

  await ctx.fill({ ariaLabel: "Email address" }, email);
  await ctx.click({ text: "Send code" });

  // Wait until the OTP input mounts (aria-label flips to "Verification code").
  await ctx.waitFor({ selector: '[aria-label="Verification code"]' });
  await ctx.screenshot("otp-step");

  // Pull the OTP from the mock tee.
  const otp = await pollForOtp(ctx, email);
  ctx.log(`fetched OTP ${otp.code} for ${email}`);

  await ctx.fill({ ariaLabel: "Verification code" }, otp.code);
  await ctx.click({ text: "Verify" });

  // The login page redirects on success; wait until we leave it.
  await waitForUrlChange(ctx, /\/login(?:\?|#|$)/, { negate: true });
  await ctx.screenshot("post-login");
}

/** Clicks the sign-out link in ProfileMenu — assumes we are signed in. */
export async function signOut(ctx: ScenarioContext): Promise<void> {
  ctx.log("sign out via /cdn-cgi/access/logout");
  // The link target is stable; navigating is more reliable than chasing the
  // ProfileMenu open state across renders.
  await ctx.browser.call("browser_navigate", {
    url: `${ctx.baseUrl}/cdn-cgi/access/logout`,
  });
  // Server returns 303 → /login; the page should land there.
  await waitForUrlChange(ctx, /\/login/, { negate: false });
  await ctx.screenshot("post-signout");
}

/** Poll /__mock/otp-latest with a short retry — the OTP may lag a tick. */
export async function pollForOtp(
  ctx: ScenarioContext,
  email: string,
  timeoutMs = 5_000,
): Promise<{ code: string; email: string; created_iso: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await ctx.mock.otpLatest(email);
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(
    `no OTP for ${email} after ${timeoutMs}ms: ${(lastError as Error)?.message ?? "unknown"}`,
  );
}

/**
 * Wait until the active page's URL matches (or stops matching) `pattern`.
 * Polls via browser_evaluate every 200ms; throws on timeout.
 */
export async function waitForUrlChange(
  ctx: ScenarioContext,
  pattern: RegExp,
  opts: { negate?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const negate = opts.negate ?? false;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = (await ctx.browser.call("browser_evaluate", {
      function: "() => location.href",
    })) as string;
    const matches = pattern.test(url);
    if ((negate && !matches) || (!negate && matches)) {
      ctx.log(`url ${negate ? "left" : "matches"} ${pattern}: ${url}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `waitForUrlChange timeout (${negate ? "leave" : "match"} ${pattern}) after ${timeoutMs}ms`,
  );
}

/** Read current URL via browser_evaluate. */
export async function currentUrl(ctx: ScenarioContext): Promise<string> {
  return (await ctx.browser.call("browser_evaluate", {
    function: "() => location.href",
  })) as string;
}

/** Assert that the page contains `text` somewhere visible, polling briefly. */
export async function assertText(
  ctx: ScenarioContext,
  text: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = (await ctx.browser.call("browser_evaluate", {
      function: `() => document.body.innerText.includes(${JSON.stringify(text)})`,
    })) as boolean;
    if (present) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `assertText: page never contained "${text}" within ${timeoutMs}ms`,
  );
}
