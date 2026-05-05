# Research Plan — Email-Testing Service for Autonomous E2E Auth Testing

**Date:** 2026-05-05
**Slug:** `email-testing-service-evaluation`
**Episode:** `ep_9208483eff50` (`main:opus:research-deep:email-testing-service-evaluation`)
**Branch:** `feature/autonomous-local-testing` @ `d9c32fb`
**Project:** `agentic-inbox`

---

## Question

Which email-receiving service should agentic-inbox adopt so the agent can run **autonomous, true end-to-end authentication tests** — invite a user from the admin panel, receive the resulting email at a programmatically-pollable inbox, extract the magic link / OTP / invite token, drive the browser through login, and verify the user is signed in — at the lowest cost compatible with the existing Cloudflare Workers + better-auth + Resend stack?

Companion question: **why are invite emails not arriving in the user's personal inbox today**, given Phase 2 already swapped outbound to Resend with sender `noreply@actionnow.ai`?

## Why now

- Phase 3 of agentic-inbox-hardening was about to begin "P2 lows + complexity reduction" — but the user reports a **structural gap**: there is no autonomous E2E mechanism for the auth flow. Every release cycle currently requires a human to check their inbox.
- Phase 2 (yesterday, 2026-05-04) shipped `workers/lib/resend-client.ts` and aligned the invite sender from `noreply@mail.actionnow.ai` (DMARC-failing subdomain) to `noreply@actionnow.ai` (apex). The user has not yet seen any of those invite emails arrive — so EITHER Resend isn't fully configured (sandbox / unverified domain / wrong key) OR the wiring isn't deployed. This blocks the user from validating the fix manually too, not just via tests.
- Without a programmatic inbox, future regressions in OTP delivery, magic-link signing, invite-token expiry, group-invitation flows, and the planned migration to a self-hosted authorization server will all be undetectable by the agent. **This is a production-readiness gate, not a nice-to-have.**

## Sub-aspects (priority)

