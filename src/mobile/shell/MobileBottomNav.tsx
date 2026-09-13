import { NavLink } from "react-router-dom";
import { useAuthStore } from "@/store/useAuthStore";
import { toAppRole } from "@/lib/roles";
import { getMobileCapabilities } from "@/mobile/navigation/mobileCapabilities";
import { getBottomNavForRole } from "@/mobile/navigation/mobileNavigation";
import { useAlertBadges } from "./useAlertBadges";

export function MobileBottomNav({ onOpenMore }: { onOpenMore: () => void }) {
  const userRole = useAuthStore((state) => state.userRole);
  const role = toAppRole(userRole);
  const capabilities = getMobileCapabilities(role);
  
  // Enforce 4-item maximum and capability filtering
  const bottomNavItems = getBottomNavForRole(role).filter((item) =>
    capabilities.has(item.id)
  );
  
  const badges = useAlertBadges();

  return (
    <nav className="mobile-bottom-nav" aria-label="التنقل الرئيسي">
      {bottomNavItems.map((item) => {
        const Icon = item.icon;
        
        // Use standard record typing for the badges map
        const badgeCount = (badges as Record<string, number>)[item.id] || 0;

        if (item.id === "more") {
          return (
            <button key={item.id} type="button" className="mobile-nav-item" onClick={onOpenMore}>
              <div className="mobile-nav-icon-wrapper">
                <Icon aria-hidden="true" />
                {badgeCount > 0 && <span className="mobile-nav-badge">{badgeCount}</span>}
              </div>
              <span>{item.label}</span>
            </button>
          );
        }

        return (
          <NavLink
            key={item.id}
            to={item.path ?? "/"}
            end
            className={({ isActive }) =>
              `mobile-nav-item${isActive ? " mobile-nav-item-active" : ""}`
            }
            aria-label={item.label}
          >
            <div className="mobile-nav-icon-wrapper">
              <Icon aria-hidden="true" />
              {badgeCount > 0 && <span className="mobile-nav-badge" aria-label={`${badgeCount} تنبيهات`}>{badgeCount}</span>}
            </div>
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
