# `app/ui/` — In-Repo Primitive Library

Ported from kumo on top of [`@base-ui/react`](https://github.com/mui/base-ui).
Each primitive lives in its own `*.tsx` file, exports its public API + the
canonical variant tables, and is barreled through `app/ui/index.ts` so consumers
write `import { Button, Dialog, Loader, ... } from "~/ui"`.

This file is the variant-table reference. **Read it before adding a new usage** —
the variant tables here are the source of truth and several primitives have
non-obvious gotchas (Loader has no `md`; Badge has no `error`; Input requires an
accessible name).

---

## Inventory

| Primitive | File | Phase shipped |
|-----------|------|---------------|
| Button, LinkButton, RefreshButton | `button.tsx`        | 1 |
| Input                              | `input.tsx`         | 1 |
| Badge                              | `badge.tsx`         | 1 |
| Loader                             | `loader.tsx`        | 1 |
| Text                               | `text.tsx`          | 1 |
| Tooltip + TooltipProvider          | `tooltip.tsx`       | 2 |
| Dialog (+ Trigger, Title, ...)     | `dialog.tsx`        | 2 |
| Toasty + ToastProvider + useToast  | `toast.tsx`         | 2 |
| LinkProvider + useLinkComponent    | `link-provider.tsx` | 2 |
| Empty                              | `empty.tsx`         | 3 |
| Banner                             | `banner.tsx`        | 3 |
| Pagination                         | `pagination.tsx`    | 3 |
| Select + Select.Option             | `select.tsx`        | 7 (T7.1 — last kumo import) |

`cn()` lives in `app/ui/lib/cn.ts` — `clsx` + `tailwind-merge`. Both packages are
direct devDeps as of Phase 7.

---

## Variant tables

### Loader

| Variant | Pixel size | Description |
|---------|-----------:|-------------|
| `sm`    |       16   | Small loader for inline use |
| `base`  |       24   | Default |
| `lg`    |       32   | Large for prominent loading states |

**Gotcha:** there is no `md`. Pass a number (e.g. `<Loader size={20} />`) for
non-canonical sizes; passing `"md"` is a runtime error.

### Badge

| Variant | Description |
|---------|-------------|
| `primary`     | Default brand-colored badge |
| `secondary`   | Muted neutral badge (used by mailbox-tree "owner") |
| `destructive` | Red — destructive / dangerous state |
| `outline`     | Bordered, no fill — low-emphasis |
| `success`     | Green — positive state |
| `beta`        | Indigo — beta/feature flag |

**Gotcha:** there is **no `error` variant** despite the matching Text variant.
Use `destructive` for error badges.

### Text

Variants include `error` (red) — a different surface from Badge. Sizes:
`xs | sm | base | lg | xl | 2xl`.

### Input

```tsx
<Input aria-label="Email" placeholder="you@example.com" />
```

**Hard requirement:** every `<Input>` MUST carry an accessible name —
`aria-label`, `<label htmlFor>`, or `aria-labelledby`. Placeholder alone fails
the runtime accessibility check (Phase 6 lesson). Variant: `size: sm | base | lg`.

### Button + LinkButton + RefreshButton

Variants: `variant: primary | secondary | destructive | outline | ghost | link`,
`size: sm | base | lg`, `shape: rectangle | square | circle`. `asChild` lets
you forward to a router `<Link>` while keeping button styles.

### Dialog

`<Dialog>` is the high-level component; `DialogRoot`, `DialogTrigger`,
`DialogTitle`, `DialogDescription`, `DialogClose` are the lower-level parts for
bespoke layouts. Sizes: `sm | base | lg | xl`. Roles: `dialog | alertdialog`.

### Tooltip

`<TooltipProvider>` must wrap the app once for delay grouping; the per-tooltip
`<Tooltip content asChild>` mounts inside that. Sides: `top | bottom | left |
right`. Aligns: `start | center | end`.

### Toasty

`<ToastProvider>` mounts once near the root. Components emit toasts via the
`useToastManager` hook. Variants: `info | success | warning | error`.

### Empty

Empty-state primitive. Sizes: `sm | base | lg`.

### Banner

Inline alert. Variants: `info | success | warning | error | beta`.

### Pagination

Standalone pager. Defaults: `pageSize=20`. `KUMO_PAGINATION_PAGE_SIZE_OPTIONS`
exposes the canonical `[10, 20, 50, 100]` page-size chips.

### Select (+ `Select.Option`) — Phase 7 T7.1

```tsx
<Select aria-label="Domain" value={selected} onValueChange={setSelected}>
  <Select.Option value="actionnow.ai">actionnow.ai</Select.Option>
  <Select.Option value="example.com">example.com</Select.Option>
</Select>
```

Backed by `@base-ui/react/select`. Variant: `size: sm | base`. Single callsite
today is `app/routes/home.tsx`'s domain picker; ported as part of the Phase 7
kumo-uninstall close-out (the last kumo import in the codebase was the kumo
`Select` here).

---

## Patterns

- **Variant tables are exported.** Every primitive exports its `KUMO_<X>_VARIANTS`
  + `KUMO_<X>_DEFAULT_VARIANTS` + a `<x>Variants(...)` helper so consumers can
  build cn-merged className strings without repeating the source-of-truth.
- **`cn()` is the only Tailwind merger.** Don't reach for `tailwind-merge`
  directly — go through `app/ui/lib/cn.ts`.
- **Tests live next to primitives** (`button.test.tsx`, `dialog.test.tsx`, …).
  Each test asserts the public-API surface that matched kumo before the port —
  this is what makes the migration "0 % visual diff" achievable.
- **Don't add a new primitive without a test file** mirroring the existing
  pattern.
