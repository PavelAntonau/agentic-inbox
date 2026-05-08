// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from kumo Input (shadcn pattern — source in app/ui/).
// Preserves exact public API, prop names, and class names from kumo's input chunk.
// Uses @base-ui/react Input as the underlying primitive (same as kumo).

import { forwardRef } from "react";
import type { ReactNode } from "react";
import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant tables (mirrors KUMO_INPUT_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_INPUT_VARIANTS = {
  size: {
    xs: {
      classes: "h-5 gap-1 rounded-sm px-1.5 text-xs",
      description: "Extra small input for compact UIs",
    },
    sm: {
      classes: "h-8 gap-1 rounded-md px-2 text-xs",
      description: "Small input for secondary fields",
    },
    base: {
      classes: "h-9 gap-1.5 rounded-lg px-3 text-base",
      description: "Default input size (36 px — backward compat)",
    },
    md: {
      classes: "h-10 gap-1.5 rounded-lg px-3 text-base",
      description: "Medium input (40 px)",
    },
    lg: {
      classes: "h-11 gap-2 rounded-lg px-4 text-base",
      description: "Large input — 44 px, meets Apple HIG tap-target floor",
    },
    xl: {
      classes: "h-14 gap-2 rounded-lg px-4 text-base",
      description: "Extra-large input — 56 px, primary CTA tier",
    },
  },
  variant: {
    default: {
      classes: "focus:ring-kumo-ring",
      description: "Default input appearance",
    },
    error: {
      classes: "!ring-kumo-danger focus:ring-kumo-danger",
      description: "Error state for validation failures",
    },
  },
} as const;

export const KUMO_INPUT_DEFAULT_VARIANTS = {
  size: "base",
  variant: "default",
} as const;

export type KumoInputSize = keyof typeof KUMO_INPUT_VARIANTS.size;
export type KumoInputVariant = keyof typeof KUMO_INPUT_VARIANTS.variant;

export interface KumoInputVariantsProps {
  size?: KumoInputSize;
  variant?: KumoInputVariant;
  parentFocusIndicator?: boolean;
  focusIndicator?: boolean;
}

// ---------------------------------------------------------------------------
// FieldErrorMatch (mirrors kumo's type)
// ---------------------------------------------------------------------------

export type FieldErrorMatch =
  | boolean
  | ((value: string) => boolean)
  | RegExp
  | string;

// ---------------------------------------------------------------------------
// inputVariants helper
// ---------------------------------------------------------------------------

type BaseInputProps = Omit<ComponentPropsWithoutRef<typeof BaseInput>, "size">;

export function inputVariants({
  variant = KUMO_INPUT_DEFAULT_VARIANTS.variant,
  size = KUMO_INPUT_DEFAULT_VARIANTS.size,
  parentFocusIndicator = false,
  focusIndicator = false,
}: KumoInputVariantsProps = {}): string {
  return cn(
    "border-0 bg-kumo-control text-kumo-default ring ring-kumo-line",
    "outline-none placeholder:text-kumo-subtle disabled:text-kumo-subtle",
    KUMO_INPUT_VARIANTS.size[size].classes,
    KUMO_INPUT_VARIANTS.variant[variant].classes,
    parentFocusIndicator && "[&:has(:focus-within)]:ring-kumo-ring",
    focusIndicator && "focus:ring-kumo-ring",
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type InputProps = Pick<KumoInputVariantsProps, "size" | "variant"> &
  BaseInputProps & {
    label?: ReactNode;
    labelTooltip?: ReactNode;
    description?: ReactNode;
    error?:
      | string
      | {
          message: ReactNode;
          match: FieldErrorMatch;
        };
  };

// ---------------------------------------------------------------------------
// Input component
// ---------------------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    size = "base",
    variant = "default",
    label,
    labelTooltip: _labelTooltip,
    description,
    error,
    ...rest
  },
  ref,
) {
  if (import.meta.env.DEV) {
    const hasLabel = !!label;
    const hasPlaceholderAndAriaLabel = !!(
      rest.placeholder && rest["aria-label"]
    );
    const hasAriaLabelledby = !!rest["aria-labelledby"];
    if (!hasLabel && !hasPlaceholderAndAriaLabel && !hasAriaLabelledby) {
      console.warn(
        `[Input]: Input must have an accessible name. Provide either:\n` +
          `  - label prop: <Input label='Email' />\n` +
          `  - placeholder + aria-label: <Input placeholder='Email' aria-label='Email address' />\n` +
          `  - aria-labelledby for custom label association`,
      );
    }
  }

  const inputEl = (
    <BaseInput
      ref={ref}
      className={cn(
        inputVariants({ size, variant, focusIndicator: true }),
        className,
      )}
      {...rest}
    />
  );

  if (!label) return inputEl;

  // Minimal field wrapper when label is provided.
  const errorMessage =
    error && typeof error === "string"
      ? error
      : (error as { message: ReactNode } | undefined)?.message;

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-kumo-default">
        {label}
        {rest.required && <span aria-hidden="true"> *</span>}
      </label>
      {inputEl}
      {description && <p className="text-xs text-kumo-subtle">{description}</p>}
      {errorMessage && (
        <p className="text-xs text-kumo-danger">{errorMessage}</p>
      )}
    </div>
  );
});
Input.displayName = "Input";
