// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// CreateMailboxDialog — creates a personal mailbox via POST /api/mailboxes.
// Domain is HARDCODED to PRIMARY_MAIL_DOMAIN; the user types only the
// local-part (suffix is non-editable). A debounced GET to
// /api/mailboxes/availability gives instant feedback on uniqueness; the
// authoritative race-safe check still happens server-side via the
// mailboxes_address_nocase UNIQUE INDEX (POST returns 409 on conflict).

import { Button, Dialog, Input } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useEffect, useRef, useState } from "react";
import {
  PRIMARY_MAIL_DOMAIN,
  isValidLocalPart,
  composeAddress,
} from "../../../shared/mail-domain";

interface CreateMailboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

type Availability =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "taken" }
  | { state: "invalid" };

const DEBOUNCE_MS = 350;

export default function CreateMailboxDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateMailboxDialogProps) {
  const toastManager = useToastManager();
  const [localPart, setLocalPart] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<Availability>({
    state: "idle",
  });
  const checkSeq = useRef(0);

  const reset = () => {
    setLocalPart("");
    setDisplayName("");
    setError(null);
    setAvailability({ state: "idle" });
  };

  // Debounced availability ping — fires whenever localPart changes and is valid.
  useEffect(() => {
    const trimmed = localPart.trim().toLowerCase();
    if (!trimmed) {
      setAvailability({ state: "idle" });
      return;
    }
    if (!isValidLocalPart(trimmed)) {
      setAvailability({ state: "invalid" });
      return;
    }
    setAvailability({ state: "checking" });
    const seq = ++checkSeq.current;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/mailboxes/availability?local_part=${encodeURIComponent(
              trimmed,
            )}`,
          );
          if (seq !== checkSeq.current) return; // stale
          if (!res.ok) {
            setAvailability({ state: "idle" });
            return;
          }
          const data = (await res.json()) as {
            available: boolean;
            reason?: string;
          };
          if (seq !== checkSeq.current) return;
          if (data.available) setAvailability({ state: "available" });
          else if (data.reason === "invalid_local_part")
            setAvailability({ state: "invalid" });
          else setAvailability({ state: "taken" });
        } catch {
          if (seq !== checkSeq.current) return;
          setAvailability({ state: "idle" });
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [localPart]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = localPart.trim().toLowerCase();
    if (!trimmed || !isValidLocalPart(trimmed)) {
      setError(
        "Invalid local-part. Use a-z, 0-9, dots, underscores, plus or hyphen; no leading/trailing or consecutive dots.",
      );
      return;
    }
    if (availability.state === "taken") {
      setError("That address is already in use.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          local_part: trimmed,
          display_name: displayName.trim() || undefined,
        }),
      });
      if (res.ok) {
        toastManager.toast("Mailbox created.");
        reset();
        onCreated();
      } else if (res.status === 409) {
        setAvailability({ state: "taken" });
        setError("That address was just taken. Please choose another.");
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(data.error ?? "Failed to create mailbox.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const trimmed = localPart.trim().toLowerCase();
  const composed = trimmed ? composeAddress(trimmed) : "";
  const submitDisabled =
    submitting ||
    !trimmed ||
    availability.state === "invalid" ||
    availability.state === "taken" ||
    availability.state === "checking";

  let hint: { tone: "muted" | "danger" | "success"; text: string } | null =
    null;
  if (availability.state === "checking") {
    hint = { tone: "muted", text: "Checking availability…" };
  } else if (availability.state === "available") {
    hint = { tone: "success", text: `${composed} is available.` };
  } else if (availability.state === "taken") {
    hint = { tone: "danger", text: `${composed} is already in use.` };
  } else if (availability.state === "invalid") {
    hint = {
      tone: "danger",
      text: "Invalid local-part. Use a-z, 0-9, . _ + - (no leading/trailing or consecutive dots).",
    };
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!submitting) {
          if (!o) reset();
          onOpenChange(o);
        }
      }}
    >
      <Dialog size="base">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="px-6 pt-6 pb-2">
            <Dialog.Title>New mailbox</Dialog.Title>
            <Dialog.Description className="mt-1">
              Create a personal mailbox on @{PRIMARY_MAIL_DOMAIN}. Share it with
              a group later from the mailbox tree.
            </Dialog.Description>
          </div>

          <div className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-text-bright">
                Email address{" "}
                <span aria-hidden="true" className="text-kumo-danger">
                  *
                </span>
              </p>
              <div className="flex items-stretch overflow-hidden rounded-md border border-border focus-within:border-kumo-accent">
                <Input
                  className="flex-1 border-none rounded-none focus:ring-0"
                  placeholder="local-part"
                  value={localPart}
                  onChange={(e) => {
                    setLocalPart(e.target.value);
                    if (error) setError(null);
                  }}
                  aria-invalid={
                    availability.state === "invalid" ||
                    availability.state === "taken"
                      ? "true"
                      : undefined
                  }
                  disabled={submitting}
                  autoFocus
                />
                <span
                  className="flex items-center px-3 text-sm text-text-muted bg-surface-1 border-l border-border select-none"
                  aria-label="domain"
                >
                  @{PRIMARY_MAIL_DOMAIN}
                </span>
              </div>
              {hint && (
                <p
                  className={
                    hint.tone === "danger"
                      ? "text-sm text-kumo-danger"
                      : hint.tone === "success"
                        ? "text-sm text-kumo-success"
                        : "text-sm text-text-muted"
                  }
                >
                  {hint.text}
                </p>
              )}
              {error && !hint && (
                <p className="text-sm text-kumo-danger">{error}</p>
              )}
              {error && hint && (
                <p className="text-sm text-kumo-danger">{error}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-text-bright">
                Display name{" "}
                <span className="font-normal text-text-muted">(optional)</span>
              </p>
              <Input
                placeholder="Info"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Dialog.Close
              render={(props) => (
                <Button
                  {...props}
                  variant="ghost"
                  disabled={submitting}
                  type="button"
                >
                  Cancel
                </Button>
              )}
            />
            <Button variant="primary" disabled={submitDisabled} type="submit">
              {submitting ? "Creating…" : "Create mailbox"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
