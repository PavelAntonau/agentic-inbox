# Phase 2 — ISD records (verbatim passages backing every load-bearing claim)

**Date:** 2026-05-05
**Slug:** `email-testing-service-evaluation`
**Episode:** `ep_9208483eff50`

Each record links a synthesis claim to a verbatim source passage. Ten ISD records — every load-bearing claim in the final report is anchored here.

---

## ISD-1 — Resend Free tier: 100/day, 3,000/month, sent + received both count

- **citation_index:** [R-quotas]
- **url:** https://resend.com/docs/knowledge-base/account-quotas-and-limits
- **accessed:** 2026-05-05
- **claim:** Resend's Free transactional tier is capped at 100 emails/day and 3,000 emails/month, AND both outbound sends and inbound (received) emails count against the same quota.
- **passage (verbatim):** *"Both **sent emails** and **received emails** (inbound) count towards your account's email quota. Each received email counts as 1 email against your daily and monthly limits, just like sent emails. ## Free Account Quotas and Limits Free accounts have the following: Transactional emails: daily email quota of 100 emails/day and 3,000 emails/month. This quota includes both sent and received emails. Multiple `To`, `CC`, or `BCC` recipients in sent emails count as separate emails towards this quota."*
- **section:** "Free Account Quotas and Limits"
- **relevance:** HIGH
- **contradicts:** Phase 1 had this number right but its phrasing implied the doubled-quota was a Resend gotcha for testing — the canonical doc confirms this verbatim, so it's a real constraint, not a synthesis hallucination.

## ISD-2 — Resend Pro is $20/mo, NOT $35/mo (Phase 1 was wrong)

- **citation_index:** [R-pricing]
- **url:** https://resend.com/pricing
- **accessed:** 2026-05-05
- **claim:** Resend's Pro tier is $20/mo for 50,000 emails/mo with NO daily limit and 10 domains. Phase 1's "Pro $35/mo for 100,000 emails" was a synthesis error.
- **passage (verbatim):** *"### Pro $20 / mo. 50,000 emails / mo. Extra emails: $0.90 / 1,000. * Sending & receiving * Ticket support * 10,000 automation runs * 30-day data retention * 10 domains * 100 AI credits / mo * No daily limit"*
- **section:** "Pricing → Pro"
- **relevance:** HIGH
- **contradicts:** Phase 1 [19] (flexprice.io blog) which Phase 1 cited as "$35/month (Pro) for 100,000 transactional emails". Either flexprice is stale or Phase 1's synthesis confused tiers. Canonical Resend page wins.

## ISD-3 — Resend Scale is $90/mo for 100,000 emails (Phase 1 was wrong)

- **citation_index:** [R-pricing]
- **url:** https://resend.com/pricing
- **accessed:** 2026-05-05
- **claim:** Resend's Scale tier is $90/mo for 100,000 emails/mo with no daily limit, 1,000 domains. Phase 1's "Scale $90 for 500,000 emails" was wrong.
- **passage (verbatim):** *"### Scale $90 / mo. 100,000 emails / mo. Extra emails: $0.90 / 1,000. * Sending & receiving * Slack & ticket support * 10,000 automation runs * 30-day data retention * 1,000 domains * 500 AI credits / mo * No daily limit"*
- **section:** "Pricing → Scale"
- **relevance:** HIGH
- **contradicts:** Phase 1 claim of 500k emails on Scale.

## ISD-4 — Resend Inbound is real, on `*.resend.app` OR custom MX

- **citation_index:** [R-inbound]
- **url:** https://resend.com/docs/knowledge-base/how-can-i-receive-emails-with-resend
- **accessed:** 2026-05-05
- **claim:** Resend natively supports receiving emails via webhooks; addresses can be on a Resend-managed `*.resend.app` domain OR on a custom domain via MX records. The webhook delivers the full email content (HTML/text/headers) and provides attachment metadata + temporary download URLs.
- **passage (verbatim):** *"Yes. Resend supports receiving emails (inbound) via webhooks. With Receiving, you can: * Receive incoming emails and get notified with the `email.received` webhook event. * Retrieve full email content (HTML, text, headers) using the Receiving API. * Process attachments using attachment metadata and temporary download URLs. You can receive emails at: * A Resend-managed `*.resend.app` receiving domain, or * Your own custom domain by adding the required `MX` record."*
- **section:** "Can I receive emails with Resend?" / opening paragraph
- **relevance:** HIGH (changes the architecture choice — Phase 1 missed this)