1. **[HIGH] Vendor matrix.** For each of: Mailosaur, MailSlurp, Mailtrap (Email Testing sandbox + Email API + Inboxes-on-Domain), Forward Email, AWS SES Inbound, Resend's own Inbound webhooks, ImprovMX, Mailpit (self-hosted), Inbucket (self-hosted) — capture:
   - Does it provide **stable receivable addresses on a vendor-managed domain** (so the agent doesn't need to set up DNS) and/or **catch-all on the user's own subdomain**?
   - API to **wait for an email** synchronously by recipient/subject/regex, with timeout and polling.
   - Magic-link / OTP regex extraction support out-of-box, OR is it pure body-fetch?
   - Free-tier limits (emails/month, inboxes, API calls).
   - Cheapest paid tier (USD/month) and what it unlocks.
   - p95 inbound→API latency (how long from "Resend hit Send" to "agent can read it").
   - TLS/SPF/DKIM behavior — do the vendor's MX servers accept mail from any sender, or do they require sender authentication?
   - First-class Playwright / TypeScript / Python SDK?

2. **[HIGH] Resend deliverability diagnosis.** Given the current code (`workers/lib/resend-client.ts` reads `RESEND_API_KEY`, `invitations.ts:208` sends from `noreply@actionnow.ai`), enumerate the most likely reasons emails don't arrive:
   - Resend account in **test mode** / sandbox: only delivers to verified-owner addresses.
   - Sender domain `actionnow.ai` not verified in Resend dashboard (DKIM CNAME records not added).
   - Free-tier rate limit hit (Resend free tier is 100/day, 3000/month last I checked — 2025 number, verify).
   - `RESEND_API_KEY` secret not set in production worker (`wrangler secret put RESEND_API_KEY`).
   - The Resend integration was ADDED but the binding wasn't switched: `getEmailBinding()` still returns the CF send_email binding, not the Resend client.
   - Recipient-side filtering (Gmail Promotions tab, Apple junk, corporate filters).

3. **[MEDIUM] Integration shape.** For the recommended service:
   - **Vendor-domain ephemeral addresses** (e.g. `mailosaur-xyz@server-id.mailosaur.net`) — best for autonomous tests; no DNS work; agent picks a random address per test run. Some vendors give the test address a permanent server but each test gets a unique recipient.
   - **Catch-all on user's domain** (e.g. `*@test.actionnow.ai` MX-routed to vendor) — feels more "real" but requires DNS setup; useful when testing sender-side allow-listing behavior.
   - Pick which makes sense for this stack and document the DNS step if needed.

4. **[MEDIUM] Concrete agent recipe.** For the chosen service, write the actual test loop:
   - Polling vs webhook-into-Worker.
   - Expected wall-clock per full E2E login test (invite → email arrives → extract code → login → assert authenticated).
   - TypeScript example for in-Worker integration tests.
   - Python example for an anaid-side agent driving Playwright + the email API.
   - Cost-per-test estimate (test run × emails × API calls).

5. **[LOW] Alternates.** If the primary recommendation has a regional gotcha or hits unexpected friction, what's the second-best choice?

## Expected source types

- **Vendor docs (primary):** Mailosaur docs (mailosaur.com/docs), MailSlurp docs (docs.mailslurp.com), Mailtrap docs (api-docs.mailtrap.io + help.mailtrap.io), Resend docs (resend.com/docs).
- **Vendor pricing pages (primary):** each vendor's `/pricing` route, accessed 2026-05-05.
- **Independent comparisons:** testRigor blog, Cypress / Playwright community discussions, DEV.to "best email testing 2025" posts, GitHub issues on real OSS projects integrating these vendors.
- **Cloudflare Workers community:** Discord / Discourse on integrating these services with CF Workers tests.
- **Production engineering blogs:** any company that has documented their E2E auth testing pipeline (often Cypress + Mailosaur or Playwright + MailSlurp).

## Success criteria

- [ ] Each HIGH sub-aspect has 2+ cited sources with verbatim ISD passages.
- [ ] Conflicting recommendations or pricing differences surfaced explicitly.
- [ ] One opinionated recommendation with concrete cost (free tier first, smallest paid tier second).
- [ ] One named alternate.
- [ ] Resend-side diagnosis lists 3+ probable causes with how to test each.
- [ ] Confidence level documented (high / medium / low) with one-line justification.

## Stop conditions (any one fires → end research)

- Citation saturation: Phase 3 returns no new sources beyond Phase 1+2.
- 4 deep calls already burned (1 seed + up to 3 hypothesis tests).
- Topic answered to success criteria above.
- User redirects.

## Initial seed query (Phase 1)

Single `perplexity_research` call, `search_context_size="high"`, `recency="year"` (deliverability + pricing both move within 12 months).

> Compare the leading email-testing services for autonomous end-to-end authentication testing in 2025-2026 — Mailosaur, MailSlurp, Mailtrap (both their Email Testing sandbox and their Email API with real domain inboxes), Forward Email, and the self-hosted Mailpit and Inbucket — for a Cloudflare-Workers-based application that already uses Resend to SEND outbound (magic-link OTP via better-auth, plus invitation emails). For EACH service, address: (a) does it expose a public API to wait for and fetch an inbound email by recipient address with a timeout, (b) does it provide stable receivable addresses on a vendor-managed domain (so test code doesn't need DNS setup) AND/OR catch-all routing for the user's own subdomain, (c) free-tier limits in 2025-2026 (emails per month, inboxes, API calls), (d) cheapest paid tier USD/month and what it unlocks, (e) typical p95 latency from inbound delivery to API availability, (f) does the vendor's MX server accept mail from arbitrary senders or require sender authentication, (g) first-class TypeScript and Python SDK availability and Playwright integration patterns. SEPARATELY: list the most common reasons that Resend (resend.com) emails fail to deliver to consumer inboxes (Gmail/Apple/Outlook) when sent from a Cloudflare Worker — covering test-mode/sandbox restrictions, sender-domain verification (DKIM CNAME records on Resend's dashboard), free-tier rate limits, and any 2024-2026 changes to Resend's free-tier delivery scope. Cite specific pricing pages, docs URLs, and recent (2025+) blog posts; surface conflicts in pricing or feature claims. End with a synthesized recommendation matrix mapping (use case = autonomous E2E auth testing, scale = single developer doing dozens of test runs per day, budget = lowest first paid tier acceptable) to ONE primary vendor and ONE named alternate.

## Hard budget

- 4 deep calls maximum (1 seed + 3 follow-ups).
- ≈ $1.20 expected cost.
- ≈ 15 min wall-clock.

## Carry-forward to Phase 2 / 3

Phase 2 will extract citations from Phase 1's report (top 3–5 URLs) via `tavily_extract` to capture verbatim ISD passages on pricing, free-tier scope, and API shape — vendor pricing pages especially, since synthesis engines often quote yesterday's prices.

Phase 3 hypothesis-test slots (used only if gaps remain after Phase 2):
- H1: "Mailosaur is the best fit but the price is the deal-breaker; MailSlurp's free tier is sufficient for daily dev use and the paid step-up is materially cheaper than Mailosaur's." Test query: head-to-head pricing + feature parity for OTP/magic-link extraction in 2025-2026.
- H2: "Mailtrap's Email Testing sandbox CANNOT receive real emails from Resend; it only captures sends made via Mailtrap's own SMTP credentials. For receiving real outbound from Resend, only Mailtrap's Email API with Inboxes-on-Domain works." Test query: Mailtrap product matrix and which products accept inbound from arbitrary senders.
- H3: "Resend's free tier in 2026 still blocks delivery to non-verified addresses unless the sender domain is verified AND the account is out of test mode — that's the most likely Resend-side failure for the user's invite-not-arriving symptom." Test query: Resend test-mode + sandbox documentation 2025-2026.
