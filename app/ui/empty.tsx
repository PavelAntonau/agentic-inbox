// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from kumo Empty (shadcn pattern — source in app/ui/).
// Preserves the exact public API: prop names, types, defaults, DOM structure,
// and Tailwind utility classes so consumer files need only an import-path change.

import { useState } from "react";
import type { ReactNode } from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant tables (mirrors KUMO_EMPTY_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_EMPTY_VARIANTS = {
  size: {
    sm: {
      classes: "px-6 py-8 gap-4",
      description: "Compact empty state for smaller containers",
    },
    base: {
      classes: "px-10 py-16 gap-6",
      description: "Default empty state size",
    },
    lg: {
      classes: "px-12 py-20 gap-8",
      description: "Large empty state for prominent placement",
    },
  },
} as const;

export const KUMO_EMPTY_DEFAULT_VARIANTS = {
  size: "base",
} as const;

export type KumoEmptySize = keyof typeof KUMO_EMPTY_VARIANTS.size;

export interface KumoEmptyVariantsProps {
  /**
   * Size of the empty state container.
   * - `"sm"` — Compact empty state for smaller containers
   * - `"base"` — Default empty state size
   * - `"lg"` — Large empty state for prominent placement
   * @default "base"
   */
  size?: KumoEmptySize;
}

export function emptyVariants({
  size = KUMO_EMPTY_DEFAULT_VARIANTS.size,
}: KumoEmptyVariantsProps = {}): string {
  return cn(
    "flex w-full flex-col items-center rounded-xl border border-kumo-fill bg-kumo-control text-kumo-default",
    KUMO_EMPTY_VARIANTS.size[size].classes,
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EmptyProps extends KumoEmptyVariantsProps {
  /** Decorative icon displayed above the title (e.g. from `@phosphor-icons/react`). */
  icon?: ReactNode;
  /** Primary heading text for the empty state. */
  title: string;
  /** Secondary description text displayed below the title. */
  description?: string;
  /** Shell command displayed in a copyable code block. */
  commandLine?: string;
  /** Additional content (buttons, links) rendered below the description. */
  contents?: ReactNode;
  /** Additional CSS classes merged via `cn()`. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Empty component
// ---------------------------------------------------------------------------

export function Empty({
  icon,
  title,
  description,
  commandLine,
  contents,
  size = KUMO_EMPTY_DEFAULT_VARIANTS.size,
  className,
}: EmptyProps) {
  const [copied, setCopied] = useState(false);

  return (
    <div className={cn(emptyVariants({ size }), className)}>
      {icon}
      <h2 className="text-2xl font-semibold">{title}</h2>
      {description && (
        <p className="max-w-140 text-center text-kumo-strong">{description}</p>
      )}
      {commandLine && (
        <div
          className={cn(
            "group/cmd relative inline-flex h-10 max-w-8/10 transform-gpu items-center gap-2 rounded-lg font-mono shadow-sm",
            "bg-kumo-overlay pr-2 pl-3",
            "transition-all duration-300 hover:border-kumo-interact/80 hover:shadow-md",
            "border border-kumo-fill/60",
          )}
        >
          <span className="text-xs text-kumo-inactive select-none">$</span>
          <span className="no-scrollbar overflow-scroll text-[14px] whitespace-nowrap text-kumo-brand">
            {commandLine}
          </span>
          <button
            type="button"
            aria-label="Copy command"
            className="group inline-flex items-center justify-center rounded px-1 py-0.5 text-sm"
            onClick={async () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1000);
              await navigator.clipboard.writeText(commandLine);
            }}
          >
            {copied ? (
              <svg
                className="animate-bounce-in h-4 w-4 text-kumo-success"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg
                className="h-4 w-4 text-kumo-inactive group-hover:text-kumo-brand"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            )}
          </button>
        </div>
      )}
      {contents}
    </div>
  );
}
