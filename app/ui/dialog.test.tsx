// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  Dialog,
  DialogRoot,
  DialogTrigger,
  DialogTitle,
  DialogDescription,
  DialogClose,
  dialogVariants,
  KUMO_DIALOG_VARIANTS,
  KUMO_DIALOG_DEFAULT_VARIANTS,
} from "./dialog";

// Minimal controlled wrapper for dialog tests
function TestDialog({
  open,
  onOpenChange,
  size,
  role,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: "base" | "sm" | "lg" | "xl";
  role?: "dialog" | "alertdialog";
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} role={role}>
      <Dialog.Trigger data-testid="trigger">Open</Dialog.Trigger>
      <Dialog size={size}>
        <Dialog.Title>Test Title</Dialog.Title>
        <Dialog.Description>Test description</Dialog.Description>
        <Dialog.Close data-testid="close-btn">Close</Dialog.Close>
      </Dialog>
    </Dialog.Root>
  );
}

describe("Dialog", () => {
  it("renders trigger", () => {
    render(<TestDialog />);
    expect(screen.getByTestId("trigger")).toBeInTheDocument();
  });

  it("does not render dialog content when closed", () => {
    render(<TestDialog open={false} />);
    expect(screen.queryByText("Test Title")).not.toBeInTheDocument();
  });

  it("renders dialog content when open", () => {
    render(<TestDialog open={true} />);
    expect(screen.getByText("Test Title")).toBeInTheDocument();
    expect(screen.getByText("Test description")).toBeInTheDocument();
  });

  it("calls onOpenChange when trigger is clicked", () => {
    const onOpenChange = vi.fn();
    render(<TestDialog open={false} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("trigger"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("calls onOpenChange when close button is clicked", () => {
    const onOpenChange = vi.fn();
    render(<TestDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("close-btn"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Title has semantic heading role", () => {
    render(<TestDialog open={true} />);
    expect(
      screen.getByRole("heading", { name: "Test Title" }),
    ).toBeInTheDocument();
  });

  it("applies size=sm variant class", () => {
    render(<TestDialog open={true} size="sm" />);
    const popup = document
      .querySelector('[role="dialog"]')
      ?.parentElement?.querySelector(".min-w-72");
    expect(popup).toBeTruthy();
  });

  it("sets alertdialog role when role=alertdialog", () => {
    render(<TestDialog open={true} role="alertdialog" />);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("forwards className to popup", () => {
    render(
      <Dialog.Root open={true}>
        <Dialog className="custom-dialog-class">
          <Dialog.Title>Hello</Dialog.Title>
        </Dialog>
      </Dialog.Root>,
    );
    // The popup element should have the custom class
    const title = screen.getByText("Hello");
    const popup = title.closest(".custom-dialog-class");
    expect(popup).toBeTruthy();
  });

  it("dialogVariants includes base style for default size", () => {
    const cls = dialogVariants();
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("bg-kumo-base");
  });

  it("KUMO_DIALOG_DEFAULT_VARIANTS has expected defaults", () => {
    expect(KUMO_DIALOG_DEFAULT_VARIANTS.size).toBe("base");
    expect(KUMO_DIALOG_DEFAULT_VARIANTS.role).toBe("dialog");
  });

  it("KUMO_DIALOG_VARIANTS contains all four sizes", () => {
    expect(Object.keys(KUMO_DIALOG_VARIANTS.size)).toEqual([
      "base",
      "sm",
      "lg",
      "xl",
    ]);
  });

  it("named exports DialogRoot, DialogTrigger etc. work standalone", () => {
    const onOpenChange = vi.fn();
    render(
      <DialogRoot open={false} onOpenChange={onOpenChange}>
        <DialogTrigger data-testid="dt">Open</DialogTrigger>
        <Dialog>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Desc</DialogDescription>
          <DialogClose data-testid="dc">Close</DialogClose>
        </Dialog>
      </DialogRoot>,
    );
    fireEvent.click(screen.getByTestId("dt"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
