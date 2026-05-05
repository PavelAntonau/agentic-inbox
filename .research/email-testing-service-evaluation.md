# Email-Testing Service Evaluation — Final Report

**Date:** 2026-05-05
**Slug:** `email-testing-service-evaluation`
**Project:** agentic-inbox
**Episode:** `ep_9208483eff50` (`main:opus:research-deep:email-testing-service-evaluation`)
**Branch:** `feature/autonomous-local-testing` @ `d9c32fb`
**Plan:** `.research/email-testing-service-evaluation-plan.md`
**Phase artifacts:** `phase1.md`, `phase2-isd.md`, `phase2-gaps.md`
**Total deep calls:** 1 of 4 budgeted (~$0.91 of ~$3.60 budget; Phase 3 skipped — Phase 2 ISD answered the architecture question)
**Confidence:** **HIGH** for pricing, free-tier limits, and architectural compatibility (every load-bearing claim has a verbatim ISD passage from a canonical source). MEDIUM for "exact shape of `*.resend.app` addresses" and "Resend Inbound retention window" (documented less precisely; verifiable at signup).

---

## Executive summary

There are **two clean paths** to autonomous E2E auth testing for agentic-inbox, both inexpensive, both inside the existing tooling envelope. The agent's first-draft assumption ("we need a third-party email-testing vendor like Mailosaur") missed the more important finding: **Resend itself supports inbound email** on `*.resend.app` subdomains AND on custom MX-routed subdomains, with a webhook on `email.received` that delivers the full message body. That means we can build the test inbox on Resend with zero added vendor — at the cost of Resend's 100/day free quota counting both sends AND receives.

The opinionated recommendation: **start with Path A (Resend Inbound, zero new vendor) and only switch to Path B (Mailosaur Starter $9/mo) if the polished `waitForLatestEmail()` ergonomics matter more than vendor minimalism.** Both work. Both cost under $20/mo at the volume implied by "single dev, 20–100 test runs/day". Both can be wired into Playwright + a Worker endpoint inside one work-day each.

The user's separate complaint — "invite emails still don't arrive" — is almost certainly **NOT a missing testing service**, but one of three things on the existing Resend integration: sender domain not verified in the Resend dashboard; the `RESEND_API_KEY` not set as a Worker secret; or the 100/day Free cap getting silently exhausted by a noisy test loop. Diagnostic recipe at the end of this report.

## Recommendation

### Primary: Resend Inbound on a `*.resend.app` subdomain (zero new vendor) — Path A

**Why.** Resend's own canonical KB confirms: *"Yes. Resend supports receiving emails (inbound) via webhooks. ... You can receive emails at: A Resend-managed `*.resend.app` receiving domain, or your own custom domain by adding the required `MX` record"* [R-inbound]. The webhook delivers full HTML/text/headers + attachment download URLs. We already have a Cloudflare Worker, a DurableObject pattern, and a Resend account — that's the entire stack the test inbox needs. **Zero new monthly fee at small volume; $20/mo Resend Pro removes the daily cap if we ever exceed 50 E2E tests/day.**

**The cost ceiling.** Resend Free is 100 emails/day + 3,000/month transactional, AND **both sent and received emails count against the same quota** [R-quotas, ISD-1]. One full E2E auth test = 1 outbound (the invite) + 1 inbound (the test inbox receives it) = 2 quota slots. Free supports ~50 E2E auth tests/day before throttle. For comfort: Resend Pro at $20/mo lifts the daily cap entirely (50,000/month, no daily) [R-pricing, ISD-2].

**Action for the user.** Stay on the existing Resend account; no signup needed. Either:
- Enable Inbound on a fresh subdomain (e.g. `inbox.actionnow.ai`) by adding the MX record Resend provides, OR
- Use Resend's `*.resend.app` managed receiving domain (no DNS work — Resend hosts it).

In the Resend dashboard: Domains → enable Receiving → register the webhook URL (must be HTTPS) → `email.received` event subscription → copy the `whsec_…` webhook secret into the Worker's `RESEND_WEBHOOK_SECRET`.

