// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// Round user avatar.
// - When avatarUrl is present: renders the uploaded image.
// - Otherwise: a coloured circle with the first character of the user's
//   display name (or email, or id) as a white initial. The colour is a
//   deterministic hash of userId so it is stable across reloads.

const PALETTE = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-blue-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-pink-500",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export interface AvatarProps {
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  /** Pixel size of the round avatar. Default 36. */
  size?: number;
  onClick?: () => void;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** Tooltip / aria label override. */
  ariaLabel?: string;
}

export default function Avatar({
  userId,
  displayName,
  email,
  avatarUrl,
  size = 36,
  onClick,
  className = "",
  ariaLabel,
}: AvatarProps) {
  const sourceName =
    (displayName && displayName.trim()) ||
    (email && email.trim()) ||
    userId ||
    "?";
  const initial = sourceName.charAt(0).toUpperCase() || "?";
  const colorClass = PALETTE[hashString(userId || sourceName) % PALETTE.length];
  const label = ariaLabel ?? `Account: ${sourceName}`;

  const inner = avatarUrl ? (
    <img
      src={avatarUrl}
      alt=""
      className="h-full w-full object-cover"
      draggable={false}
    />
  ) : (
    <span
      className="font-semibold text-white select-none"
      style={{ fontSize: Math.max(11, Math.round(size * 0.42)) }}
    >
      {initial}
    </span>
  );

  const wrapperClasses = [
    "inline-flex items-center justify-center rounded-full overflow-hidden shrink-0",
    avatarUrl ? "bg-card-light" : colorClass,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`${wrapperClasses} cursor-pointer transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand`}
        style={{ width: size, height: size }}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className={wrapperClasses}
      style={{ width: size, height: size }}
      aria-label={label}
    >
      {inner}
    </div>
  );
}
