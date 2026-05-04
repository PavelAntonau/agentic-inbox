// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from kumo Button (shadcn pattern — source in app/ui/).
// Preserves the exact public API: prop names, types, defaults, DOM structure,
// and Tailwind utility classes so consumer files need only an import-path change.

import { forwardRef, isValidElement } from "react";
import type { Icon } from "@phosphor-icons/react";
import { Loader } from "~/ui/loader";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant tables (mirrors KUMO_BUTTON_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_BUTTON_VARIANTS = {
  shape: {
    base: {
      classes: "",
      description: "Default rectangular button shape",
    },
    square: {
      classes: "items-center justify-center p-0",
      description: "Square button for icon-only actions",
    },
    circle: {
      classes: "items-center justify-center p-0 rounded-full",
      description: "Circular button for icon-only actions",
    },
  },
  size: {
    xs: {
      classes: "h-5 gap-1 rounded-sm px-1.5 text-xs",
      description: "Extra small button for compact UIs",
    },
    sm: {
      classes: "h-6.5 gap-1 rounded-md px-2 text-xs",
      description: "Small button for secondary actions",
    },
    base: {
      classes: "h-9 gap-1.5 rounded-lg px-3 text-base",
      description: "Default button size",
    },
    lg: {
      classes: "h-10 gap-2 rounded-lg px-4 text-base",
      description: "Large button for primary CTAs",
    },
  },
  compactSize: {
    xs: { classes: "size-3.5" },
    sm: { classes: "size-6.5" },
    base: { classes: "size-9" },
    lg: { classes: "size-10" },
  },
  variant: {
    primary: {
      classes:
        "bg-kumo-brand !text-white hover:bg-kumo-brand-hover focus:bg-kumo-brand-hover disabled:bg-kumo-brand/50",
      description: "High-emphasis button for primary actions",
    },
    secondary: {
      classes:
        "bg-kumo-base !text-kumo-default ring not-disabled:hover:border-secondary! not-disabled:hover:bg-kumo-tint disabled:bg-kumo-base/50 disabled:!text-kumo-default/70 ring-kumo-ring data-[state=open]:bg-kumo-base",
      description: "Default button style for most actions",
    },
    ghost: {
      // hover bg uses the project's theme-aware --color-card-light token
      // (registered via @theme so Tailwind emits a var()-backed utility).
      // bg-kumo-tint was @theme-inline-baked to a near-white in BOTH modes,
      // which produced the dark-mode "white flash" on hover (UAT round 2,
      // item E — refresh / delete / copy-MCP buttons going white in dark mode).
      classes: "text-kumo-default hover:bg-card-light shadow-none bg-inherit",
      description: "Minimal button with no background",
    },
    destructive: {
      classes: "bg-kumo-danger !text-white hover:bg-kumo-danger/70",
      description: "Danger button for destructive actions like delete",
    },
    "secondary-destructive": {
      classes:
        "bg-kumo-base !text-kumo-danger ring not-disabled:hover:border-secondary! not-disabled:hover:bg-kumo-base disabled:bg-kumo-base/50 disabled:!text-kumo-danger/70 ring-kumo-line data-[state=open]:bg-kumo-base",
      description:
        "Secondary button with destructive text for less prominent dangerous actions",
    },
    outline: {
      classes: "bg-transparent text-kumo-default ring-2 ring-kumo-ring",
      description: "Bordered button with transparent background",
    },
  },
} as const;

export const KUMO_BUTTON_DEFAULT_VARIANTS = {
  shape: "base",
  size: "base",
  variant: "secondary",
} as const;

// ---------------------------------------------------------------------------
// Type exports (mirrors kumo type exports)
// ---------------------------------------------------------------------------

export type KumoButtonShape = keyof typeof KUMO_BUTTON_VARIANTS.shape;
export type KumoButtonSize = keyof typeof KUMO_BUTTON_VARIANTS.size;
export type KumoButtonVariant = keyof typeof KUMO_BUTTON_VARIANTS.variant;

export interface KumoButtonVariantsProps {
  shape?: KumoButtonShape;
  size?: KumoButtonSize;
  variant?: KumoButtonVariant;
}

// ---------------------------------------------------------------------------
// buttonVariants helper
// ---------------------------------------------------------------------------

export function buttonVariants({
  variant = KUMO_BUTTON_DEFAULT_VARIANTS.variant,
  size = KUMO_BUTTON_DEFAULT_VARIANTS.size,
  shape = KUMO_BUTTON_DEFAULT_VARIANTS.shape,
}: KumoButtonVariantsProps = {}): string {
  const isCompact = shape === "square" || shape === "circle";
  return cn(
    "group flex w-max shrink-0 items-center font-medium select-none",
    "border-0 shadow-xs",
    "cursor-pointer",
    "disabled:cursor-not-allowed disabled:text-kumo-subtle",
    KUMO_BUTTON_VARIANTS.variant[variant].classes,
    KUMO_BUTTON_VARIANTS.size[size].classes,
    KUMO_BUTTON_VARIANTS.shape[shape].classes,
    isCompact && KUMO_BUTTON_VARIANTS.compactSize[size].classes,
  );
}

// ---------------------------------------------------------------------------
// Props (discriminated union: text button vs icon-only button)
// ---------------------------------------------------------------------------

type ButtonBaseProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: React.ReactNode;
  className?: string;
  icon?: Icon | React.ReactNode;
  loading?: boolean;
};

