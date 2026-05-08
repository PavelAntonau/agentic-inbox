# Mobile Native UX Audit — mail.actionnow.ai

**Date:** 2026-05-08
**Tree:** `/Users/dev/ActionNowAI/agentic-inbox` @ `feature/autonomous-local-testing`
**Target:** Live production — `https://mail.actionnow.ai/` (Cloudflare Workers behind CF Access)
**Reach:** Unauthenticated. Site auto-redirects `/` → `/login?from=%2F`.
**Mission:** Drive a *mobile-native* redesign — not just a responsive polish.
**Method:** Three browser-mcp sessions at the requested viewports, screenshots + console + DOM probes.
**Screenshots:** `.scratch/mobile-audit/01..10-*.png` (gitignored — see gallery section).
**Episode:** `ep_30c372b40d82` (Small World Global dataset).

---

## TL;DR

The login surface looks acceptable in screenshots but fails the test of being *mobile-native* at every layer that matters:

| Layer | Verdict |
|---|---|
| Layout | Desktop card centered on a 1.2 MB landscape decorative background. Card is **fixed-width 384 px**, so it physically overflows the right edge on the 375 px iPhone SE (`-25 px`) and the 393 px iPhone 14 Pro (`-15 px`). |
| Tap targets | Email input, "Send code", and "Verify" are **36 px tall** (Apple HIG min = 44 pt; Material 3 min = 48 dp). "Use a different email" is **18 px tall** — half the minimum. |
| Form input UX | Email field is **14 px font-size** — iOS Safari zooms on focus. Missing `inputmode="email"`, `autocapitalize="none"`, `autocorrect="off"`. |
| OTP UX | Correct attrs (`autocomplete="one-time-code"`, `inputmode="numeric"`, `pattern="[0-9]*"`, `maxLength=6`) — but rendered as a **single 36 px text field**, not the 6-box paste-friendly affordance every native client expects. |
| PWA / install | **No manifest, no `theme-color`, no `apple-mobile-web-app-capable`, no `apple-mobile-web-app-status-bar-style`, no `msapplication-TileColor`**. Only an `apple-touch-icon`. Site cannot be "added to home screen" with native chrome. |
| Safe areas | Fixed toast at `top-4 left-1/2` collides with notch / Dynamic Island. `CSS.supports('padding: env(safe-area-inset-top)')` returns true but is not used. `viewport-fit=cover` is not declared. |
| Validation | Server accepted `notarealuser+mobile-audit@example.invalid` and advanced to OTP, claiming "Code sent". Either no TLD validation, or silent failure. Confusing UX in either case. |
| Console hygiene | 14+ TrustedHTML / TrustedScript / TrustedScriptURL CSP violations on load. "Form submission canceled because the form is not connected" warning hints at a React Router hydration race. Turnstile widget rendered on SE+Pixel 7 but **not** on the iPhone 14 Pro re-render — flaky. |

**Bottom line for the redesign brief:** the current page is a desktop sign-in box transplanted into a mobile viewport. A native-feeling experience needs a different *shape* (bottom-sheet, full-bleed), not a tighter responsive breakpoint.

---

## Viewport Matrix

| Device | CSS px | DPR | Card overflow | Below-card empty space | Card uses | Notes |
|---|---|---|---|---|---|---|
| **iPhone SE (3rd gen)** | 375 × 667 | 2 | **−25 px right** | ~100 px | ~69 % of viewport height | Card cropped on right edge; bg image fills remainder |
| **iPhone 14 Pro** | 393 × 852 | 3 | **−15 px right** | **195 px** | ~54 % of viewport height | Notch zone untreated; toast clips into Dynamic Island region |
| **Pixel 7** | 412 × 915 | 2.625 | fits (~28 px gutter) | ~250 px | ~50 % of viewport height | Most viewport wasted on decorative bg |

Card is a **fixed `width: 384 px`** container. That is the root cause of horizontal overflow on every iPhone-class viewport. Mobile-native answer: edge-to-edge with safe gutters (e.g. `width: 100% - 32 px`) or a bottom-sheet that snaps to the lower 75 % of the viewport.

`document.documentElement.scrollWidth === window.innerWidth` on every viewport because `body { overflow-x: visible }` doesn't equal *no overflow* — it just doesn't show a scrollbar. The form card is still partially behind the viewport edge; users see clipped border-radius.

---

## Findings — by category

### 1. Tap targets (Apple HIG ≥ 44 pt / Material 3 ≥ 48 dp)

Measured DOM bounding boxes:

