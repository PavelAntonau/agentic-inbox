// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MobileBottomSheet } from "./MobileBottomSheet";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Sheet({
  open = true,
  onOpenChange = vi.fn(),
  forceMobile,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  forceMobile?: boolean;
}) {
  return (
    <MobileBottomSheet
      open={open}
      onOpenChange={onOpenChange}
      forceMobile={forceMobile}
    >
      <MobileBottomSheet.Header>
        <h2>Sheet Title</h2>
      </MobileBottomSheet.Header>
      <MobileBottomSheet.Body>
        <button data-testid="first-focusable">First</button>
        <button data-testid="second-focusable">Second</button>
      </MobileBottomSheet.Body>
    </MobileBottomSheet>
  );
}

// ---------------------------------------------------------------------------
// open / close
// ---------------------------------------------------------------------------

describe("MobileBottomSheet — open/close", () => {
  it("renders nothing when closed", () => {
    render(<Sheet open={false} />);
    expect(screen.queryByTestId("bottom-sheet-panel")).not.toBeInTheDocument();
  });

  it("renders panel when open", () => {
    render(<Sheet open={true} />);
    expect(screen.getByTestId("bottom-sheet-panel")).toBeInTheDocument();
    expect(screen.getByText("Sheet Title")).toBeInTheDocument();
  });

  it("calls onOpenChange(false) when backdrop is clicked", () => {
    const onOpenChange = vi.fn();
    render(<Sheet open={true} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("bottom-sheet-backdrop"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onOpenChange(false) on Escape key", () => {
    const onOpenChange = vi.fn();
    render(<Sheet open={true} onOpenChange={onOpenChange} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// snap height — mobile shape at 599px viewport
// ---------------------------------------------------------------------------

describe("MobileBottomSheet — mobile shape (forceMobile=true)", () => {
  it("applies h-[75vh] (snap to lower 75%) on mobile", () => {
    render(<Sheet open={true} forceMobile={true} />);
    const panel = screen.getByTestId("bottom-sheet-panel");
    expect(panel.className).toContain("h-[75vh]");
    expect(panel.className).toContain("bottom-0");
    expect(panel.className).toContain("rounded-t-2xl");
  });

  it("renders drag handle on mobile", () => {
    render(<Sheet open={true} forceMobile={true} />);
    expect(screen.getByTestId("drag-handle")).toBeInTheDocument();
  });

  it("renders header and body sub-components", () => {
    render(<Sheet open={true} forceMobile={true} />);
    expect(screen.getByTestId("bottom-sheet-header")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-sheet-body")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// desktop shape at ≥600px viewport
// ---------------------------------------------------------------------------

describe("MobileBottomSheet — desktop shape (forceMobile=false)", () => {
  it("does NOT apply h-[75vh] on desktop", () => {
    render(<Sheet open={true} forceMobile={false} />);
    const panel = screen.getByTestId("bottom-sheet-panel");
    expect(panel.className).not.toContain("h-[75vh]");
    expect(panel.className).not.toContain("bottom-0");
  });

  it("renders as centered card on desktop", () => {
    render(<Sheet open={true} forceMobile={false} />);
    const panel = screen.getByTestId("bottom-sheet-panel");
    expect(panel.className).toContain("-translate-x-1/2");
    expect(panel.className).toContain("-translate-y-1/2");
  });

  it("does NOT render drag handle on desktop", () => {
    render(<Sheet open={true} forceMobile={false} />);
    expect(screen.queryByTestId("drag-handle")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// viewport-based shape switch via window.innerWidth
// ---------------------------------------------------------------------------

describe("MobileBottomSheet — shape switch via window.innerWidth", () => {
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it("uses mobile shape when window.innerWidth = 599", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 599,
    });
    render(<Sheet open={true} />);
    const panel = screen.getByTestId("bottom-sheet-panel");
    expect(panel.className).toContain("h-[75vh]");
  });

  it("uses desktop shape when window.innerWidth = 768", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 768,
    });
    render(<Sheet open={true} />);
    const panel = screen.getByTestId("bottom-sheet-panel");
    expect(panel.className).not.toContain("h-[75vh]");
  });
});

// ---------------------------------------------------------------------------
// focus trap
// ---------------------------------------------------------------------------

describe("MobileBottomSheet — focus trap", () => {
  it("has dialog role and aria-modal", () => {
    render(<Sheet open={true} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("traps focus: Tab from last focusable wraps to first", () => {
    render(<Sheet open={true} forceMobile={true} />);
    const second = screen.getByTestId("second-focusable");
    second.focus();
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: false });
    // After trap fires, first element should have focus
    expect(document.activeElement).toBe(screen.getByTestId("first-focusable"));
  });

  it("traps focus: Shift+Tab from first focusable wraps to last", () => {
    render(<Sheet open={true} forceMobile={true} />);
    const first = screen.getByTestId("first-focusable");
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("second-focusable"));
  });
});

// ---------------------------------------------------------------------------
// prefers-reduced-motion
// ---------------------------------------------------------------------------

describe("MobileBottomSheet — prefers-reduced-motion", () => {
  let matchMediaSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    matchMediaSpy = vi.spyOn(window, "matchMedia");
  });

  afterEach(() => {
    matchMediaSpy.mockRestore();
  });

  it("omits transition class when prefers-reduced-motion is reduce", () => {
    matchMediaSpy.mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as MediaQueryList);

    render(<Sheet open={true} forceMobile={true} />);
    const panel = screen.getByTestId("bottom-sheet-panel");
    expect(panel.className).not.toContain("transition-transform");
  });

  it("includes transition class when no reduced-motion preference", () => {
    matchMediaSpy.mockReturnValue({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as MediaQueryList);

    render(<Sheet open={true} forceMobile={true} />);
    const panel = screen.getByTestId("bottom-sheet-panel");
    expect(panel.className).toContain("transition-transform");
  });
});

// ---------------------------------------------------------------------------
// Header and Body as named subcomponents
// ---------------------------------------------------------------------------

describe("MobileBottomSheet — named subcomponents", () => {
  it("Header renders children", () => {
    render(<Sheet open={true} />);
    expect(screen.getByText("Sheet Title")).toBeInTheDocument();
  });

  it("Body renders children", () => {
    render(<Sheet open={true} />);
    expect(screen.getByTestId("first-focusable")).toBeInTheDocument();
  });
});
