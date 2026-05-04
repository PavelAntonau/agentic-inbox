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
  size?: number;
  className?: string;
}

export default function ComposeIcon({
  size = 18,
  className,
}: ComposeIconProps) {
  return (
    <span
      className={`relative inline-block shrink-0 ${className ?? ""}`.trim()}
      style={{ width: size, height: size }}
    >
      <img
        src={lightUrl}
        alt=""
        width={size}
        height={size}
        className="absolute inset-0 h-full w-full object-contain select-none dark:hidden"
        draggable={false}
      />
      <img
        src={darkUrl}
        alt=""
        width={size}
        height={size}
        className="absolute inset-0 hidden h-full w-full object-contain select-none dark:block"
        draggable={false}
      />
    </span>
  );
}
