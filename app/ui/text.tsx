// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from @cloudflare/kumo Text (shadcn pattern — source in app/ui/).
// Preserves exact public API, prop names, and class names from kumo's text chunk.

import { forwardRef, useMemo } from "react";
import type {
  CSSProperties,
  ComponentPropsWithoutRef,
  ElementRef,
  ElementType,
  ForwardedRef,
} from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant / size tables (mirrors KUMO_TEXT_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_TEXT_VARIANTS = {
  variant: {
    heading1: {
      classes: "text-3xl font-semibold",
      description: "Large heading for page titles",
    },
    heading2: {
      classes: "text-2xl font-semibold",
      description: "Medium heading for section titles",
    },
    heading3: {
      classes: "text-lg font-semibold",
      description: "Small heading for subsections",
    },
    body: {
      classes: "text-kumo-default",
      description: "Default body text",
    },
    secondary: {
      classes: "text-kumo-subtle",
      description: "Muted text for secondary information",
    },
    success: {
      classes: "text-kumo-link",
      description: "Success state text",
    },
    error: {
      classes: "text-kumo-danger",
      description: "Error state text",
    },
    mono: {
      classes: "font-mono",
      description: "Monospace text for code",
    },
    "mono-secondary": {
      classes: "font-mono text-kumo-subtle",
      description: "Muted monospace text",
    },
  },
  size: {
    xs: { classes: "text-xs", description: "Extra small text" },
    sm: { classes: "text-sm", description: "Small text" },
    base: { classes: "text-base", description: "Default text size" },
    lg: { classes: "text-lg", description: "Large text" },
  },
} as const;

export const KUMO_TEXT_DEFAULT_VARIANTS = {
  variant: "body",
  size: "base",
} as const;

export type KumoTextVariant = keyof typeof KUMO_TEXT_VARIANTS.variant;
export type KumoTextSize = keyof typeof KUMO_TEXT_VARIANTS.size;

export interface KumoTextVariantsProps {
  variant?: KumoTextVariant;
  size?: KumoTextSize;
}

export function textVariants({
  variant = KUMO_TEXT_DEFAULT_VARIANTS.variant,
  size = KUMO_TEXT_DEFAULT_VARIANTS.size,
}: KumoTextVariantsProps = {}): string {
  return cn(
    KUMO_TEXT_VARIANTS.variant[variant].classes,
    KUMO_TEXT_VARIANTS.size[size].classes,
  );
}

// ---------------------------------------------------------------------------
// Internal discriminated-union props (mirrors kumo's TextPropsInternal)
// ---------------------------------------------------------------------------

type TextVariant = KumoTextVariant;
type TextSize = KumoTextSize;

type BaseTextProps = Omit<
  ComponentPropsWithoutRef<"span">,
  "className" | "style"
> & {
  DANGEROUS_className?: string;
  DANGEROUS_style?: CSSProperties;
  as?: ElementType;
};

type CopyVariant = "body" | "secondary" | "success" | "error";
type MonospaceVariant = "mono" | "mono-secondary";
type HeadingVariant = "heading1" | "heading2" | "heading3";

type TextPropsInternal<Variant extends TextVariant = "body"> = BaseTextProps &
  (Variant extends CopyVariant
    ? { variant?: Variant; bold?: boolean; size?: TextSize }
    : Variant extends MonospaceVariant
      ? { variant?: Variant; bold?: never; size?: "lg" }
      : Variant extends HeadingVariant
        ? { variant?: Variant; bold?: never; size?: never }
        : never);

// ---------------------------------------------------------------------------
// Public TextProps (simplified for consumers)
// ---------------------------------------------------------------------------

export interface TextProps {
  variant?: KumoTextVariant;
  size?: KumoTextSize;
  bold?: boolean;
  as?: ElementType;
  children?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Text component (generic, uses forwardRef)
// ---------------------------------------------------------------------------

// Phase 6 carve-out: `forwardRef` render functions must accept exactly two
// parameters (props, ref). The previous signature destructured `ref` from
// `props`, leaving the actual second arg unused — React 19 flags that with
// `forwardRef render functions accept exactly two parameters: props and ref.
// Did you forget to use the ref parameter?`. Switching to the canonical
// (props, ref) signature silences the warning while preserving the cast at
// the export site.
function TextInner<Variant extends TextVariant = "body">(
  props: TextPropsInternal<Variant>,
  ref: ForwardedRef<ElementRef<"span">>,
) {
  const {
    variant = "body" as Variant,
    bold = false,
    size = "base" as TextSize,
    children,
    DANGEROUS_className,
    DANGEROUS_style,
    as,
    ...rest
  } = props as TextPropsInternal<"body"> & {
    variant?: TextVariant;
    bold?: boolean;
    size?: TextSize;
  };

  const isCopy = (
    ["body", "secondary", "success", "error"] as TextVariant[]
  ).includes(variant);
  const isMono = (["mono", "mono-secondary"] as TextVariant[]).includes(
    variant,
  );

  const Tag = useMemo(
    () =>
      as ||
      (variant === "heading1"
        ? "h1"
        : variant === "heading2"
          ? "h2"
          : variant === "heading3"
            ? "h3"
            : isMono
              ? "span"
              : "p"),
    [variant, as, isMono],
  );

  const className = cn(
    "text-kumo-default",
    KUMO_TEXT_VARIANTS.variant[variant as KumoTextVariant].classes,
    isCopy ? KUMO_TEXT_VARIANTS.size[size as KumoTextSize].classes : "",
    isCopy && bold ? "font-medium" : "",
    // Monospace text rendered 1pt smaller to optically match body
    isMono &&
      (size === "lg"
        ? KUMO_TEXT_VARIANTS.size.base.classes
        : KUMO_TEXT_VARIANTS.size.sm.classes),
    DANGEROUS_className,
  );

  return (
    <Tag ref={ref} className={className} style={DANGEROUS_style} {...rest}>
      {children}
    </Tag>
  );
}

export const Text = forwardRef(TextInner) as <
  Variant extends TextVariant = "body",
>(
  props: TextPropsInternal<Variant> & {
    ref?: ForwardedRef<ElementRef<"span">>;
  },
) => React.ReactElement;
