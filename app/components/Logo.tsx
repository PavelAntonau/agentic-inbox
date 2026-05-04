// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Link } from "react-router";
import iconLightUrl from "~/assets/branding/logo-icon-light.png?url";
import iconDarkUrl from "~/assets/branding/logo-icon-dark.png?url";
import titleLightUrl from "~/assets/branding/logo-title-light.png?url";
import titleDarkUrl from "~/assets/branding/logo-title-dark.png?url";

type LogoProps = {
  /** Pixel height of the logo. Default 48. */
  height?: number;
  /** Where to navigate when clicked. Default `/`. Pass null to render
   *  the logo as a plain image with no link wrapper. */
  to?: string | null;
  /** Extra classes for the outer wrapper. */
  className?: string;
};

// The brand mark is split into two pieces — an icon (the symbol) and a
// title (the wordmark) — both with light and dark variants. We render
// all four images and toggle visibility with `dark:` so the swap is
// instant and never flashes. Tailwind's `dark:` variant is wired to
// `.theme-dark` on <html> in app/index.css.
export default function Logo({ height = 48, to = "/", className }: LogoProps) {
  // Title sits at ~60% of icon height so the wordmark reads as the
  // companion, not the headline. Both heights are in css pixels.
  const titleHeight = Math.round(height * 0.62);

  const content = (
    <span
      className={`inline-flex items-center gap-2 ${className ?? ""}`.trim()}
    >
      <img
        src={iconLightUrl}
        alt=""
        height={height}
        style={{ height, width: "auto" }}
        className="block select-none dark:hidden"
        draggable={false}
      />
      <img
        src={iconDarkUrl}
        alt=""
        height={height}
        style={{ height, width: "auto" }}
        className="hidden select-none dark:block"
        draggable={false}
      />
      <img
        src={titleLightUrl}
        alt="ActionNow.AI"
        height={titleHeight}
        style={{ height: titleHeight, width: "auto" }}
        className="block select-none dark:hidden"
        draggable={false}
      />
      <img
        src={titleDarkUrl}
        alt="ActionNow.AI"
        height={titleHeight}
        style={{ height: titleHeight, width: "auto" }}
        className="hidden select-none dark:block"
        draggable={false}
      />
    </span>
  );

  if (to === null) return content;
  return (
    <Link
      to={to}
      aria-label="ActionNow.AI home"
      className="inline-flex items-center"
    >
      {content}
    </Link>
  );
}
