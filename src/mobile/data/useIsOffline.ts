/**
 * Is the browser offline, right now?
 *
 * ## Why this is a hook and not `!navigator.onLine` inline
 *
 * Eight mobile screens asked the question as a bare expression in their JSX:
 *
 *     typeof navigator !== "undefined" && !navigator.onLine ? <OfflineState /> : …
 *
 * That reads the flag only when the component happens to re-render. Losing the
 * connection does not re-render anything, so an operator standing in a stock
 * room watched a list sit there looking live while nothing behind it could
 * load. The screens that DID handle it — الرئيسية — had already written the
 * `online`/`offline` listener pair by hand, which is the shape this extracts.
 *
 * Subscribing makes the state honest: the moment the connection drops the
 * screen says so, and the moment it returns the screen goes back to normal.
 *
 * ## This is not offline support
 *
 * NEXUS CORE is online-only. Knowing the connection is gone exists so the app
 * can SAY so and refuse to pretend — not so it can queue work. Nothing here
 * stores, defers or reconciles anything.
 *
 * `navigator.onLine` only knows whether the device has a network interface, not
 * whether Supabase is reachable, so it is a fast negative and never a positive
 * guarantee. Every read still has its own error state, and the one write still
 * awaits the server.
 */

import { useEffect, useState } from "react";

function offlineNow(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function useIsOffline(): boolean {
  const [offline, setOffline] = useState(offlineNow);

  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    // Re-read on mount: the connection may have changed between the initial
    // state and the effect running.
    setOffline(offlineNow());
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return offline;
}
