// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Promoted from app/ui/lib/link-provider.tsx (Phase 2).
// Full LinkProvider with context provider + useLinkComponent hook.
// Mirrors kumo's link-provider contract so consumers need only an import-path change.

import { createContext, forwardRef, useContext } from "react";
import type { AnchorHTMLAttributes, ForwardedRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  /** React Router / TanStack Router prop — treated as href when no href. */
  to?: string;
  ref?: ForwardedRef<HTMLAnchorElement>;
};

export type LinkComponentType = React.ForwardRefExoticComponent<
  LinkProps & React.RefAttributes<HTMLAnchorElement>
>;

// ---------------------------------------------------------------------------
// Default link component: plain <a> element
// ---------------------------------------------------------------------------

const DefaultLink = forwardRef<HTMLAnchorElement, LinkProps>(
  function DefaultLink({ to, href, ...props }, ref) {
    return <a ref={ref} href={href ?? to ?? undefined} {...props} />;
  },
);
DefaultLink.displayName = "DefaultLink";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const LinkContext = createContext<LinkComponentType>(DefaultLink);

// ---------------------------------------------------------------------------
// useLinkComponent — hook used by LinkButton and any consumer that needs
// the configured link component
// ---------------------------------------------------------------------------

export function useLinkComponent(): LinkComponentType {
  return useContext(LinkContext);
}

// ---------------------------------------------------------------------------
// LinkProvider — wrap the app once to configure the link component.
//
// @example
// ```tsx
// import { Link as RouterLink } from "react-router";
// <LinkProvider Component={RouterLink}>
//   <App />
// </LinkProvider>
// ```
// ---------------------------------------------------------------------------

export interface LinkProviderProps {
  /**
   * The link component to use for internal navigation.
   * Receives `href` and `to` props; must be a forwardRef component.
   * Defaults to a plain `<a>` element when not provided.
   *
   * Matches kumo's lowercase `component` prop for drop-in compatibility.
   */
  component?: LinkComponentType;
  /** App content. */
  children: React.ReactNode;
}

export function LinkProvider({
  component,
  children,
}: LinkProviderProps): React.ReactElement {
  return (
    <LinkContext.Provider value={component ?? DefaultLink}>
      {children}
    </LinkContext.Provider>
  );
}
