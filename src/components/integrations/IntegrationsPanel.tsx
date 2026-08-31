import { useState } from "react";
import { RefreshCw, Lock, CheckCircle2, AlertCircle, Globe, Cog } from "lucide-react";
import { useSubscriptionStore } from "@/store/useSubscriptionStore";
import { useBusinessStore } from "@/store/useBusinessStore";
import { checkPremiumAccess } from "@/lib/subscription";
import { syncPendingOrders, getRegisteredSources } from "@/services/integrationService";
import { Button } from "@/components/ui/button";
import { IntegrationsSettingsPanel } from "./IntegrationsSettingsPanel";

export function IntegrationsPanel() {
  const { isProPlan } = useSubscriptionStore();
  const { products } = useBusinessStore();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string } | null>(null);

  const registeredSources = getRegisteredSources();

  const handleSync = async () => {
    // Premium access guard
    if (!checkPremiumAccess("omnichannel_integration")) {
      setSyncResult({
        success: false,
        message: "Pro Subscription Required: Omnichannel integration is a premium feature",
      });
      return;
    }

    setIsSyncing(true);
    setSyncResult(null);

    try {
      const result = await syncPendingOrders(products);
      setSyncResult({
        success: result.success,
        message: result.message,
      });
    } catch (error) {
      setSyncResult({
        success: false,
        message: error instanceof Error ? error.message : "Sync failed",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Existing sync panel (Pro-gated) ─────────────────────── */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center gap-3 mb-6">
          <div
            className="size-10 rounded-xl flex items-center justify-center"
            style={{ background: "var(--gradient-primary)" }}
          >
            <Globe className="size-5 text-primary-foreground" />
          </div>
          <div>
            <p className="text-xs tracking-wider text-muted-foreground">التكاملات</p>
            <h3 className="font-display text-2xl font-bold mt-1">ربط المتجر الإلكتروني</h3>
          </div>
        </div>

        {/* Sync Result */}
        {syncResult && (
          <div
            className={`mb-6 rounded-xl p-4 flex items-start gap-3 ${
              syncResult.success
                ? "bg-green-50 border border-green-200"
                : "bg-red-50 border border-red-200"
            }`}
          >
            {syncResult.success ? (
              <CheckCircle2 className="size-5 text-green-600 mt-0.5" />
            ) : (
              <AlertCircle className="size-5 text-red-600 mt-0.5" />
            )}
            <div className="flex-1">
              <p
                className={`font-semibold ${syncResult.success ? "text-green-900" : "text-red-900"}`}
              >
                {syncResult.success ? "تمت المزامنة بنجاح" : "فشلت المزامنة"}
              </p>
              <p
                className={`text-sm mt-1 ${syncResult.success ? "text-green-700" : "text-red-700"}`}
              >
                {syncResult.message}
              </p>
            </div>
          </div>
        )}

        {/* Connected Sources */}
        <div className="mb-6">
          <h4 className="font-semibold mb-3">المصادر المتصلة</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {registeredSources.map((source) => (
              <div
                key={source}
                className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/50"
              >
                <Globe className="size-5 text-primary" />
                <div>
                  <p className="font-medium capitalize">{source}</p>
                  <p className="text-xs text-muted-foreground">متصل</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Sync Controls — gated by Pro plan */}
        {isProPlan ? (
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm text-muted-foreground">
                  مزامنة الطلبات المعلقة من جميع المصادر المتصلة
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  سيتم تحديث المخزون والسجلات المالية تلقائياً
                </p>
              </div>
            </div>
            <Button onClick={handleSync} disabled={isSyncing} className="w-full" size="lg">
              <RefreshCw className={`size-4 ml-2 ${isSyncing ? "animate-spin" : ""}`} />
              {isSyncing ? "جاري المزامنة..." : "مزامنة الطلبات"}
            </Button>
          </div>
        ) : (
          <div className="border-t border-border pt-4">
            <div className="rounded-lg bg-muted/50 p-4 flex items-center gap-3">
              <Lock className="size-5 text-muted-foreground shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">المزامنة التلقائية للطلبات</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  ميزة احترافية — تتطلب الخطة المدفوعة
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => (window.location.href = "/settings")}
              >
                ترقية
              </Button>
            </div>
          </div>
        )}

        {/* Info Box */}
        <div className="mt-4 rounded-lg bg-blue-50 border border-blue-200 p-4">
          <p className="text-sm text-blue-900 font-medium">معلومات التكامل</p>
          <p className="text-xs text-blue-700 mt-1">
            يستخدم النظام نمط المحول (Adapter Pattern) لدعم منصات متعددة مثل Shopify و WooCommerce.
            يمكنك إضافة مصادر جديدة دون تعديل المنطق الأساسي.
          </p>
        </div>
      </div>

      {/* ── New: dedicated integration-settings panel (all plans) ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Cog className="size-5 text-muted-foreground" />
          <h2 className="text-xl font-display font-bold">إعدادات الربط والخدمات الخارجية</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          تحكم في Paymob (بوابة الدفع)، شركة الشحن، واستلام الطلبات الإلكترونية. كل خدمة اختيارية
          ويمكن إيقافها في أي وقت. المفاتيح تُحفظ محلياً ولا تُشارك.
        </p>
        <IntegrationsSettingsPanel />
      </div>
    </div>
  );
}
