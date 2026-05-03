// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from kumo Tooltip (shadcn pattern — source in app/ui/).
// Preserves the exact public API: prop names, types, defaults, DOM structure,
// and Tailwind utility classes so consumer files need only an import-path change.

import { Tooltip as TooltipBase } from "@base-ui/react/tooltip";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant tables (mirrors KUMO_TOOLTIP_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_TOOLTIP_VARIANTS = {
  side: {
    top: {
      classes: "",
      description: "Tooltip appears above the trigger",
    },
    bottom: {
      classes: "",
      description: "Tooltip appears below the trigger",
    },
    left: {
      classes: "",
      description: "Tooltip appears to the left of the trigger",
    },
    right: {
      classes: "",
      description: "Tooltip appears to the right of the trigger",
    },
  },
} as const;

export const KUMO_TOOLTIP_DEFAULT_VARIANTS = {
  side: "top",
} as const;

export type KumoTooltipSide = keyof typeof KUMO_TOOLTIP_VARIANTS.side;

export interface KumoTooltipVariantsProps {
  side?: KumoTooltipSide;
}

export function tooltipVariants({
  side,
}: KumoTooltipVariantsProps = {}): string {
  return cn(side && KUMO_TOOLTIP_VARIANTS.side[side].classes);
}

// ---------------------------------------------------------------------------
// TooltipProvider — mounts once at the root, enables delay grouping
// ---------------------------------------------------------------------------

export const TooltipProvider = TooltipBase.Provider;

// ---------------------------------------------------------------------------
// Tooltip props
// ---------------------------------------------------------------------------

type BaseTooltipProps = ComponentPropsWithoutRef<typeof TooltipBase.Root>;

/** Alignment on the axis perpendicular to `side`. */
type TooltipAlign = "start" | "center" | "end";

export type TooltipProps = BaseTooltipProps &
  KumoTooltipVariantsProps & {
    align?: TooltipAlign;
    /** When true, the trigger wraps the child element instead of adding a wrapper. */
    asChild?: boolean;
    /** Additional CSS classes merged via `cn()`. */
    className?: string;
    /** Content to display inside the tooltip popup. */
    content: ReactNode;
  };

// ---------------------------------------------------------------------------
// Tooltip — accessible popup that shows additional info on hover/focus
// ---------------------------------------------------------------------------

/**
 * Accessible popup that shows additional information on hover/focus.
 * Wrap your app or section with `<TooltipProvider>` to enable delay grouping.
 *
 * @example
 * ```tsx
 * <Tooltip content="Save changes" asChild>
 *   <Button variant="primary">Save</Button>
 * </Tooltip>
 * ```
 */
export function Tooltip({
  content,
  children,
  align,
  asChild = false,
  side = KUMO_TOOLTIP_DEFAULT_VARIANTS.side,
  className,
  ...rootProps
}: TooltipProps) {
  return (
    <TooltipBase.Root {...rootProps}>
      <TooltipBase.Trigger
        className={cn(
          // Defensive resets when not using asChild — matches kumo chunk
          !asChild &&
            "inline-flex items-center bg-transparent border-none shadow-none p-0 m-0 h-auto min-h-0 leading-[0]",
          className,
        )}
        render={asChild ? (children as React.ReactElement) : undefined}
      >
        {asChild ? undefined : (children as React.ReactNode)}
      </TooltipBase.Trigger>
      <TooltipBase.Portal>
        <TooltipBase.Positioner side={side} align={align} sideOffset={10}>
          <TooltipBase.Popup
            className={cn(
              "flex origin-[var(--transform-origin)] flex-col rounded-md bg-kumo-base px-2.5 py-1.5 text-sm text-kumo-default",
              "shadow-lg shadow-kumo-tip-shadow outline outline-kumo-fill",
              "transition-[transform,opacity] duration-150",
              "data-[starting-style]:scale-90 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-90 data-[ending-style]:opacity-0",
              "data-[instant]:duration-0",
              "kumo-tooltip-popup",
            )}
          >
            <TooltipBase.Arrow
              className={cn(
                "flex",
                "data-[side=bottom]:top-[-8px]",
                "data-[side=left]:right-[-13px] data-[side=left]:rotate-90",
                "data-[side=right]:left-[-13px] data-[side=right]:-rotate-90",
                "data-[side=top]:bottom-[-8px] data-[side=top]:rotate-180",
              )}
            >
              <TooltipArrowSvg />
            </TooltipBase.Arrow>
            {content}
          </TooltipBase.Popup>
        </TooltipBase.Positioner>
      </TooltipBase.Portal>
    </TooltipBase.Root>
  );
}

// ---------------------------------------------------------------------------
// Arrow SVG — matches the kumo chunk exactly
// ---------------------------------------------------------------------------

function TooltipArrowSvg(
  props: React.SVGProps<SVGSVGElement>,
): React.ReactElement {
  return (
    <svg width="20" height="10" viewBox="0 0 20 10" fill="none" {...props}>
      <path
        d="M9.66437 2.60207L4.80758 6.97318C4.07308 7.63423 3.11989 8 2.13172 8H0V10H20V8H18.5349C17.5468 8 16.5936 7.63423 15.8591 6.97318L11.0023 2.60207C10.622 2.2598 10.0447 2.25979 9.66437 2.60207Z"
        className="fill-kumo-base"
      />
      <path
        d="M8.99542 1.85876C9.75604 1.17425 10.9106 1.17422 11.6713 1.85878L16.5281 6.22989C17.0789 6.72568 17.7938 7.00001 18.5349 7.00001L15.89 7L11.0023 2.60207C10.622 2.2598 10.0447 2.2598 9.66436 2.60207L4.77734 7L2.13171 7.00001C2.87284 7.00001 3.58774 6.72568 4.13861 6.22989L8.99542 1.85876Z"
        className="fill-kumo-tip-shadow"
      />
      <path
        d="M10.3333 3.34539L5.47654 7.71648C4.55842 8.54279 3.36693 9 2.13172 9H0V8H2.13172C3.11989 8 4.07308 7.63423 4.80758 6.97318L9.66437 2.60207C10.0447 2.25979 10.622 2.2598 11.0023 2.60207L15.8591 6.97318C16.5936 7.63423 17.5468 8 18.5349 8H20V9H18.5349C17.2998 9 16.1083 8.54278 15.1901 7.71648L10.3333 3.34539Z"
        className="fill-kumo-tip-stroke"
      />
    </svg>
  );
}