### Alternate: Mailosaur Starter ($9/mo, billed annually) — Path B

**Why.** If the user prefers a purpose-built testing platform with a polished `waitForLatestEmail()` SDK and complete isolation between test traffic and production Resend quota, Mailosaur Starter is the cleanest choice. Verbatim from Mailosaur's pricing page: *"Starter — $9 / month (billed annually) — Includes 50 daily email tests — Upgradable to 1,000 daily tests — Unlimited email addresses — API for test automation — SMTP connectivity"* [M-pricing, ISD-8].

**Action for the user.** Sign up at mailosaur.com (no permanent free tier — only a 14-day trial), pick the Starter plan annually ($108/year), receive a `<account>.mailosaur.net` test domain, install `npm i mailosaur`. Tests generate `e2e-${nonce}@<account>.mailosaur.net`; the Worker sends via Resend; test code calls `messages.waitForLatestEmail({server: account, sentTo: address})` to block until arrival; OTP/magic-link extraction lands as a one-line regex.

**Why Mailosaur over MailSlurp.** ISD-9 confirmed MailSlurp's Free tier (30/day, 100/month, 5 inboxes) is too tight for daily dev use, and MailSlurp Pro ($69/mo) is materially more expensive than Mailosaur Starter ($9/mo) for equivalent capacity. Mailosaur Business ($80/mo) competes with MailSlurp Pro at higher volume; Starter wins the small-team budget question.

### Why I'm NOT recommending these

- **Mailtrap Email Sandbox.** ISD-10 confirms the architecture is incompatible: Mailtrap's Sandbox is a CLIENT-side SMTP server (your code connects TO it), not an MX inbound. External Resend sends won't reach a Mailtrap sandbox address.
- **MailSlurp Free.** 30/day cap is too tight; the moment we exceed it, the next tier is $69/mo (8× Mailosaur Starter).
- **Mailpit / Inbucket.** Both are excellent for self-contained dev environments but require public deployment + DNS + TLS to receive external Resend mail — operational overhead not justified when Resend Inbound is one webhook away.
- **Forward Email.** No query API for received messages; useful as an MX-forwarding layer only, not as a test inbox primary.

## What changed from the agent's first draft (ISD corrections)

Phase 1 (the seed deep call) made three pricing/feature errors that ISD caught. Logging them so the report's audit trail is honest:

| Phase 1 claimed | Actual (ISD-verified) | Source |
|---|---|---|
| Resend Pro $35/mo for 100k emails | **Pro $20/mo for 50k emails, no daily cap** | resend.com/pricing |
| Resend Scale $90/mo for 500k emails | **Scale $90/mo for 100k emails, no daily cap** | resend.com/pricing |
| MailSlurp is cheaper than Mailosaur | **Mailosaur Starter $9 is cheaper than MailSlurp Pro $69** at non-Free volumes | mailosaur.com/pricing + mailslurp.com/pricing |
| Mailosaur has a free tier | **Only a 14-day trial; no permanent free tier** | mailosaur.com/pricing |
| (Unsaid — Phase 1 missed it) | **Resend has its own Inbound product on `*.resend.app` or custom MX** | resend.com/docs/knowledge-base/how-can-i-receive-emails-with-resend |
| Resend's official Playwright doc covers full E2E | **It only covers "did the API get called", not "did the email arrive in an inbox"** | resend.com/docs/knowledge-base/end-to-end-testing-with-playwright |

## Why your invite emails probably aren't arriving today (separate diagnosis)

This is a separate question from "which testing service do I pick" — but it is the user's most acute pain. The Phase 2 mail-delivery-diagnosis already ruled out CF Email Routing as the active failure (you switched to Resend yesterday in `workers/lib/resend-client.ts`). The remaining most-likely root causes, in order of probability:

1. **Sender domain `actionnow.ai` not verified in the Resend dashboard.** Resend will accept the API call and return success, then never deliver. Verify under Resend Dashboard → Domains → look for the green "Verified" badge on `actionnow.ai`. If not there, follow `https://resend.com/docs/dashboard/domains/introduction` to add SPF + DKIM TXT records at your DNS provider. **This is the single most likely cause of "the API call succeeds but no mail arrives".**

