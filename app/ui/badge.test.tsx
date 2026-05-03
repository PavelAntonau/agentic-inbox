// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
  it("renders text content", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders as a span element", () => {
    render(<Badge>Label</Badge>);
    expect(screen.getByText("Label").tagName).toBe("SPAN");
  });

  it("applies variant=primary classes (default)", () => {
    render(<Badge variant="primary">Primary</Badge>);
    expect(screen.getByText("Primary").className).toContain("bg-kumo-contrast");
  });

  it("applies variant=secondary classes", () => {
    render(<Badge variant="secondary">Secondary</Badge>);
    expect(screen.getByText("Secondary").className).toContain("bg-kumo-fill");
  });

  it("applies variant=destructive classes", () => {
    render(<Badge variant="destructive">Error</Badge>);
    expect(screen.getByText("Error").className).toContain("bg-kumo-danger");
  });

  it("applies variant=success classes", () => {
    render(<Badge variant="success">OK</Badge>);
    expect(screen.getByText("OK").className).toContain("bg-kumo-success");
  });

  it("applies variant=beta dashed border classes", () => {
    render(<Badge variant="beta">Beta</Badge>);
    const el = screen.getByText("Beta");
    expect(el.className).toContain("border-dashed");
    expect(el.className).toContain("border-kumo-brand");
  });

  it("forwards className", () => {
    render(<Badge className="custom-badge">Tag</Badge>);
    expect(screen.getByText("Tag").className).toContain("custom-badge");
  });
});
