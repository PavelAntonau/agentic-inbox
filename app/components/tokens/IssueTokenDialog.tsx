// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// IssueTokenDialog — form for issuing a new agent token.
// Fields: label, max_instances, duration (chip presets).
// On success, switches to CopyTokenCard (one-time secret display).

import { Button, Dialog, Input } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";
import CopyTokenCard, { type NewTokenSecret } from "./CopyTokenCard";

interface IssueTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mailboxId: string;
  workspaceHost?: string;
  onIssued: () => void;
}

// Duration preset chips (OQ-V2U-4 resolved: default = 2160h / 90 days)
const DURATION_CHIPS = [
  { label: "30 d", value: "720h" },
  { label: "90 d (default)", value: "2160h" },
  { label: "1 y", value: "8760h" },
  { label: "forever", value: "87600h" },
] as const;

type DurationValue = (typeof DURATION_CHIPS)[number]["value"];

const DEFAULT_DURATION: DurationValue = "2160h";

export default function IssueTokenDialog({
  open,
  onOpenChange,
  mailboxId,
  workspaceHost,
  onIssued,
}: IssueTokenDialogProps) {
  const toastManager = useToastManager();

  const [label, setLabel] = useState("");
  const [maxInstances, setMaxInstances] = useState(1);
  const [duration, setDuration] = useState<DurationValue>(DEFAULT_DURATION);
  const [isIssuing, setIsIssuing] = useState(false);
  const [newToken, setNewToken] = useState<NewTokenSecret | null>(null);

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      // Reset form state on close
      setLabel("");
      setMaxInstances(1);
      setDuration(DEFAULT_DURATION);
      setIsIssuing(false);
      setNewToken(null);
    }
    onOpenChange(nextOpen);
  };

  const handleIssue = async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      toastManager.add({ title: "Label is required", variant: "error" });
      return;
    }
    setIsIssuing(true);
    try {
      const res = await fetch(`/api/tokens/mailboxes/${mailboxId}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: trimmedLabel,
          max_instances: maxInstances,
          duration,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toastManager.add({
          title: data.error ?? "Failed to issue token",
          variant: "error",
        });
        return;
      }
      const data = (await res.json()) as { token: NewTokenSecret };
      setNewToken(data.token);
      onIssued();
    } catch {
      toastManager.add({ title: "Failed to issue token", variant: "error" });
    } finally {
      setIsIssuing(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog size="lg" className="p-6">
        {newToken ? (
          // Copy-card phase — one-time secret reveal
          <>
            <Dialog.Title className="text-base font-semibold mb-4">
              Token Issued — Save Your Secret
            </Dialog.Title>
            <CopyTokenCard token={newToken} workspaceHost={workspaceHost} />
            <div className="flex justify-end mt-4">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="primary" size="sm" type="button">
                    Done
                  </Button>
                )}
              />
            </div>
          </>
        ) : (
          // Issue form phase
          <>
            <Dialog.Title className="text-base font-semibold mb-4">
              Issue Agent Token
            </Dialog.Title>

            <div className="flex flex-col gap-4">
              {/* Label */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="token-label"
                  className="text-sm font-medium text-kumo-default"
                >
                  Label
                </label>
                <Input
                  id="token-label"
                  placeholder="e.g. claude-code-local"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  autoFocus
                />
              </div>

              {/* Max instances */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="token-max-instances"
                  className="text-sm font-medium text-kumo-default"
                >
                  Max concurrent instances
                </label>
                <Input
                  id="token-max-instances"
                  type="number"
                  min={1}
                  max={20}
                  value={String(maxInstances)}
                  onChange={(e) =>
                    setMaxInstances(
                      Math.max(1, parseInt(e.target.value, 10) || 1),
                    )
                  }
                />
                <p className="text-xs text-kumo-subtle">
                  Maximum simultaneous agent processes that can use this token
                  (1–20).
                </p>
              </div>

              {/* Duration chips */}
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium text-kumo-default">
                  Token lifetime
                </p>
                <div className="flex flex-wrap gap-2">
                  {DURATION_CHIPS.map((chip) => (
                    <button
                      key={chip.value}
                      type="button"
                      onClick={() => setDuration(chip.value)}
                      className={[
                        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                        duration === chip.value
                          ? "border-kumo-brand bg-kumo-brand text-white"
                          : "border-kumo-line bg-kumo-base text-kumo-default hover:border-kumo-ring",
                      ].join(" ")}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Dialog.Close
                render={(props) => (
                  <Button
                    {...props}
                    variant="secondary"
                    size="sm"
                    type="button"
                  >
                    Cancel
                  </Button>
                )}
              />
              <Button
                variant="primary"
                size="sm"
                loading={isIssuing}
                onClick={handleIssue}
              >
                Issue Token
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
