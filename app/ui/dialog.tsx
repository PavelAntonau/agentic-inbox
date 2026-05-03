// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from @cloudflare/kumo Dialog (shadcn pattern — source in app/ui/).
// Preserves the exact public API: prop names, types, defaults, DOM structure,
// and Tailwind utility classes so consumer files need only an import-path change.

import { createContext, useContext } from "react";
import { Dialog as DialogBase } from "@base-ui/react/dialog";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant tables (mirrors KUMO_DIALOG_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_DIALOG_VARIANTS = {
  size: {
    base: {
      classes: "sm:min-w-96",
      description: "Default dialog width",
    },
    sm: {
      classes: "min-w-72",
      description: "Small dialog for simple confirmations",
    },
    lg: {
      classes: "min-w-[32rem]",
      description: "Large dialog for complex content",
    },
    xl: {
      classes: "min-w-[48rem]",
      description: "Extra large dialog for detailed views",
    },
  },
  role: {
    dialog: {
      classes: "",
      description: "Standard dialog for general-purpose modals",
    },
    alertdialog: {
      classes: "",
      description:
        "Alert dialog for confirmation flows requiring explicit user acknowledgment",
    },
  },
} as const;

export const KUMO_DIALOG_DEFAULT_VARIANTS = {
  size: "base",
  role: "dialog",
} as const;

export type KumoDialogSize = keyof typeof KUMO_DIALOG_VARIANTS.size;
export type KumoDialogRole = keyof typeof KUMO_DIALOG_VARIANTS.role;

export interface KumoDialogVariantsProps {
  size?: KumoDialogSize;
  role?: KumoDialogRole;
}

// ---------------------------------------------------------------------------
// Internal role context so sub-components know whether to use alertdialog
// ---------------------------------------------------------------------------

const DialogRoleContext = createContext<KumoDialogRole>(
  KUMO_DIALOG_DEFAULT_VARIANTS.role,
);

function useDialogRole(): KumoDialogRole {
  return useContext(DialogRoleContext);
}

// ---------------------------------------------------------------------------
// dialogVariants helper
// ---------------------------------------------------------------------------

export function dialogVariants({
  size = KUMO_DIALOG_DEFAULT_VARIANTS.size,
}: KumoDialogVariantsProps = {}): string {
  return cn(
    // Base styles — matches kumo chunk exactly
    "shadow-m fixed top-1/2 left-1/2 w-full sm:w-auto",
    "max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-3rem)]",
    "-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl",
    "bg-kumo-base text-kumo-default duration-150",
    "data-ending-style:scale-90 data-ending-style:opacity-0",
    "data-starting-style:scale-90 data-starting-style:opacity-0",
    // Size variant
    KUMO_DIALOG_VARIANTS.size[size].classes,
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type DialogProps = KumoDialogVariantsProps & {
  className?: string;
  children: ReactNode;
  style?: CSSProperties;
};

// ---------------------------------------------------------------------------
// DialogContent (the default export that forms the compound object)
// ---------------------------------------------------------------------------

function DialogContent({
  className,
  children,
  style,
  size = KUMO_DIALOG_DEFAULT_VARIANTS.size,
}: DialogProps) {
  const role = useDialogRole();
  return (
    <DialogBase.Portal>
      <DialogBase.Backdrop className="fixed inset-0 bg-kumo-overlay opacity-80 transition-all duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <DialogBase.Popup
        render={<div role={role} />}
        className={cn(dialogVariants({ size }), className)}
        style={
          {
            transitionProperty: "scale, opacity",
            transitionTimingFunction:
              "var(--default-transition-timing-function)",
            "--tw-shadow":
              "0 20px 25px -5px rgb(0 0 0 / 0.03), 0 8px 10px -6px rgb(0 0 0 / 0.03)",
            ...style,
          } as React.CSSProperties
        }
      >
        {children}
      </DialogBase.Popup>
    </DialogBase.Portal>
  );
}

// ---------------------------------------------------------------------------
// DialogRoot
// ---------------------------------------------------------------------------

type BaseDialogRootProps = ComponentPropsWithoutRef<typeof DialogBase.Root>;
export type DialogRootProps = Omit<BaseDialogRootProps, "onOpenChange"> & {
  role?: KumoDialogRole;
  onOpenChange?: (open: boolean) => void;
};

function DialogRoot({
  children,
  role = KUMO_DIALOG_DEFAULT_VARIANTS.role,
  onOpenChange,
  ...props
}: DialogRootProps) {
  // alertdialog: pointer-dismiss is disabled to match kumo behavior
  const disablePointerDismissal = role === "alertdialog";
  return (
    <DialogRoleContext.Provider value={role}>
      <DialogBase.Root
        {...props}
        disablePointerDismissal={disablePointerDismissal}
        onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
      >
        {children}
      </DialogBase.Root>
    </DialogRoleContext.Provider>
  );
}
DialogRoot.displayName = "Dialog.Root";

// ---------------------------------------------------------------------------
// DialogTrigger
// ---------------------------------------------------------------------------

type BaseDialogTriggerProps = ComponentPropsWithoutRef<
  typeof DialogBase.Trigger
>;
export type DialogTriggerProps = BaseDialogTriggerProps;

function DialogTrigger({ children, ...props }: DialogTriggerProps) {
  return <DialogBase.Trigger {...props}>{children}</DialogBase.Trigger>;
}
DialogTrigger.displayName = "Dialog.Trigger";

// ---------------------------------------------------------------------------
// DialogTitle
// ---------------------------------------------------------------------------

type BaseDialogTitleProps = ComponentPropsWithoutRef<typeof DialogBase.Title>;
export type DialogTitleProps = BaseDialogTitleProps;

function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <DialogBase.Title
      className={cn("text-lg font-semibold text-kumo-default", className)}
      {...props}
    />
  );
}
DialogTitle.displayName = "Dialog.Title";

// ---------------------------------------------------------------------------
// DialogDescription
// ---------------------------------------------------------------------------

type BaseDialogDescriptionProps = ComponentPropsWithoutRef<
  typeof DialogBase.Description
>;
export type DialogDescriptionProps = BaseDialogDescriptionProps;

function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <DialogBase.Description
      className={cn("text-sm text-kumo-subtle", className)}
      {...props}
    />
  );
}
DialogDescription.displayName = "Dialog.Description";

// ---------------------------------------------------------------------------
// DialogClose
// ---------------------------------------------------------------------------

type BaseDialogCloseProps = ComponentPropsWithoutRef<typeof DialogBase.Close>;
export type DialogCloseProps = BaseDialogCloseProps;

function DialogClose({ children, ...props }: DialogCloseProps) {
  return <DialogBase.Close {...props}>{children}</DialogBase.Close>;
}
DialogClose.displayName = "Dialog.Close";

// ---------------------------------------------------------------------------
// Compound Dialog export (mirrors kumo)
// ---------------------------------------------------------------------------

const Dialog = Object.assign(DialogContent, {
  Root: DialogRoot,
  Trigger: DialogTrigger,
  Title: DialogTitle,
  Description: DialogDescription,
  Close: DialogClose,
});

export {
  Dialog,
  DialogRoot,
  DialogTrigger,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