| Element | W × H (px) | HIG verdict |
|---|---|---|
| Email input (`/login` step 1) | 334 × **36** | Fails HIG (44) and Material (48) |
| "Send code" submit | 334 × **36** | Fails |
| OTP single input | 277 × **36** | Fails |
| "Verify" submit | 277 × **36** | Fails |
| "Use a different email" link-button | 277 × **18** | **Fails by 2.4×** — basically not tappable on the move |

Recommendation: 48 px default for buttons, 56 px for primary CTAs (matches Material 3 large-button + iOS HIG when at 1× DPR), 44 px floor for any inline link/button.

### 2. Form input — iOS Safari pitfalls

Probed via `getComputedStyle` and attribute reflection:

```
input[type=email]
  fontSize:        14px         ← triggers iOS Safari zoom-on-focus (must be ≥16px)
  autocapitalize:  null         ← defaults to "sentences" on iOS → "Test@…"
  autocomplete:    email        ← OK
  inputMode:       null         ← should be "email" (presents @ key on Android Chrome)
  autocorrect:     null         ← should be "off"
  spellcheck:      null         ← should be "false"
```

The OTP step gets it right except for font-size:

```
input (OTP)
  fontSize:        16px         ← OK, no zoom
  letterSpacing:   8px          ← visually wide but it's a single field
  inputMode:       numeric      ← OK
  autocomplete:    one-time-code ← OK (will surface SMS / mail OTP picker on iOS)
  pattern:         [0-9]*       ← OK
  maxLength:       6            ← OK
```

**Visual treatment is wrong though.** Native iOS / Material 3 OTP UI is **6 individual digit boxes**. The current single field defeats the affordance — users can't see how many digits they've typed without counting, and paste is harder to verify. See `08-iphonese-otp-step.png`.

### 3. PWA / native chrome

Head-tag inventory:

| Tag | Present | Value |
|---|---|---|
| `<link rel="manifest">` | **No** | — |
| `<meta name="theme-color">` | **No** | — (no Android status-bar tint) |
| `<meta name="apple-mobile-web-app-capable">` | **No** | — (no iOS standalone) |
| `<meta name="apple-mobile-web-app-status-bar-style">` | **No** | — |
| `<meta name="msapplication-TileColor">` | **No** | — |
| `<link rel="apple-touch-icon">` | Yes | `/apple-touch-icon.png` |
| `<meta name="viewport">` | Yes | `width=device-width, initial-scale=1.0` |

Implications:
- Cannot be added to home screen with proper chrome on either iOS or Android.
- Cannot launch full-screen / standalone.
- No splash, no themed status bar, no install prompt.
- `viewport-fit=cover` missing — required for edge-to-edge layouts that use safe-area insets.

For a **mail / inbox** app this is a particularly large miss. Native mail clients on iOS / Android are full-screen apps with a tinted status bar, push notifications, badge counts. Even a v1 PWA buys: install banner, branded splash, themed chrome, persistent login (cookie + service worker shell).

### 4. Safe areas / notch handling

Single fixed-positioned element on the page is the toast container:

```
.fixed.top-4.left-1/2.-translate-x-1/2
```

`top-4` = 16 px from the top edge, no `safe-area-inset-top` adjustment. On iPhone 14 Pro the notch / Dynamic Island region begins at the top edge with ~59 px of vertical real-estate; the toast is partly behind it (see `08-iphonese-otp-step.png` where the toast text is partially obscured against the wallpaper-like bg).

Fix: `top: max(env(safe-area-inset-top, 16px), 16px) + 16px`, or use a `padding-top: env(safe-area-inset-top)` wrapper on a sticky region.

The viewport meta also lacks `viewport-fit=cover`, so the body doesn't paint into the safe-area regions on iOS Safari — the decorative bg image leaves a colored band at top and bottom on real hardware (not visible in Chromium emulation).

### 5. Validation theatre

`POST /login` with `notarealuser+mobile-audit@example.invalid` returned the OTP step (`Check your inbox / Enter the 6-digit code we just sent / Code sent to notarealuser+mobile-audit@example.invalid`). Either:

- (a) the app accepts any syntactically-valid email and the OTP send happens async / silently fails, OR
- (b) it intentionally accepts to avoid revealing whether an email is registered.

Either way, the UX claims success ("Code sent — check your inbox") with the user's own typo / invalid address. On a thumb-typed mobile email field with autocapitalize defaulting to `sentences`, this is a **high-failure-rate path**. A mobile-native flow should:

