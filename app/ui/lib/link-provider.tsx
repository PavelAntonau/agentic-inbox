// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Minimal link-provider context used by LinkButton.
// Mirrors kumo's internal link-provider context so that root.tsx's LinkProvider
// (Phase 2) can later be swapped to ~/ui/link-provider without changing this hook.

import { createContext, forwardRef, useContext } from "react";
import type { AnchorHTMLAttributes, ForwardedRef } from "react";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  to?: string;
  ref?: ForwardedRef<HTMLAnchorElement>;
};

type LinkComponentType = React.ForwardRefExoticComponent<
  LinkProps & React.RefAttributes<HTMLAnchorElement>
>;

// Default link component: plain <a> element.
const DefaultLink = forwardRef<HTMLAnchorElement, LinkProps>(
  function DefaultLink({ to, href, ...props }, ref) {
    return <a ref={ref} href={href ?? to ?? undefined} {...props} />;
  },
);

const LinkContext = createContext<LinkComponentType>(DefaultLink);

export function useLinkComponent(): LinkComponentType {
  return useContext(LinkContext);
}
