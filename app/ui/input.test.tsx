// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Input, KUMO_INPUT_VARIANTS, inputVariants } from "./input";

describe("Input", () => {
  it("renders an input element", () => {
    render(<Input aria-label="Email" />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("applies placeholder", () => {
    render(<Input placeholder="Search..." aria-label="Search" />);
    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
  });

  it("is disabled when disabled prop is set", () => {
    render(<Input aria-label="Disabled" disabled />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("works as a controlled input — value + onChange", () => {
    const onChange = vi.fn();
    render(
      <Input aria-label="Name" value="hello" onChange={onChange} readOnly />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("hello");
  });

  it("fires onChange on user input (uncontrolled)", () => {
    const onChange = vi.fn();
    render(<Input aria-label="Field" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("renders label when label prop is provided", () => {
    render(<Input label="Email address" placeholder="you@example.com" />);
    expect(screen.getByText("Email address")).toBeInTheDocument();
  });

  it("renders error message when error string is provided", () => {
    render(
      <Input
        label="Email"
        placeholder="you@example.com"
        error="Invalid email"
      />,
    );
    expect(screen.getByText("Invalid email")).toBeInTheDocument();
  });

  it("applies error variant ring classes", () => {
    render(<Input aria-label="Error field" variant="error" />);
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("ring-kumo-danger");
  });
});

// ---------------------------------------------------------------------------
// Tap-target tier assertions (T1.1)
// ---------------------------------------------------------------------------

describe("KUMO_INPUT_VARIANTS size tiers", () => {
  it("sm tier emits h-8", () => {
    expect(KUMO_INPUT_VARIANTS.size.sm.classes).toContain("h-8");
  });

  it("base tier emits h-9 (backward compat)", () => {
    expect(KUMO_INPUT_VARIANTS.size.base.classes).toContain("h-9");
  });

  it("md tier emits h-10", () => {
    expect(KUMO_INPUT_VARIANTS.size.md.classes).toContain("h-10");
  });

  it("lg tier emits h-11 (44 px tap-target floor)", () => {
    expect(KUMO_INPUT_VARIANTS.size.lg.classes).toContain("h-11");
  });

  it("lg tier emits text-[16px] to prevent iOS Safari zoom-on-focus", () => {
    expect(KUMO_INPUT_VARIANTS.size.lg.classes).toContain("text-[16px]");
  });

  it("xl tier emits h-14 (56 px primary CTA)", () => {
    expect(KUMO_INPUT_VARIANTS.size.xl.classes).toContain("h-14");
  });

  it("xl tier emits text-[16px] to prevent iOS Safari zoom-on-focus", () => {
    expect(KUMO_INPUT_VARIANTS.size.xl.classes).toContain("text-[16px]");
  });
});

describe("inputVariants() size output", () => {
  it("size=lg includes h-11", () => {
    expect(inputVariants({ size: "lg" })).toContain("h-11");
  });

  it("size=xl includes h-14", () => {
    expect(inputVariants({ size: "xl" })).toContain("h-14");
  });

  it("size=base still includes h-9", () => {
    expect(inputVariants({ size: "base" })).toContain("h-9");
  });
});
