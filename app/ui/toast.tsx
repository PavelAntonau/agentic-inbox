// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from kumo Toasty + useKumoToastManager (shadcn pattern — source in app/ui/).
// Preserves the exact public API so consumer files need only an import-path change.
// Hook is named useToastManager (not useKumoToastManager — that name belongs to kumo).

import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Variant tables (mirrors KUMO_TOAST_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_TOAST_VARIANTS = {
  root: {
    classes:
      "rounded-lg border border-kumo-fill bg-kumo-control p-4 shadow-lg text-kumo-default",
    description: "Toast container with background, border, and shadow",
  },
  title: {
    classes: "text-[0.975rem] leading-5 font-medium text-kumo-default",
    description: "Toast title with primary text color",
  },
  description: {
    classes: "text-[0.925rem] leading-5 text-kumo-subtle",
    description: "Toast description with muted text color",
  },
  close: {
    classes:
      "absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded border-none bg-transparent text-kumo-subtle hover:bg-kumo-fill-hover hover:text-kumo-strong",
    description: "Close button with X icon",
  },
  variant: {
    default: {
      classes: "border-kumo-fill bg-kumo-control",
      description: "Default toast style",
    },
    error: {
      classes:
        "border-kumo-fill bg-kumo-control [&_[data-toast-icon]]:text-[light-dark(var(--color-red-600),var(--color-red-400))] [&_[data-toast-title]]:text-[light-dark(var(--color-red-600),var(--color-red-400))]",
      description: "Error toast for critical issues",
    },
    warning: {
      classes:
        "border-kumo-fill bg-kumo-control [&_[data-toast-icon]]:text-[light-dark(var(--color-amber-700),var(--color-amber-500))] [&_[data-toast-title]]:text-[light-dark(var(--color-amber-700),var(--color-amber-500))]",
      description: "Warning toast for cautionary messages",
    },
  },
} as const;

export const KUMO_TOAST_DEFAULT_VARIANTS = {
  variant: "default",
} as const;

export type KumoToastVariant = keyof typeof KUMO_TOAST_VARIANTS.variant;

export interface KumoToastVariantsProps {
  variant?: KumoToastVariant;
}

export function toastVariants({
  variant = KUMO_TOAST_DEFAULT_VARIANTS.variant,
}: KumoToastVariantsProps = {}): string {
  return cn(KUMO_TOAST_VARIANTS.variant[variant].classes);
}

// ---------------------------------------------------------------------------
// ToastData — the per-toast payload stored in base-ui state
// ---------------------------------------------------------------------------

export interface ToastData {
  variant?: KumoToastVariant;
  description?: ReactNode;
}

// ---------------------------------------------------------------------------
// useToastManager — drop-in replacement for useKumoToastManager
// Returns { toast, add, dismiss, dismissAll } where:
//   toast(title, opts)  — creates a toast, returns its id
//   add({ title, variant?, description? }) — kumo-compatible alias
//   dismiss(id?)        — closes a specific or all toasts
//   dismissAll()        — closes all toasts
// ---------------------------------------------------------------------------

export function useToastManager() {
  const manager = Toast.useToastManager<ToastData>();

  function add(opts: {
    title?: ReactNode;
    variant?: KumoToastVariant;
    description?: ReactNode;
    duration?: number;
    bump?: boolean;
  }): string {
    return manager.add({
      title: opts.title,
      description: opts.description,
      timeout: opts.duration ?? 5000,
      type: opts.variant ?? "default",
      data: {
        variant: opts.variant,
        description: opts.description,
      },
    });
  }

  function toast(
    title: ReactNode,
    opts: {
      variant?: KumoToastVariant;
      description?: ReactNode;
      duration?: number;
    } = {},
  ): string {
    return add({ title, ...opts });
  }

  function dismiss(id?: string): void {
    manager.close(id);
  }

  function dismissAll(): void {
    manager.close();
  }

  return { toast, add, dismiss, dismissAll };
}

// ---------------------------------------------------------------------------
// ToastList — renders all active toasts inside the Viewport
// ---------------------------------------------------------------------------

function ToastList() {
  const { toasts } = Toast.useToastManager<ToastData>();
  return toasts.map((t) => (
    <Toast.Root
      key={t.id}
      toast={t}
      className={cn(
        // Stacking / animation classes from kumo chunk
        "absolute right-0 bottom-0 left-auto z-[calc(1000-var(--toast-index))] mr-0 h-[var(--height)] w-full origin-bottom select-none",
        toastVariants({ variant: t.data?.variant }),
        "[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
        "[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_0.5s_cubic-bezier(0.22,1,0.36,1),opacity_0.5s,height_0.15s]",
        "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-[ending-style]:opacity-0 data-[expanded]:h-[var(--toast-height)] data-[expanded]:[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--offset-y)))] data-[limited]:opacity-0 data-[starting-style]:[transform:translateY(150%)]",
      )}
    >
      {/* Glass backing — matches kumo */}
      <div className="absolute inset-0 rounded-[11px] bg-kumo-control/90" />
      <Toast.Content className="isolate flex flex-col gap-1 transition-opacity [transition-duration:250ms] data-[behind]:pointer-events-none data-[behind]:opacity-0 data-[expanded]:pointer-events-auto data-[expanded]:opacity-100">
        <div className="flex items-start gap-2">
          <div className="flex flex-col gap-1 overflow-hidden">
            <Toast.Title
              data-toast-title
              className="text-[0.975rem] leading-5 font-medium text-kumo-default"
            />
            <Toast.Description className="text-[0.925rem] leading-5 text-kumo-subtle" />
          </div>
        </div>
        <Toast.Close
          className="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded border-none bg-transparent text-current/50 hover:bg-kumo-contrast/10 hover:text-current"
          aria-label="Close"
        >
          <svg
            className="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}

// ---------------------------------------------------------------------------
// Toasty — provider + viewport. Wrap the app once.
// ---------------------------------------------------------------------------

export interface ToastyProps {
  children: ReactNode;
  variant?: KumoToastVariant;
}

export function Toasty({ children }: ToastyProps) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed top-auto right-4 bottom-4 z-1 mx-auto flex w-[calc(100%-2rem)] sm:right-8 sm:bottom-8 sm:w-[340px]">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

/** Alias for Toasty — provided for discoverability when migrating from other libraries */
export const ToastProvider = Toasty;
