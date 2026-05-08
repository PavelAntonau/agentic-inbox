// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase 6.1 — branded sign-in page. Two-step flow:
//   1. Email entry → POST /api/auth/email-otp/send-verification-otp
//   2. OTP entry  → POST /api/auth/sign-in/email-otp
//
// On successful verification better-auth sets a `__Host-anai.session_token`
// cookie. We then navigate to the original ?redirect= target (or `/`).
//
// During Phase 6.1 this page is reachable INSIDE the existing CF Access
// authentication shell (CF Access still wraps the worker). After Phase 6.2's
// cutover this becomes the primary auth gate.
//
// Phase G-2 — Turnstile widget integration.
//   • The Turnstile JS is loaded via a <script> tag injected into <head> on
//     mount.  The widget renders in the email-entry step form.
//   • On submit, `window.turnstile.getResponse()` provides the token, which is
//     forwarded as the `X-Turnstile-Token` header on the OTP-send fetch.
//   • The site key is read from the `TURNSTILE_SITE_KEY` env var inlined at
//     build time by Vite (see vite.config.ts `define`).  Integrators MUST set
//     this var (see docs/phase-g-dashboard-config.md).

import { Button, Input, Loader, useToastManager } from "~/ui";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { authClient } from "~/lib/auth-client";
import Logo from "~/components/Logo";
import loginHeroUrl from "~/assets/branding/login-hero.webp?url";

// ---------------------------------------------------------------------------
// Turnstile globals — declared so TypeScript does not error on window.turnstile.
// The actual implementation is injected at runtime by the CF Turnstile script.
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    turnstile?: {
      render(
        container: string | HTMLElement,
        options: TurnstileOptions,
      ): string;
      getResponse(widgetId?: string): string | undefined;
      reset(widgetId?: string): void;
      remove(widgetId?: string): void;
    };
  }
}

interface TurnstileOptions {
  sitekey: string;
  callback?: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
}

// Vite build-time constant. Provide via `define: { TURNSTILE_SITE_KEY: ... }`
// in vite.config.ts, or fall back to empty string (widget won't render).
declare const TURNSTILE_SITE_KEY: string;
const SITE_KEY: string =
  typeof TURNSTILE_SITE_KEY !== "undefined" ? TURNSTILE_SITE_KEY : "";

export function meta() {
  return [{ title: "Sign in | ActionNowAI Mail" }];
}

type Step = "email" | "otp";

/**
 * Phase C3 / TASK-C3.22 — D-12 fix.
 *
 * The previous regex was `^\/(?!\/)[^?#]*([?#].*)?$`, which rejected the
 * `//evil.com` protocol-relative form but still accepted `/\\evil.com`
 * because `\` was permitted inside the path body. Some browsers (notably
 * older Safari and IE) normalise `\` to `/` before navigation, turning
 * `/\\evil.com` into `//evil.com` AFTER the safeRedirect check has already
 * approved it.
 *
 * The hardened pattern:
 *   • Starts with a single `/`.
 *   • Disallows `/` and `\` immediately after — `(?![\/\\])`.
 *   • Path body forbids both `\` and `?#` — `[^\\?#]*`.
 *   • Optional query/fragment captured but no further constraint (browser
 *     parses these per RFC 3986).
 */
