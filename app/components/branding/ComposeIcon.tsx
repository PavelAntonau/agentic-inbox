// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// ComposeIcon — the mailbox-as-robot brand mark used by every "compose"
// or "send mail" button in the app. Theme-aware: renders the light PNG
// in light mode and the dark PNG in dark mode by toggling visibility
// (no JS state, instant swap, no flash).

import lightUrl from "~/assets/branding/compose-mailbox-light.png?url";
import darkUrl from "~/assets/branding/compose-mailbox-dark.png?url";

interface ComposeIconProps {
  /** Pixel HEIGHT of the rendered icon. Width follows the asset's
   *  intrinsic 863:651 aspect (~4:3). */
  size?: number;
  className?: string;
}

// Asset is 863 × 651 (transparent PNG, anai_mailbox_light original).
const ASPECT = 863 / 651;

export default function ComposeIcon({
  size = 18,
  className,
}: ComposeIconProps) {
  const width = Math.round(size * ASPECT);
  return (
    <span
      className={`relative inline-block shrink-0 ${className ?? ""}`.trim()}
      style={{ width, height: size }}
    >
      <img
        src={lightUrl}
        alt=""
        width={width}
        height={size}
        className="block h-full w-full object-contain select-none dark:hidden"
        draggable={false}
      />
      <img
        src={darkUrl}
        alt=""
        width={width}
        height={size}
        className="hidden h-full w-full object-contain select-none dark:block"
        draggable={false}
      />
    </span>
  );
}
