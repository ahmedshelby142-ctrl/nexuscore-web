import { useCallback, useEffect, useState } from "react";
import type { MobileCapability } from "@/mobile/navigation/mobileCapabilities";
import { composeMobileHomeSnapshot, readMobileHomeSnapshot, type ComposedMobileHomeSnapshot } from "./mobileHomeReader";

const cache = new Map<string, ComposedMobileHomeSnapshot>();
const pending = new Map<string, Promise<ComposedMobileHomeSnapshot>>();

export function useMobileHomeData(capabilities: ReadonlySet<MobileCapability>, licenseAtRisk: boolean) {
  const [state, setState] = useState<{ data: ComposedMobileHomeSnapshot | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const key = `${[...capabilities].sort().join(",")}:${licenseAtRisk}`;
      const cached = cache.get(key);
      const request = cached
        ? Promise.resolve(cached)
        : pending.get(key) ?? readMobileHomeSnapshot(capabilities).then((snapshot) => composeMobileHomeSnapshot(snapshot, capabilities, licenseAtRisk));
      pending.set(key, request);
      const data = await request;
      cache.set(key, data);
      pending.delete(key);
      setState({ data, loading: false, error: null });
    } catch (error) {
      setState({ data: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }, [capabilities, licenseAtRisk]);
  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload };
}
