import { useAuthStore } from "@/store/useAuthStore";
import { toAppRole } from "@/lib/roles";
import { getMobileCapabilities } from "@/mobile/navigation/mobileCapabilities";
import { useStoreLicense } from "@/store/useStoreLicense";
import { useMobileHomeData } from "@/mobile/data/useMobileHomeData";

export function useAlertBadges() {
  const userRole = useAuthStore((state) => state.userRole);
  const licenseDecision = useStoreLicense((state) => state.decision);
  const role = toAppRole(userRole);
  const capabilities = getMobileCapabilities(role);
  const home = useMobileHomeData(capabilities, licenseDecision?.verdict === "unverified" || licenseDecision?.verdict === "suspended");
  const badges: Record<string, number> = {};
  for (const alert of home.data?.alerts ?? []) {
    if (alert.level !== "CRITICAL" && alert.level !== "ACTION") continue;
    badges[alert.capability] = (badges[alert.capability] ?? 0) + alert.count;
  }
  return badges;
}
