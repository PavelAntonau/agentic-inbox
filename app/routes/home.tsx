// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  Button,
  Dialog,
  Input,
  Loader,
  Select,
  Text,
  useToastManager,
} from "~/ui";
import { PlusIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import api from "~/services/api";
import { useCreateMailbox, useMailboxes } from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import ComposeIcon from "~/components/branding/ComposeIcon";

export function meta() {
  return [{ title: "Agentic Inbox" }];
}

export default function HomeRoute() {
  const toastManager = useToastManager();
  const {
    data: mailboxes = [],
    refetch: refetchMailboxes,
    isFetched: mailboxesFetched,
  } = useMailboxes();
  const createMailbox = useCreateMailbox();

  const { data: configData } = useQuery({
    queryKey: queryKeys.config,
    queryFn: () => api.getConfig(),
    staleTime: Infinity, // config rarely changes
  });

  const domains = configData?.domains ?? [];
  const emailAddresses = configData?.emailAddresses ?? [];

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newPrefix, setNewPrefix] = useState("");
  const [selectedDomain, setSelectedDomain] = useState("");
  const [newName, setNewName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Set default domain when config loads
  useEffect(() => {
    if (domains.length > 0 && !selectedDomain) {
      setSelectedDomain(domains[0]);
    }
  }, [domains, selectedDomain]);

  // Auto-create mailboxes from config (run once when both data sources are ready)
  const autoCreateDone = useRef(false);
  useEffect(() => {
    if (autoCreateDone.current) return;
    if (emailAddresses.length === 0 || !mailboxesFetched) return;
    const existingEmails = new Set(mailboxes.map((m) => m.email.toLowerCase()));
    const toCreate = emailAddresses.filter(
      (addr) => !existingEmails.has(addr.toLowerCase()),
    );
    if (toCreate.length === 0) {
      autoCreateDone.current = true;
      return;
    }
    autoCreateDone.current = true;
    let cancelled = false;
    Promise.all(
      toCreate.map((addr) => {
        const localPart = addr.split("@")[0] || addr;
        return api.createMailbox(addr, localPart).catch(() => {});
      }),
    ).then(() => {
      if (!cancelled) refetchMailboxes();
    });
    return () => {
      cancelled = true;
    };
  }, [emailAddresses, mailboxes, refetchMailboxes]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    if (!newPrefix || !selectedDomain) {
      setCreateError("Please fill in all fields");
      return;
    }
    const email = `${newPrefix}@${selectedDomain}`;
    const name = newName || newPrefix;
    setIsCreating(true);
    try {
      await createMailbox.mutateAsync({ email, name });
      toastManager.add({ title: "Mailbox created successfully!" });
      setIsCreateOpen(false);
      setNewPrefix("");
      setNewName("");
    } catch (err: unknown) {
      const message =
        (err instanceof Error ? err.message : null) ||
        "Failed to create mailbox";
      setCreateError(message);
    } finally {
      setIsCreating(false);
    }
  };

  const isConfigured = emailAddresses.length > 0;
  const isLoading = !configData;

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 md:py-16">
        {/* Mailboxes are shown exclusively in the sidebar via MailboxTreeRail.
            This page is the welcome / empty state seen when no mailbox is open.
            The mid-page account list was removed in Phase 2 (TASK-2.4) to avoid
            duplicating the sidebar tree. */}

        {isLoading ? (
          <div className="flex justify-center py-20">
            <Loader size="lg" />
          </div>
        ) : (
          <div className="rounded-panel border border-border bg-card py-20 px-10 md:px-12">
            <div className="flex flex-col items-center text-center">
              {/* Brand robot pair — the mailbox-as-robot mark belongs on the
                  central welcome island, not on the rail buttons (UAT
                  round-3 directive). Two robots, mirrored, evoke the
                  "agent + inbox" pairing the product is about. */}
              <div className="mb-5 flex items-end justify-center gap-3">
                <ComposeIcon size={56} className="opacity-90" />
                <ComposeIcon size={56} className="opacity-90 -scale-x-100" />
              </div>
              {/* Show Create CTA only when there are no mailboxes yet and the
                  app is not in managed-address mode. */}
              {!isConfigured && mailboxes.length === 0 && (
                <div className="mb-6">
                  <Button
                    variant="primary"
                    icon={<PlusIcon size={16} />}
                    onClick={() => setIsCreateOpen(true)}
                  >
                    Create Mailbox
                  </Button>
                </div>
              )}
              <h3 className="text-lg font-semibold text-text-bright mb-1.5">
                {mailboxes.length > 0 ? "Select a mailbox" : "No mailboxes yet"}
              </h3>
              <p className="italic text-sm text-text-muted max-w-md">
                {mailboxes.length > 0
                  ? "Choose a mailbox from the sidebar to start reading your email."
                  : isConfigured
                    ? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
                    : "Create a mailbox to start sending and receiving emails with your domain."}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <Dialog size="sm" className="p-6">
          <Dialog.Title className="text-base font-semibold mb-5">
            Create New Mailbox
          </Dialog.Title>
          <form onSubmit={handleCreate} className="space-y-4">
            {createError && (
              <Text variant="error" size="sm">
                {createError}
              </Text>
            )}
            <div>
              <span className="text-sm font-medium text-text-bright mb-1.5 block">
                Email Address
              </span>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Input
                    aria-label="Address prefix"
                    placeholder="info"
                    size="sm"
                    value={newPrefix}
                    onChange={(e) => setNewPrefix(e.target.value)}
                    required
                  />
                </div>
                <span className="text-sm text-text-muted">@</span>
                {domains.length > 1 ? (
                  <div className="flex-1">
                    <Select
                      aria-label="Domain"
                      value={selectedDomain}
                      onValueChange={(value) => {
                        if (value) setSelectedDomain(value);
                      }}
                    >
                      {domains.map((d) => (
                        <Select.Option key={d} value={d}>
                          {d}
                        </Select.Option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <span className="text-sm text-text-muted">
                    {selectedDomain || "no domain"}
                  </span>
                )}
              </div>
            </div>
            <Input
              label="Display Name (optional)"
              placeholder="Info"
              size="sm"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="secondary" size="sm">
                    Cancel
                  </Button>
                )}
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={isCreating}
                disabled={!selectedDomain}
              >
                Create
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
