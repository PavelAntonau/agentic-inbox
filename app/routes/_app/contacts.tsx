// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Contacts page — pending requests, accepted contacts, blocked users tabs.

import { Button, Loader } from "~/ui";
import { PlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import ContactRow, { type Contact } from "~/components/contacts/ContactRow";
import SendContactRequestDialog from "~/components/contacts/SendContactRequestDialog";

type Tab = "all" | "sent" | "incoming" | "accepted" | "blocked";

export function meta() {
  return [{ title: "Contacts | Agentic Inbox" }];
}

interface ContactsApiResponse {
  contacts: Contact[];
}

interface MeResponse {
  user_id: string;
  role: string;
}

export default function ContactsRoute() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [sendOpen, setSendOpen] = useState(false);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [meRes, contactsRes] = await Promise.all([
        fetch("/api/admin/me"),
        fetch("/api/contacts"),
      ]);
      if (meRes.ok) {
        const me = (await meRes.json()) as MeResponse;
        setActorUserId(me.user_id);
      }
      if (!contactsRes.ok) {
        throw new Error(`Failed to load contacts: ${contactsRes.status}`);
      }
      const data = (await contactsRes.json()) as ContactsApiResponse;
      setContacts(data.contacts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchContacts();
  }, [fetchContacts]);

  // Sent = outgoing pending requests (initiated_by = me).
  // Incoming = pending requests addressed to me (initiated_by != me).
  // Phase 5 / D12: outgoing rows stay 'pending' forever from the sender's view
  // even if the recipient declined — declined rows are filtered server-side
  // out of the recipient's listing only.
  const isSent = (c: Contact) =>
    c.status === "pending" && c.initiated_by === actorUserId;
  const isIncoming = (c: Contact) =>
    c.status === "pending" && c.initiated_by !== actorUserId;

  const counts = {
    all: contacts.length,
    sent: contacts.filter(isSent).length,
    incoming: contacts.filter(isIncoming).length,
    accepted: contacts.filter((c) => c.status === "accepted").length,
    blocked: contacts.filter((c) => c.status === "blocked").length,
  };

  const filtered = (() => {
    if (tab === "all") return contacts;
    if (tab === "sent") return contacts.filter(isSent);
    if (tab === "incoming") return contacts.filter(isIncoming);
    return contacts.filter((c) => c.status === tab);
  })();

  const TABS: { id: Tab; label: string }[] = [
    { id: "all", label: `All (${counts.all})` },
    { id: "sent", label: `Sent (${counts.sent})` },
    { id: "incoming", label: `Incoming (${counts.incoming})` },
    { id: "accepted", label: `Accepted (${counts.accepted})` },
    { id: "blocked", label: `Blocked (${counts.blocked})` },
  ];

  return (
    <div className="max-w-3xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-text-bright">Contacts</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Manage your contact requests, accepted contacts, and blocked users.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon size={16} />}
          onClick={() => setSendOpen(true)}
        >
          Send request
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={[
              "px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
              tab === t.id
                ? "border-kumo-brand text-text-bright"
                : "border-transparent text-text-muted hover:text-text",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-20">
          <Loader size="lg" />
        </div>
      )}

      {error && (
        <p className="text-sm text-kumo-danger py-4 text-center">{error}</p>
      )}

      {!loading && !error && (
        <div className="rounded-lg border border-border bg-card px-5">
          {filtered.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-12">
              {tab === "sent" && "No outgoing requests."}
              {tab === "incoming" && "No incoming requests."}
              {tab === "accepted" && "No accepted contacts yet."}
              {tab === "blocked" && "No blocked users."}
              {tab === "all" &&
                "You have no contacts yet. Click 'Send request' to add one."}
            </p>
          ) : (
            filtered.map((contact) => (
              <ContactRow
                key={`${contact.owner_user_id}-${contact.contact_user_id}`}
                contact={contact}
                actorUserId={actorUserId ?? ""}
                onMutated={() => void fetchContacts()}
              />
            ))
          )}
        </div>
      )}

      <SendContactRequestDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        onRequestSent={() => {
          setSendOpen(false);
          void fetchContacts();
        }}
      />
    </div>
  );
}
