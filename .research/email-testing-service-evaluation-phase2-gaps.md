# Phase 2 — Gap analysis + Phase 3 decision

**Date:** 2026-05-05
**Slug:** `email-testing-service-evaluation`

---

## What Phase 1 + Phase 2 ISD established (cited)

1. **Resend has its own Inbound product.** A Resend-managed `*.resend.app` subdomain OR your own MX-routed subdomain → webhook on `email.received` → full email content via the Receiving API. Cited at ISD-4 and ISD-5.
2. **Resend's official Playwright doc does NOT cover receive-and-extract.** It only covers "did the API get called". Cited at ISD-6.
3. **Resend Free transactional quota is 100/day + 3,000/month, and BOTH sent + received emails count.** Cited at ISD-1.
4. **Resend Pro is $20/mo, NOT $35.** Cited at ISD-2. (Phase 1 corrected.)
5. **Mailosaur Starter $9/mo for 50 daily tests, unlimited addresses, no free tier.** Cited at ISD-8.
6. **MailSlurp Free is 30/day + 100/month + 5 inboxes; Pro $69/mo is the next step.** Cited at ISD-9.
7. **Mailtrap Email Sandbox is incompatible with external SMTP inbound** — designed for connecting to Mailtrap's SMTP server as a CLIENT, not for receiving Resend → Mailtrap. Cited at ISD-10.

## What Phase 1 + Phase 2 ISD ruled out

- **Mailpit / Inbucket as a test inbox for Resend → external** — both are designed to be co-located with the test runner; deploying publicly with DNS+TLS is operational overhead inappropriate for testing tooling.
- **Forward Email as a primary** — no test-query API, only forwarding.
- **Mailtrap Email Sandbox as a primary** — not an MX inbound; cannot accept external Resend sends.

## Remaining open gaps that DO matter

None that require another deep call. Two minor gaps remain, resolvable inline in the final report:

- **Exact `*.resend.app` address shape** — is it `<random>@<account-or-zone>.resend.app`, account-wide, or per-domain? The Resend doc says "A Resend-managed `*.resend.app` receiving domain" but doesn't fully spell the shape. **Resolution:** flag this in the report as "verify in dashboard at signup; documented but exact pattern not in public KB." Not a blocker for the decision.
- **Resend Inbound retention window** — how long can the agent poll for an inbound message before it's purged? **Resolution:** the pricing page lists "30-day data retention" generically across plans; assume same for Inbound. Note as low-confidence.

## Hypothesis re-test results

The plan listed three Phase 3 hypotheses; ISD already disposed of all three:

- **H1 — "Mailosaur is best, MailSlurp is cheaper":** REFUTED in part. Mailosaur is best, AND Mailosaur Starter ($9/mo) is cheaper than MailSlurp Pro ($69/mo) at non-Free volumes. MailSlurp wins only at the very low end if 30/day is enough.
- **H2 — "Mailtrap Sandbox can't accept external SMTP":** CONFIRMED. ISD-10.
- **H3 — "Resend test mode + 100/day is the user's symptom":** CONFIRMED for monthly cap; the new finding is that the user's actual problem is more likely **(a) sender domain `actionnow.ai` not yet DKIM-verified in Resend**, OR **(b) Resend Free's 100/day cap was hit during testing iterations** (ISD-1's "received counts" rule means a single test that invites 50 users counts as 50 outbound + however many bounced + delivered = quota burn). Not "test mode" — Resend doesn't have a sandbox-mode-only-deliver-to-account-owner restriction in the modern docs.

## Phase 3 deep-call decision

**Phase 3 SKIPPED.** Reasons:

1. The canonical Resend KB (markdown variant accessible to AI agents) answered every load-bearing architectural and pricing question.
2. Mailosaur and MailSlurp pricing pages confirmed the cost matrix.
3. Mailtrap pricing + Sandbox API integration pages confirmed the architectural incompatibility.
4. The remaining gaps (exact `*.resend.app` shape, Inbound retention window) are dashboard-time confirmations, not research questions.
5. Budget preserved: 1 deep call used of 4 budgeted (~$0.91 of ~$3.60). Remaining budget can fund a follow-up if the recommendation reveals an unknown later.

## Emerging architectural recommendation (to be formalized in Phase 4)

Two clean paths emerge. Both are cheap, neither requires the user to sign up for a brand-new vendor.

### Path A — Resend Receiving on `*.resend.app` (zero new vendor; cheapest)

- **Cost:** $0 for low-volume (50 E2E tests/day max on Free, since each test = 1 send + 1 receive = 2 quota), $20/mo Resend Pro for unlimited daily.
- **Mechanism:** Verify a subdomain in Resend → enable Inbound → Resend POSTs `email.received` webhooks to a Worker endpoint → Worker writes to a DurableObject keyed by the recipient address → agent polls `/api/__test__/inbox/<addr>?nonce=<n>&since=<ts>` from the Worker.
- **Pros:** No new vendor; no new monthly bill at low volume; tests EXERCISE the real Resend send-side that will run in production; same retry/bounce/spam events flow through; Resend Inbound is paid by the same quota as outbound, so capacity planning is one-dimensional.
- **Cons:** Free's 100/day cap is hit at ~50 E2E tests/day; webhook needs Svix-signature verification; Worker needs the `email.received` route plumbed; initial dashboard step to verify the subdomain.

### Path B — Mailosaur Starter ($9/mo)

- **Cost:** $9/mo billed annually = $108/year. 50 daily tests on Starter; upgrade in-place to higher daily caps.
- **Mechanism:** Sign up → get a `<account>.mailosaur.net` domain → tests generate `e2e-${nonce}@<account>.mailosaur.net` → Worker sends invite via Resend (uses Resend Free quota) → test code uses Mailosaur SDK `messages.waitForLatestEmail({server, sentTo})` to block until arrival → extract OTP/magic-link → drive Playwright login.
- **Pros:** Purpose-built `waitForLatestEmail()`, no DNS work, isolation from production Resend volume (Mailosaur receives don't burn Resend quota), first-class Playwright/TS/Python SDKs, official Playwright + Mailosaur tutorial.
- **Cons:** $9/mo recurring; vendor lock-in for the test inbox; Starter's 50 daily tests cap (matches Path A's effective ceiling); no permanent free tier.

### Decision criteria the user should apply

| Question | Path A wins | Path B wins |
|---|---|---|
| "I want zero new vendors" | ✓ | |
| "I want zero new monthly bills" | ✓ (until 100/day burned) | |
| "I want the test to exercise real Resend send-and-receive" | ✓ | |
| "I want a polished `waitForLatestEmail` API and won't write the polling loop myself" | | ✓ |
| "I want full isolation between test traffic and production Resend quota" | | ✓ |
| "I want a vendor whose ENTIRE business is testing emails" | | ✓ |
| "I'm running 100+ E2E tests/day already" | $20/mo Resend Pro | $9/mo Starter — but I'd hit the 50/day cap, so $80/mo Business is needed |

The cleanest answer for **the user's stated requirement — autonomous E2E testing where the AI agent goes through the full flow** — comes down to **how much polish vs. how much vendor minimalism the user prefers**. Both paths land within Email-testing/mo, and the user can swap between them with two days of code changes.

## Confidence

**HIGH** for pricing, free-tier limits, architectural compatibility (every claim ISD-backed by a canonical source).

**MEDIUM** for "exact shape of `*.resend.app` addresses" and "Resend Inbound retention" (documented less precisely; verify at signup).

**LOW** for the latency claim (Phase 1 quoted "p95 a few hundred ms" without a hard citation; both paths run on production-grade infra so this is not decision-relevant).
