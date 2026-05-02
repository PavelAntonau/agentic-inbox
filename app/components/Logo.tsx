// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Link } from "react-router";
import logoUrl from "~/assets/branding/anai-mail-logo.png?url";

type LogoProps = {
  /** Pixel height of the logo. Default 64. */
  height?: number;
  /** Where to navigate when clicked. Default `/`. Pass null to render
   *  the logo as a plain image with no link wrapper. */
  to?: string | null;
  /** Extra classes for the outer wrapper. */
  className?: string;
};

export default function Logo({ height = 64, to = "/", className }: LogoProps) {
  const img = (
    <img
      src={logoUrl}
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
