// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from @cloudflare/kumo Pagination (shadcn pattern — source in app/ui/).
// Preserves the convenience-form public API used by all current consumers:
// `<Pagination page setPage perPage totalCount text? controls? className? />`.
// Compound subcomponents (.Info / .PageSize / .Controls / .Separator) are
// not yet ported — they depend on kumo Select + InputGroup; defer until a
// consumer needs them. The current consumers (email-list, search-results)
// use only the convenience form.

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  CaretDoubleLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretDoubleRightIcon,
} from "@phosphor-icons/react";
import { cn } from "~/ui/lib/cn";
import { Button } from "~/ui/button";
import { Input } from "~/ui/input";

// ---------------------------------------------------------------------------
// Defaults (mirrors kumo)
// ---------------------------------------------------------------------------

export const KUMO_PAGINATION_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

export const KUMO_PAGINATION_DEFAULTS = {
  controls: "full" as const,
};

export type KumoPaginationControls = "full" | "minimal";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PaginationTextRenderArgs {
  page: number;
  perPage: number;
  totalCount: number;
  pageShowingRange: string;
}

export interface PaginationProps {
  /** Current 1-indexed page. */
  page?: number;
  /** Items per page. */
  perPage: number;
  /** Total item count across all pages. */
  totalCount: number;
  /** Set the current page (caller-owned state). */
  setPage: (page: number) => void;
  /** Override the default "Showing X-Y of Z" info text. */
  text?: (args: PaginationTextRenderArgs) => ReactNode;
  /** `"full"` = first/last buttons + page input; `"minimal"` = prev/next only. */
  controls?: KumoPaginationControls;
  /** Additional CSS classes. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Pagination component (convenience form)
// ---------------------------------------------------------------------------

export function Pagination({
  page = 1,
  perPage,
  totalCount,
  setPage,
  text,
  controls = KUMO_PAGINATION_DEFAULTS.controls,
  className,
}: PaginationProps) {
  const [editingPage, setEditingPage] = useState(page);

  useEffect(() => {
    setEditingPage(page);
  }, [page]);

  const pageShowingRange = useMemo(() => {
    let start = page * perPage - perPage + 1;
    let end = Math.min(page * perPage, totalCount);
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end)) end = 0;
    return `${start}-${end}`;
  }, [page, perPage, totalCount]);

  const maxPage = useMemo(
    () => Math.max(1, Math.ceil(totalCount / Math.max(perPage, 1))),
    [totalCount, perPage],
  );

  const goTo = (next: number) => {
    const clamped = Math.min(Math.max(next, 1), maxPage);
    setPage(clamped);
    setEditingPage(clamped);
  };

  const infoNode: ReactNode = text ? (
    text({ page, perPage, totalCount, pageShowingRange })
  ) : totalCount > 0 ? (
    <>
      Showing <span className="tabular-nums">{pageShowingRange}</span> of{" "}
      <span className="tabular-nums">{totalCount}</span>
    </>
  ) : null;

  return (
    <div
      data-slot="pagination"
      className={cn("flex items-center gap-2 w-full", className)}
    >
      <div
        data-slot="pagination-info"
        className="grow text-sm text-kumo-strong"
      >
        {infoNode}
      </div>
      <div data-slot="pagination-controls" className="flex items-center gap-1">
        {controls === "full" && (
          <Button
            variant="secondary"
            aria-label="First page"
            disabled={page <= 1}
            onClick={() => goTo(1)}
          >
            <CaretDoubleLeftIcon size={16} />
          </Button>
        )}
        <Button
          variant="secondary"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => goTo(page - 1)}
        >
          <CaretLeftIcon size={16} />
        </Button>
        {controls === "full" && (
          <Input
            style={{ width: 50 }}
            className="text-center"
            aria-label="Page number"
            placeholder="Page"
            value={String(editingPage)}
            onChange={(e) => {
              const next = Number(e.currentTarget.value);
              if (!Number.isNaN(next)) setEditingPage(next);
            }}
            onBlur={() => goTo(editingPage)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goTo(editingPage);
            }}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
          />
        )}
        <Button
          variant="secondary"
          aria-label="Next page"
          disabled={page >= maxPage}
          onClick={() => goTo(page + 1)}
        >
          <CaretRightIcon size={16} />
        </Button>
        {controls === "full" && (
          <Button
            variant="secondary"
            aria-label="Last page"
            disabled={page >= maxPage}
            onClick={() => goTo(maxPage)}
          >
            <CaretDoubleRightIcon size={16} />
          </Button>
        )}
      </div>
    </div>
  );
}

Pagination.displayName = "Pagination";
