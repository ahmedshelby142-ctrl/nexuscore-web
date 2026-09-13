import { Navigate, Route, Routes } from "react-router-dom";
import type { SessionReconciliationState } from "@/lib/auth/useSessionReconciliation";
import { MobileLogin } from "./auth/MobileLogin";
import { MobileSetPassword } from "./auth/MobileSetPassword";
import { MobileLicenseExpired } from "./screens/LicenseExpired";
import { MobileHomePlaceholder } from "./screens/MobileHomePlaceholder";
import { MobileRouteGuard } from "./navigation/MobileRouteGuard";
import { MobileDeferredScreen } from "./screens/MobileDeferredScreen";
import { MobileStockScreen } from "./screens/MobileStockScreen";
import { MobileOrdersScreen } from "./screens/MobileOrdersScreen";
import { MobileShipmentsScreen } from "./screens/MobileShipmentsScreen";
import { MobileCustomersScreen } from "./screens/MobileCustomersScreen";
import { MobileProductDetails } from "./screens/MobileProductDetails";
import { MobileOrderDetails } from "./screens/MobileOrderDetails";
import { MobileCustomerDetails } from "./screens/MobileCustomerDetails";
import { MobileQuickRestock } from "./screens/MobileQuickRestock";
import { MobileSessionGate } from "./shell/MobileSessionGate";
import { MobileShell } from "./shell/MobileShell";

export function MobileRouter({
  sessionState,
}: {
  sessionState: "checking" | SessionReconciliationState;
}) {
  return (
    <Routes>
      <Route path="/login" element={<MobileLogin />} />
      <Route path="/set-password" element={<MobileSetPassword />} />
      <Route element={<MobileSessionGate sessionState={sessionState} />}>
        <Route path="/license-expired" element={<MobileLicenseExpired />} />
        <Route path="/" element={<MobileShell />}>
          <Route index element={<MobileHomePlaceholder />} />
          <Route element={<MobileRouteGuard capability="orders" />}><Route path="orders" element={<MobileOrdersScreen />} /></Route>
          <Route element={<MobileRouteGuard capability="orders" />}><Route path="orders/:orderId" element={<MobileOrderDetails />} /></Route>
          <Route element={<MobileRouteGuard capability="stock" />}><Route path="inventory" element={<MobileStockScreen />} /></Route>
          <Route element={<MobileRouteGuard capability="stock" />}><Route path="inventory/shortages" element={<MobileStockScreen />} /></Route>
          <Route element={<MobileRouteGuard capability="stock" />}><Route path="inventory/:productId" element={<MobileProductDetails />} /></Route>
          <Route element={<MobileRouteGuard capability="shipments" />}><Route path="shipments" element={<MobileShipmentsScreen />} /></Route>
          <Route element={<MobileRouteGuard capability="customers" />}><Route path="customers" element={<MobileCustomersScreen />} /></Route>
          <Route element={<MobileRouteGuard capability="customers" />}><Route path="customers/:customerId" element={<MobileCustomerDetails />} /></Route>
          <Route element={<MobileRouteGuard capability="purchasing" />}><Route path="purchasing" element={<MobileDeferredScreen title="المشتريات" />} /><Route path="restock" element={<MobileQuickRestock />} /></Route>
          <Route element={<MobileRouteGuard capability="preferences" />}><Route path="preferences" element={<MobileDeferredScreen title="الإعدادات" />} /></Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
