// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// ClientsPanel — unified "Connected Agents" panel for /account.
//
// Fetches GET /api/users/me/clients (Phase 2 endpoint added by TASK-2.1) and
// renders each entry as a ClientRow.  Browser sessions are projected as
// kind='browser' clients by the API, so there is no separate Devices panel
// (D-PLAT-7).  This component resolves USR-anti-2 ("last login but no agents"
// UX confusion) by showing every client type in one unified list.

// TODO(post-integration): import shared types from workers/routes/clients.ts once shared types module exists
export interface ClientGrant {
  inbox_id: string;
  scope: "read" | "write";
  granted_at: number;
}

export interface Client {
  id: string;
  kind: "browser" | "mcp" | "ios" | "desktop" | "other";
  name: string;
  oauth_client_id: string | null;
  last_seen_at: number | null;
  ip_address: string | null;
  user_agent: string | null;
  revoked_at: number | null;
  created_at: number;
  is_current?: boolean;
  grants: ClientGrant[];
}

interface ClientsResponse {
  clients: Client[];
}

import { Button, Loader } from "~/ui";
import { DevicesIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useToastManager } from "~/ui";
import ClientRow from "./ClientRow";

export default function ClientsPanel() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const toastManager = useToastManager();

  const fetchClients = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/users/me/clients");
      if (!res.ok) throw new Error(`Failed to load clients: ${res.status}`);
      const data = (await res.json()) as ClientsResponse;
      setClients(data.clients);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchClients();
  }, [fetchClients]);

  const handleRevoke = useCallback(
    async (clientId: string) => {
      const res = await fetch(`/api/users/me/clients/${clientId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toastManager.add({
          title: "Failed to revoke client",
          variant: "error",
        });
        return;
      }
      toastManager.add({ title: "Client revoked" });
      await fetchClients();
    },
    [fetchClients, toastManager],
  );

  const handleGranted = useCallback(async () => {
    await fetchClients();
  }, [fetchClients]);

  const handleRevokeOthers = async () => {
    setRevokingOthers(true);
    try {
      const res = await fetch("/api/users/me/sessions/revoke-others", {
        method: "POST",
      });
      if (!res.ok) {
        toastManager.add({
          title: "Failed to sign out other sessions",
          variant: "error",
        });
        return;
      }
      toastManager.add({ title: "Other sessions signed out" });
      await fetchClients();
    } catch {
      toastManager.add({ title: "Network error", variant: "error" });
    } finally {
      setRevokingOthers(false);
    }
  };

  const nonCurrentCount = clients.filter(
    (c) => !c.is_current && !c.revoked_at,
  ).length;

  return (
    <section className="mb-6 rounded-panel border border-border bg-card p-6">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UsersThreeIcon
            size={18}
            weight="duotone"
            className="text-text-muted"
          />
          <h2 className="text-lg font-semibold text-text-bright">
            Connected Agents
          </h2>
          {!loading && clients.length > 0 && (
            <span className="rounded-full bg-border px-2 py-0.5 text-xs font-medium text-text-muted">
              {clients.filter((c) => !c.revoked_at).length}
            </span>
          )}
        </div>
        {nonCurrentCount > 0 && (
          <Button
            variant="ghost"
            onClick={() => void handleRevokeOthers()}
            disabled={revokingOthers}
          >
            {revokingOthers ? "Signing out…" : "Sign out other sessions"}
          </Button>
        )}
      </div>
      <p className="mb-4 text-sm text-text-muted">
        Browsers, MCP agents, and apps connected to your account. Revoke any you
        don't recognise.
      </p>

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader size="sm" />
        </div>
      ) : error ? (
        <p className="text-sm text-kumo-danger">{error}</p>
      ) : clients.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <DevicesIcon
            size={32}
            weight="duotone"
            className="text-text-muted opacity-50"
          />
          <p className="text-sm text-text-muted">
            No connected agents yet — sign in from another device or connect an
            MCP client.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {clients.map((client) => (
            <ClientRow
              key={client.id}
              client={client}
              isCurrent={!!client.is_current}
              onRevoke={handleRevoke}
              onGranted={handleGranted}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