2. **`RESEND_API_KEY` not set in production Worker.** Diagnostic: `wrangler secret list --env production`. If `RESEND_API_KEY` isn't in the list, the Worker is calling the binding with `undefined` and the `resend-client.ts` re-throw is being swallowed by the invitation route's `try { } catch { /* swallow */ }`. Action: `wrangler secret put RESEND_API_KEY` (paste from `mcp__key__tool_get_secret(service="resend", account="api-key")`).

3. **100/day Free quota silently exhausted.** Resend's quota counts inbound *and* outbound: a busy session that triggered 60 invite tests in development today already spent the budget. Diagnostic: Resend Dashboard → Usage page. **Critical detail from the canonical doc:** *"Multiple `To`, `CC`, or `BCC` recipients in sent emails count as separate emails towards this quota"* [R-quotas, ISD-1]. Even one batch invite to 50 group members eats half the daily allowance.

4. **Recipient-side filtering** (Gmail Promotions tab, Apple junk, corporate filters). Lower probability but routine — verify by checking the Resend dashboard's per-message events: did the message go `delivered`, `bounced`, `complained`, `delayed`, or `suppressed`? If `delivered` but the user can't find it, search their spam folder.

5. **Invitation route is still swallowing errors silently** (`workers/routes/invitations.ts:226-255` catch-and-swallow per `mail-delivery-diagnosis.md` Phase 2 plan T2.4). If T2.4 hasn't shipped yet, the route returns `{sent: true}` even when Resend threw — that's why the dashboard says "invite sent" and the user never gets it. Fix: log structured `mail.send.fail` with reason; surface a non-PII signal to inviter on hard error.

The one-shot diagnostic the agent can run autonomously after the recommendation lands:

```bash
# In the agentic-inbox Worker context
wrangler tail --format pretty &
# Trigger an invite to a recipient you control (your real address)
# In a second pane:
curl -s https://api.resend.com/domains \
  -H "Authorization: Bearer $RESEND_API_KEY" | jq '.[].status'
# Inspect: should be "verified". If "pending" or "not_started", that's #1.
```

## Concrete agent recipe — Path A (Resend Inbound)

End-to-end, this is what an autonomous E2E auth test looks like on Path A:

```
1. Test setup
   - Generate a unique test address: `e2e-${crypto.randomUUID()}@inbox.actionnow.ai`
   - The address doesn't need to exist in advance; Resend's MX accepts any
     local-part on the verified subdomain.

2. Drive the admin flow (Playwright)
   - browser.navigate to /admin/users
   - browser.click "Invite user"
   - browser.fill { email: <test address> }
   - browser.click "Send invitation"
   - assert: page shows "Invitation sent"

3. Wait for the inbound webhook to land
   - The Worker's POST /api/__test__/inbound-webhook handler:
       a. Verifies the Svix signature (raw body, RESEND_WEBHOOK_SECRET).
       b. Parses email.received event.
       c. Stores into a DurableObject keyed by recipient → array of messages
          with TTL = 1 hour.
   - Test code polls GET /api/__test__/inbox/${address}?since=${ts}
     with a 60-second timeout, 500 ms interval.

4. Extract the OTP / magic link from the email body
   - One-line regex: const [_, token] = body.match(/\?token=([A-Za-z0-9_-]+)/);
   - For magic links: extract the full URL.
   - For OTPs: extract the 6 digits matching /\b\d{6}\b/.

5. Drive login completion (Playwright)
   - browser.navigate to the magic-link URL, OR
   - browser.fill the OTP into the login form
   - assert: redirect to /, session cookie present, /me returns the user

6. Cleanup
   - DurableObject auto-purges by TTL.
   - The test address is single-use; no cleanup needed.
```

Wall-clock per test: ~3–5 seconds (admin click → invite → webhook → poll → click → assert), most of which is the network round-trip from Resend SMTP to Resend Inbound webhook (typically <2 s). Comfortably inside Playwright's default 30-second test timeout.

