// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResendCountdown } from "./ResendCountdown";

// ---------------------------------------------------------------------------
// Timer control helpers
// ---------------------------------------------------------------------------

// We use real fake timers via vitest so we can advance time deterministically.

describe("ResendCountdown — countdown ticks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("shows 'Resend in 0:30' on mount", () => {
    render(<ResendCountdown onResend={vi.fn()} />);
    expect(screen.getByTestId("resend-button")).toHaveTextContent(
      "Resend in 0:30",
    );
  });

  it("button is disabled while counting", () => {
    render(<ResendCountdown onResend={vi.fn()} />);
    expect(screen.getByTestId("resend-button")).toBeDisabled();
  });

  it("ticks down: shows 'Resend in 0:29' after 1 second", () => {
    render(<ResendCountdown onResend={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("resend-button")).toHaveTextContent(
      "Resend in 0:29",
    );
  });

  it("ticks down: shows 'Resend in 0:15' after 15 seconds", () => {
    render(<ResendCountdown onResend={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(screen.getByTestId("resend-button")).toHaveTextContent(
      "Resend in 0:15",
    );
  });

  it("enables after 30 seconds and shows 'Resend code'", () => {
    render(<ResendCountdown onResend={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    const btn = screen.getByTestId("resend-button");
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent("Resend code");
  });
});

// ---------------------------------------------------------------------------
// Click after enable fires onResend and resets
// ---------------------------------------------------------------------------

describe("ResendCountdown — click behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("clicking after countdown calls onResend", () => {
    const onResend = vi.fn();
    render(<ResendCountdown onResend={onResend} />);
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    fireEvent.click(screen.getByTestId("resend-button"));
    expect(onResend).toHaveBeenCalledOnce();
  });

  it("clicking after countdown resets the timer to 30s", () => {
    const onResend = vi.fn();
    render(<ResendCountdown onResend={onResend} />);
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    fireEvent.click(screen.getByTestId("resend-button"));
    // After click, countdown resets — button should be disabled again
    expect(screen.getByTestId("resend-button")).toBeDisabled();
    expect(screen.getByTestId("resend-button")).toHaveTextContent(
      "Resend in 0:30",
    );
  });

  it("clicking while counting does not call onResend", () => {
    const onResend = vi.fn();
    render(<ResendCountdown onResend={onResend} />);
    // Only 5 seconds elapsed — still counting
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    fireEvent.click(screen.getByTestId("resend-button"));
    expect(onResend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// disabled prop
// ---------------------------------------------------------------------------

describe("ResendCountdown — disabled prop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("stays disabled when disabled=true even after countdown completes", () => {
    render(<ResendCountdown onResend={vi.fn()} disabled={true} />);
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(screen.getByTestId("resend-button")).toBeDisabled();
  });
});
