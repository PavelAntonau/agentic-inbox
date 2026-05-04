# Mail-Delivery Diagnosis — Invite + Sign-in-Code Paths

**Status:** Phase 1 of UAT round 2 — diagnostic only, no source changes shipped here.
**Branch:** `feature/autonomous-local-testing` @ `68f10e4`
**Date:** 2026-05-04

---

## Executive summary

Both delivery branches use the **Cloudflare Email Routing `send_email`
Worker binding** (`env.EMAIL.send`). The binding is fundamentally an
inbound-routing service with a **deliberately narrow outbound surface**;
sending to arbitrary recipient addresses (e.g. a disposable SimpleLogin
inbox the inviter just typed) is **not what the binding is for**.

Two compounding failure modes are almost certainly responsible for the
observed "no mail arrives":

1. **CF Email Routing rejects outbound sends to non-verified
   destinations.** Free Email Routing only allows a Worker to send TO an
   address that is already a verified destination in the zone's Email
   Routing config, or to reply within an existing inbound routing
   chain. A fresh invite recipient is neither. Both paths hit this.
2. **Invitation path is `noreply@<request host>` = `noreply@mail.actionnow.ai`,
   a subdomain.** CF Email Routing is enabled on the apex zone
   (`actionnow.ai`); DKIM/SPF alignment is configured for the apex.
   `noreply@mail.actionnow.ai` is unlikely to be DKIM-aligned with the
   zone's signing key, so even if (1) were satisfied, recipient servers
   would mark the message as failing DMARC and either reject or
   junk-folder it.

A third effect makes the user-facing diagnosis nearly impossible:

3. **The invitation endpoint swallows every send error and always
   returns `{ sent: true }`** to the UI. The inviter sees "invite sent"
   even when the binding threw. The OTP path does NOT do this — it
   re-throws — so OTP failures at least surface as a 500 to better-auth.

The bottom line: this is not a Routing-rule typo or a missing record.
**The architecture is wrong for the use case.** Phase 2 should switch
outbound mail to a transactional provider (Resend / Postmark / SES /
Mailgun) for both branches, keep CF Email Routing for inbound only,
align the sender on a single apex-domain identity, and stop silently
swallowing send errors on the invite path.

---

## How outbound mail is sent today

```
┌─────────────────────────┐
│  better-auth emailOTP   │ ── sign-in code path
│  workers/auth/index.ts  │     sender: auth@actionnow.ai
└────────────┬────────────┘     errors: re-thrown
             │
┌────────────▼────────────┐
│  workers/routes/        │ ── invitation path
│    invitations.ts       │     sender: noreply@mail.actionnow.ai
└────────────┬────────────┘     errors: SWALLOWED, always returns sent:true
             │
┌────────────▼────────────┐
│  email-sender.ts        │ ── sendEmail(binding, params)
│  binding.send(message)  │
└────────────┬────────────┘
             │
┌────────────▼────────────┐
│  wrangler.jsonc         │ ── send_email binding "EMAIL"
│  "send_email":[{"name": │     prod: real CF Email Routing
│    "EMAIL"}]            │     local dev: miniflare no-op (per file comment)
└─────────────────────────┘     MOCK_MODE: outbox JSON in R2
```

### Code references

| Location | What it does |
|---|---|
| `workers/email-sender.ts:40-72` | `sendEmail(binding, params)` — translates `SendEmailParams` to the `binding.send(...)` shape |
| `workers/auth/index.ts:184-194` | better-auth `emailOTP` plugin → calls `sendOtpEmail` |
| `workers/auth/index.ts:234-268` | `sendOtpEmail` — sender `{ name: "Agentic Inbox", email: "auth@actionnow.ai" }`, subject `"Your Agentic Inbox sign-in code"`, plain text + HTML |
| `workers/auth/index.ts:232` | Docstring confirms errors are re-thrown (so the user sees the failure) |
| `workers/routes/invitations.ts:213-252` | Invitation send — sender `{ name: "ActionNow.AI", email: \`noreply@${host}\` }` where `host = new URL(c.req.url).host` |
| `workers/routes/invitations.ts:226-255` | `try { ... } catch { /* swallow */ }` — error path is **silent** |
| `workers/routes/invitations.ts:270` | `return c.json({ sent: true })` — runs regardless of catch |
| `wrangler.jsonc:33-37` | `"send_email": [{ "name": "EMAIL" }]` — the binding |
| `wrangler.jsonc:27-32` | Comment confirms local dev is unauthenticated; outbound is a no-op in miniflare |
| `workers/lib/mocks/email-binding.ts` | MOCK_MODE swap that captures sends to an R2 outbox |

