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

import { Button, Input, Loader, useToastManager } from "~/ui";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { authClient } from "~/lib/auth-client";

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
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      toast.add({ title: "Enter a valid email address", variant: "error" });
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: trimmed,
        type: "sign-in",
      });
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-text-bright">
            ActionNowAI Mail
          </h1>
          <p className="text-sm text-text-muted mt-1">
            {step === "email"
              ? "Sign in with your email."
              : "Check your inbox for a 6-digit code."}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-lg">
          {step === "email" ? (
            <form onSubmit={handleSendOtp} className="flex flex-col gap-4">
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
              <Button
                type="submit"
                variant="primary"
                size="base"
                loading={submitting}
                disabled={!email.trim()}
              >
                {submitting ? <Loader size="sm" /> : "Send code"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
              <p className="text-xs text-text-muted">
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
                disabled={otp.length < 6}
              >
                {submitting ? <Loader size="sm" /> : "Verify"}
              </Button>
              <button
                type="button"
                className="text-xs text-text-muted hover:text-text transition-colors"
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

        <p className="text-xs text-text-muted text-center mt-6">
          We'll email you a 6-digit code that expires in 10 minutes.
        </p>
      </div>
    </div>
  );
}
