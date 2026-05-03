// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Ported from @cloudflare/kumo Loader (shadcn pattern — source in app/ui/).
// Preserves exact public API and SVG structure from kumo's loader chunk.

// ---------------------------------------------------------------------------
// Variant table (mirrors KUMO_LOADER_VARIANTS)
// ---------------------------------------------------------------------------

export const KUMO_LOADER_VARIANTS = {
  size: {
    sm: {
      value: 16,
      description: "Small loader for inline use",
    },
    base: {
      value: 24,
      description: "Default loader size",
    },
    lg: {
      value: 32,
      description: "Large loader for prominent loading states",
    },
  },
} as const;

export const KUMO_LOADER_DEFAULT_VARIANTS = {
  size: "base",
} as const;

export type KumoLoaderSize = keyof typeof KUMO_LOADER_VARIANTS.size;

export interface KumoLoaderVariantsProps {
  size?: KumoLoaderSize | number;
}

export function loaderVariants({
  size = KUMO_LOADER_DEFAULT_VARIANTS.size,
}: KumoLoaderVariantsProps = {}): number {
  return typeof size === "number"
    ? size
    : KUMO_LOADER_VARIANTS.size[size].value;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LoaderProps {
  className?: string;
  size?: KumoLoaderSize | number;
}

// ---------------------------------------------------------------------------
// Loader component (animated SVG spinner)
// ---------------------------------------------------------------------------

export const Loader = ({
  className,
  size = KUMO_LOADER_DEFAULT_VARIANTS.size,
}: LoaderProps) => {
  const px = loaderVariants({ size });
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
      className={className}
      style={{ height: px, width: px }}
      aria-label="Loading"
      role="status"
    >
      <circle
        cx="12"
        cy="12"
        r="9.5"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="2s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="stroke-dasharray"
          values="0 150;42 150;42 150"
          keyTimes="0;0.5;1"
          dur="1.5s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="stroke-dashoffset"
          values="0;-16;-59"
          keyTimes="0;0.5;1"
          dur="1.5s"
          repeatCount="indefinite"
        />
      </circle>
      <circle
        cx="12"
        cy="12"
        r="9.5"
        fill="none"
        opacity={0.1}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
};
