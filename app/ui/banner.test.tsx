// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  Banner,
  bannerVariants,
  BannerVariant,
  KUMO_BANNER_BASE_STYLES,
  KUMO_BANNER_VARIANTS,
  KUMO_BANNER_DEFAULT_VARIANTS,
} from "./banner";

describe("Banner", () => {
  it("renders text-only form via `text` prop", () => {
    render(<Banner text="Something happened." />);
    expect(screen.getByText("Something happened.")).toBeInTheDocument();
  });

  it("renders text-only form via children", () => {
    render(<Banner>Body via children</Banner>);
    expect(screen.getByText("Body via children")).toBeInTheDocument();
  });

  it("renders title + description form", () => {
    render(<Banner title="Heads up" description="Read the fine print." />);
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    expect(screen.getByText("Read the fine print.")).toBeInTheDocument();
  });

  it("renders ReactNode description without wrapping in <p>", () => {
    render(
      <Banner
        title="Heads up"
        description={<span data-testid="custom">Custom node</span>}
      />,
    );
    expect(screen.getByTestId("custom")).toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(<Banner text="msg" icon={<span data-testid="icon">i</span>} />);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("applies default variant classes", () => {
    const { container } = render(<Banner text="msg" />);
    expect(container.firstChild).toHaveClass("text-kumo-info");
  });

  it("applies alert variant classes", () => {
    const { container } = render(<Banner text="msg" variant="alert" />);
    expect(container.firstChild).toHaveClass("text-kumo-warning");
  });

  it("applies error variant classes", () => {
    const { container } = render(<Banner text="msg" variant="error" />);
    expect(container.firstChild).toHaveClass("text-kumo-danger");
  });

  it("forwards className to container", () => {
    const { container } = render(<Banner text="msg" className="custom-bn" />);
    expect(container.firstChild).toHaveClass("custom-bn");
  });

  it("forwards ref to container div", () => {
    let captured: HTMLDivElement | null = null;
    render(
      <Banner
        text="msg"
        ref={(el) => {
          captured = el;
        }}
      />,
    );
    expect(captured).not.toBeNull();
    expect(captured!.tagName).toBe("DIV");
  });
});

describe("bannerVariants", () => {
  it("returns base styles for default variant", () => {
    const cls = bannerVariants();
    expect(cls).toContain("flex");
    expect(cls).toContain("rounded-lg");
    expect(cls).toContain("text-kumo-info");
  });

  it("includes warning classes for alert variant", () => {
    const cls = bannerVariants({ variant: "alert" });
    expect(cls).toContain("text-kumo-warning");
  });

  it("KUMO_BANNER_DEFAULT_VARIANTS.variant is default", () => {
    expect(KUMO_BANNER_DEFAULT_VARIANTS.variant).toBe("default");
  });

  it("KUMO_BANNER_VARIANTS.variant has default, alert, error keys", () => {
    expect(Object.keys(KUMO_BANNER_VARIANTS.variant)).toEqual([
      "default",
      "alert",
      "error",
    ]);
  });

  it("KUMO_BANNER_BASE_STYLES exposes the base layout class string", () => {
    expect(KUMO_BANNER_BASE_STYLES).toContain("flex");
    expect(KUMO_BANNER_BASE_STYLES).toContain("rounded-lg");
  });
});

describe("BannerVariant enum", () => {
  it("encodes the kumo numeric variants", () => {
    expect(BannerVariant.DEFAULT).toBe(0);
    expect(BannerVariant.ALERT).toBe(1);
    expect(BannerVariant.ERROR).toBe(2);
  });
});
