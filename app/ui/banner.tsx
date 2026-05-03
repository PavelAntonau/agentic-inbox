// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from kumo Banner (shadcn pattern — source in app/ui/).
// Preserves the exact public API: prop names, types, defaults, DOM structure,
// and Tailwind utility classes so consumer files need only an import-path change.

import { forwardRef, isValidElement } from "react";
import type { ReactNode } from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant tables (mirrors KUMO_BANNER_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_BANNER_BASE_STYLES =
  "flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-base";

export const KUMO_BANNER_VARIANTS = {
  variant: {
    default: {
      classes:
        "bg-kumo-info/10 border-kumo-info/30 text-kumo-info selection:bg-kumo-info-tint",
      iconClasses: "text-kumo-info",
      description: "Informational banner for general messages",
    },
    alert: {
      classes:
        "bg-kumo-warning/10 border-kumo-warning/30 text-kumo-warning selection:bg-kumo-warning-tint",
      iconClasses: "text-kumo-warning",
      description: "Warning banner for cautionary messages",
    },
    error: {
      classes:
        "bg-kumo-danger/10 border-kumo-danger/30 text-kumo-danger selection:bg-kumo-danger-tint",
      iconClasses: "text-kumo-danger",
      description: "Error banner for critical issues",
    },
  },
} as const;

export const KUMO_BANNER_DEFAULT_VARIANTS = {
  variant: "default",
} as const;

export type KumoBannerVariant = keyof typeof KUMO_BANNER_VARIANTS.variant;

export interface KumoBannerVariantsProps {
  /**
   * Visual variant of the banner.
   * - `"default"` — Informational banner for general messages
   * - `"alert"` — Warning banner for cautionary messages
   * - `"error"` — Error banner for critical issues
   * @default "default"
   */
  variant?: KumoBannerVariant;
}

export function bannerVariants({
  variant = KUMO_BANNER_DEFAULT_VARIANTS.variant,
}: KumoBannerVariantsProps = {}): string {
  return cn(
    KUMO_BANNER_BASE_STYLES,
    KUMO_BANNER_VARIANTS.variant[variant].classes,
  );
}

// ---------------------------------------------------------------------------
// Numeric variant enum (kumo parity — Figma plugin consumer)
// ---------------------------------------------------------------------------

export enum BannerVariant {
  DEFAULT = 0,
  ALERT = 1,
  ERROR = 2,
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BannerCommonProps extends KumoBannerVariantsProps {
  /** Optional leading icon (e.g. from `@phosphor-icons/react`). */
  icon?: ReactNode;
  /** Additional CSS classes merged via `cn()`. */
  className?: string;
}

interface BannerWithTitleProps extends BannerCommonProps {
  /** Heading text rendered above the description. */
  title?: string;
  /** Body content (string or ReactNode). */
  description?: ReactNode;
  text?: never;
  children?: never;
}

interface BannerTextOnlyProps extends BannerCommonProps {
  title?: never;
  description?: never;
  /** Body content as plain text. */
  text?: ReactNode;
  /** Body content as children (alternative to `text`). */
  children?: ReactNode;
}

export type BannerProps = BannerWithTitleProps | BannerTextOnlyProps;

// ---------------------------------------------------------------------------
// Banner component
// ---------------------------------------------------------------------------

export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
  { icon, variant = KUMO_BANNER_DEFAULT_VARIANTS.variant, className, ...rest },
  ref,
) {
  const variantStyles = KUMO_BANNER_VARIANTS.variant[variant];
  const titleProps = rest as BannerWithTitleProps;
  const textProps = rest as BannerTextOnlyProps;
  const hasTitleForm =
    titleProps.title !== undefined || titleProps.description !== undefined;

  if (hasTitleForm) {
    return (
      <div ref={ref} className={cn(bannerVariants({ variant }), className)}>
        {icon && (
          <span
            className={cn(
              "shrink-0 flex items-center h-[1.375em]",
              variantStyles.iconClasses,
            )}
          >
            {icon}
          </span>
        )}
        <div className="flex flex-col gap-0.5">
          {titleProps.title && (
            <p className="font-medium leading-snug">{titleProps.title}</p>
          )}
          {titleProps.description !== undefined && (
            <div className="text-sm leading-snug">
              {isValidElement(titleProps.description) ? (
                titleProps.description
              ) : (
                <p>{titleProps.description}</p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const body = textProps.children ?? textProps.text;
  const bodyNode = isValidElement(body) ? body : <p>{body}</p>;

  return (
    <div ref={ref} className={cn(bannerVariants({ variant }), className)}>
      {icon && (
        <span className={cn("shrink-0", variantStyles.iconClasses)}>
          {icon}
        </span>
      )}
      {bodyNode}
    </div>
  );
});

Banner.displayName = "Banner";
