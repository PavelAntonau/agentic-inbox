// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  Empty,
  emptyVariants,
  KUMO_EMPTY_VARIANTS,
  KUMO_EMPTY_DEFAULT_VARIANTS,
} from "./empty";

describe("Empty", () => {
  it("renders the title", () => {
    render(<Empty title="No results found" />);
    expect(
      screen.getByRole("heading", { name: "No results found" }),
    ).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(<Empty title="Empty" description="Try a different search." />);
    expect(screen.getByText("Try a different search.")).toBeInTheDocument();
  });

  it("does not render description element when omitted", () => {
    render(<Empty title="Empty" />);
    expect(
      screen.queryByText("Try a different search."),
    ).not.toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(<Empty title="Empty" icon={<span data-testid="icon">icon</span>} />);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("renders contents when provided", () => {
    render(
      <Empty title="Empty" contents={<button type="button">Go back</button>} />,
    );
    expect(screen.getByRole("button", { name: "Go back" })).toBeInTheDocument();
  });

  it("renders commandLine with copy button", () => {
    render(<Empty title="Empty" commandLine="npm install kumo" />);
    expect(screen.getByText("npm install kumo")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy command" }),
    ).toBeInTheDocument();
  });

  it("forwards className to container", () => {
    const { container } = render(
      <Empty title="Empty" className="custom-empty" />,
    );
    expect(container.firstChild).toHaveClass("custom-empty");
  });

  it("applies size=sm variant classes", () => {
    const { container } = render(<Empty title="Empty" size="sm" />);
    expect(container.firstChild).toHaveClass("px-6", "py-8");
  });

  it("applies size=lg variant classes", () => {
    const { container } = render(<Empty title="Empty" size="lg" />);
    expect(container.firstChild).toHaveClass("px-12", "py-20");
  });

  it("defaults to size=base", () => {
    const { container } = render(<Empty title="Empty" />);
    expect(container.firstChild).toHaveClass("px-10", "py-16");
  });
});

describe("emptyVariants", () => {
  it("returns base styles for default size", () => {
    const cls = emptyVariants();
    expect(cls).toContain("flex");
    expect(cls).toContain("flex-col");
    expect(cls).toContain("items-center");
    expect(cls).toContain("rounded-xl");
  });

  it("includes size=sm padding for sm", () => {
    const cls = emptyVariants({ size: "sm" });
    expect(cls).toContain("px-6");
  });

  it("KUMO_EMPTY_DEFAULT_VARIANTS.size is base", () => {
    expect(KUMO_EMPTY_DEFAULT_VARIANTS.size).toBe("base");
  });

  it("KUMO_EMPTY_VARIANTS.size has sm, base, lg keys", () => {
    expect(Object.keys(KUMO_EMPTY_VARIANTS.size)).toEqual(["sm", "base", "lg"]);
  });
});

describe("Empty commandLine copy", () => {
  it("shows copy button that triggers clipboard write", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });
    render(<Empty title="Empty" commandLine="npm test" />);
    const copyBtn = screen.getByRole("button", { name: "Copy command" });
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("npm test");
  });
});
