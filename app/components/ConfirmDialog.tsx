// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// ConfirmDialog — drop-in replacement for window.confirm()
//
// Phase F (one-inbox-one-client, 2026-05-06): native window.confirm /
// window.alert / window.prompt look unstyled, render outside the app's
// kumo theme, and on Safari iOS they steal the lock screen for a beat.
// This primitive gives the app a single confirm modal that follows the
// kumo Dialog style (built on @base-ui/react/dialog via ~/ui/dialog) and
// supports a destructive variant for delete-this-thing flows.
//
// Two usage patterns:
//
//   1. Imperative — `const confirm = useConfirm(); if (await confirm({…}))`
//      Drop-in for `window.confirm`. Returns a Promise<boolean> so any
//      handler that previously branched on `if (window.confirm(...))`
//      can switch to `if (await confirm({...}))` with no other change.
//      Requires `<ConfirmDialogProvider>` mounted at app root (root.tsx
//      handles this).
//
//   2. Declarative — `<ConfirmDialog open onOpenChange title body …/>`
//      Useful when the call site already manages open/close state and
//      wants to embed the dialog inline. Less common; the imperative
//      hook is the headline for the 9 confirm-replacement sites.

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { Button, Dialog } from "~/ui";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  /** Modal heading (renders as `<Dialog.Title>`). Required. */
  title: string;
  /** Optional supporting copy below the title. */
  body?: ReactNode;
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * When true, the confirm button uses the `danger` variant — used for
   * delete / leave-group / discard-draft type actions. Defaults to false.
   */
  destructive?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the confirm button is clicked. */
  onConfirm: () => void;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Imperative hook + provider
// ---------------------------------------------------------------------------

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (result: boolean) => void;
}

/**
 * Hook returning a `confirm(options): Promise<boolean>` function that
 * shows the dialog and resolves to `true` on confirm, `false` on cancel
 * (incl. backdrop click / Escape / browser back). Must be used inside
 * a `<ConfirmDialogProvider>` subtree (root.tsx mounts the provider at
 * app-root scope).
 */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) {
    throw new Error(
      "useConfirm must be called inside a <ConfirmDialogProvider>",
    );
  }
  return fn;
}

/**
 * Provider that mounts a single ConfirmDialog instance and exposes
 * `useConfirm` to any descendant. Place at app root above any consumer.
 */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, resolve });
      }),
    [],
  );

  const close = useCallback((result: boolean) => {
    setPending((current) => {
      if (current) current.resolve(result);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) close(false);
          }}
          title={pending.title}
          body={pending.body}
          confirmLabel={pending.confirmLabel}
          cancelLabel={pending.cancelLabel}
          destructive={pending.destructive}
          onConfirm={() => close(true)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Declarative component
// ---------------------------------------------------------------------------

/**
 * Confirm modal. The provider mounts one of these on demand for the
 * imperative `useConfirm()` path; call sites that already have local
 * open/close state can render this directly.
 *
 * Uses `role="alertdialog"` — base-ui adds the proper ARIA semantics
 * for "explicit user acknowledgment required" flows (focus trap on
 * confirm + cancel only, no implicit dismiss on outside click for
 * destructive actions).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
      <Dialog size="sm">
        <div className="px-6 pt-6 pb-2">
          <Dialog.Title>{title}</Dialog.Title>
          {body !== undefined && body !== null && (
            <Dialog.Description className="mt-1">{body}</Dialog.Description>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="ghost" type="button">
                {cancelLabel}
              </Button>
            )}
          />
          <Button
            variant={destructive ? "destructive" : "primary"}
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