type ButtonWithTextProps = ButtonBaseProps & {
  shape?: "base";
  size?: KumoButtonSize;
  variant?: KumoButtonVariant;
};

type IconOnlyButtonProps = ButtonBaseProps & {
  shape: "square" | "circle";
  size?: KumoButtonSize;
  variant?: KumoButtonVariant;
  "aria-label": string;
};

export type ButtonProps = ButtonWithTextProps | IconOnlyButtonProps;

// ---------------------------------------------------------------------------
// Render icon (element pass-through or component instantiation)
// ---------------------------------------------------------------------------

function renderIcon(icon: Icon | React.ReactNode | undefined) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const IconComponent = icon as Icon;
  return <IconComponent />;
}

// ---------------------------------------------------------------------------
// Button component
// ---------------------------------------------------------------------------

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      className,
      disabled,
      loading,
      shape = "base",
      size = "base",
      variant = "secondary",
      icon,
      ...rest
    },
    ref,
  ) {
    const { type, ...props } = rest as {
      type?: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
    } & Omit<typeof rest, "type">;
    return (
      <button
        ref={ref}
        className={cn(
          buttonVariants({ variant, size, shape }),
          "outline-none focus:opacity-100 focus-visible:ring-1 focus-visible:ring-kumo-ring *:in-focus:opacity-100",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        disabled={loading || disabled}
        type={type ?? "button"}
        {...props}
      >
        {loading && <Loader size={size === "lg" ? 16 : 14} />}
        {!loading && renderIcon(icon)}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

// ---------------------------------------------------------------------------
// RefreshButton
// ---------------------------------------------------------------------------

import { ArrowsClockwise } from "@phosphor-icons/react";

export function RefreshButton({
  "aria-label": ariaLabel = "Refresh",
  loading,
  ...props
}: ButtonProps) {
  return (
    <Button shape="square" aria-label={ariaLabel} {...props}>
      <ArrowsClockwise
        className={cn({
          "animate-refresh": loading,
          "size-4.5": props.size === "base" || !props.size,
          "size-4": props.size === "sm",
          "size-5": props.size === "lg",
        })}
      />
    </Button>
  );
}

// ---------------------------------------------------------------------------
// LinkButton (context-aware anchor styled as a button)
// ---------------------------------------------------------------------------

import { useLinkComponent } from "~/ui/link-provider";

export type LinkButtonProps = React.AnchorHTMLAttributes<HTMLAnchorElement> &
  KumoButtonVariantsProps & {
    children?: React.ReactNode;
    className?: string;
    icon?: Icon | React.ReactNode;
    external?: boolean;
    linksExternal?: boolean;
  };

export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(
  function LinkButton(
    {
      children,
      className,
      external,
      href,
      shape = "base",
      size = "base",
      variant = "ghost",
      icon,
      // linksExternal = false,
      ...rest
    },
    ref,
  ) {
    const LinkComponent = useLinkComponent();
    const externalProps = external
      ? { target: "_blank", rel: "noopener noreferrer" }
      : {};
    return (
      <LinkComponent
        ref={ref}
        className={cn(
          buttonVariants({ variant, size, shape }),
          "flex items-center no-underline!",
          className,
        )}
        href={href}
        to={typeof href === "string" ? href : undefined}
        {...externalProps}
        {...rest}
      >
        {renderIcon(icon)}
        {children}
      </LinkComponent>
    );
  },
);
LinkButton.displayName = "LinkButton";
