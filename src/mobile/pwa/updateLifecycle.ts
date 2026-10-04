/**
 * Mobile PWA updates: notice a new release while the app is open, and reload
 * into it at a moment that cannot cost the user anything.
 *
 * ## What was wrong
 *
 * The worker itself was right — `autoUpdate` + `skipWaiting` + `clientsClaim` +
 * `cleanupOutdatedCaches`: each release's precache is one consistent set of
 * html/js/css, and a new worker replaces the old one as soon as it installs.
 * But registration was the plugin's injected `registerSW.js`, which only
 * registers. Nothing asked for updates while a tab stayed open, and nothing
 * reloaded the page when a new worker took over, so:
 *
 *   - an open tab ran the old release until someone pressed refresh;
 *   - a cold start was served the OLD shell by the old worker, the new worker
 *     activated behind it, and only a SECOND load showed the release
 *     (observed on 503fe30 → c8b337c: `C6SOAOVi` first, `3KQlFe8n` after one
 *     manual refresh).
 *
 * ## What this does
 *
 *   1. Asks for an update every `checkIntervalMs` while visible, whenever the
 *      app comes back to the foreground or online, and (throttled) on
 *      navigation. `sw.js` is served `max-age=0, must-revalidate`, so each ask
 *      reaches the deployment.
 *   2. When a new worker has taken over, reloads — but only when nothing the
 *      user typed would be lost (`unsafeReloadReason`). Otherwise it waits and
 *      re-checks on the next navigation, when the app is backgrounded, and on a
 *      short timer.
 *
 * It changes no caching rule. Data is never cached by the worker (Supabase
 * REST/Auth/Realtime are not in the precache), so a reload re-reads the server.
 */

/** Why reloading now could lose something the user did, or `null` if it cannot. */
export function unsafeReloadReason(
  doc: Pick<Document, "activeElement" | "querySelector" | "querySelectorAll">,
): string | null {
  // Forms own the meaning of their draft, including selections held only in
  // React state and writes in flight. Commit this marker with the form render
  // so it cannot lag behind the visible draft or leak after unmount/reset.
  // Read-only filters/navigation must not opt in: this is unsaved user work.
  if (doc.querySelector('[data-pwa-unsaved="true"]')) return "unsaved-work";
  const active = doc.activeElement as (Element & { isContentEditable?: boolean }) | null;
  if (active && (isTextEntry(active) || active.isContentEditable)) return "typing";
  // A sheet or dialog is an action in progress — a filter being chosen, a
  // confirmation being read.
  if (doc.querySelector('[role="dialog"], [role="alertdialog"]')) return "dialog-open";
  for (const field of Array.from(doc.querySelectorAll("input, textarea"))) {
    if (isTextEntry(field) && (field as HTMLInputElement).value !== "") return "unsaved-input";
  }
  return null;
}

const NON_TEXT_INPUTS = new Set([
  "hidden",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "range",
  "color",
]);

function isTextEntry(el: Element): boolean {
  // Opt-out for read-only search/filter controls, not draft fields. Their
  // values do not represent uncommitted business work.
  if (el.getAttribute?.("data-pwa-reload-safe") === "true") return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA")
    return !(el as HTMLTextAreaElement).readOnly && !(el as HTMLTextAreaElement).disabled;
  // A <select> holds a choice, not typed work, and always has a value.
  if (tag !== "INPUT") return false;
  const input = el as HTMLInputElement;
  return (
    !NON_TEXT_INPUTS.has((input.type || "text").toLowerCase()) && !input.readOnly && !input.disabled
  );
}

export interface UpdateLifecycleDeps {
  /** `registration.update()` — asks the server for a newer `sw.js`. */
  checkForUpdate: () => Promise<unknown> | void;
  reload: () => void;
  isSafe: () => boolean;
  isVisible: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  setTimeout: (fn: () => void, ms: number) => unknown;
  now: () => number;
  checkIntervalMs?: number;
  /** How often a deferred reload looks again for a safe moment. */
  retryMs?: number;
}

export interface UpdateLifecycle {
  /** The new worker controls the page: reload as soon as it is safe. */
  updateActivated(): void;
  /** A route change — the natural safe point, and a cheap time to ask. */
  navigated(): void;
  /** The app came back to the foreground (`visible`) or went to the background. */
  visibilityChanged(): void;
  online(): void;
  /** For tests and diagnostics. */
  state(): { pendingReload: boolean; reloaded: boolean; lastCheckAt: number };
}

export function createUpdateLifecycle(deps: UpdateLifecycleDeps): UpdateLifecycle {
  const checkIntervalMs = deps.checkIntervalMs ?? 60_000;
  const retryMs = deps.retryMs ?? 15_000;
  // Navigation asks at most this often; the timer covers the rest.
  const navigationThrottleMs = 30_000;
  let pendingReload = false;
  let reloaded = false;
  let retryScheduled = false;
  let lastCheckAt = -Infinity;

  const check = () => {
    if (reloaded) return;
    lastCheckAt = deps.now();
    try {
      void Promise.resolve(deps.checkForUpdate()).catch(() => {
        /* offline or the deployment is mid-swap — the next tick asks again */
      });
    } catch {
      /* same */
    }
  };

  const tryReload = () => {
    if (!pendingReload || reloaded) return;
    if (!deps.isSafe()) {
      if (!retryScheduled) {
        retryScheduled = true;
        deps.setTimeout(() => {
          retryScheduled = false;
          tryReload();
        }, retryMs);
      }
      return;
    }
    reloaded = true;
    deps.reload();
  };

  deps.setInterval(() => {
    if (deps.isVisible()) check();
  }, checkIntervalMs);

  return {
    updateActivated() {
      pendingReload = true;
      tryReload();
    },
    navigated() {
      if (pendingReload) tryReload();
      else if (deps.now() - lastCheckAt >= navigationThrottleMs) check();
    },
    visibilityChanged() {
      if (pendingReload) tryReload();
      else if (deps.isVisible()) check();
    },
    online() {
      if (!pendingReload) check();
    },
    state: () => ({ pendingReload, reloaded, lastCheckAt }),
  };
}
