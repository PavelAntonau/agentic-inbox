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

---

## D-MNR-1 — Mobile-native-redesign phase decomposition (3 phases)

**status:** active (mobile-native-redesign, graph node `5H__5x3lTSb-s-plgWgn0`)

**context.** The audit produced ~25 mobile-correctness recommendations
spanning size tiers, OTP shape, PWA chrome, hydration / CSP, and copy.
A monolithic implementation phase would have stranded reviewable
checkpoints; a 5+ phase decomposition would have over-fragmented.

**decision.** Three phases:
1. **Mobile-correctness foundation** — additive size tiers, iOS input
   attrs, fixed-width card removal, viewport metas (low-risk; can ship
   independently).
2. **Mobile-native shape + PWA chrome** — new components
   (`MobileBottomSheet`, `OTPInput`, `ResendCountdown`), service
   worker, manifest, Lighthouse gate.
3. **Integration + regression + cutover** — CSP audit (T3.2),
   Turnstile telemetry (T3.3), visual regression (T3.4), docs
   (T3.5), final push (T3.6).

**rationale.** Aligns with the `feature` recipe (research → design →
implement → test → integrate). Each phase ships independently
reviewable and individually pushable.

---

## D-MNR-2 — Mobile-only auth shape: bottom-sheet snapping at `<md`

**status:** active (Phase 2, graph node `xAkVscRSfoS5uBnBoISww`)

**context.** Audit measured the centered-card desktop layout as
"insufficient" on mobile — 384px fixed width overflowed iPhone SE,
"Use a different email" 18px text link failed the 44px tap-target
floor, primary CTA sat above the thumb zone.

**decision.** On viewports `<md` (`<768px`), render the auth flow as
a `MobileBottomSheet` snapping to the lower 75% of the viewport with
the primary CTA in the thumb zone. Brand mark + tagline live in the
top section. At `≥md` the existing centered card stays exactly as it
was (no desktop regression).

**rejected:** full-bleed (would require additional design exploration)
and centered-card-tightened (insufficient per audit).

---

## D-MNR-3 — OTP entry: 6 individual digit boxes with paste-spread + auto-advance

**status:** active (Phase 2, graph node `5ta2zWCX2YvWF2mBKyQRm`)

**context.** Native iOS / Material 3 OTP UI is six discrete digit
boxes, not a single input field. The previous single-input
implementation had the right HTML attrs (`autoComplete="one-time-code"`
+ `inputMode="numeric"`) but the wrong shape.

**decision.** Render six `<input>` boxes via the new `OTPInput`
component. Paste of a 6-digit string spreads across boxes; typed
digits auto-advance focus; backspace on an empty box pulls focus
left; the `autoComplete="one-time-code"` attribute lives on a
hidden master input so iOS Safari's keyboard suggestions still
populate the entire string at once.

---

## D-MNR-4 — Native-feel ambition: PWA-first, defer native shells

**status:** active (Phase 2, graph node `uJN-2glSp5XGE9C5bzMzY`)

**context.** Audit recommended both PWA chrome (manifest + theme-color
+ service worker) and Capacitor / PWA-Builder native shells. PWA
delivers most of the "feels installed" UX with one-tenth the surface
area.

**decision.** Ship PWA-first: `/manifest.webmanifest`,
`<meta name="theme-color">`, both `mobile-web-app-capable` tags
(see D-MOBILE-1), `public/sw.js` registered with origin-root scope.
Native-shell wrappers stay deferred — revisit only if PWA usage
proves real and the ceiling is genuinely the wrapper, not the web
runtime.

**rejected:** Capacitor / PWA-Builder shells (premature; no signal
that the PWA layer is the bottleneck).

---

## D-MNR-5 — Tap-target tier introduction: additive `lg` (44px) + `xl` (56px)

**status:** active (Phase 1, graph node `4y3zY16kyq9Bkch88IO5l`)

**context.** Existing Input/Button size variants topped out at `base`
(h-10/40px) — below the iOS HIG and Material guideline floor (44px),
let alone primary-CTA (56px). The audit flagged "Use a different
email" at 18px tall as the most egregious case.

**decision.** Add two new tiers to `app/ui/{input,button}.tsx`:
- `lg` — h-11 (44px), `text-[16px]` (bypasses kumo `--text-base` 14px
  override that was triggering iOS Safari zoom-on-focus; see
  L-2026-05-08 in LESSONS_LEARNED.md).
- `xl` — h-14 (56px), `text-[16px]`.

Existing `base` callsites keep working; the auth surface migrates
deliberately to `lg` (email input) + `xl` (primary CTA). Additive,
zero unrelated regressions.

**rejected:** replacing `base` with h-11 (forces unrelated callsite
migrations); single-tier override at CSS level (loses per-component
intent + makes the tier table unreadable).
