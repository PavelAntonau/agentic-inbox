// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  Pagination,
  KUMO_PAGINATION_DEFAULTS,
  KUMO_PAGINATION_PAGE_SIZE_OPTIONS,
} from "./pagination";

describe("Pagination", () => {
  it("renders default 'Showing X-Y of Z' info row", () => {
    render(
      <Pagination page={1} perPage={25} totalCount={100} setPage={() => {}} />,
    );
    expect(screen.getByText(/Showing/)).toBeInTheDocument();
    expect(screen.getByText("1-25")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
  });

  it("renders no info text when totalCount=0", () => {
    render(
      <Pagination page={1} perPage={25} totalCount={0} setPage={() => {}} />,
    );
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it("renders custom text via render-prop", () => {
    render(
      <Pagination
        page={2}
        perPage={10}
        totalCount={50}
        setPage={() => {}}
        text={({ pageShowingRange, totalCount }) =>
          `${pageShowingRange} of ${totalCount}`
        }
      />,
    );
    expect(screen.getByText("11-20 of 50")).toBeInTheDocument();
  });

  it("disables First/Previous on page 1", () => {
    render(
      <Pagination page={1} perPage={25} totalCount={100} setPage={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
  });

  it("disables Next/Last on the last page", () => {
    render(
      <Pagination page={4} perPage={25} totalCount={100} setPage={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Last page" })).toBeDisabled();
  });

  it("clicking Next calls setPage(page+1)", () => {
    const setPage = vi.fn();
    render(
      <Pagination page={1} perPage={25} totalCount={100} setPage={setPage} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(setPage).toHaveBeenCalledWith(2);
  });

  it("clicking Previous calls setPage(page-1)", () => {
    const setPage = vi.fn();
    render(
      <Pagination page={3} perPage={25} totalCount={100} setPage={setPage} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(setPage).toHaveBeenCalledWith(2);
  });

  it("clicking First calls setPage(1)", () => {
    const setPage = vi.fn();
    render(
      <Pagination page={3} perPage={25} totalCount={100} setPage={setPage} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    expect(setPage).toHaveBeenCalledWith(1);
  });

  it("clicking Last calls setPage(maxPage)", () => {
    const setPage = vi.fn();
    render(
      <Pagination page={1} perPage={25} totalCount={100} setPage={setPage} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(setPage).toHaveBeenCalledWith(4);
  });

  it("clamps to maxPage when caller passes a value past the end", () => {
    const setPage = vi.fn();
    render(
      <Pagination page={1} perPage={25} totalCount={100} setPage={setPage} />,
    );
    const input = screen.getByRole("textbox", { name: "Page number" });
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.blur(input);
    expect(setPage).toHaveBeenLastCalledWith(4);
  });

  it("hides First/Last and page input in controls=minimal", () => {
    render(
      <Pagination
        page={1}
        perPage={25}
        totalCount={100}
        setPage={() => {}}
        controls="minimal"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "First page" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Last page" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Page number" }),
    ).not.toBeInTheDocument();
  });

  it("forwards className to root", () => {
    const { container } = render(
      <Pagination
        page={1}
        perPage={25}
        totalCount={100}
        setPage={() => {}}
        className="custom-pg"
      />,
    );
    expect(container.firstChild).toHaveClass("custom-pg");
  });

  it("KUMO_PAGINATION_DEFAULTS.controls is full", () => {
    expect(KUMO_PAGINATION_DEFAULTS.controls).toBe("full");
  });

  it("KUMO_PAGINATION_PAGE_SIZE_OPTIONS exposes the standard sizes", () => {
    expect(KUMO_PAGINATION_PAGE_SIZE_OPTIONS).toEqual([25, 50, 100, 250]);
  });
});
