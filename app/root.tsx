// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  Button,
  Empty,
  LinkProvider,
  Loader,
  Toasty,
  TooltipProvider,
} from "~/ui";
import { WarningIcon } from "@phosphor-icons/react";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { forwardRef, useState } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Link as RouterLink,
  Scripts,
  ScrollRestoration,
} from "react-router";
import Header from "~/components/Header";
import { ApiError } from "~/services/api";
import "./index.css";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Don't retry 4xx errors (not found, unauthorized, etc.)
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            return false;
          }
          return failureCount < 2;
        },
      },
    },
    mutationCache: new MutationCache({
      onError: (error) => {
        // Global fallback for mutations that don't handle errors themselves.
        // Consumers using mutateAsync + try/catch handle their own errors.
        console.error("Mutation failed:", error);
      },
    }),
  });
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
  if (typeof window === "undefined") {
    // SSR: always create a fresh client per request to prevent cross-user cache leaks
    return makeQueryClient();
  }
  // Browser: reuse the same client across navigations
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}

const KumoLink = forwardRef<
  HTMLAnchorElement,
  React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }
>(function KumoLink({ href, ...props }, ref) {
  if (href && !href.startsWith("http")) {
    return (
      <RouterLink to={href} ref={ref} {...(props as Record<string, unknown>)} />
    );
  }
  return <a href={href} ref={ref} {...props} />;
});

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link
          rel="icon"
          type="image/x-icon"
          href="/favicon.ico"
          sizes="48x48 32x32 16x16"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Agentic Inbox</title>
        {/* Apply theme class on <html> BEFORE first paint to avoid the
         * flash-of-wrong-theme. Reads localStorage["anai-theme"]; falls
         * back to system preference. The ThemeToggle in the header
         * mutates this class + the same localStorage key. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted boot script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('anai-theme');if(s!=='light'&&s!=='dark'){s=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.classList.add('theme-'+s);}catch(e){}})();`,
          }}
        />
        <Meta />
        <Links />
      </head>
      <body className="bg-bg text-text antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function HydrateFallback() {
  return (
    <div className="flex items-center justify-center h-screen">
      <Loader size="lg" />
    </div>
  );
}

export default function App() {
  // Use useState to ensure each SSR request gets a fresh client while the
  // browser reuses the same singleton across navigations.
  const [queryClient] = useState(getQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <LinkProvider component={KumoLink}>
        <TooltipProvider>
          <Toasty>
            {/* flex flex-col h-screen so child routes using flex-1 fill
                the space below the sticky Header correctly. */}
            <div className="flex flex-col h-screen overflow-hidden">
              <Header />
              <Outlet />
            </div>
          </Toasty>
        </TooltipProvider>
      </LinkProvider>
    </QueryClientProvider>
  );
}

export function ErrorBoundary({ error }: { error: unknown }) {
  let title = "Something went wrong";
  let description = "An unexpected error occurred. Please try again.";
  let status: number | null = null;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (error.status === 404) {
      title = "Page not found";
      description =
        "The page you're looking for doesn't exist or has been moved.";
    } else {
      title = `Error ${error.status}`;
      description = error.statusText || description;
    }
  } else if (error instanceof Error && import.meta.env.DEV) {
    description = error.message;
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-8">
      <Empty
        icon={<WarningIcon size={48} className="text-text-muted" />}
        title={status === 404 ? "404 — Page not found" : title}
        description={description}
        contents={
          <Button
            variant="primary"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            Go Home
          </Button>
        }
      />
    </div>
  );
}
