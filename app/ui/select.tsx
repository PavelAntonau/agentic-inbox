// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from kumo Select (shadcn pattern — source in app/ui/).
// Preserves the `<Select value onValueChange aria-label>` + `<Select.Option value>`
// surface the codebase uses (single callsite: app/routes/home.tsx domain picker).

import { Select as SelectBase } from "@base-ui/react/select";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant tables (mirrors KUMO_SELECT_VARIANTS — minimal subset in use)
// ---------------------------------------------------------------------------

export const KUMO_SELECT_VARIANTS = {
  size: {
    sm: {
      classes: "h-8 px-2 text-xs",
      description: "Small select for compact rails",
    },
    base: {
      classes: "h-9 px-3 text-sm",
      description: "Default select size",
    },
  },
} as const;

export const KUMO_SELECT_DEFAULT_VARIANTS = {
  size: "base",
} as const;

export type KumoSelectSize = keyof typeof KUMO_SELECT_VARIANTS.size;

export interface KumoSelectVariantsProps {
  size?: KumoSelectSize;
}

export function selectVariants({
  size = KUMO_SELECT_DEFAULT_VARIANTS.size,
}: KumoSelectVariantsProps = {}): string {
  return cn(
    "inline-flex items-center justify-between gap-2 rounded-md border border-kumo-fill",
    "bg-kumo-base text-kumo-default outline-none",
    "focus-visible:ring-2 focus-visible:ring-kumo-fill",
    "disabled:cursor-not-allowed disabled:opacity-50",
    KUMO_SELECT_VARIANTS.size[size].classes,
  );
}

// ---------------------------------------------------------------------------
// Select root — controlled / uncontrolled value with onValueChange
// ---------------------------------------------------------------------------

export type SelectProps = KumoSelectVariantsProps & {
  /** Controlled value. */
  value?: string;
  /** Initial value when uncontrolled. */
  defaultValue?: string;
  /** Fires when the user picks a new value. */
  onValueChange?: (value: string) => void;
  /** Accessible name for the trigger. REQUIRED for screen readers. */
  "aria-label"?: string;
  /** Trigger label override; defaults to the selected option's text. */
  placeholder?: string;
  /** Trigger className (merged with `selectVariants(size)`). */
  className?: string;
  /** Disable the trigger. */
  disabled?: boolean;
  /** Select.Option children. */
  children: ReactNode;
};

/**
 * Accessible select dropdown ported from kumo. Uses `@base-ui/react`'s Select
 * primitive under the hood (focus management, keyboard nav, portal popup).
 *
 * @example
 * ```tsx
 * <Select aria-label="Domain" value={selectedDomain} onValueChange={setSelectedDomain}>
 *   <Select.Option value="actionnow.ai">actionnow.ai</Select.Option>
 *   <Select.Option value="example.com">example.com</Select.Option>
 * </Select>
 * ```
 */
export function Select({
  value,
  defaultValue,
  onValueChange,
  "aria-label": ariaLabel,
  placeholder,
  className,
  size,
  disabled,
  children,
}: SelectProps) {
  return (
    <SelectBase.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange?.(next);
      }}
      disabled={disabled}
    >
      <SelectBase.Trigger
        aria-label={ariaLabel}
        className={cn(
          selectVariants({ size }),
          "kumo-select-trigger",
          className,
        )}
      >
        <SelectBase.Value placeholder={placeholder} />
        <SelectBase.Icon className="text-text-muted">
          <CaretDownIcon size={14} weight="bold" />
        </SelectBase.Icon>
      </SelectBase.Trigger>
      <SelectBase.Portal>
        <SelectBase.Positioner sideOffset={4} alignItemWithTrigger={false}>
          <SelectBase.Popup
            className={cn(
              "min-w-[var(--anchor-width)] overflow-y-auto rounded-md border border-kumo-fill",
              "bg-kumo-base p-1 shadow-lg shadow-kumo-tip-shadow outline-none",
              "max-h-[min(var(--available-height),24rem)]",
              "transition-[transform,opacity] duration-150",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "kumo-select-popup",
            )}
          >
            <SelectBase.List>{children}</SelectBase.List>
          </SelectBase.Popup>
        </SelectBase.Positioner>
      </SelectBase.Portal>
    </SelectBase.Root>
  );
}

// ---------------------------------------------------------------------------
// Select.Option — single item inside the popup
// ---------------------------------------------------------------------------

export type SelectOptionProps = {
  value: string;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
};

function SelectOption({
  value,
  className,
  disabled,
  children,
}: SelectOptionProps) {
  return (
    <SelectBase.Item
      value={value}
      disabled={disabled}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-kumo-default outline-none",
        "data-[highlighted]:bg-kumo-fill data-[highlighted]:text-kumo-default",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className,
      )}
    >
      <SelectBase.ItemText>{children}</SelectBase.ItemText>
    </SelectBase.Item>
  );
}

Select.Option = SelectOption;