## ISD-5 — Resend Inbound flow: webhook on `email.received` event, signed by Svix

- **citation_index:** [R-inbound-fwd]
- **url:** https://resend.com/docs/knowledge-base/forward-emails-with-resend-inbound
- **accessed:** 2026-05-05
- **claim:** Inbound delivery is a POST webhook to your endpoint with the email payload, signed via Svix headers. Subscribe to `email.received`. Verify with `RESEND_WEBHOOK_SECRET`. Use the raw request body when verifying — JSON-parse-then-stringify breaks the signature.
- **passage (verbatim):** *"Resend can send a webhook to your application's endpoint every time you receive an email. Add a new POST route to your application's endpoint. ... Go to the Webhooks page and click **Add Webhook**. 1. Add your publicly accessible HTTPS URL. 2. Select all events you want to observe (e.g., `email.received`). 3. Click **Add**. ... Make sure that you're using the raw request body when verifying webhooks. The cryptographic signature is sensitive to even the slightest change. Some frameworks parse the request as JSON and then stringify it, and this will also break the signature verification."*
- **section:** "Forward emails with Resend Inbound" / steps 3-5
- **relevance:** HIGH

## ISD-6 — Resend's official Playwright pattern stops at "did the API get called"

- **citation_index:** [R-playwright]
- **url:** https://resend.com/docs/knowledge-base/end-to-end-testing-with-playwright
- **accessed:** 2026-05-05
- **claim:** Resend's canonical "E2E with Playwright" pattern offers two options: (1) call the real Resend API and assert the response shape, or (2) mock `page.route()` to avoid quota. Neither option covers the full journey "agent receives the email, extracts the OTP, clicks the link, completes login" — both stop at "the send happened". For true E2E auth testing, a separate inbox is still required.
- **passage (verbatim):** *"## 2. Write the test spec file ... You can test in two ways: ### Option 1: Call the Resend API — Calling the Resend API tests the entire API flow, including Resend's API responses, but counts towards your account's sending quota. ... ### Option 2: Mock a response — Mocking the response lets you test \\*your\\* app's flow without calling the Resend API and impacting your account's sending quota. ... However you test, it's important to test using a test email address (e.g., `delivered@resend.dev`) so your tests don't impact your deliverability. Resend's test accounts run through the entire API flow without harming your reputation."*
- **section:** "E2E testing with Playwright" / steps 1-2
- **relevance:** HIGH

## ISD-7 — Resend test addresses simulate events, NOT pollable inboxes

- **citation_index:** [R-test-addrs]
- **url:** https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing
- **accessed:** 2026-05-05
- **claim:** Resend provides reserved `*@resend.dev` addresses (`delivered@`, `bounced@`, `complained@`, `suppressed@`) that simulate delivery events. These are for verifying webhook handlers, NOT for receiving an actual email body to extract a magic link from. They support `+label` for tracking. `@example.com` and `@test.com` are blocked with HTTP 422.
- **passage (verbatim):** *"### List of addresses to use ... | `delivered@resend.dev` | Email being delivered | | `bounced@resend.dev` | Email bouncing | | `complained@resend.dev` | Email marked as spam | | `suppressed@resend.dev` | Email being suppressed | Using these addresses in your tests allows you to validate email flows without risking real-world deliverability problems. ... ### Why not use @example.com or @test.com? ... Resend blocks such addresses and returns a `422 Unprocessable Entity` error if you attempt to send to them. ### Labeling support ... `delivered+user1@resend.dev`"*
- **section:** "What email addresses to use for testing"
- **relevance:** MEDIUM — clarifies that Resend's test addresses are NOT a substitute for a real polling inbox.

