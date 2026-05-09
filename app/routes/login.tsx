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

import { Button, Input, useToastManager } from "~/ui";
import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { authClient } from "~/lib/auth-client";
import Logo from "~/components/Logo";
import { MobileBottomSheet } from "~/components/MobileBottomSheet";
import { OTPInput } from "~/ui/otp-input";
import { ResendCountdown } from "~/components/ResendCountdown";
import { track } from "~/services/telemetry";
import loginHeroUrl from "~/assets/branding/login-hero.webp?url";

/**
 * T3.3 — how long to wait after the Turnstile script appends to <head>
 * before we declare a mount timeout. Real-world bootstrap on the slowest
 * paths (Pixel 7 over LTE) lands in 2–4 s; 10 s is generous enough that
 * we don't false-positive on slow networks but short enough that a stuck
 * mount surfaces as a telemetry signal before the user gives up.
 */
const TURNSTILE_MOUNT_TIMEOUT_MS = 10_000;

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

  // Phase 2 — breakpoint gate for mobile shape.
  // Read at mount; update on resize. md breakpoint = 768px (Tailwind default).
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < 768 : false,
  );
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Phase G-2 — Turnstile widget state.
  // `turnstileToken` holds the most recent solved-challenge token. It is
  // populated by the Turnstile callback and cleared when the form is submitted
  // or when the challenge expires. `turnstileWidgetId` lets us reset the
  // widget after a successful submission so it is fresh for any retry.
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const turnstileWidgetId = useRef<string>("");
  const turnstileContainerRef = useRef<HTMLDivElement>(null);

  // Phase 2 — OTPInput fires onComplete when all 6 digits are filled;
  // auto-submit the verification form on that event.
  const handleOtpComplete = useCallback(
    (value: string) => {
      setOtp(value);
      // Trigger verification immediately: synthesise a form submit.
      // We schedule via setTimeout so state has settled before the async call.
      setTimeout(() => {
        void (async () => {
          setSubmitting(true);
          try {
            const { error } = await authClient.signIn.emailOtp({
              email: email.trim(),
              otp: value,
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
            toast.add({
              title: "Network error — try again.",
              variant: "error",
            });
          } finally {
            setSubmitting(false);
          }
        })();
      }, 0);
    },
    [email, navigate, redirect, toast],
  );

  // Phase 2 + T3.3 — resend OTP handler.
  //
  // Production OTP-send is gated by `requireTurnstile()` (workers/middleware/
  // turnstile.ts). The first send carries `X-Turnstile-Token` from the widget
  // callback; after that send the widget is `reset()` so its token is
  // single-use. Resend MUST attach a fresh token or the backend correctly
  // returns 403 TURNSTILE_FAILED — that 403 is the reason the Phase 2 retro
  // flagged "resend doesn't re-fire Turnstile" as a 4th telemetry concern.
  //
  // Behaviour:
  //   • SITE_KEY configured + token absent → `resend.no-token` telemetry,
  //     refuse with a clear toast prompting the user to re-solve the
  //     challenge. The widget container is still mounted (the email step is
  //     still in the DOM behind the OTP step on mobile); the user scrolls
  //     up, solves, retries.
  //   • SITE_KEY configured + token present → forward via X-Turnstile-Token,
  //     reset the widget after the send so the next resend also requires a
  //     fresh challenge.
  //   • SITE_KEY absent (dev / CI) → unchanged from before; no token plumbed.
  const handleResendOtp = useCallback(async () => {
    const trimmed = email.trim();
    const token = turnstileToken || window.turnstile?.getResponse() || "";
    if (SITE_KEY && !token) {
      track("turnstile", "resend.no-token");
      toast.add({
        title: "Solve the security challenge to resend.",
        variant: "error",
      });
      return;
    }
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: trimmed,
        type: "sign-in",
        ...(token
          ? { fetchOptions: { headers: { "X-Turnstile-Token": token } } }
          : {}),
      });
      // Single-use token — reset the widget after every resend attempt so a
      // replay is not possible on the next click.
      if (window.turnstile && turnstileWidgetId.current) {
        window.turnstile.reset(turnstileWidgetId.current);
      }
      setTurnstileToken("");
      if (error) {
        track("turnstile", "resend.error", {
          message: error.message ?? null,
        });
        toast.add({
          title: error.message ?? "Failed to resend code",
          variant: "error",
        });
      } else {
        track("turnstile", "resend.success");
        toast.add({ title: "Code resent — check your inbox." });
        setOtp("");
      }
    } catch {
      track("turnstile", "resend.network-error");
      toast.add({ title: "Network error — try again.", variant: "error" });
    }
  }, [email, turnstileToken, toast]);

  // Phase G-2 — load the Turnstile script once on mount and render the widget
  // into `turnstileContainerRef` as soon as the script is ready.
  //
  // T3.3 — telemetry covers four lifecycle states:
  //   • `mount.script_loaded`    — onload callback fired (script bootstrapped).
  //   • `mount.widget_rendered`  — render() returned a widget id (visible).
  //   • `mount.timeout`          — neither happened within TURNSTILE_MOUNT_TIMEOUT_MS.
  //   • `error` / `expired` / `success` — solver-side outcomes.
  // The 4th audit concern (resend without token) is instrumented in
  // handleResendOtp below.
  useEffect(() => {
    if (!SITE_KEY) return; // site key not configured — skip (dev / CI)

    const SCRIPT_ID = "cf-turnstile-script";
    const CALLBACK_NAME = "__turnstileOnLoad";
    const mountStart = Date.now();
    let widgetRendered = false;

    function renderWidget() {
      if (!turnstileContainerRef.current || !window.turnstile) return;
      turnstileWidgetId.current = window.turnstile.render(
        turnstileContainerRef.current,
        {
          sitekey: SITE_KEY,
          theme: "auto",
          callback: (token: string) => {
            setTurnstileToken(token);
            track("turnstile", "success", {
              elapsed_ms: Date.now() - mountStart,
            });
          },
          "expired-callback": () => {
            setTurnstileToken("");
            track("turnstile", "expired");
          },
          "error-callback": () => {
            setTurnstileToken("");
            track("turnstile", "error");
          },
        },
      );
      widgetRendered = !!turnstileWidgetId.current;
      if (widgetRendered) {
        track("turnstile", "mount.widget_rendered", {
          elapsed_ms: Date.now() - mountStart,
        });
      }
    }

    // Idempotent: if the script is already present (HMR re-mount), skip.
    if (!document.getElementById(SCRIPT_ID)) {
      // Register a global onload callback that Turnstile will invoke once the
      // script has finished bootstrapping its runtime.
      (window as unknown as Record<string, unknown>)[CALLBACK_NAME] = () => {
        track("turnstile", "mount.script_loaded", {
          elapsed_ms: Date.now() - mountStart,
        });
        renderWidget();
      };

      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?onload=${CALLBACK_NAME}&render=explicit`;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else if (window.turnstile && turnstileContainerRef.current) {
      // Script already loaded (HMR case) — render directly.
      renderWidget();
    }

    // Mount-timeout watchdog. Fires once if neither the onload callback nor
    // the direct render() call produces a widget id. Surfaces a telemetry
    // event the next auditor can grep for (and a future iteration can use
    // to render a "Continue without challenge" fallback CTA gated by
    // server policy — audit recommendation E.14).
    const timeoutHandle = window.setTimeout(() => {
      if (!widgetRendered) {
        track("turnstile", "mount.timeout", {
          elapsed_ms: TURNSTILE_MOUNT_TIMEOUT_MS,
        });
      }
    }, TURNSTILE_MOUNT_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutHandle);
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

  // OTPInput auto-focuses its first box on mount; no manual focus needed.

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

  // ---------------------------------------------------------------------------
  // Shared auth form content — used inside both the mobile bottom-sheet and
  // the desktop card.  Extracted to avoid duplication.
  // ---------------------------------------------------------------------------

  const emailForm = (
    <>
      <form
        onSubmit={handleSendOtp}
        className="flex flex-col gap-3"
        aria-label="Sign in with email"
      >
        <Input
          aria-label="Email address"
          type="email"
          size="lg"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={submitting}
        />
        {/* Send button — full-width primary. Disabled until email validates
            AND Turnstile token has resolved (when SITE_KEY is configured). */}
        <Button
          type="submit"
          variant="primary"
          size="xl"
          loading={submitting}
          className="w-full justify-center"
          disabled={
            !isValidEmailShape(email) || (SITE_KEY ? !turnstileToken : false)
          }
        >
          Send code
        </Button>
      </form>

      {/* Phase G-2 — Turnstile challenge widget */}
      {SITE_KEY && (
        <div className="mt-5 rounded-xl border border-border bg-card/60 backdrop-blur-sm p-4 shadow-sm">
          <div
            ref={turnstileContainerRef}
            className="flex justify-center"
            aria-label="Security challenge"
          />
        </div>
      )}

      <p className="text-xs text-text-muted text-center mt-6">
        We&apos;ll email you a 6-digit code that expires in 10 minutes.
      </p>
    </>
  );

  const otpForm = (
    <form
      onSubmit={handleVerifyOtp}
      className="flex flex-col gap-3 items-center"
      aria-label="Verify code"
    >
      <p className="text-xs text-text-muted text-center w-full">
        Code sent to <span className="text-text-bright">{email}</span>
      </p>
      {/* Phase 2 — 6-box OTPInput replaces the single text Input.
          onComplete auto-submits when the 6th digit is entered. */}
      <OTPInput
        value={otp}
        onChange={setOtp}
        onComplete={handleOtpComplete}
        disabled={submitting}
      />
      <Button
        type="submit"
        variant="primary"
        size="xl"
        loading={submitting}
        className="w-full justify-center"
        disabled={otp.replace(/\D/g, "").length < 6}
      >
        Verify
      </Button>
      {/* Phase 2 — ResendCountdown beneath the Verify button */}
      <ResendCountdown
        onResend={handleResendOtp}
        disabled={submitting}
        className="w-full flex justify-center"
      />
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
  );

  // Header block reused in both shapes.
  const authHeader = (
    <div className="flex flex-col items-center text-center mb-6">
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
  );

  // ── Mobile shape (<md): bottom-sheet ──────────────────────────────────────
  if (isMobile) {
    return (
      <div className="min-h-screen bg-bg relative overflow-hidden">
        {/* Full-bleed hero behind the bottom-sheet */}
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          aria-hidden="true"
        >
          <img
            src={loginHeroUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/15" />
        </div>

        {/* MobileBottomSheet — always open on this route; no dismiss */}
        <MobileBottomSheet
          open={true}
          onOpenChange={() => {
            /* auth sheet stays open */
          }}
          forceMobile={true}
        >
          <MobileBottomSheet.Header>{authHeader}</MobileBottomSheet.Header>
          <MobileBottomSheet.Body>
            {step === "email" ? emailForm : otpForm}
          </MobileBottomSheet.Body>
        </MobileBottomSheet>
      </div>
    );
  }

  // ── Desktop shape (≥md): existing two-column glass-card layout ────────────
  const mobileGlassCard =
    "rounded-2xl bg-card/55 backdrop-blur-xl border border-white/30 dark:border-white/10 shadow-2xl p-6";

  return (
    <div className="min-h-screen flex items-stretch bg-bg relative overflow-hidden">
      {/* ── Left: form column ─────────────────────────────────────────── */}
      {/* Explicit `md:w-1/2` forces 50/50 split at md+ — `flex-1
       *  min-w-0` alone wasn't doing it (suspect a nested-flex
       *  intrinsic-min-width quirk in this build). The exact 50/50
       *  split is load-bearing: it makes the column boundary land at
       *  viewport-50 %, where `.login-seam-glow` is anchored, so the
       *  hero column actually overlaps the stripe instead of leaving
       *  a visible gap. Below `md` the form column reverts to
       *  `flex-1` and takes the full mobile bottom-sheet column. */}
      <div className="flex-1 min-w-0 md:w-1/2 md:flex-none flex items-center justify-center px-6 py-10 md:px-12 md:py-12 relative z-10">
        <div className={`w-full max-w-md mx-4 ${mobileGlassCard}`}>
          <div className="mb-6 md:mb-8">{authHeader}</div>
          {step === "email" ? emailForm : otpForm}
        </div>
      </div>

      {/* Animated seam glow — aurora ribbon along the cream/hero seam.
       * Lives in the OUTER wrapper at `left: 50%; z-index: 1` so it
       * sits BENEATH the hero image (which has z-20 below). Only the
       * left ~14 px peeks out into the cream side; the right half is
       * hidden under the photo, exactly per user direction. Desktop
       * only — mobile bottom-sheet has no seam to decorate.
       * CSS: app/index.css `.login-seam-glow`; honors
       * `prefers-reduced-motion`. Order matters: render BEFORE the
       * photo column so the photo paints on top in z-auto stacking
       * even before the explicit z-index fight. */}
      <div className="login-seam-glow hidden md:block" aria-hidden="true" />

      {/* ── Right: hero image ─────────────────────────────────────────── */}
      {/* Mirror of the form column's 50/50 sizing — explicit
       *  `md:w-1/2 md:flex-none` overrides the `flex-1` shrink-grow
       *  asymmetry that left a gap between the aurora stripe and the
       *  hero photo before. `min-w-0` for safety. */}
      <div
        className="hidden md:block flex-1 min-w-0 md:w-1/2 md:flex-none relative overflow-hidden z-20"
        aria-hidden="true"
      >
        <img
          src={loginHeroUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover login-hero-fade-left"
        />
      </div>
    </div>
  );
}
