import { purgeStoredIntegrationSecrets } from "@/store/useIntegrationsStore";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeTheme } from "./lib/theme";
import { registerWipeCommand } from "./lib/localWipe";
import "./styles.css";

// Initialize theme before rendering
initializeTheme();

// Exposes __nexusWipe() / __nexusPending() in devtools. Registering a function
// on `window` ships no UI and no button a client could press by accident.
registerWipeCommand();

/**
 * Recover from a stale code-split chunk after a deploy.
 *
 * Routes like POS are lazy-loaded, so the shell holds a hashed chunk name
 * (`CheckoutForm-uqxzO-I5.js`). Ship a new build and that file is gone — a tab
 * still running the old shell then fails the dynamic import and the route dies
 * behind its error boundary showing "تعذر تحميل شاشة البيع". Reproduced exactly
 * that way while testing the new service worker, which makes a stale shell more
 * likely by design, since it caches one.
 *
 * Vite fires `vite:preloadError` for precisely this. Reloading picks up the new
 * index and the chunk names that go with it.
 *
 * The sessionStorage flag matters: if the chunk is missing for any reason OTHER
 * than a deploy — a bad upload, an offline tab — reloading would loop forever.
 * One attempt per tab, then the error is allowed through to the boundary so the
 * user sees an honest failure instead of a reload cycle.
 */
// Before anything renders: clear any integration secret an earlier build
// left in localStorage. See `purgeStoredIntegrationSecrets`.
purgeStoredIntegrationSecrets();

window.addEventListener("vite:preloadError", (event) => {
  const RELOAD_ONCE = "nexus-chunk-reload";
  if (sessionStorage.getItem(RELOAD_ONCE)) return;
  try {
    sessionStorage.setItem(RELOAD_ONCE, String(Date.now()));
  } catch {
    return; // storage blocked — never risk an unbounded reload loop
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