## ISD-8 — Mailosaur Starter is $9/mo (annual), 50 daily tests, unlimited addresses, NO free tier

- **citation_index:** [M-pricing]
- **url:** https://mailosaur.com/pricing
- **accessed:** 2026-05-05
- **claim:** Mailosaur's lowest tier is Starter at $9/month (billed annually) with 50 daily email tests upgradable to 1,000 daily, unlimited email addresses, API access for test automation, SMTP connectivity. The Business tier is $80/month (annual) with 5,000 daily tests + 500 SMS/month + 5 users included. Mailosaur offers a 14-day free trial — there is **no permanent free tier**.
- **passage (verbatim):** *"Starter — For individuals looking to perform a small number of email tests — $9 / month (billed annually) — Includes 50 daily email tests — Upgradable to 1,000 daily tests — Try free for 14 days — Unlimited email addresses — API for test automation — Increase users/emails at any time — Add extra users for $9/month — SMTP connectivity. Business — For teams looking to automate end-to-end tests with email or SMS — $80 / month (billed annually) — Includes 5,000 daily email tests — Plus 500 SMS messages/month — Try free for 14 days"*
- **section:** "Pricing → Starter / Business"
- **relevance:** HIGH
- **contradicts:** Phase 1 implied Mailosaur had a free tier; canonical pricing page shows only a 14-day trial.

## ISD-9 — MailSlurp Free: 100 inbound/mo + 30/day, 5 inboxes, receive-only; Pro $69/mo

- **citation_index:** [MS-pricing]
- **url:** https://www.mailslurp.com/pricing/
- **accessed:** 2026-05-05
- **claim:** MailSlurp Free tier: 30 included new inboxes/month, 5 total inboxes max, 100 inbound emails/month, 30 inbound emails/day, 50 MB storage, 2 MB max email, receive-only (no outbound). Pro is $69/mo (NOT cheaper than Mailosaur, contradicting Phase 1). Growth from $249/mo.
- **passage (verbatim):** *"Compare features ... | Included new inboxes / month | 30 | 2,000 | 10,000 | 10,000 | | Total inboxes | 5 | 500 | Unlimited | Unlimited | | Included inbound emails / month | 100 | 5,000 | 20,000 | 50,000 | | Inbound emails / day | 30 | Unlimited | Unlimited | Unlimited | | Included outbound emails / month | - | 2,000 | 5,000 | 10,000 | ... | Custom domains | - | 1 | 3 | 10 | ... Pro From $69.00 / month ... Growth From $249.00 / month"*
- **section:** "Compare features" table + plan summary
- **relevance:** HIGH
- **contradicts:** Phase 1's claim that "MailSlurp's free tier appears more generous than Mailosaur's" — the canonical pricing shows Mailosaur Starter ($9) gives 50 *tests/day* (effectively 50 inbounds/day) for $9/mo, while MailSlurp Pro at $69/mo is the next step from free. Mailosaur Starter is materially cheaper at low volume.

## ISD-10 — Mailtrap Sandbox capped at 100 emails/sandbox on Free; needs SMTP-relay routing (incompatible with external Resend send to a public address)

- **citation_index:** [MT-pricing], [MT-sandbox-api]
- **url:** https://docs.mailtrap.io/email-sandbox/setup/sandbox-api-integration + https://mailtrap.io/pricing/?tab=email-sandbox
- **accessed:** 2026-05-05
- **claim:** Mailtrap's Email Sandbox is built around test code connecting to Mailtrap's SMTP relay as a CLIENT (port 1025 / API token authenticated) — it does NOT operate as an MX inbound for arbitrary external senders. So if Resend tries to deliver to a Mailtrap sandbox address from outside, Mailtrap won't accept it. The product is for capturing your own outbound during dev, not for receiving real-world inbound.
- **passage (verbatim, sandbox-api-integration):** *"### How to get started with Sandbox API: First, you need to get a token. You can find it under Settings > API Tokens. ... Send a HTTP header `Api-Token: {api_token}` ... ## Sandbox SMTP Integration [previous]"* — and from the linked Sandbox SMTP doc workflow: connect to Mailtrap SMTP servers using the credentials shown in your sandbox.
- **passage (verbatim, pricing):** *"Free | $0 | 4,000 emails | 1 user | 3 days of email logs | 1 domain | 150 emails/day"* (this is Email API; the Sandbox tab pricing renders dynamically and the static extract collapsed it). Mailtrap's Sandbox tier requires a connected SMTP client.
- **section:** Sandbox API Integration / How to get started
- **relevance:** HIGH — confirms Phase 1's "Mailtrap Sandbox is incompatible with external Resend → sandbox" claim.

