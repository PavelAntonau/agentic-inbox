// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Loader } from "./loader";

describe("Loader", () => {
  it("renders with accessible role=status", () => {
    render(<Loader />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("has accessible aria-label", () => {
    render(<Loader />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("renders with size=sm (16px)", () => {
    render(<Loader size="sm" />);
    const svg = screen.getByRole("status");
    expect(svg).toHaveStyle("height: 16px; width: 16px");
  });

  it("renders with size=base (24px, default)", () => {
    render(<Loader />);
    const svg = screen.getByRole("status");
    expect(svg).toHaveStyle("height: 24px; width: 24px");
  });

  it("renders with size=lg (32px)", () => {
    render(<Loader size="lg" />);
    const svg = screen.getByRole("status");
    expect(svg).toHaveStyle("height: 32px; width: 32px");
  });

  it("accepts a numeric size", () => {
    render(<Loader size={20} />);
    const svg = screen.getByRole("status");
    expect(svg).toHaveStyle("height: 20px; width: 20px");
  });

  it("forwards className", () => {
    render(<Loader className="text-blue-500" />);
    expect(screen.getByRole("status").className).toContain("text-blue-500");
  });
});
