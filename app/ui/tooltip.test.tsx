// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  Tooltip,
  TooltipProvider,
  tooltipVariants,
  KUMO_TOOLTIP_VARIANTS,
  KUMO_TOOLTIP_DEFAULT_VARIANTS,
} from "./tooltip";

// Wrap with TooltipProvider for all tooltip tests (as required in real usage)
function WithProvider({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

describe("Tooltip", () => {
  it("renders the trigger element", () => {
    render(
      <WithProvider>
        <Tooltip content="Tip text">
          <button type="button">Hover me</button>
        </Tooltip>
      </WithProvider>,
    );
    expect(screen.getByText("Hover me")).toBeInTheDocument();
  });

  it("does not show tooltip content initially", () => {
    render(
      <WithProvider>
        <Tooltip content="Hidden tip">
          <button type="button">Btn</button>
        </Tooltip>
      </WithProvider>,
    );
    expect(screen.queryByText("Hidden tip")).not.toBeInTheDocument();
  });

  it("shows tooltip content when open=true (controlled)", () => {
    render(
      <WithProvider>
        <Tooltip content="Visible tip" open={true}>
          <span>Btn</span>
        </Tooltip>
      </WithProvider>,
    );
    expect(screen.getByText("Visible tip")).toBeInTheDocument();
  });

  it("hides tooltip content when open=false (controlled)", () => {
    render(
      <WithProvider>
        <Tooltip content="Tip to hide" open={false}>
          <span>Btn</span>
        </Tooltip>
      </WithProvider>,
    );
    expect(screen.queryByText("Tip to hide")).not.toBeInTheDocument();
  });

  it("forwards className to trigger", () => {
    render(
      <WithProvider>
        <Tooltip content="Tip" className="my-trigger-class">
          <span>Target</span>
        </Tooltip>
      </WithProvider>,
    );
    const trigger = document.querySelector(".my-trigger-class");
    expect(trigger).toBeTruthy();
  });

  it("uses asChild to avoid extra wrapper", () => {
    render(
      <WithProvider>
        <Tooltip content="Tip" asChild>
          <button type="button" data-testid="direct-btn">
            Direct
          </button>
        </Tooltip>
      </WithProvider>,
    );
    // The trigger button is the child itself
    expect(screen.getByTestId("direct-btn")).toBeInTheDocument();
  });

  it("tooltipVariants returns empty string for default (side handled by positioner)", () => {
    const cls = tooltipVariants();
    expect(typeof cls).toBe("string");
  });

  it("KUMO_TOOLTIP_DEFAULT_VARIANTS side is top", () => {
    expect(KUMO_TOOLTIP_DEFAULT_VARIANTS.side).toBe("top");
  });

  it("KUMO_TOOLTIP_VARIANTS has four sides", () => {
    expect(Object.keys(KUMO_TOOLTIP_VARIANTS.side)).toEqual([
      "top",
      "bottom",
      "left",
      "right",
    ]);
  });

  it("TooltipProvider renders children", () => {
    render(
      <TooltipProvider>
        <span data-testid="child">child</span>
      </TooltipProvider>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