Cost per test on Resend Free: 2 quota slots (1 send + 1 receive). At 100/day cap, that's ~50 E2E auth tests/day. Upgrade to Pro ($20/mo) to remove the daily cap.

## Concrete agent recipe — Path B (Mailosaur Starter)

Same shape, different vendor:

```
1. Test setup
   - account = "MAILOSAUR_SERVER" env var (assigned at signup)
   - address = `e2e-${crypto.randomUUID()}@${account}.mailosaur.net`
   - Mailosaur SDK initialized with MAILOSAUR_API_KEY

2-3. Drive admin flow (same as Path A); then await Mailosaur:
   const message = await mailosaur.messages.waitForLatestEmail({
     server: account,
     sentTo: address,
     timeout: 30_000,  // ms
   });

4. Extract from message.text or message.html (Mailosaur parses both):
   const otp = message.text.codes[0].value;     // built-in OTP extraction
   const link = message.html.links.find(l => l.text === "Sign in").href;

5-6. Same as Path A.
```

Wall-clock: comparable. Cost: $9/mo flat (50 tests/day on Starter). Outbound still consumes Resend Free quota (1 quota slot/test instead of 2 — Mailosaur receives don't burn Resend quota since Resend treats them as a successful delivery to a verified-domain recipient).

## Cost summary

| Scenario | Path A (Resend Inbound) | Path B (Mailosaur Starter) |
|---|---|---|
| 0–50 E2E auth tests/day | **$0/mo** (Resend Free) | $9/mo (Mailosaur Starter, billed annually) |
| 50–1,000 E2E auth tests/day | **$20/mo** (Resend Pro) | $9/mo Starter (50/day cap) → upgrade to Mailosaur Business $80/mo for 5,000/day |
| Bursty CI runs (e.g. 200 tests in one PR) | Stay on Resend Pro $20/mo | Mailosaur Starter $9/mo with daily-test upgrade option, OR Business $80/mo |
| Vendor lock-in risk | None new (already using Resend) | Mailosaur as second vendor |

**For your stated scale ("20–100 test runs/day"):** Path A on Resend Free covers the lower half (≤50/day), Resend Pro $20/mo covers the upper half. Path B Mailosaur Starter $9/mo also covers the upper half exactly. **Path A wins on minimalism; Path B wins on ergonomics.**

## Architecture-level reasoning the user should weigh

1. **"Test the integration we ship in production" vs. "isolate the test rig from prod traffic":** Path A tests REAL Resend send→Resend Receive — high fidelity, but a Resend outage takes both sides down at once. Path B isolates: Resend handles outbound, Mailosaur handles receive — independent failure surfaces, easier to diagnose "is the bug in our send-side or in the auth-callback flow".
2. **Future migration to a self-hosted authorization server:** in Path A, when the user moves auth off better-auth/Resend onto their own server, the test inbox stays on Resend (still receives invite emails sent from the new server). In Path B, the test inbox is decoupled and survives any auth-stack migration unchanged.
3. **DNS work:** Path A using `*.resend.app` — zero DNS work. Path A using a custom subdomain (`inbox.actionnow.ai`) — one MX record. Path B — zero DNS work.
4. **Webhook plumbing:** Path A requires implementing the `email.received` webhook handler with Svix signature verification AND the test-only inbox storage (DurableObject + polling endpoint). Path B requires zero webhook plumbing — Mailosaur handles storage, the SDK provides `waitForLatestEmail()`.

## Open questions (deferrable, NOT blockers)

- **Exact shape of Resend `*.resend.app` test addresses:** the doc confirms the existence of "a Resend-managed `*.resend.app` receiving domain" but doesn't fully specify whether it's `<account>.resend.app` or `<random>.resend.app` per-domain. Verify in dashboard at signup. Either way, the test address pattern works.
- **Resend Inbound message retention:** the pricing page lists "30-day data retention" generically; assume same for inbound but confirm at integration time.
- **Resend Inbound rate limits separately from the 100/day transactional cap:** worth checking on the pricing page Sending & Receiving tab — the doc didn't specify a separate inbound rate limit, but production behavior may differ.

## Recommendation in one sentence

**Wire Path A (Resend Inbound + Worker DurableObject test inbox) first because it's free, in-house, and tests the real send-side. If the agent's experience-of-use proves unwieldy after one work-day of integration, switch to Path B (Mailosaur Starter, $9/mo) — both architectures coexist cleanly and switching the test-side vendor is a 1-day refactor.**

## What I need from you

You said: *"first, do some research on what you're missing for the full cycle, tell me which service you need, I'll register and pay."*

The specific ask:
- **If you accept Path A:** no signup, no payment. Confirm "go ahead with Resend Inbound" and I'll wire the webhook + DurableObject + test-inbox endpoint in the next phase. Optionally, decide whether you want me to upgrade Resend to Pro ($20/mo) preemptively or stay on Free until we hit the cap.
- **If you accept Path B:** sign up at mailosaur.com → pick Starter ($9/mo billed annually = $108) → put the API key into the agent's keychain via `mcp__key__tool_set_secret(service="mailosaur", account="api-key", value=<key>)` and the server name via `mcp__key__tool_set_secret(service="mailosaur", account="server-id", value=<id>)`. Then I'll wire it.
- **The Resend deliverability fix is independent of either path** — it should be done in either case (verify domain in Resend dashboard, set RESEND_API_KEY, audit invite swallow-catch). I can do all three diagnostics autonomously next.

---

## Citations (with ISD passages — Iterative Source Decomposition)

**[R-pricing]** **Resend — Pricing** — https://resend.com/pricing — accessed 2026-05-05 — relevance: high
> Claim: Resend Pro is $20/mo for 50,000 emails with no daily cap.
> Passage: "Pro $20 / mo. 50,000 emails / mo. Extra emails: $0.90 / 1,000. Sending & receiving · Ticket support · 10,000 automation runs · 30-day data retention · 10 domains · 100 AI credits / mo · No daily limit"
> Section: Pricing → Pro

**[R-quotas]** **Resend — Account Quotas and Limits** — https://resend.com/docs/knowledge-base/account-quotas-and-limits — accessed 2026-05-05 — relevance: high
> Claim: Free is 100/day + 3,000/month, both sent AND received count, with a 5x overage cap on paid.
> Passage: "Both **sent emails** and **received emails** (inbound) count towards your account's email quota. Each received email counts as 1 email against your daily and monthly limits, just like sent emails. … Free accounts: Transactional emails: daily email quota of 100 emails/day and 3,000 emails/month. This quota includes both sent and received emails. Multiple `To`, `CC`, or `BCC` recipients in sent emails count as separate emails towards this quota."
> Section: Free Account Quotas and Limits

**[R-inbound]** **Resend — Can I receive emails with Resend?** — https://resend.com/docs/knowledge-base/how-can-i-receive-emails-with-resend — accessed 2026-05-05 — relevance: high
> Claim: Resend supports inbound email via webhooks on `*.resend.app` or custom MX.
> Passage: "Yes. Resend supports receiving emails (inbound) via webhooks. With Receiving, you can: Receive incoming emails and get notified with the `email.received` webhook event. Retrieve full email content (HTML, text, headers) using the Receiving API. Process attachments using attachment metadata and temporary download URLs. You can receive emails at: A Resend-managed `*.resend.app` receiving domain, or your own custom domain by adding the required `MX` record."
> Section: opening paragraph

**[R-inbound-fwd]** **Resend — Forward emails with Resend Inbound** — https://resend.com/docs/knowledge-base/forward-emails-with-resend-inbound — accessed 2026-05-05 — relevance: high
> Claim: Inbound delivers via Svix-signed POST webhook on the `email.received` event; verify with raw body.
> Passage: "Resend can send a webhook to your application's endpoint every time you receive an email. … Add a new POST route to your application's endpoint. … Go to the Webhooks page and click Add Webhook. Select all events you want to observe (e.g., `email.received`). … Make sure that you're using the raw request body when verifying webhooks. The cryptographic signature is sensitive to even the slightest change. Some frameworks parse the request as JSON and then stringify it, and this will also break the signature verification."
> Section: steps 3-5

**[R-playwright]** **Resend — How to set up E2E testing with Playwright** — https://resend.com/docs/knowledge-base/end-to-end-testing-with-playwright — accessed 2026-05-05 — relevance: high
> Claim: Resend's official Playwright pattern stops at "did the API get called"; does NOT cover receive-and-extract.
> Passage: "You can test in two ways: ### Option 1: Call the Resend API — Calling the Resend API tests the entire API flow, including Resend's API responses, but counts towards your account's sending quota. … ### Option 2: Mock a response — Mocking the response lets you test *your* app's flow without calling the Resend API and impacting your account's sending quota. … However you test, it's important to test using a test email address (e.g., `delivered@resend.dev`) so your tests don't impact your deliverability."
> Section: §2 "Write the test spec file"

**[R-test-addrs]** **Resend — What email addresses to use for testing?** — https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing — accessed 2026-05-05 — relevance: medium
> Claim: Resend's `*@resend.dev` test addresses simulate delivery events but are NOT a pollable inbox.
> Passage: "Resend provides a set of safe email addresses specifically designed for testing, ensuring that you can simulate different email events without affecting your domain's reputation. … `delivered@resend.dev` | Email being delivered | `bounced@resend.dev` | Email bouncing | `complained@resend.dev` | Email marked as spam | `suppressed@resend.dev` | Email being suppressed |. … Resend blocks such addresses [example.com / test.com] and returns a `422 Unprocessable Entity` error if you attempt to send to them."
> Section: List of addresses to use

**[R-domains]** **Resend — Managing Domains** — https://resend.com/docs/dashboard/domains/introduction — accessed 2026-05-05 — relevance: medium
> Claim: Resend domain verification requires SPF + DKIM TXT records, optionally DMARC; recommend subdomain over apex.
> Passage: "Resend sends emails using a domain you own. We recommend using subdomains (e.g., `updates.example.com`) to isolate your sending reputation and communicate your intent. … In order to verify a domain, you must set two DNS entries: 1. SPF: list of IP addresses authorized to send email on behalf of your domain. 2. DKIM: public key used to verify email authenticity. These two DNS entries grant Resend permission to send email on your behalf. Once SPF and DKIM verify, you can optionally add a DMARC record to build additional trust with mailbox providers."
> Section: Verifying a domain

**[CF-resend]** **Cloudflare Workers — Send Emails With Resend** — https://developers.cloudflare.com/workers/tutorials/send-emails-with-resend/ — accessed 2026-05-05 — relevance: medium
> Claim: CF Workers + Resend integration is standard HTTPS to api.resend.com; secrets via `wrangler secret put`.
> Passage: "On your Cloudflare dashboard, select the domain you entered earlier and navigate to DNS > Records. Copy/paste the DNS records (DKIM, SPF, and DMARC records) from Resend to your Cloudflare domain. … Sensitive information such as API keys and token should always be stored in secrets. … `wrangler secret put RESEND_API_KEY`"
> Section: Add your domain to Resend / Move API keys to Secrets

**[M-pricing]** **Mailosaur — Pricing** — https://mailosaur.com/pricing — accessed 2026-05-05 — relevance: high
> Claim: Mailosaur Starter $9/mo (annual) for 50 daily tests, unlimited addresses, no permanent free tier.
> Passage: "Starter — For individuals looking to perform a small number of email tests — $9 / month (billed annually) — Includes 50 daily email tests — Upgradable to 1,000 daily tests — Try free for 14 days — Unlimited email addresses — API for test automation … Business — $80 / month (billed annually) — Includes 5,000 daily email tests — Plus 500 SMS messages/month — Up to 5 users (included)"
> Section: Pricing → Starter / Business

**[M-playwright]** **Mailosaur — Automate email verification testing in Playwright** — https://mailosaur.com/blog/playwright-email-verification — accessed 2026-05-05 — relevance: medium
> Claim: Mailosaur ships an official Playwright starter pattern (`npm create mailosaur@latest`) for OTP / magic-link extraction.
> Passage: "Mailosaur as your email testing tool. … Run tests to check any link sent to an email works as intended, which you can use for account creation, or closure processes. … if you choose to send a verification code in your email, it's easy to extract it for testing purposes. … npm create mailosaur@latest"
> Section: How to use Playwright for account verification testing

**[MS-pricing]** **MailSlurp — Pricing** — https://www.mailslurp.com/pricing/ — accessed 2026-05-05 — relevance: high
> Claim: MailSlurp Free 100/mo + 30/day + 5 inboxes; Pro $69/mo for 5,000 inbound; Growth from $249/mo.
> Passage: "| Included new inboxes / month | 30 | 2,000 | 10,000 | 10,000 | | Total inboxes | 5 | 500 | Unlimited | Unlimited | | Included inbound emails / month | 100 | 5,000 | 20,000 | 50,000 | | Inbound emails / day | 30 | Unlimited | Unlimited | Unlimited | | Custom domains | - | 1 | 3 | 10 | … Pro From $69.00 / month … Growth From $249.00 / month"
> Section: Compare features

**[MS-receive]** **MailSlurp — Receiving and downloading emails** — https://www.mailslurp.com/guides/receiving-emails/ — accessed 2026-05-05 — relevance: medium
> Claim: MailSlurp's primary inbound primitive is `WaitForControllerApi` with recommended ≥60-second timeout.
> Passage: "MailSlurp recommends using `waitFor` methods over `getEmails` as the emails you expect may not have arrived when you call MailSlurp. `waitFor` solves this problem. See the WaitForControllerApi for documentation. … It is important to set a timeout when waiting for emails. Email is a slow protocol and provider may differ in their sending speeds. We recommend a timeout of at least 60000ms."
> Section: Waiting for emails

**[MT-pricing]** **Mailtrap — Pricing** — https://mailtrap.io/pricing/ — accessed 2026-05-05 — relevance: medium
> Claim: Mailtrap Email API Free $0/mo for 4,000 emails/mo + 150/day; Basic $15/mo for 10k; Business $85/mo for 100k.
> Passage: "Free — $0/month — 4,000 emails — 1 user — 3 days of email logs — 1 domain — 150 emails/day | Basic — $15/month — 10,000 emails — 3 users — 5 domains | Business — $85/month — 100,000 emails — 1,000 users — 3,000 domains | Enterprise — $750/month — 1,500,000 emails"
> Section: Pricing comparison table

**[MT-sandbox-api]** **Mailtrap — Sandbox API Integration** — https://docs.mailtrap.io/email-sandbox/setup/sandbox-api-integration — accessed 2026-05-05 — relevance: high
> Claim: Mailtrap Email Sandbox is a CLIENT-side SMTP relay (test code connects TO Mailtrap), incompatible with external Resend → Sandbox.
> Passage: "The testing API uses REST protocol and can return calls as JSON objects. … Send a HTTP header `Api-Token: {api_token}`, where `{api_token}` is your API token. … (Sandbox SMTP integration → connect to Mailtrap SMTP servers using the credentials shown in your sandbox.)"
> Section: How to get started with Sandbox API

**[MT-features]** **Mailtrap — Email Sandbox Features and Limits** — https://docs.mailtrap.io/email-sandbox/help/features-and-limits — accessed 2026-05-05 — relevance: medium
> Claim: Sandbox features include forwarding to real inboxes (Basic+), per-10-second rate limits, FIFO cleanup at the per-sandbox cap.
> Passage: "Rate limits per 10 sec: The number of emails you can send to each of your Sandboxes every 10 seconds. … Once the rate limit per 10 seconds is reached, the messages are not getting sent and are rejected with the error '550 5.7.0 Requested action not taken: too many emails per second'. … Total forwarded emails per month — The maximum number of emails you can forward from your account to real inboxes for testing and preview purposes. The maximum number of forwarding rules is 300. Email forwarding is available in the Basic Testing plan and more advanced billing plans."
> Section: features-and-limits page body
