// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// ResendCountdown — 30-second countdown for OTP resend flow.
//
// API:  <ResendCountdown onResend disabled?>
//
// Behaviour:
//   - Mounts with a 30s countdown; the Resend button is disabled while
//     the timer is running.
//   - Label: "Resend in 0:XX" while counting; "Resend code" once enabled.
//   - On click, calls onResend() and resets the countdown to 30s.
//   - `disabled` prop allows the parent to keep the button disabled even
//     after the countdown completes (e.g. during a network request).

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "~/ui/button";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COUNTDOWN_SECONDS = 30;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ResendCountdownProps {
  onResend: () => void;
  disabled?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ResendCountdown({
  onResend,
  disabled = false,
  className,
}: ResendCountdownProps) {
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCountdown = useCallback(() => {
    setRemaining(COUNTDOWN_SECONDS);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Start countdown on mount.
  useEffect(() => {
    startCountdown();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — run once on mount

  const isCounting = remaining > 0;
  const isButtonDisabled = disabled || isCounting;

  const handleClick = useCallback(() => {
    if (isButtonDisabled) return;
    onResend();
    startCountdown();
  }, [isButtonDisabled, onResend, startCountdown]);

  // Format "0:SS" label.
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const label = isCounting
    ? `Resend in ${minutes}:${String(seconds).padStart(2, "0")}`
    : "Resend code";

  return (
    <div className={className} data-testid="resend-countdown">
      <Button
        variant="ghost"
        size="sm"
        disabled={isButtonDisabled}
        onClick={handleClick}
        data-testid="resend-button"
        aria-live="polite"
        aria-label={label}
      >
        {label}
      </Button>
    </div>
  );
}
