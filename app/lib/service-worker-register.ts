// Service worker registration — production only.
//
// Call once from a useEffect in the root layout (or client entry). The
// function is a no-op in dev (import.meta.env.DEV) so Vite's HMR and the
// SW never race during local development.
export function registerServiceWorker(): void {
  if (import.meta.env.DEV) return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err: unknown) => {
      console.warn("[sw] registration failed:", err);
    });
  });
}