const SAFE_REDIRECT_PATTERN = /^\/(?![\/\\])[^\\?#]*([?#].*)?$/;

function safeRedirect(raw: string | null): string {
  if (!raw) return "/";
  // Only same-origin paths starting with a single `/`, no `//` or `/\` (both
  // browser-normalised to a protocol-relative URL on some platforms).
  if (!SAFE_REDIRECT_PATTERN.test(raw)) return "/";
  if (raw.startsWith("/login")) return "/";
  return raw;
}

// Phase C3 / TASK-C3.22 — exported so the test file can exercise it directly.
export { safeRedirect, SAFE_REDIRECT_PATTERN };

// Client-side email-shape gate. Prevents the "Send code" button from
// activating on a half-typed string and burning a Turnstile challenge or
// a per-email-rate-limit slot on garbage. The backend remains the source
// of truth (better-auth's email validator + the per-email rate-limiter
// in workers/middleware/auth-rate-limit.ts both enforce on the wire).
//
// Pattern is the standard "local @ domain . tld" shape — accepts +tags,
// dots, and Unicode in the local part; rejects whitespace, double-@, and
// missing TLD. Conservative enough to catch typos, lenient enough not to
// reject legitimate addresses (we don't enforce RFC 5321 here; the server
// and the eventual SMTP exchange handle the long-tail).
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmailShape(s: string): boolean {
  return EMAIL_SHAPE_RE.test(s.trim());
}
export { EMAIL_SHAPE_RE, isValidEmailShape };

export default function LoginRoute() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToastManager();

  const redirect = safeRedirect(searchParams.get("redirect"));

  // Plain-text invitation emails route recipients to /login?email=<urlencoded>;
  // pre-fill the input so they can hit "Send code" immediately. We still let
  // the user edit it before submission.
  const prefilledEmail = (() => {
    const raw = searchParams.get("email");
    if (!raw) return "";
    const trimmed = raw.trim();
    return trimmed.includes("@") ? trimmed : "";
  })();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(prefilledEmail);
  const [otp, setOtp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const otpInputRef = useRef<HTMLInputElement>(null);

  // Phase G-2 — Turnstile widget state.
  // `turnstileToken` holds the most recent solved-challenge token. It is
  // populated by the Turnstile callback and cleared when the form is submitted
  // or when the challenge expires. `turnstileWidgetId` lets us reset the
  // widget after a successful submission so it is fresh for any retry.
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const turnstileWidgetId = useRef<string>("");
  const turnstileContainerRef = useRef<HTMLDivElement>(null);

  // Phase G-2 — load the Turnstile script once on mount and render the widget
  // into `turnstileContainerRef` as soon as the script is ready.
  useEffect(() => {
    if (!SITE_KEY) return; // site key not configured — skip (dev / CI)

    const SCRIPT_ID = "cf-turnstile-script";
    const CALLBACK_NAME = "__turnstileOnLoad";

    // Idempotent: if the script is already present (HMR re-mount), skip.
    if (!document.getElementById(SCRIPT_ID)) {
      // Register a global onload callback that Turnstile will invoke once the
      // script has finished bootstrapping its runtime.
      (window as unknown as Record<string, unknown>)[CALLBACK_NAME] = () => {
        if (!turnstileContainerRef.current || !window.turnstile) return;
        turnstileWidgetId.current = window.turnstile.render(
          turnstileContainerRef.current,
          {
            sitekey: SITE_KEY,
            theme: "auto",
            callback: (token: string) => setTurnstileToken(token),
            "expired-callback": () => setTurnstileToken(""),
            "error-callback": () => setTurnstileToken(""),
          },
        );
      };

      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?onload=${CALLBACK_NAME}&render=explicit`;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else if (window.turnstile && turnstileContainerRef.current) {
      // Script already loaded (HMR case) — render directly.
      turnstileWidgetId.current = window.turnstile.render(
        turnstileContainerRef.current,
        {
          sitekey: SITE_KEY,
          theme: "auto",
          callback: (token: string) => setTurnstileToken(token),
          "expired-callback": () => setTurnstileToken(""),
          "error-callback": () => setTurnstileToken(""),
        },
      );
    }

    return () => {
      // Clean up the widget on unmount to avoid duplicate renders.
      if (window.turnstile && turnstileWidgetId.current) {
        window.turnstile.remove(turnstileWidgetId.current);
        turnstileWidgetId.current = "";
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally once

  // Already-authenticated short-circuit. If the user lands on /login but
  // already has a valid better-auth session, send them through to redirect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await authClient.getSession();
        if (!cancelled && data?.session) {
          navigate(redirect, { replace: true });
        }
      } catch {
        // No session — stay on the form.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, redirect]);

  // When we transition to the OTP step, focus the OTP input.
  useEffect(() => {
    if (step === "otp") otpInputRef.current?.focus();
  }, [step]);

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    // Defensive: the Send button is disabled when the email shape is
    // invalid, but Enter-submit can bypass the disabled attribute on some
    // browsers, and a future refactor could forget the disabled gate.
    // Validate here too — the backend will also reject, but this saves a
    // wasted Turnstile token + a per-email-rate-limit slot.
    const trimmed = email.trim();
    if (!isValidEmailShape(trimmed)) {
      toast.add({ title: "Enter a valid email address", variant: "error" });
      return;
    }

    // Phase G-2 — Turnstile gate. If SITE_KEY is configured and no token has
    // been resolved yet, refuse to submit and prompt the user to complete the
    // challenge.  When SITE_KEY is absent (dev / CI) we skip this check so
    // the flow is unaffected in environments without a real site key.
    const token = turnstileToken || window.turnstile?.getResponse() || "";
    if (SITE_KEY && !token) {
      toast.add({
        title: "Please complete the security challenge.",
        variant: "error",
      });
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: trimmed,
        type: "sign-in",
        ...(token
          ? { fetchOptions: { headers: { "X-Turnstile-Token": token } } }
          : {}),
      });

      // Phase G-2 — reset widget after each submission attempt so the token
      // cannot be replayed on a second send.
      if (window.turnstile && turnstileWidgetId.current) {
        window.turnstile.reset(turnstileWidgetId.current);
      }
      setTurnstileToken("");
      if (error) {
        toast.add({
          title: error.message ?? "Failed to send code",
          variant: "error",
        });
        return;
      }
      toast.add({ title: "Code sent — check your inbox." });
      setStep("otp");
    } catch {
      toast.add({ title: "Network error — try again.", variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = otp.trim();
    if (trimmed.length < 6) {
      toast.add({ title: "Enter the 6-digit code", variant: "error" });
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await authClient.signIn.emailOtp({
        email: email.trim(),
        otp: trimmed,
      });
      if (error) {
        toast.add({
          title: error.message ?? "Invalid or expired code",
          variant: "error",
        });
        setOtp("");
        return;
      }
      toast.add({ title: "Signed in." });
      navigate(redirect, { replace: true });
    } catch {
      toast.add({ title: "Network error — try again.", variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  // Mobile-only: the form column is wrapped in a glass-morphism card
  // (semi-transparent surface + backdrop-blur) that floats centered over
  // a full-screen hero image background. Desktop (md+) keeps the
  // two-column split where the image lives in its own right column —
  // these classes are no-ops on md+ thanks to `md:bg-transparent` etc.
  // bg-card/55 reads correctly in BOTH light and dark themes (the token
  // is theme-aware, so the glass panel inverts with the rest of the UI).
  const mobileGlassCard =
    "rounded-2xl bg-card/55 backdrop-blur-xl border border-white/30 dark:border-white/10 shadow-2xl p-6 " +
    "md:bg-transparent md:backdrop-blur-0 md:border-0 md:shadow-none md:p-0 md:rounded-none";

  return (
    // Two-column split: form on the left, brand hero image on the right.
    // Mobile (< md): the right column collapses; in its place a
    // full-bleed hero image fills the viewport and the form sits on a
    // glass card on top. The page sits on the site's existing `bg-bg`
    // + the fixed radial-gradient pseudo-elements painted by
    // app/index.css for the desktop case.
    <div className="min-h-screen flex items-stretch bg-bg relative overflow-hidden">
      {/* ── Mobile-only: full-bleed hero behind the form ──────────────── */}
      <div
        className="md:hidden absolute inset-0 z-0 pointer-events-none"
        aria-hidden="true"
      >
        <img
          src={loginHeroUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Light dim layer to keep the foreground form readable on bright
            sections of the image. Theme-neutral; tuned by visual check
            (Playwright headed at 390 × 844). */}
        <div className="absolute inset-0 bg-black/15" />
      </div>

      {/* ── Left: form column ─────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center px-6 py-10 md:px-12 md:py-12 relative z-10">
        <div className={`w-full max-w-sm ${mobileGlassCard}`}>
          <div className="flex flex-col items-center text-center mb-6 md:mb-8">
            <Logo height={72} to={null} className="mb-4" />
            <h1 className="text-2xl font-semibold text-text-bright">
              {step === "email" ? "Welcome back" : "Check your inbox"}
            </h1>
            <p className="text-sm text-text-muted mt-1">
              {step === "email"
                ? "Sign in with your email to continue."
                : "Enter the 6-digit code we just sent."}
            </p>
          </div>

          {step === "email" ? (
            <>
              <form
                onSubmit={handleSendOtp}
                className="flex flex-col gap-3"
                aria-label="Sign in with email"
              >
                <Input
                  aria-label="Email address"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  autoComplete="email"
                  disabled={submitting}
                />
                {/* Send button sits directly under the email input,
                    full-width, primary variant. Shimmer-on-hover comes
                    from `bg-kumo-brand` in app/index.css automatically.
                    Stays disabled until the email shape validates AND
                    the Turnstile token has resolved. */}
                <Button
                  type="submit"
                  variant="primary"
                  size="base"
                  loading={submitting}
                  className="w-full"
                  disabled={
                    !isValidEmailShape(email) ||
                    (SITE_KEY ? !turnstileToken : false)
                  }
                >
                  {submitting ? <Loader size="sm" /> : "Send code"}
                </Button>
              </form>

              {/* Phase G-2 — Turnstile widget. Wrapped in a rounded
                  surface so the CF challenge sits inside the same visual
                  language as the rest of the form. The widget itself
                  renders inside `turnstileContainerRef`; we only style
                  the surrounding card here. On mobile we skip the
                  inner glass (the outer card already provides it) and
                  drop the bg fill so it reads as part of one surface. */}
              {SITE_KEY && (
                <div className="mt-5 rounded-xl border border-border bg-card/60 backdrop-blur-sm p-4 shadow-sm md:bg-card/60 md:backdrop-blur-sm">
                  <div
                    ref={turnstileContainerRef}
                    className="flex justify-center"
                    aria-label="Security challenge"
                  />
                </div>
              )}

              <p className="text-xs text-text-muted text-center mt-6">
                We'll email you a 6-digit code that expires in 10 minutes.
              </p>
            </>
          ) : (
            <form
              onSubmit={handleVerifyOtp}
              className="flex flex-col gap-3"
              aria-label="Verify code"
            >
              <p className="text-xs text-text-muted text-center">
                Code sent to <span className="text-text-bright">{email}</span>
              </p>
              <Input
                ref={otpInputRef}
                aria-label="Verification code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="123456"
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                autoComplete="one-time-code"
                maxLength={6}
                disabled={submitting}
                className="text-center text-lg tracking-[0.5em] font-mono"
              />
              <Button
                type="submit"
                variant="primary"
                size="base"
                loading={submitting}
                className="w-full"
                disabled={otp.length < 6}
              >
                {submitting ? <Loader size="sm" /> : "Verify"}
              </Button>
              <button
                type="button"
                className="text-xs text-text-muted hover:text-text transition-colors mt-2"
                onClick={() => {
                  setStep("email");
                  setOtp("");
                }}
              >
                Use a different email
              </button>
            </form>
          )}
        </div>
      </div>

      {/* ── Right: hero image (md+ only) ──────────────────────────────── */}
      <div
        className="hidden md:block flex-1 relative overflow-hidden"
        aria-hidden="true"
      >
        <img
          src={loginHeroUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          // The intrinsic 1122 × 1402 source carries the file (~118 KB
          // WebP). object-cover crops to fit; on a half-screen panel
          // the framing keeps the central robot composition centered
          // at all common viewport ratios.
        />
        {/* Subtle inner shadow on the seam so the image edge never reads
            as a hard cut on the form-side gradient. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            boxShadow: "inset 24px 0 48px -24px rgba(10, 29, 68, 0.35)",
          }}
        />
      </div>
    </div>
  );
}
