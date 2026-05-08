// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import {
  Toasty,
  useToastManager,
  toastVariants,
  KUMO_TOAST_VARIANTS,
  KUMO_TOAST_DEFAULT_VARIANTS,
  ToastProvider,
} from "./toast";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A component that exposes the toast manager to the test via a callback. */
let capturedManager: ReturnType<typeof useToastManager> | null = null;

function ToastConsumer() {
  capturedManager = useToastManager();
  return <div data-testid="consumer" />;
}

function WithToasty({ children }: { children: React.ReactNode }) {
  return <Toasty>{children}</Toasty>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Toasty", () => {
  it("renders children", () => {
    render(
      <WithToasty>
        <span data-testid="child">Hello</span>
      </WithToasty>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("ToastProvider is an alias for Toasty", () => {
    expect(ToastProvider).toBe(Toasty);
  });
});

describe("useToastManager", () => {
  beforeEach(() => {
    capturedManager = null;
  });

  it("returns toast, add, dismiss, dismissAll functions", () => {
    render(
      <WithToasty>
        <ToastConsumer />
      </WithToasty>,
    );
    expect(typeof capturedManager!.toast).toBe("function");
    expect(typeof capturedManager!.add).toBe("function");
    expect(typeof capturedManager!.dismiss).toBe("function");
    expect(typeof capturedManager!.dismissAll).toBe("function");
  });

  it("toast() creates a toast in the region", async () => {
    render(
      <WithToasty>
        <ToastConsumer />
      </WithToasty>,
    );
    await act(async () => {
      capturedManager!.toast("Hello toast");
    });
    expect(screen.getByText("Hello toast")).toBeInTheDocument();
  });

  it("add() creates a toast via kumo-compatible API", async () => {
    render(
      <WithToasty>
        <ToastConsumer />
      </WithToasty>,
    );
    await act(async () => {
      capturedManager!.add({ title: "Draft saved!" });
    });
    expect(screen.getByText("Draft saved!")).toBeInTheDocument();
  });

  it("dismiss(id) removes a specific toast", async () => {
    render(
      <WithToasty>
        <ToastConsumer />
      </WithToasty>,
    );
    let id!: string;
    await act(async () => {
      id = capturedManager!.add({ title: "To be dismissed" });
    });
    expect(screen.getByText("To be dismissed")).toBeInTheDocument();
    await act(async () => {
      capturedManager!.dismiss(id);
    });
    expect(screen.queryByText("To be dismissed")).not.toBeInTheDocument();
  });

  it("dismissAll() removes all toasts", async () => {
    render(
      <WithToasty>
        <ToastConsumer />
      </WithToasty>,
    );
    await act(async () => {
      capturedManager!.add({ title: "Toast A" });
      capturedManager!.add({ title: "Toast B" });
    });
    expect(screen.getByText("Toast A")).toBeInTheDocument();
    expect(screen.getByText("Toast B")).toBeInTheDocument();
    await act(async () => {
      capturedManager!.dismissAll();
    });
    expect(screen.queryByText("Toast A")).not.toBeInTheDocument();
    expect(screen.queryByText("Toast B")).not.toBeInTheDocument();
  });

  it("toast() with variant=error returns a string id", async () => {
    render(
      <WithToasty>
        <ToastConsumer />
      </WithToasty>,
    );
    let id!: string;
    await act(async () => {
      id = capturedManager!.toast("Error!", { variant: "error" });
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("add() with error variant renders toast", async () => {
    render(
      <WithToasty>
        <ToastConsumer />
      </WithToasty>,
    );
    await act(async () => {
      capturedManager!.add({ title: "Something failed", variant: "error" });
    });
    expect(screen.getByText("Something failed")).toBeInTheDocument();
  });
});

describe("toastVariants", () => {
  it("returns default variant classes for no args (glassy green fill)", () => {
    // After the @cloudflare/kumo → @base-ui/react migration (commit 34ed2e4)
    // and the toast-style follow-ups (9508b1b plus the glass-fill restyle),
    // the default variant carries a richly-filled emerald background with
    // backdrop-blur — readable white text on top in any theme.
    const cls = toastVariants();
    expect(cls).toContain("bg-emerald-500/90");
    expect(cls).toContain("text-white");
  });

  it("returns error variant classes (glassy red fill)", () => {
    const cls = toastVariants({ variant: "error" });
    expect(cls).toContain("bg-rose-600/90");
    expect(cls).toContain("text-white");
  });

  it("KUMO_TOAST_DEFAULT_VARIANTS.variant is default", () => {
    expect(KUMO_TOAST_DEFAULT_VARIANTS.variant).toBe("default");
  });

  it("KUMO_TOAST_VARIANTS.variant has default + success + error + warning", () => {
    // Keep `default` and `success` distinct so callers can opt in to the
    // explicit success variant for clarity even though both use the same
    // visual treatment.
    expect(Object.keys(KUMO_TOAST_VARIANTS.variant)).toEqual([
      "default",
      "success",
      "error",
      "warning",
    ]);
  });
});
