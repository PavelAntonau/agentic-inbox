// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Input } from "./input";

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
