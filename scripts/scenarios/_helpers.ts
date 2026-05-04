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
 * Sign in via the MOCK_MODE dev identity picker. With CF_ACCESS_DEV_MODE=mock,
 * `/login` serves a server-rendered radio-picker (workers/app.ts:renderDevLoginPicker)
 * instead of the better-auth OTP page. POSTing identity=<email> sets
 * `x-mock-user-email` cookie and 303s to `/`.
 *
 * The better-auth OTP flow stays available behind `/login?otp=1` (TODO: not
 * wired yet) and is exercised by a dedicated S-AUTH-OTP-* scenario when the
 * "one-time passport" module is tested in isolation per the user's directive.
 *
 * Steps for mock-picker login:
 *   1. Navigate to /login → server-rendered picker renders.
 *   2. Click the "Custom email" radio + fill `custom_email` with `email`.
 *      (Avoids reliance on which preset is currently mounted.)
 *   3. Submit the form.
 *   4. Wait for the URL to leave /login.
 */
export async function loginAs(
  ctx: ScenarioContext,
  email: string,
): Promise<void> {
  ctx.log(`login as ${email} (dev picker)`);
  await ctx.browser.call("browser_navigate", {
    url: `${ctx.baseUrl}/login`,
  });
  await ctx.screenshot("login-picker");

  // Submit via a programmatic POST instead of form.submit() — submitting the
  // form mid-browser_evaluate destroys the execution context before the
  // serialized return value lands and Playwright throws. fetch() with
  // redirect:'manual' lets us cookie-set then navigate ourselves.
  await ctx.browser.call("browser_evaluate", {
    expression: `(async () => {
      const form = new FormData();
      form.set('identity', 'custom');
      form.set('custom_email', ${JSON.stringify(email)});
      const res = await fetch('/login', { method: 'POST', body: form, redirect: 'manual' });
      // Manual redirects from same-origin POST land as opaqueredirect (status 0)
      // when the browser is willing to follow, OR as 303 with no body
      // depending on fetch policy. Either way the Set-Cookie has applied.
      return { status: res.status, type: res.type };
    })()`,
  });

  // Now navigate to the home view explicitly (cookie is set).
  await ctx.browser.call("browser_navigate", { url: `${ctx.baseUrl}/` });
  await waitForUrlChange(ctx, /\/login(?:\?|#|$)/, { negate: true });
  await ctx.screenshot("post-login");
}

/** Better-auth OTP login (separate from the mock picker — for the
 *  "one-time passport" isolation scenario). Kept for future use. */
export async function loginAsViaOtp(
  ctx: ScenarioContext,
  email: string,
): Promise<void> {
  ctx.log(`OTP login as ${email}`);
  await ctx.browser.call("browser_navigate", {
    url: `${ctx.baseUrl}/login?otp=1`,
  });
  await ctx.fill({ ariaLabel: "Email address" }, email);
  await ctx.click({ text: "Send code" });
  await ctx.waitFor({ selector: '[aria-label="Verification code"]' });
  const otp = await pollForOtp(ctx, email);
  await ctx.fill({ ariaLabel: "Verification code" }, otp.code);
  await ctx.click({ text: "Verify" });
  await waitForUrlChange(ctx, /\/login(?:\?|#|$)/, { negate: true });
}

/**
 * Sign out via the worker's `/logout` endpoint. In MOCK_MODE this clears the
 * `x-mock-user-email` cookie and 303s to /login. The
 * `/cdn-cgi/access/logout` handler is the equivalent for the ProfileMenu
 * link path; both end up at /login.
 */
export async function signOut(ctx: ScenarioContext): Promise<void> {
  ctx.log("sign out via /logout");
  await ctx.browser.call("browser_navigate", {
    url: `${ctx.baseUrl}/logout`,
  });
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
      expression: "location.href",
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
    expression: "location.href",
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
      expression: `document.body && document.body.innerText.includes(${JSON.stringify(text)})`,
    })) as boolean;
    if (present) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `assertText: page never contained "${text}" within ${timeoutMs}ms`,
  );
}
