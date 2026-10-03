/// <reference types="vite-plugin-pwa/client" />
import { createUpdateLifecycle, unsafeReloadReason, type UpdateLifecycle } from "./updateLifecycle";

let lifecycle: UpdateLifecycle | null = null;

/**
 * Register the Mobile service worker and keep the open app on the current
 * release. Replaces the plugin's injected `registerSW.js` (`injectRegister:
 * false`), which registered and did nothing else. See `updateLifecycle.ts`.
 *
 * Production builds only: the dev server has no worker.
 */
export async function registerMobileUpdates(): Promise<void> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const { registerSW } = await import("virtual:pwa-register");
  let registration: ServiceWorkerRegistration | undefined;

  lifecycle = createUpdateLifecycle({
    checkForUpdate: () => registration?.update(),
    reload: () => window.location.reload(),
    isSafe: () => unsafeReloadReason(document) === null,
    isVisible: () => document.visibilityState === "visible",
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    now: () => Date.now(),
  });

  registerSW({
    immediate: true,
    // `autoUpdate`: the new worker has already activated and claimed this
    // page. The plugin would `location.reload()` right here, whatever the user
    // was typing; the lifecycle waits for a safe moment instead.
    onNeedReload: () => lifecycle?.updateActivated(),
    onRegisteredSW: (_url, reg) => {
      registration = reg;
    },
  });

  document.addEventListener("visibilitychange", () => lifecycle?.visibilityChanged());
  window.addEventListener("online", () => lifecycle?.online());
}

/** Called on every route change — the app's natural safe point. */
export function notifyMobileNavigation(): void {
  lifecycle?.navigated();
}
