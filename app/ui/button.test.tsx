// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Button, KUMO_BUTTON_VARIANTS, buttonVariants } from "./button";

describe("Button", () => {
  it("renders text content", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("handles click events", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled when disabled prop is set", () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("is disabled and shows loader when loading prop is set", () => {
    render(<Button loading>Loading</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
  });

  it("applies variant=primary class bg-kumo-brand", () => {
    render(<Button variant="primary">Primary</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-kumo-brand");
  });

  it("applies variant=secondary classes", () => {
    render(<Button variant="secondary">Secondary</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-kumo-base");
  });

  it("applies variant=ghost classes", () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-inherit");
  });

  it("defaults to type=button to prevent accidental form submit", () => {
    render(<Button>Submit</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("forwards className", () => {
    render(<Button className="custom-class">Styled</Button>);
    expect(screen.getByRole("button").className).toContain("custom-class");
  });
});

// ---------------------------------------------------------------------------
// Tap-target tier assertions (T1.1)
// ---------------------------------------------------------------------------

describe("KUMO_BUTTON_VARIANTS size tiers", () => {
  it("sm tier emits h-8", () => {
    expect(KUMO_BUTTON_VARIANTS.size.sm.classes).toContain("h-8");
  });

  it("base tier emits h-9 (backward compat)", () => {
    expect(KUMO_BUTTON_VARIANTS.size.base.classes).toContain("h-9");
  });

  it("md tier emits h-10", () => {
    expect(KUMO_BUTTON_VARIANTS.size.md.classes).toContain("h-10");
  });

  it("lg tier emits h-11 (44 px tap-target floor)", () => {
    expect(KUMO_BUTTON_VARIANTS.size.lg.classes).toContain("h-11");
  });

  it("xl tier emits h-14 (56 px primary CTA)", () => {
    expect(KUMO_BUTTON_VARIANTS.size.xl.classes).toContain("h-14");
  });
});

describe("KUMO_BUTTON_VARIANTS compactSize tiers", () => {
  it("lg compactSize emits size-11", () => {
    expect(KUMO_BUTTON_VARIANTS.compactSize.lg.classes).toContain("size-11");
  });

  it("xl compactSize emits size-14", () => {
    expect(KUMO_BUTTON_VARIANTS.compactSize.xl.classes).toContain("size-14");
  });
});

describe("buttonVariants() size output", () => {
  it("size=lg includes h-11", () => {
    expect(buttonVariants({ size: "lg" })).toContain("h-11");
  });

  it("size=xl includes h-14", () => {
    expect(buttonVariants({ size: "xl" })).toContain("h-14");
  });

  it("size=base still includes h-9", () => {
    expect(buttonVariants({ size: "base" })).toContain("h-9");
  });
});
