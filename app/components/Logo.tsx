// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Link } from "react-router";
import lightLogoUrl from "~/assets/branding/anai-mail-logo-light.png?url";
import darkLogoUrl from "~/assets/branding/anai-mail-logo-dark.png?url";

type LogoProps = {
  /** Pixel height of the logo. Default 40. */
  height?: number;
  /** Where to navigate when clicked. Default `/`. Pass null to render
   *  the logo as a plain image with no link wrapper. */
  to?: string | null;
  /** Extra classes for the outer wrapper. */
  className?: string;
};

export default function Logo({ height = 40, to = "/", className }: LogoProps) {
  // Native <picture> swap on prefers-color-scheme. Browser picks the right
  // asset; no JS, no flash-of-wrong-logo.
  const img = (
    <picture>
      <source srcSet={darkLogoUrl} media="(prefers-color-scheme: dark)" />
      <img
        src={lightLogoUrl}
        alt="ActionNow.AI — Trusted Agent Inbox"
        height={height}
        style={{ height, width: "auto" }}
        className={`block select-none ${className ?? ""}`.trim()}
        draggable={false}
      />
    </picture>
  );
  if (to === null) return img;
  return (
    <Link
      to={to}
      aria-label="ActionNow.AI home"
      className="inline-flex items-center"
    >
      {img}
    </Link>
  );
}
