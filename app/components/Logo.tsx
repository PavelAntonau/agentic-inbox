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
//
// Asset intrinsic dimensions (UAT round-3 audit, 2026-05-04):
//   logo-icon-{light,dark}.png   — 256 × 238  (identical aspect)
//   logo-title-light.png         — 921 × 192  (aspect ≈ 4.80)
//   logo-title-dark.png          — 1101 × 192 (aspect ≈ 5.73)
// The title-dark.png is ~20 % wider than its light counterpart, which
// produces a visible size jump when toggling theme. We normalise by
// pinning BOTH wordmark variants to the same rendered box (height-locked
// AND width-locked to the lighter aspect) and letting object-fit:contain
// letterbox the wider asset — the wordmark text reads at the same size
// in both modes.
const TITLE_ASPECT = 4.8; // Locked to the light variant's intrinsic ratio.

export default function Logo({ height = 48, to = "/", className }: LogoProps) {
  // Title sits at ~60% of icon height so the wordmark reads as the
  // companion, not the headline. Both heights are in css pixels.
  const titleHeight = Math.round(height * 0.62);
  const titleWidth = Math.round(titleHeight * TITLE_ASPECT);

  const titleStyle = {
    height: titleHeight,
    width: titleWidth,
    objectFit: "contain" as const,
    objectPosition: "left center" as const,
  };

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
        width={titleWidth}
        style={titleStyle}
        className="block select-none dark:hidden"
        draggable={false}
      />
      <img
        src={titleDarkUrl}
        alt="ActionNow.AI"
        height={titleHeight}
        width={titleWidth}
        style={titleStyle}
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