---

## Why CF Email Routing `send_email` does not deliver to fresh addresses

Cloudflare Email Routing is documented as an **inbound** service with
two narrow outbound capabilities:

1. **Reply within a routing chain.** A Worker that received a message
   via Email Routing can call `message.reply(...)` or send a reply via
   the binding TO the original sender. This is the canonical outbound
   path.
2. **Send TO a verified destination address.** Outbound from a Worker
   to an address that has been added as a destination in the zone's
   Email Routing dashboard AND verified by clicking Cloudflare's
   confirmation link. Without verification, the send is rejected.

Neither of those covers "an admin typed a stranger's email into an
invitation form". The `send_email` binding is **not a transactional
mail API** — it is an inbox plumbing API, narrowly extended for
worker-side replies. Treating it as a generic outbound channel is the
architectural mismatch at the heart of this bug.

Sources:
- Cloudflare docs, [Email Routing → Send emails from Workers](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) — explicit verified-destination requirement.
- Cloudflare docs, [send_email binding reference](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/) — explicit reply-only / verified-destination semantics.
- Community + Cloudflare-blog reporting on the same constraint at scale (multiple posts, all 2024–2025).

> The diagnosis takes Cloudflare's stated semantics at face value;
> Phase 2 should still confirm via `wrangler tail` (see "Verification
> gap" below) before flipping providers.

---

## Why the invitation path additionally fails DMARC

Even on a hypothetical CF account where the recipient is verified, the
invitation path uses a **subdomain sender**:

```ts
from: { name: "ActionNow.AI", email: `noreply@${host}` }
//                                              ^^^^^
//                                              "mail.actionnow.ai" in prod
```

Cloudflare Email Routing's DKIM signing is configured on the **apex
zone** `actionnow.ai`. The DKIM-Signature header signs as `d=actionnow.ai`.
A `From: noreply@mail.actionnow.ai` will not align with that DKIM
identifier under strict DMARC alignment, and SPF on the subdomain (if
not separately configured) will fall through. Most consumer providers
(Gmail, Apple, Outlook.com) and almost all aggregator front-ends
(SimpleLogin, AnonAddy) reject or junk-folder messages that fail
DMARC alignment.

The OTP path's `auth@actionnow.ai` (apex) is more likely to align, so
OTP emails are slightly less likely to be DMARC-rejected — but they
still hit failure mode (1) above when the recipient isn't a verified
destination.

---

## Why the inviter sees "Invite sent" anyway

`workers/routes/invitations.ts:226-255`:

```ts
try {
  const emailBinding = getEmailBinding(c.env);
  if (emailBinding) {
    // ... build body, call emailBinding.send(...)
  }
} catch {
  // Intentionally swallowed — privacy-preserving:
  // never reveal email delivery errors
}
// ...
return c.json({ sent: true });   // line 270 — runs unconditionally
```

The intent (per the inline comment, and the audit-log entry that fires
just above the return) is **privacy-preserving** — don't leak whether
an email address belongs to an existing user. That goal is legitimate
but the implementation conflates two failure modes that need different
handling:

| Failure | Today | Should be |
|---|---|---|
| Recipient address doesn't match a known user | Silent `sent: true` (correct privacy behaviour) | Silent `sent: true` |
| Mail send threw (binding unavailable, address rejected, DMARC fail, etc.) | Silent `sent: true` (HIDES the bug) | Logged, exposed to inviter via a non-blocking signal — the inviter needs to know to retry |

The OTP path doesn't have this problem; better-auth re-throws and
returns a 500 to the client.

---

## Verification gap (T1.4)

The plan asks for a `wrangler tail` confirmation to see what actually
fires when an invite is sent. **I cannot run this from the current
session** — it requires authenticated access to the Cloudflare account
and was not part of the diagnostic scope (Phase 1 is "diagnose without
shipping a fix"). Phase 2 should:

1. Trigger an invite to a fresh SimpleLogin alias on `mail.actionnow.ai`.
2. `wrangler tail --format pretty` and capture the lines that appear.
3. Cross-check Cloudflare Email Routing dashboard → Activity log for
   the same window.
4. Confirm whether the failure surface is:
   - "destination not verified" (Routing-side rejection), or
   - "DKIM/SPF/DMARC fail at recipient" (the message left CF but was
     bounced), or
   - "binding not bound / 503" (something simpler is broken).

The expected outcome of step 2 is the binding throwing on the call. If
it does not throw — i.e. CF accepts the call but the recipient never
sees the message — DMARC alignment is the active failure and the
sender-domain fix becomes higher priority than the provider switch.

---

## Recommended Phase 2 plan

In priority order:

1. **Switch outbound to a transactional provider.** Resend is the
   lowest-friction match for a Cloudflare-native stack — single
   `RESEND_API_KEY` secret via the Key MCP, single `fetch` call in
   `email-sender.ts`. Postmark / SES / Mailgun are all viable
   alternatives; the architecture is identical (HTTP API + sender-domain
   verification). Resend's free tier covers the v0.1 launch volume.
2. **Sender identity:** standardise on `noreply@actionnow.ai` (apex,
   DKIM-aligned via the new provider's DNS records) for invites; keep
   `auth@actionnow.ai` for OTP. Both verified in the provider dashboard.
3. **Plain-text invite template.** The plan already specifies the body:
   ```
   Hello,

   You've been invited to ActionNow. Open this link to sign in:

     https://mail.actionnow.ai/login?email=<urlencoded>

   — ActionNow team
   ```
   No HTML, no images, no magic-link tokens. Spec lives in
   `action-plan-agentic-inbox-uat-round2.md` Phase 2 T2.2.
4. **Stop swallowing errors silently.** Keep the audit-log entry, keep
   the `{ sent: true }` privacy contract for unknown-recipient cases,
   but log mail-send exceptions with structured context so they show
   up in `wrangler tail` / CF logs / the new provider's bounce webhook
   — and, ideally, surface a non-PII signal to the inviter
   (e.g. a transient "delivery delayed, we'll retry" toast) when the
   provider returns a hard error code.
5. **Inbound stays on CF Email Routing.** That's what the binding is
   actually for, and the inbound path (`/api/__test__/email-ingest`,
   `MailboxDO`) is unchanged.

The provider switch is a one-day change; sender-domain DNS + DMARC
alignment is the gating dependency (24-hour DNS propagation worst
case). Both should land in a single Phase 2 commit so the deploy
gate is "send a real invite to a real disposable address and watch
it arrive".

---

## Out-of-scope footnotes

- **MOCK_MODE.** The mock binding swap (`workers/lib/mocks/email-binding.ts`)
  routes outbound to an R2-backed outbox during local testing. The
  diagnosis above is for production / `mail.actionnow.ai`; MOCK_MODE
  is unaffected by the provider switch — it intercepts at the
  `getEmailBinding` boundary, before the real `binding.send` call.
- **`/api/__test__/email-ingest`.** Inbound test fixture, not a sender.
  Listed here so a future reader doesn't conflate it with the bug
  surface.
- **`workers/lib/tools.ts:507` and `:605`.** Two MCP-exposed
  `send_email` tool implementations. Same binding, same root cause —
  Phase 2 changes propagate transparently if the helper signature is
  preserved.

---

## Sign-off

Diagnosis complete. Recommended Phase 2 action: provider switch +
sender alignment + non-silent error handling. No source changes were
shipped in this phase; the H-bug fix that did ship in this phase
(`68f10e4`) is unrelated to mail delivery.
