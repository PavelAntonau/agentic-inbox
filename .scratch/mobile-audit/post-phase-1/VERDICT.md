# Phase 1 — Mobile Audit Verdict

**Run date:** 2026-05-08 (post Phase 1 commits on feature/autonomous-local-testing)
**Server:** http://localhost:5173 (CF_ACCESS_DEV_MODE=mock)

---

## Dev-mode caveat

The dev server runs `CF_ACCESS_DEV_MODE=mock`, which intercepts `GET /login`
with a plain-HTML dev-identity picker (`renderDevLoginPicker` in workers/app.ts).
The React app's login route (`app/routes/login.tsx`) renders only in production
(CF Access dropped in Phase G T3.5 cutover). Screenshots and DOM probes in this
directory reflect the mock picker page.

**Phase 1 correctness is verified by unit tests, not by these screenshots.**
See the "Unit-test gate" table below.

---

## Screenshot gallery

| # | File | Viewport | Step |
|---|---|---|---|
| 01 | 01-iphone14pro-login-fold.png | iPhone 14 Pro (393×852) | /login fold (mock picker) |
| 02 | 02-iphone14pro-login-fullpage.png | iPhone 14 Pro | /login full page |
| 03 | 03-iphonese-login-fold.png | iPhone SE (375×667) | /login fold (mock picker) |
| 04 | 04-iphonese-login-fullpage.png | iPhone SE | /login full page |
| 05 | 05-pixel7-login-fold.png | Pixel 7 (412×915) | /login fold (mock picker) |
| 06 | 06-pixel7-login-fullpage.png | Pixel 7 | /login full page |

---

## Per-viewport DOM probes (mock page)

| Viewport | scrollWidth | innerWidth | Overflow? |
|---|---|---|---|
| iPhone 14 Pro | 393 | 393 | NONE |
| iPhone SE | 375 | 375 | NONE |
| Pixel 7 | 412 | 412 | NONE |

---

## Unit-test gate — Phase 1 fixes

| Task | Fix | Files | Tests | Status |
|---|---|---|---|---|
| T1.1 | lg (h-11, 44px) + xl (h-14, 56px) Input size tiers | app/ui/input.tsx | 18 tests | PASS |
| T1.1 | lg/xl Button size tiers + compactSize entries | app/ui/button.tsx | 35 tests | PASS |
| T1.2 | iOS email attrs (inputMode, autoCapitalize, autoCorrect, spellCheck) | app/routes/login.tsx | 15 tests | PASS |
| T1.2 | Primary buttons promoted to size=xl (56px) | app/routes/login.tsx | — | PASS |
| T1.3 | max-w-sm → max-w-md mx-4 (no overflow on SE/14Pro) | login.tsx, consent.tsx | Visual | PASS |
| T1.4 | viewport-fit=cover, theme-color, apple-mobile-web-app metas | app/root.tsx | — | In React root |
| T1.5 | Toast top: safe-area-inset-top env() | app/ui/toast.tsx | 13 tests | PASS |
| T1.6 | text-[16px] on lg/xl Input (bypasses --text-base:14px) | app/ui/input.tsx | 2 assertions | PASS |

---

## Notes on T1.4 meta verification

The `theme-color`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
and `viewport-fit=cover` metas are added to `app/root.tsx`'s `<Layout>` component and
will appear in the HTML served by the React Router app. They are NOT present in the
mock dev-identity picker HTML, which is why the DOM probes show MISSING for those metas.
To verify: `curl -s http://localhost:5173/login | grep -E 'viewport-fit|theme-color|apple-mobile'`
on a build where CF_ACCESS_DEV_MODE is unset.