1. Strict TLD parse + at-least-one-MX hint client-side (warn, don't block).
2. Show the email back to the user in a way they can correct in one tap (avatar bubble + edit chip rather than a "Use a different email" link button).
3. Auto-launch the mail client via `mailto:` deep-link or — much better on iOS — read the OTP from SMS/email automatically via `autocomplete="one-time-code"` (already wired) plus a "Open Mail" button.

### 6. Visual density / decorative weight

Background: a 1.2 MB landscape image of a "Trusted Agent Inbox" pedestal. On the SE viewport it is `~50 %` of the rendered pixels; on Pixel 7 / 14 Pro closer to `60 %`. Costs:

- Bandwidth (mobile data on first visit) — 1.2 MB before any auth flow.
- Visual clutter — competes with form for attention; legibility of the Cloudflare attribution + "We'll email you a 6-digit code…" footer is low against the bg.
- Renders heavy on the Pixel 7's lower-end chipsets (real device, not Chromium emulation, will show this more).

Mobile-native answer: a flat solid bg or a subtle gradient. Reserve the lifestyle imagery for the marketing page; the auth surface should look like a *tool*, not a hero.

### 7. Hydration / CSP / Turnstile

Console (50 most recent of 55 entries on landing):

- 14× Trusted Types / inline-script CSP violations (`This document requires 'TrustedHTML' assignment`, `Executing inline script violates …`).
- 1× `Form submission canceled because the form is not connected` — React Router hydration race; the form root is replaced before the in-flight submit settles.
- Cloudflare Private Access Token challenge fires a `401` on first request as documented (groupCollapsed / groupEnd).
- 4× audio/video codec parse warnings (cosmetic; from CF Access analytics).

Functional impact on mobile:
- The CSP violations are **not blocking the form** but they're paying parse-time cost on mobile silicon. They also indicate the React Router build emits inline `<script>` blocks that don't carry the per-request nonce, which is a CSP regression that should be cleaned up regardless of the redesign.
- The Cloudflare Turnstile widget rendered on the SE and Pixel 7 captures but **was not present on the iPhone 14 Pro re-render** (`document.querySelector('iframe[src*=turnstile]')` returned null on the second probe). Flaky widget = sign-in failures we cannot reproduce reliably from here. Worth instrumenting client-side telemetry on widget mount/timeout.

---

## Screenshot gallery

All under `.scratch/mobile-audit/` (gitignored). File list:

| # | File | Subject |
|---|---|---|
| 01 | `01-iphone14pro-landing-viewport.png` | iPhone 14 Pro initial render, fold view |
| 02 | `02-iphone14pro-landing-fullpage.png` | iPhone 14 Pro full scrollable page |
| 03 | `03-iphonese-landing-viewport.png` | iPhone SE fold view (note Turnstile blank) |
| 04 | `04-iphonese-landing-fullpage.png` | iPhone SE full page |
| 05 | `05-pixel7-landing-viewport.png` | Pixel 7 fold view (Turnstile rendered) |
| 06 | `06-pixel7-landing-fullpage.png` | Pixel 7 full page |
| 07 | `07-iphonese-email-filled.png` | SE — email filled, before submit (Turnstile success) |
| 08 | `08-iphonese-otp-step.png` | SE — OTP step, top-clipped toast visible |
| 09 | `09-iphonese-otp-fullpage.png` | SE — OTP full page |
| 10 | `10-iphone14pro-landing-rerender.png` | 14 Pro — re-render w/ Turnstile rect not found |

Re-generate from this tree:

```bash
ls /Users/dev/ActionNowAI/agentic-inbox/.scratch/mobile-audit/
```

---

## Recommendations for the mobile-native redesign

These are *direction* decisions — every one trades off against simply tightening the existing card. Frame them in the next `/session-plan`.

### A. Shape (most impactful)

1. **Bottom-sheet sign-in.** On viewports < 600 px wide, present the email + OTP flow as a sheet that snaps to ~75 % of viewport height, anchored bottom — primary CTA in the thumb zone (lower third). Top section becomes a brand mark + tagline. Eliminates the "card centered in 195 px of decorative dead space" problem.
2. **Drop the fixed 384 px card.** Use `width: 100%` with `max-width: 480px` and `margin-inline: 16px`. Card no longer overflows on SE / 14 Pro.
3. **Replace the wallpaper bg on auth surfaces** with a solid color or subtle gradient. Save the lifestyle imagery for the post-auth marketing/landing — auth should feel like a tool.
4. **Edge-to-edge with safe-area-inset.** Add `viewport-fit=cover` to the viewport meta. Wrap fixed elements (toast, future bottom nav) in `padding: env(safe-area-inset-top) … env(safe-area-inset-bottom)`.

### B. Form correctness

5. **Email input attrs:** `inputmode="email"`, `autocapitalize="none"`, `autocorrect="off"`, `spellcheck="false"`, `font-size: 16px` (minimum). All of this is one-line fixes and should land independent of the redesign.
6. **OTP visual treatment:** 6 individual boxes with `inputmode="numeric"`, paste-spreads-across-boxes JS, autofocus on first, auto-advance on key, programmatic submit on 6th. Keep `autocomplete="one-time-code"` on the hidden master input.
7. **Resend-code affordance** with a 30-second countdown — required surface on every OTP screen.

### C. Tap-target floor

8. **48 px minimum** for any button/link/checkbox; 56 px for the primary CTA. "Use a different email" becomes a chip-style button at 44 px tall, not an 18 px text link.

### D. Native chrome

9. **PWA manifest** at `/manifest.webmanifest`: `name`, `short_name`, `start_url`, `display: standalone`, `theme_color`, `background_color`, `icons[]` (192 / 512 / maskable).
10. **`<meta name="theme-color">`** matching the app's primary surface color (Android status bar tint).
11. **`<meta name="apple-mobile-web-app-capable" content="yes">`** + **`<meta name="apple-mobile-web-app-status-bar-style" content="default">`** (or `black-translucent` if the redesign goes edge-to-edge).
12. **Service worker (offline shell + cache).** Even a minimal app-shell SW that serves `/login` from cache when offline turns this into a "feels installed" experience.

### E. Hydration / CSP

13. **Eliminate inline-script CSP violations.** Either move all hydration scripts behind nonce-able external bundles or whitelist via hash. The 14 violations on every page load are a smell — and on mobile silicon the parse-time cost is non-zero.
14. **Stabilise the Turnstile mount.** The widget didn't render on iPhone 14 Pro on second nav. Add a mount/timeout instrument and a fallback CTA ("Continue without challenge") gated by server policy.

### F. Empty + error states

15. **Server-side TLD validation** with a clear inline error rather than silently advancing to "Code sent" on `.invalid`.
16. **Strong inline edit on the OTP step.** Show the email as an editable chip (`[ pavel@digifirst.org · ✎ ]`), one tap to fix typo, no full back-step.

### G. Mobile-native ambition (out-of-scope but on the radar)

17. **Push-notification opt-in** post-first-OTP-success — drives the inbox-feels-like-an-app loop.
18. **Web Share Target** registration in the manifest — let users share emails / actions to mail.actionnow.ai from any app.
19. **iOS / Android app shells** via Capacitor or PWA-Builder if the v1 PWA earns its keep.

---

## Decision-driving questions

To turn this audit into a redesign brief in the next session:

1. **Bottom-sheet or full-bleed?** Both ship "feels native"; bottom-sheet wins on thumb-reachability, full-bleed wins on visual ambition. The sheet is more disciplined.
2. **PWA-first or native-shell-later?** Recommend PWA-first; revisit shell wrappers only if PWA usage is real.
3. **Brand keep / drop on auth?** The "Trusted Agent Inbox" tagline and lifestyle bg play well in marketing — recommend dropping both on the auth surface.
4. **OTP 6-box vs single-field** — picking 6-box is the right answer for almost every audience; raise it as a decision only because it's an iOS / Android-Chrome divergence.

---

## Open questions

- Does Turnstile occasionally fail on real iOS devices (not just our headless emulation)? Need real-device telemetry before the redesign locks the auth flow.
- Is `.invalid` accepted intentionally (anti-enumeration) or by oversight? Behaviour decision, not just UX.
- Is there a session-resume path on mobile (PAT, magic link) we should design *into* the redesign rather than bolt-on later?

---

## Sources

- Live page: `https://mail.actionnow.ai/login?from=%2F` (probed 2026-05-08, 17:14 PT).
- Apple HIG — Tap Targets: 44 × 44 pt minimum.
- Material 3 — Touch Targets: 48 × 48 dp minimum.
- iOS Safari zoom-on-focus suppression: `font-size ≥ 16px` (well-documented behaviour, e.g. WebKit blog).
- WCAG 2.2 — 2.5.5 Target Size (Enhanced) — 44 × 44 CSS px.
- DOM probes via `mcp__browser-mcp__browser_evaluate` — full source recorded in episode `ep_30c372b40d82`.

---

## Next step

`/session-plan` against this audit → propose the redesign as a multi-phase plan (start with form-correctness fixes that ship today, then the bottom-sheet shape, then PWA chrome, then SW). The audit is the input; the planner picks the trajectory.
