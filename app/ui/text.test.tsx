// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Text } from "./text";

describe("Text", () => {
  it("renders text content", () => {
    render(<Text>Hello world</Text>);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders as <p> by default (body variant)", () => {
    render(<Text>Body text</Text>);
    expect(screen.getByText("Body text").tagName).toBe("P");
  });

  it("renders as <h1> for heading1 variant", () => {
    render(<Text variant="heading1">Page Title</Text>);
    expect(screen.getByText("Page Title").tagName).toBe("H1");
  });

  it("renders as <h2> for heading2 variant", () => {
    render(<Text variant="heading2">Section</Text>);
    expect(screen.getByText("Section").tagName).toBe("H2");
  });

  it("renders as <h3> for heading3 variant", () => {
    render(<Text variant="heading3">Sub</Text>);
    expect(screen.getByText("Sub").tagName).toBe("H3");
  });

  it("renders as <span> for mono variant", () => {
    render(<Text variant="mono">code()</Text>);
    expect(screen.getByText("code()").tagName).toBe("SPAN");
  });

  it("applies the as prop to override the element type", () => {
    render(<Text as="div">Div text</Text>);
    expect(screen.getByText("Div text").tagName).toBe("DIV");
  });

  it("applies heading1 size class (text-3xl)", () => {
    render(<Text variant="heading1">Big</Text>);
    expect(screen.getByText("Big").className).toContain("text-3xl");
  });

  it("applies secondary variant muted color class", () => {
    render(<Text variant="secondary">Muted</Text>);
    expect(screen.getByText("Muted").className).toContain("text-kumo-subtle");
  });

  it("applies error variant color class", () => {
    render(<Text variant="error">Broken</Text>);
    expect(screen.getByText("Broken").className).toContain("text-kumo-danger");
  });

  it("applies bold=true as font-medium for copy variants", () => {
    render(
      <Text variant="body" bold>
        Bold body
      </Text>,
    );
    expect(screen.getByText("Bold body").className).toContain("font-medium");
  });

  it("applies size=sm class for body variant", () => {
    render(
      <Text variant="body" size="sm">
        Small
      </Text>,
    );
    expect(screen.getByText("Small").className).toContain("text-sm");
  });
});
