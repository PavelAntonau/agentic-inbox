// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Link } from "react-router";
import lightLogoUrl from "~/assets/branding/anai-mail-logo-light.png?url";
import darkLogoUrl from "~/assets/branding/anai-mail-logo-dark.png?url";
import { useTheme } from "~/hooks/useTheme";

type LogoProps = {
  /** Pixel height of the logo. Default 96. */
  height?: number;
  /** Where to navigate when clicked. Default `/`. Pass null to render
   *  the logo as a plain image with no link wrapper. */
  to?: string | null;
  /** Extra classes for the outer wrapper. */
  className?: string;
};

export default function Logo({ height = 96, to = "/", className }: LogoProps) {
  const { theme } = useTheme();
  const src = theme === "dark" ? darkLogoUrl : lightLogoUrl;
  const img = (
    <img
      src={src}
      alt="ActionNow.AI — Trusted Agent Inbox"
      height={height}
      style={{ height, width: "auto" }}
      className={`block select-none ${className ?? ""}`.trim()}
      draggable={false}
    />
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
