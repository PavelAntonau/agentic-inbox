# Decisions — agentic-inbox

Log of architectural decisions taken in this fork. Append-only; if a
decision is reversed, add a new entry that supersedes it and link the two.

Format: `D-<scope>-<n>` · context · decision · rationale · status.

---

## D-CSP-1 — Per-request nonce + `'strict-dynamic'` for script-src

**status:** active (Phase E / TASK-E.1, verified 2026-05-08 against the
production-built path under `mock:up`)

**context.** React Router 7 emits a handful of inline `<script>` tags on
every HTML response (router context, serialized loader data, the entry-
client bootstrap). Phase C3 had to ship `script-src … 'unsafe-inline'`
to keep hydration alive — a known XSS-mitigation regression carried as
TODO until E.

**decision.** Generate a fresh per-request CSP nonce in
`workers/lib/csp.ts::generateCspNonce()`; stamp it on every `<script>`
tag via `HTMLRewriter` in the security-headers middleware
(`workers/app.ts`); emit
`script-src 'self' 'nonce-<value>' 'strict-dynamic' https://challenges.cloudflare.com`
with `'unsafe-inline'` REMOVED. Fail closed when the nonce is null:
`script-src 'self' 'strict-dynamic' …` (no inline scripts execute,
regression surfaces immediately).

**rationale.** `'strict-dynamic'` lets the nonced loader scripts pull
in their dependency graph transitively without enumerating chunk
hashes — survives every Vite build without manual maintenance.
Per-request nonce defeats nonce-replay attacks on cached HTML.

**security stance.** XSS via injected inline `<script>` is now
ineffective in production: any inline script the attacker manages to
land carries no nonce, and no host whitelist applies because
`'strict-dynamic'` overrides them. Inline event handlers (`onclick=…`)
are also blocked because `'unsafe-inline'` is absent. Test coverage:
`workers/csp.test.ts`.

**verified empirically (2026-05-08).** Production-built bundle served
via `npm run build && wrangler dev --local` — `/`, `/settings`,
`/mailbox`, and the not-found 404 catch-all each render six inline
`<script>` tags, every one carrying the per-request nonce, browser
console reports ZERO CSP violations across all four routes. The
`/login` dev picker (rendered only under `MOCK_MODE=1`) is plain HTML
with zero scripts — also clean.

---

## D-CSP-2 — Audit's "14 inline-script CSP violations" was a Vite-dev artifact, not production

**status:** active (T3.2 of mobile-native-redesign, 2026-05-08)

**context.** `.research/mobile-native-audit.md` §7 reported 14 inline-
script CSP violations on every page load when probing the local app
during the Phase 2 mobile audit. The audit was run via
`react-router dev` (Vite + HMR) — Vite injects an HMR-bootstrap inline
`<script>` block on every Vite-served HTML response and it does NOT
flow through the worker's HTMLRewriter (Vite owns the response
pipeline in dev mode). Those scripts are unnonced; the worker's CSP
header still applies; the browser blocks them and emits one console
violation per occurrence. Result: 14 violations under Vite, all
spurious from a security standpoint (HMR runtime, not user-shipped
code).

**decision.** Treat the audit's 14-violations finding as Vite-dev
specific. Do NOT add `'unsafe-inline'` or per-script hashes to relax
production CSP. The production code path (`npm run build && wrangler
dev` or `npm run deploy`) is the single security-bearing path.

**evidence.** Direct probe 2026-05-08:
- `curl -I http://127.0.0.1:8788/login` and `…/` both return the
  expected `script-src 'self' 'nonce-<value>' 'strict-dynamic'
  https://challenges.cloudflare.com` header.
- HTML for `/` contains exactly 6 `<script>` tags, all bearing
  `nonce="<value>"` matching the response header.
- Headed browser pass through `/`, `/settings`, `/mailbox`,
  `/not-found-route-test` reports zero CSP violations in the console.

**dev-vs-prod rule.** When auditing CSP, Trusted Types, or any
script-loading behaviour, ALWAYS run against the production-style
serve (`npm run build && wrangler dev --local`) — never against the
Vite dev server. Vite's HMR runtime is benign noise that masks (or
fabricates) real findings. Documented in `CLAUDE.md` for the next
auditor.

---

## D-AUTH-OQ3 — Anti-enumeration: silent "OTP sent" on invalid emails (T3.1)

**status:** active (T3.1 of mobile-native-redesign, commit `74ab4e5`,
2026-05-08)

**context.** The mobile audit OQ-3 asked whether the server should
return a server-side TLD-validation error when a user submits an
unreachable email address (`example@.invalid`). The current behaviour
is: server accepts any well-formed email, advances to the OTP step,
and silently no-ops the OTP send for unknown / invalid recipients.

**decision.** Keep the silent-advance behaviour as a deliberate
anti-enumeration design. The auth surface MUST NOT distinguish
"email not registered" from "email registered but undeliverable" from
"email accepted, OTP en route" in any user-visible signal — response
status, response timing, error copy, or otherwise. Returning a
server-side TLD-validity error would let an attacker enumerate the
user table by probing arbitrary addresses.

**rationale.** Email enumeration is one of the most common
reconnaissance vectors against authentication surfaces; silent-advance
is the OWASP-recommended posture. The cost is one rare UX wrinkle
(typo on `.invalid` → user waits for an OTP that never arrives) which
the resend-countdown affordance (T2.4 / commit `0fead43`) makes
recoverable in 30s.

**reference.** Full rationale + the alternatives considered live in
`docs/auth-design.md` §"Anti-enumeration".

---

## D-MOBILE-1 — `mobile-web-app-capable` + `apple-mobile-web-app-capable` carried together

**status:** active (T3.2 follow-on, 2026-05-08)

**context.** Chromium emits a deprecation warning when only the
`apple-mobile-web-app-capable` meta tag is present. The W3C-standard
tag is `mobile-web-app-capable`. iOS Safari, however, still requires
the `apple-`-prefixed tag for "Add to Home Screen" → standalone
launch.

**decision.** Carry both tags. Standard tag silences the Chromium
deprecation warning; iOS Safari shim retains standalone support. Two
lines in `app/root.tsx`; zero functional risk.
