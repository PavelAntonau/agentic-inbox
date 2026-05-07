# Phase G-2 — Cloudflare Dashboard Configuration Checklist

Operator runbook. Apply these settings manually in the Cloudflare dashboard
**after** code is deployed. All items are within the **Free plan** scope.
No Pro / Business / Enterprise features are referenced.

---

## 1. Bot Fight Mode

**Navigation:** Cloudflare Dashboard → your zone → Security → Bots

- [ ] Set **Bot Fight Mode** to **ON**
  - This is the Free-plan bot mitigation tier. It challenges known bad bots
    at the edge with no code changes required.
  - Do NOT enable Super Bot Fight Mode (Pro only).

---

## 2. DDoS Sensitivity

**Navigation:** Cloudflare Dashboard → your zone → Security → DDoS

- [ ] Confirm that **HTTP DDoS Attack Protection** ruleset is enabled (it is
  active by default on all plans — verify it has not been disabled).
- [ ] Set the **Sensitivity Level** to **High** if available for your plan,
  otherwise leave on **Default**.
  - The Free plan's automatic DDoS mitigation fires at the "Default" threshold.
    "High" sensitivity lowers the trigger threshold and is available on Free.
  - Do NOT configure custom DDoS Managed Rulesets (Pro only).

---

## 3. Rate Limit Rule — OTP Endpoint (Free Plan: 1 rule, IP-only)

**Navigation:** Cloudflare Dashboard → your zone → Security → WAF → Rate limiting rules

> **Free plan constraint:** one active rate-limit rule per zone, IP-only
> counting, minimum window 10 seconds. Per-cookie / per-header counting and
> multiple rules require Pro or Business. This single rule covers the
> highest-risk surface (OTP send).

- [ ] Click **Create rule**
- [ ] **Rule name:** `OTP send — per-IP rate limit`
- [ ] **Field:** URI Path  **Operator:** starts with  **Value:** `/api/auth/email-otp/`
- [ ] **Counting:** Per IP address
- [ ] **Requests:** `5`  **Period:** `10 seconds`
- [ ] **Action:** Block (returns 429)
- [ ] **Duration:** 1 minute (or leave at default)
- [ ] Save and **enable** the rule

---

## 4. Turnstile — Generate Site Key and Secret

**Navigation:** Cloudflare Dashboard → Turnstile (left sidebar, top-level)

### 4a. Create a widget

- [ ] Click **Add widget**
- [ ] **Widget name:** `ActionNowAI Mail Login`
- [ ] **Domains:** add your production domain (e.g. `mail.actionnow.ai`)
  - Also add `localhost` or your staging domain if you want the widget to
    render in non-production environments.
- [ ] **Widget type:** choose **Managed** (recommended — CF decides invisibility
  vs. challenge based on risk). Use **Non-interactive** only if you want it
  always invisible regardless of risk. Do NOT choose **Invisible** for a
  login form — visible fallback challenges are the correct UX.
- [ ] Click **Create**

### 4b. Copy credentials

- [ ] Copy the **Site Key** (public, safe to embed in frontend JS).
- [ ] Copy the **Secret Key** (server-side only — never expose to clients).

### 4c. Place credentials in the Worker

The integrator (Teammate C) must add these to `wrangler.jsonc` / secrets:

| Variable | Where | Value |
|---|---|---|
| `TURNSTILE_SITE_KEY` | `wrangler.jsonc` `vars` block (build-time Vite define) | Site Key from step 4b |
| `TURNSTILE_SECRET_KEY` | `wrangler secret put TURNSTILE_SECRET_KEY` | Secret Key from step 4b |

> `TURNSTILE_SITE_KEY` must also be added to Vite's `define` block in
> `vite.config.ts` so the React login page can read it at build time:
>
> ```ts
> // vite.config.ts
> define: {
>   TURNSTILE_SITE_KEY: JSON.stringify(process.env.TURNSTILE_SITE_KEY ?? ""),
> }
> ```
>
> Set `TURNSTILE_SITE_KEY` in `.dev.vars` (gitignored) for local development.

- [ ] Run `wrangler secret put TURNSTILE_SECRET_KEY` and paste the Secret Key
  when prompted. Confirm with `wrangler secret list`.
- [ ] Add `TURNSTILE_SITE_KEY` to the `vars` block in `wrangler.jsonc`
  (Teammate C owns this file).
- [ ] Add `TURNSTILE_SITE_KEY` to the `define` block in `vite.config.ts`.
- [ ] Redeploy the Worker after secrets and vars are in place.

---

## 5. Verification

After deploying, verify the full flow:

- [ ] Visit `/login` — the Turnstile widget should render below the email input.
- [ ] Complete the challenge, enter a valid email, click "Send code" — the OTP
  email should be sent (no 403 from the Turnstile middleware).
- [ ] Attempt the same flow with browser DevTools → Network → cancel the
  Turnstile challenge (block `challenges.cloudflare.com`) — the "Send code"
  button should remain disabled (no token).
- [ ] Verify the rate-limit rule fires: send 6+ OTP requests from the same IP
  in 10 seconds → expect HTTP 429 from the edge.

---

## Out of scope for v1 (Free plan ceiling)

The following items were considered and deferred because they require Pro or
Business plan features. Note here for future reference:

- **Multiple rate-limit rules** (e.g. separate rules for `/api/auth/sign-in/`
  and `/api/auth/email-otp/`) — Pro plan minimum. v1.1: add second rule on Pro
  upgrade.
- **Per-session / per-cookie counting** in rate-limit rules — Business plan.
  Application-layer session tracking is the Free-plan alternative.
- **Super Bot Fight Mode** (ML-scored bots, JS challenge for borderline
  requests) — Pro plan. Bot Fight Mode (Free) is sufficient for v1.
- **DDoS Managed Ruleset overrides** (custom sensitivity per path) — Pro plan.
  Default automatic mitigation is the Free-plan baseline.
- **`http.response.code`-based rate-limit counting** (count only 200 responses
  to distinguish real users from blocked bots) — Business plan.