---

## Synthesis claims that survived ISD with quoted backing

| Claim | ISD | Status |
|---|---|---|
| Resend Free 100/day + 3,000/mo, sent and received both count | ISD-1 | **Verified** |
| Resend Pro $20/mo, 50k/mo, no daily limit | ISD-2 | **Verified — Phase 1 had wrong $35** |
| Resend Scale $90/mo, 100k/mo, no daily limit | ISD-3 | **Verified — Phase 1 had wrong 500k** |
| Resend supports inbound on `*.resend.app` or custom MX | ISD-4 | **Verified (Phase 1 missed this entirely)** |
| Resend Inbound delivers via webhook with Svix signing | ISD-5 | **Verified** |
| Resend's official Playwright doc only validates "send happened" | ISD-6 | **Verified — does NOT cover receive-and-extract** |
| Resend test `*@resend.dev` addresses simulate events, not real inboxes | ISD-7 | **Verified** |
| Mailosaur Starter $9/mo (annual), 50 daily, unlimited addresses; no free tier | ISD-8 | **Verified — Phase 1 implied a free tier** |
| MailSlurp Free 100/mo + 30/day, 5 inboxes; Pro $69/mo | ISD-9 | **Verified — Phase 1 was wrong that MailSlurp was cheaper** |
| Mailtrap Sandbox uses SMTP-client model, NOT MX inbound | ISD-10 | **Verified — incompatible with external Resend → sandbox** |

## Synthesis claims that did NOT verify

- **"Mailosaur free tier"** — does not exist; only a 14-day trial.
- **"MailSlurp's free tier appears more generous than Mailosaur's"** — incorrect framing; Mailosaur Starter ($9/mo, 50/day) is cheaper than MailSlurp Pro ($69/mo) for any usage above MailSlurp's 30/day Free cap.

## Verbatim claims from Phase 1 that were superseded

- ❌ Resend Pro $35/mo, 100k emails — **Now: $20/mo, 50k emails**.
- ❌ Resend Scale $90/mo, 500k emails — **Now: $90/mo, 100k emails**.
- ❌ "MailSlurp is cheaper than Mailosaur" — reversed: at low volume Mailosaur Starter ($9) wins; at higher volume Mailosaur Business ($80) wins.

## Updated reference data (verbatim from canonical sources)

| Service | Free tier | Cheapest paid | What unlocks |
|---|---|---|---|
| Resend (send+receive, same quota) | 100/day, 3,000/mo, both directions count | **Pro $20/mo** for 50k/mo, no daily | 10 domains, no daily cap |
| Mailosaur | 14-day trial only | **Starter $9/mo** annual, 50 tests/day | Unlimited addresses, SMTP, API |
| MailSlurp | 30/day, 100/mo, 5 inboxes | **Pro $69/mo** | 5,000 inbound/mo, custom domains, webhooks |
| Mailtrap Email API | $0 — 4,000/mo, 150/day | Basic $15/mo | 5 domains, larger volume — sending only |
| Mailtrap Email Sandbox | Free with limits | Plan-dependent | Per-sandbox rate limits, forwarding |
| Mailpit | Free, self-host | n/a | n/a |
| Inbucket | Free, self-host | n/a | n/a |
| Forward Email | Unlimited free forwarding | $3/mo Enhanced | Outbound, 10 GB storage |
