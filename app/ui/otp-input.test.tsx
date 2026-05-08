// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { OTPInput } from "./otp-input";

// ---------------------------------------------------------------------------
// Controlled wrapper
// ---------------------------------------------------------------------------

function ControlledOTPInput({
  onComplete = vi.fn(),
  initialValue = "",
}: {
  onComplete?: (v: string) => void;
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <OTPInput
      value={value}
      onChange={setValue}
      onComplete={onComplete}
      aria-label="Enter OTP"
    />
  );
}

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

describe("OTPInput — rendering", () => {
  it("renders 6 visible input boxes", () => {
    render(<ControlledOTPInput />);
    for (let i = 0; i < 6; i++) {
      expect(screen.getByTestId(`otp-box-${i}`)).toBeInTheDocument();
    }
  });

  it("renders a hidden master input with autoComplete=one-time-code", () => {
    render(<ControlledOTPInput />);
    const hidden = screen.getByTestId("otp-hidden-input");
    expect(hidden).toBeInTheDocument();
    expect(hidden).toHaveAttribute("autocomplete", "one-time-code");
  });

  it("visible boxes use inputMode=numeric", () => {
    render(<ControlledOTPInput />);
    const box = screen.getByTestId("otp-box-0");
    expect(box).toHaveAttribute("inputmode", "numeric");
  });

  it("visible boxes use pattern=[0-9]*", () => {
    render(<ControlledOTPInput />);
    const box = screen.getByTestId("otp-box-0");
    expect(box).toHaveAttribute("pattern", "[0-9]*");
  });

  it("visible boxes have maxLength=1", () => {
    render(<ControlledOTPInput />);
    expect(screen.getByTestId("otp-box-0")).toHaveAttribute("maxlength", "1");
  });

  it("applies lg size tier class (h-11) to visible boxes", () => {
    render(<ControlledOTPInput />);
    const box = screen.getByTestId("otp-box-0");
    expect(box.className).toContain("h-11");
  });
});

// ---------------------------------------------------------------------------
// Type and auto-advance
// ---------------------------------------------------------------------------

describe("OTPInput — type and auto-advance", () => {
  it("typing a digit in box 0 populates it", () => {
    render(<ControlledOTPInput />);
    const box0 = screen.getByTestId("otp-box-0") as HTMLInputElement;
    fireEvent.change(box0, { target: { value: "3" } });
    // value should now contain '3' at position 0
    expect(box0.value).toBe("3");
  });

  it("typing digits advances focus through all boxes", () => {
    render(<ControlledOTPInput />);
    for (let i = 0; i < 5; i++) {
      const box = screen.getByTestId(`otp-box-${i}`) as HTMLInputElement;
      fireEvent.change(box, { target: { value: `${i + 1}` } });
    }
    // After typing in boxes 0-4, box 5 should be present and filled via state
    expect(screen.getByTestId("otp-box-4")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Backspace on empty box jumps left
// ---------------------------------------------------------------------------

describe("OTPInput — backspace navigation", () => {
  it("Backspace on an empty box focuses the previous box", () => {
    render(<ControlledOTPInput initialValue="12" />);
    // box 2 is empty (only 2 digits were provided)
    const box2 = screen.getByTestId("otp-box-2") as HTMLInputElement;
    box2.focus();
    fireEvent.keyDown(box2, { key: "Backspace" });
    // focus should move to box 1
    expect(document.activeElement).toBe(screen.getByTestId("otp-box-1"));
  });

  it("Backspace on a filled box clears it without moving focus", () => {
    render(<ControlledOTPInput initialValue="1" />);
    const box0 = screen.getByTestId("otp-box-0") as HTMLInputElement;
    box0.focus();
    expect(box0.value).toBe("1");
    fireEvent.keyDown(box0, { key: "Backspace" });
    // Box 0 should be cleared
    expect(box0.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Paste — spread across all boxes
// ---------------------------------------------------------------------------

describe("OTPInput — paste", () => {
  it("paste 6 digits fills all boxes", () => {
    render(<ControlledOTPInput />);
    const box0 = screen.getByTestId("otp-box-0");
    fireEvent.paste(box0, {
      clipboardData: { getData: () => "123456" },
    });
    // All 6 boxes should be filled
    for (let i = 0; i < 6; i++) {
      const box = screen.getByTestId(`otp-box-${i}`) as HTMLInputElement;
      expect(box.value).toBe(String(i + 1));
    }
  });

  it("paste strips non-digit chars", () => {
    render(<ControlledOTPInput />);
    const box3 = screen.getByTestId("otp-box-3");
    fireEvent.paste(box3, {
      clipboardData: { getData: () => "1-2-3-4-5-6" },
    });
    for (let i = 0; i < 6; i++) {
      const box = screen.getByTestId(`otp-box-${i}`) as HTMLInputElement;
      expect(box.value).toBe(String(i + 1));
    }
  });

  it("paste fewer than 6 digits fills only those boxes", () => {
    render(<ControlledOTPInput />);
    const box0 = screen.getByTestId("otp-box-0");
    fireEvent.paste(box0, {
      clipboardData: { getData: () => "123" },
    });
    expect((screen.getByTestId("otp-box-0") as HTMLInputElement).value).toBe(
      "1",
    );
    expect((screen.getByTestId("otp-box-1") as HTMLInputElement).value).toBe(
      "2",
    );
    expect((screen.getByTestId("otp-box-2") as HTMLInputElement).value).toBe(
      "3",
    );
  });
});

// ---------------------------------------------------------------------------
// onComplete fires once on 6th digit
// ---------------------------------------------------------------------------

describe("OTPInput — onComplete", () => {
  it("onComplete fires when all 6 digits are filled", () => {
    const onComplete = vi.fn();
    const { rerender } = render(
      <OTPInput
        value="12345"
        onChange={vi.fn()}
        onComplete={onComplete}
        aria-label="OTP"
      />,
    );
    expect(onComplete).not.toHaveBeenCalled();
    rerender(
      <OTPInput
        value="123456"
        onChange={vi.fn()}
        onComplete={onComplete}
        aria-label="OTP"
      />,
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("123456");
  });

  it("onComplete does NOT fire again if value stays complete without changing", () => {
    const onComplete = vi.fn();
    const { rerender } = render(
      <OTPInput
        value="123456"
        onChange={vi.fn()}
        onComplete={onComplete}
        aria-label="OTP"
      />,
    );
    // Re-render with same value — should not fire again
    rerender(
      <OTPInput
        value="123456"
        onChange={vi.fn()}
        onComplete={onComplete}
        aria-label="OTP"
      />,
    );
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("onComplete fires again after value is cleared and re-filled", () => {
    const onComplete = vi.fn();
    const { rerender } = render(
      <OTPInput
        value="123456"
        onChange={vi.fn()}
        onComplete={onComplete}
        aria-label="OTP"
      />,
    );
    expect(onComplete).toHaveBeenCalledOnce();
    rerender(
      <OTPInput
        value=""
        onChange={vi.fn()}
        onComplete={onComplete}
        aria-label="OTP"
      />,
    );
    rerender(
      <OTPInput
        value="654321"
        onChange={vi.fn()}
        onComplete={onComplete}
        aria-label="OTP"
      />,
    );
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith("654321");
  });
});
