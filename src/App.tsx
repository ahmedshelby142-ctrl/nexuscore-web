import { Component, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { RoleGuard } from "@/components/auth/RoleGuard";

class RouteBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-background p-8">
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center max-w-md space-y-4">
            <p className="text-lg font-semibold text-destructive">تعذر تحميل الصفحة</p>
            <p className="text-sm text-muted-foreground">
              حدث خطأ غير متوقع. يرجى إعادة تحميل الصفحة.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="text-sm text-primary hover:underline"
            >
              إعادة تحميل
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
import { Login } from "@/pages/Login";
import { Dashboard } from "@/routes/dashboard";
import { Products } from "@/routes/products";
import { POS } from "@/routes/pos";
import { Inventory } from "@/routes/inventory";
import { StockAudit } from "@/routes/stock-audit";
import { Purchasing } from "@/routes/purchasing";
import { Wholesale } from "@/routes/wholesale";
import { Partners } from "@/routes/partners";
import { Integrations } from "@/routes/integrations";
import { Settings } from "@/routes/settings";
import { EcommerceOrders } from "@/routes/ecommerce-orders";
import { EcommerceOrdersHub } from "@/routes/ecommerce-orders-hub";
import { CourierLedger } from "@/routes/courier-ledger";
import { Bundles } from "@/routes/bundles";
import { Discounts } from "@/routes/discounts";
import { CRM } from "@/routes/crm";
import { Returns } from "@/routes/returns";
import { BranchesPage } from "@/routes/branches";
import { UsersPage } from "@/routes/users";
import { BackupsPage } from "@/routes/backups";
import { PlaceholderPage } from "@/routes/placeholder";

import { useRealtimeSync } from "@/hooks/useRealtimeSync";

export function App() {
  useRealtimeSync();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="products" element={<Products />} />
            <Route
              path="pos"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner", "cashier", "cashier_data_entry"]}
                    message="هذه الشاشة مخصصة لكاشير البيع المباشر فقط."
                    redirectPath="/ecommerce-orders"
                    redirectLabel="العودة إلى الطلبات الإلكترونية"
                  >
                    <POS />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route path="inventory" element={<Inventory />} />
            <Route path="stock-audit" element={<StockAudit />} />
            <Route path="purchasing" element={<Purchasing />} />
            <Route path="wholesale" element={<Wholesale />} />
            <Route path="partners" element={<Partners />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="settings" element={<Settings />} />
            <Route
              path="ecommerce-orders"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner", "data_entry", "cashier_data_entry"]}
                    message="عذراً، هذه اللوحة مخصصة للإدارة أو موظفي الداتا إنتري فقط."
                  >
                    <EcommerceOrders />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route
              path="orders"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner", "data_entry", "cashier_data_entry"]}
                    message="عذراً، هذه اللوحة مخصصة للإدارة أو موظفي الداتا إنتري فقط."
                  >
                    <EcommerceOrdersHub />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route
              path="courier-ledger"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner"]}
                    message="عذراً، هذه اللوحة مخصصة لمدير المشروع فقط."
                  >
                    <CourierLedger />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route
              path="bundles"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner", "data_entry"]}
                    message="عذراً، هذه اللوحة مخصصة للإدارة أو الداتا إنتري فقط."
                  >
                    <Bundles />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route
              path="discounts"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner", "data_entry"]}
                    message="عذراً، هذه اللوحة مخصصة للإدارة أو الداتا إنتري فقط."
                  >
                    <Discounts />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route
              path="crm"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner", "data_entry"]}
                    message="عذراً، هذه اللوحة مخصصة للإدارة أو الداتا إنتري فقط."
                  >
                    <CRM />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route path="returns" element={<Returns />} />
            <Route
              path="branches"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner"]}
                    message="إدارة الفروع متاحة لمدير المشروع فقط."
                  >
                    <BranchesPage />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route
              path="users"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner"]}
                    message="إدارة المستخدمين متاحة لمدير المشروع فقط."
                  >
                    <UsersPage />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            <Route
              path="backups"
              element={
                <RouteBoundary>
                  <RoleGuard
                    allowedRoles={["owner"]}
                    message="النسخ الاحتياطي متاح لمدير المشروع فقط."
                  >
                    <BackupsPage />
                  </RoleGuard>
                </RouteBoundary>
              }
            />
            {/* Business-Profile-specific route placeholders */}
            <Route
              path="credit-invoices"
              element={
                <PlaceholderPage
                  title="الفواتير الآجلة"
                  description="إدارة الفواتير المؤجلة وآجال السداد للعملاء"
                />
              }
            />
            <Route
              path="credit-limits"
              element={
                <PlaceholderPage
                  title="حد الائتمان للعملاء"
                  description="تحديد ومراقبة الحدود الائتمانية لكل عميل"
                />
              }
            />
            <Route
              path="reps-activity"
              element={
                <PlaceholderPage
                  title="حركة المندوبين"
                  description="تتبع نشاط المندوبين والمبيعات الميدانية"
                />
              }
            />
            <Route
              path="b2b-sales"
              element={
                <PlaceholderPage
                  title="المبيعات الإدارية B2B"
                  description="إدارة مبيعات الشركات والعقود التجارية"
                />
              }
            />
            <Route
              path="contracts"
              element={
                <PlaceholderPage
                  title="العقود والفواتير"
                  description="إدارة العقود التجارية والفواتير المرتبطة بها"
                />
              }
            />
            <Route
              path="production-lines"
              element={
                <PlaceholderPage
                  title="خطوط الإنتاج"
                  description="إدارة خطوط الإنتاج والجداول الزمنية للتصنيع"
                />
              }
            />
            <Route
              path="raw-materials"
              element={
                <PlaceholderPage
                  title="المواد الخام"
                  description="تتبع المواد الخام والمخزون التصنيعي"
                />
              }
            />
            <Route
              path="waste-cost"
              element={
                <PlaceholderPage
                  title="حساب تكلفة الهالك"
                  description="احتساب تكلفة الهالك والمواد المفقودة في الإنتاج"
                />
              }
            />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
