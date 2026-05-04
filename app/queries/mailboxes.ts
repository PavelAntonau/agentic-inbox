// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Mailbox } from "~/types";
import { queryKeys } from "./keys";

/**
 * Normalise a raw mailbox record from /api/v1/mailboxes so that `name` is
 * always a non-empty string.  D1 mailboxes from the unified D1+R2 union
 * endpoint do not include a `name` field (only `email` + `address` +
 * `owner_user_id` + `kind`).  R2 legacy mailboxes always have `name`.
 */
function normalizeMailbox(raw: Mailbox): Mailbox {
  return {
    ...raw,
    name: raw.name || raw.email.split("@")[0] || raw.email,
  };
}

export function useMailboxes() {
  return useQuery<Mailbox[]>({
    queryKey: queryKeys.mailboxes.all,
    queryFn: async () => {
      const raw = (await api.listMailboxes()) as Mailbox[];
      return raw.map(normalizeMailbox);
    },
  });
}

export function useMailbox(mailboxId: string | undefined) {
  return useQuery<Mailbox>({
    queryKey: mailboxId
      ? queryKeys.mailboxes.detail(mailboxId)
      : ["mailboxes", "_disabled"],
    queryFn: () => api.getMailbox(mailboxId!) as Promise<Mailbox>,
    enabled: !!mailboxId,
  });
}

export function useCreateMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, name }: { email: string; name: string }) =>
      api.createMailbox(email, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
    },
  });
}

export function useUpdateMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      mailboxId,
      settings,
    }: {
      mailboxId: string;
      settings: unknown;
    }) => api.updateMailbox(mailboxId, settings),
    onSuccess: (_data, { mailboxId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
      qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
    },
  });
}

export function useDeleteMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mailboxId: string) => api.deleteMailbox(mailboxId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
    },
  });
}
