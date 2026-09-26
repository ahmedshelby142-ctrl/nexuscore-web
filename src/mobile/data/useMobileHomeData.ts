import { useCallback, useEffect, useState } from "react";
import type { MobileCapability } from "@/mobile/navigation/mobileCapabilities";
import { composeMobileHomeSnapshot, readMobileHomeSnapshot, type ComposedMobileHomeSnapshot } from "./mobileHomeReader";
import { useRealtimeTables } from "./useMobileRealtime";

/**
 * The read in flight, shared by the two consumers (Home and the nav badges)
 * that mount together — so one screen costs one read, not two.
 *
 * ## Why there is no result cache any more
 *
 * This used to keep every composed snapshot in a module-level Map for the life
 * of the tab, keyed only by role capabilities. Three things followed from it:
 *
 *   - تحديث and "حاول مرة أخرى" were served from that Map, so they never asked
 *     the server again. The home screen could not be refreshed at all.
 *   - A FAILED read stayed in `pending` (it was only removed on success), so
 *     every retry re-awaited the same rejected promise. A failure was terminal.
 *   - Signing out does not reload the page. The next person to sign in on the
 *     same phone with the same role got the previous store's alerts, order
 *     numbers and customer names from the Map.
 *
 * So only the in-flight promise is shared, and it is dropped the moment it
 * settles, success or failure.
 */
const pending = new Map<string, Promise<ComposedMobileHomeSnapshot>>();

export function readSharedHomeSnapshot(capabilities: ReadonlySet<MobileCapability>, licenseAtRisk: boolean): Promise<ComposedMobileHomeSnapshot> {
  const key = `${[...capabilities].sort().join(",")}:${licenseAtRisk}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const request = readMobileHomeSnapshot(capabilities)
    .then((snapshot) => composeMobileHomeSnapshot(snapshot, capabilities, licenseAtRisk))
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function useMobileHomeData(capabilities: ReadonlySet<MobileCapability>, licenseAtRisk: boolean) {
  const [state, setState] = useState<{ data: ComposedMobileHomeSnapshot | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const reload = useCallback(async () => {
    // Skeleton only when nothing is on screen: a realtime cue must not blank
    // the home screen under the operator's thumb.
    setState((current) => ({ ...current, loading: current.data === null, error: null }));
    try {
      const data = await readSharedHomeSnapshot(capabilities, licenseAtRisk);
      setState({ data, loading: false, error: null });
    } catch (error) {
      setState({ data: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }, [capabilities, licenseAtRisk]);
  useEffect(() => { void reload(); }, [reload]);
  // Home and the badges are the two surfaces that never remount while the
  // shell is up, so without a cue they only ever showed the first answer.
  useRealtimeTables(["orders", "products", "ledger_events"], () => { void reload(); });
  return { ...state, reload };
}
