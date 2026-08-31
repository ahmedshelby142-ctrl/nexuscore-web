import { useEffect, useState } from "react";

/**
 * Is the browser online?
 *
 * This replaces the `isOnline` slice of the old sync store. That store tracked
 * a local queue draining; there is no queue now, so the only thing worth
 * showing is whether a write would reach Supabase at all — which the platform
 * already answers.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  return online;
}
