import { useEffect } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import { useSettingsStore } from "@/store/useSettingsStore";

/** Off while idle, loading, saving, or failed; no cached-value flash. */
export function useWholesaleEnabled(): boolean {
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const status = useSettingsStore((s) => s.wholesaleStatus);
  const enabled = useSettingsStore((s) => s.wholesaleEnabled);
  const pull = useSettingsStore((s) => s.pullWholesaleFeature);
  useEffect(() => {
    if (authenticated && status === "idle") void pull();
  }, [authenticated, status, pull]);
  return authenticated && status === "ready" && enabled;
}
