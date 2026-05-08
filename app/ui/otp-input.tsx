// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// OTPInput — 6-box one-time-password input.
//
// Features:
//   - 6 individual <input maxLength=1 inputMode=numeric pattern=[0-9]> boxes.
//   - Paste 6 digits anywhere → fills all 6 boxes, autofocuses last.
//   - Auto-advance on digit keystroke; Backspace on empty box jumps left.
//   - Hidden master <input autoComplete='one-time-code'> mirrors the joined
//     value for iOS autofill.
//   - autoFocus first box on mount.
//   - API: <OTPInput value onChange onComplete>
//     onComplete(value) fires when all 6 digits are filled.
//   - Uses lg size tier (text-[16px]) to prevent iOS Safari zoom-on-focus.

import {
  useRef,
  useEffect,
  useCallback,
  type ClipboardEvent,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import { cn } from "~/ui/lib/cn";
import { inputVariants } from "~/ui/input";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LENGTH = 6;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OTPInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OTPInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  className,
  "aria-label": ariaLabel = "One-time password",
}: OTPInputProps) {
  // Build a fixed-length array of individual digit chars.
  // Array.from ensures exactly LENGTH slots regardless of value length.
  const digits = Array.from({ length: LENGTH }, (_, i) => value[i] ?? "");
  const inputRefs = useRef<Array<HTMLInputElement | null>>(
    Array(LENGTH).fill(null),
  );
  // Track whether onComplete has been fired for the current full value so we
  // don't fire it on every re-render when value is already complete.
  const completedRef = useRef<string>("");

  // Focus first box on mount.
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  // Fire onComplete exactly once per unique complete value.
  useEffect(() => {
    const joined = value.slice(0, LENGTH);
    if (
      joined.length === LENGTH &&
      /^\d{6}$/.test(joined) &&
      joined !== completedRef.current
    ) {
      completedRef.current = joined;
      onComplete?.(joined);
    }
    if (joined.length < LENGTH) {
      completedRef.current = "";
    }
  }, [value, onComplete]);

  // Build the updated full string from a per-box change.
  const spliceDigit = useCallback(
    (index: number, digit: string): string => {
      const chars = Array.from({ length: LENGTH }, (_, i) => value[i] ?? "");
      chars[index] = digit;
      return chars.join("");
    },
    [value],
  );

  const handleChange = useCallback(
    (index: number, e: ChangeEvent<HTMLInputElement>) => {
      // Filter to digits only.
      const raw = e.target.value.replace(/\D/g, "");
      const digit = raw.slice(-1); // take last char if browser typed more
      const next = spliceDigit(index, digit);
      onChange(next);
      // Advance focus on digit entry.
      if (digit && index < LENGTH - 1) {
        inputRefs.current[index + 1]?.focus();
      }
    },
    [onChange, spliceDigit],
  );

  const handleKeyDown = useCallback(
    (index: number, e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Backspace") {
        e.preventDefault();
        if (digits[index]) {
          // Clear current box.
          onChange(spliceDigit(index, ""));
        } else if (index > 0) {
          // Jump left and clear.
          const newValue = spliceDigit(index - 1, "");
          onChange(newValue);
          inputRefs.current[index - 1]?.focus();
        }
      } else if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        inputRefs.current[index - 1]?.focus();
      } else if (e.key === "ArrowRight" && index < LENGTH - 1) {
        e.preventDefault();
        inputRefs.current[index + 1]?.focus();
      }
    },
    [digits, onChange, spliceDigit],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const pasted = e.clipboardData
        .getData("text")
        .replace(/\D/g, "")
        .slice(0, LENGTH);
      if (!pasted) return;
      onChange(pasted);
      // Focus the last filled box (or the last box overall).
      const focusIndex = Math.min(pasted.length, LENGTH) - 1;
      inputRefs.current[Math.max(0, focusIndex)]?.focus();
    },
    [onChange],
  );

  // When the hidden autofill input receives a value from iOS autofill,
  // spread it across the boxes.
  const handleAutofill = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const filled = e.target.value.replace(/\D/g, "").slice(0, LENGTH);
      if (filled) {
        onChange(filled.slice(0, LENGTH));
        const focusIndex = Math.min(filled.length, LENGTH) - 1;
        inputRefs.current[Math.max(0, focusIndex)]?.focus();
      }
    },
    [onChange],
  );

  return (
    <div
      className={cn("relative flex flex-col gap-2", className)}
      aria-label={ariaLabel}
      data-testid="otp-input-root"
    >
      {/* Hidden master input for iOS one-time-code autofill */}
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        onChange={handleAutofill}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only absolute inset-0 opacity-0 pointer-events-none"
        data-testid="otp-hidden-input"
        readOnly={false}
      />
      {/* Visible 6-box row */}
      <div
        className="flex gap-2 justify-center"
        role="group"
        aria-label={ariaLabel}
        data-testid="otp-boxes"
      >
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(el) => {
              inputRefs.current[index] = el;
            }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            value={digit}
            autoFocus={index === 0}
            disabled={disabled}
            autoComplete="off"
            aria-label={`Digit ${index + 1} of ${LENGTH}`}
            className={cn(
              inputVariants({ size: "lg" }),
              "w-11 text-center font-mono tracking-normal",
            )}
            onChange={(e) => handleChange(index, e)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onPaste={handlePaste}
            data-testid={`otp-box-${index}`}
          />
        ))}
      </div>
    </div>
  );
}
