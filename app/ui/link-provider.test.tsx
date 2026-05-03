// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { forwardRef } from "react";
import {
  LinkProvider,
  useLinkComponent,
  type LinkComponentType,
  type LinkProviderProps,
} from "./link-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Renders a link using useLinkComponent and exposes it via data-testid. */
function LinkConsumer({ href }: { href: string }) {
  const Link = useLinkComponent();
  return (
    <Link href={href} data-testid="link">
      click me
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinkProvider", () => {
  it("renders children without a Component prop", () => {
    render(
      <LinkProvider>
        <span data-testid="child">child</span>
      </LinkProvider>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("useLinkComponent defaults to a plain <a> element", () => {
    render(
      <LinkProvider>
        <LinkConsumer href="/home" />
      </LinkProvider>,
    );
    const link = screen.getByTestId("link");
    expect(link.tagName.toLowerCase()).toBe("a");
    expect(link).toHaveAttribute("href", "/home");
  });

  it("useLinkComponent uses the configured Component", () => {
    const CustomLink = forwardRef<
      HTMLAnchorElement,
      { href?: string; children?: React.ReactNode }
    >(function CustomLink({ href, children, ...props }, ref) {
      return (
        <a ref={ref} href={href} data-custom="true" {...props}>
          {children}
        </a>
      );
    }) as LinkComponentType;

    render(
      <LinkProvider component={CustomLink}>
        <LinkConsumer href="/custom" />
      </LinkProvider>,
    );
    const link = screen.getByTestId("link");
    expect(link).toHaveAttribute("data-custom", "true");
    expect(link).toHaveAttribute("href", "/custom");
  });

  it("useLinkComponent falls back to <a> when Component=undefined", () => {
    render(
      <LinkProvider component={undefined}>
        <LinkConsumer href="/fallback" />
      </LinkProvider>,
    );
    const link = screen.getByTestId("link");
    expect(link.tagName.toLowerCase()).toBe("a");
    expect(link).toHaveAttribute("href", "/fallback");
  });

  it("useLinkComponent uses `to` prop as href fallback", () => {
    function ToConsumer() {
      const Link = useLinkComponent();
      return (
        <Link to="/route" data-testid="to-link">
          nav
        </Link>
      );
    }
    render(
      <LinkProvider>
        <ToConsumer />
      </LinkProvider>,
    );
    const link = screen.getByTestId("to-link");
    expect(link).toHaveAttribute("href", "/route");
  });

  it("nested providers: inner provider wins", () => {
    const InnerLink = forwardRef<
      HTMLAnchorElement,
      { href?: string; children?: React.ReactNode }
    >(function InnerLink({ href, children, ...props }, ref) {
      return (
        <a ref={ref} href={href} data-inner="true" {...props}>
          {children}
        </a>
      );
    }) as LinkComponentType;

    render(
      <LinkProvider>
        <LinkProvider component={InnerLink}>
          <LinkConsumer href="/nested" />
        </LinkProvider>
      </LinkProvider>,
    );
    expect(screen.getByTestId("link")).toHaveAttribute("data-inner", "true");
  });

  it("accepts LinkProviderProps type (compile-time check via usage)", () => {
    const props: LinkProviderProps = { children: <span /> };
    expect(props.children).toBeTruthy();
  });

  it("useLinkComponent outside provider returns default <a>", () => {
    // No LinkProvider — context default kicks in
    render(<LinkConsumer href="/bare" />);
    const link = screen.getByTestId("link");
    expect(link.tagName.toLowerCase()).toBe("a");
  });

  it("LinkProvider renders with Component forwarding ref correctly", () => {
    const RefLink = forwardRef<
      HTMLAnchorElement,
      { href?: string; children?: React.ReactNode }
    >(function RefLink({ href, children, ...rest }, ref) {
      return (
        <a ref={ref} href={href} data-ref="forwarded" {...rest}>
          {children}
        </a>
      );
    }) as LinkComponentType;

    render(
      <LinkProvider component={RefLink}>
        <LinkConsumer href="/ref" />
      </LinkProvider>,
    );
    expect(screen.getByTestId("link")).toHaveAttribute("data-ref", "forwarded");
  });

  it("link text content is rendered", () => {
    render(
      <LinkProvider>
        <LinkConsumer href="/" />
      </LinkProvider>,
    );
    expect(screen.getByText("click me")).toBeInTheDocument();
  });
});
