import { useState } from "react";
import {
  Settings as SettingsIcon,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  History,
  Globe,
  Info,
  BookOpen,
  Sparkles,
  Wifi,
  WifiOff,
  ShoppingCart,
  Truck,
  Wallet,
  PackageSearch,
  ArrowRight,
} from "lucide-react";
import {
  PaymobSettingsCard,
  ShippingIntegrationCard,
  OnlineOrderIntakeCard,
} from "./IntegrationConfigCards";
import { useIntegrationsStore } from "@/store/useIntegrationsStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useFeatureStore } from "@/store/useFeatureStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuditStore } from "@/store/useAuditStore";
import { Link } from "react-router-dom";

/**
 * The dedicated settings page for external integrations.
 *
 * Layout:
 *   1. Placeholder notice (clearly states these are wire-it-yourself slots)
 *   2. Product-mode status (offline / cloud, with manual fallback list)
 *   3. Tab strip: "الإعدادات" | "سجل الأحداث"
 *   4. Settings tab: Paymob, Shipping, Online Order Intake cards
 *   5. Audit Log tab: latest 100 entries for integration-related actions
 *
 * This is rendered alongside the existing <IntegrationsPanel /> sync
 * view (which remains untouched at the top of the page) — see
 * src/components/integrations/IntegrationsPanel.tsx for how it's
 * composed in src/routes/integrations.tsx.
 */
export function IntegrationsSettingsPanel() {
  const { getActiveProviders } = useIntegrationsStore();
  const { entries, clear } = useAuditStore();
  const { username, userRole, operationMode } = useAuthStore();
  const { ecommerceSyncEnabled, shippingTrackingEnabled } = useFeatureStore();

  const activeProviders = getActiveProviders();
  const integrationEntries = entries.filter(
    (e) =>
      e.action.startsWith("integrations.") ||
      e.action.startsWith("orders.order_status_changed") ||
      e.action.startsWith("orders.order_created"),
  );

  return (
    <div className="space-y-6">
      {/* Placeholder / product-mode notice */}
      <PlaceholderNotice operationMode={operationMode} />

      {/* Manual fallback card — guarantees the product works without any integration */}
      <ManualFallbackCard
        ecommerceSyncEnabled={ecommerceSyncEnabled}
        shippingTrackingEnabled={shippingTrackingEnabled}
      />

      <Tabs defaultValue="settings" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="settings" className="gap-2">
            <SettingsIcon className="size-3.5" /> الإعدادات
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-2">
            <History className="size-3.5" /> سجل الأحداث
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="space-y-5 mt-5">
          <PaymobSettingsCard />
          <ShippingIntegrationCard />
          <OnlineOrderIntakeCard />
        </TabsContent>

        <TabsContent value="audit" className="mt-5">
          <IntegrationAuditLog
            entries={integrationEntries}
            onClear={() => clear()}
            currentUsername={username}
            currentRole={userRole}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PlaceholderNotice({ operationMode }: { operationMode: "offline_local" | "cloud_sync" }) {
  return (
    <div className="rounded-2xl border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/20 p-4 flex items-start gap-3">
      <div className="size-10 rounded-xl bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center shrink-0">
        <Sparkles className="size-5 text-blue-600 dark:text-blue-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-sm">جاهز للربط — عند الحاجة فقط</h3>
          <Badge variant="outline" className="text-[10px] gap-1">
            {operationMode === "cloud_sync" ? (
              <>
                <Wifi className="size-3" /> وضع سحابي
              </>
            ) : (
              <>
                <WifiOff className="size-3" /> وضع أوفلاين
              </>
            )}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
          هذه البطاقات هي <strong className="text-foreground">فتحات ربط جاهزة</strong> — تسمح لك
          بربط النظام بـ Paymob (بوابة الدفع)، شركات الشحن، أو متجر إلكتروني لاحقاً عند الحاجة.
          النظام يعمل بشكل كامل بدونها، وكل العمليات متاحة يدوياً.
        </p>
        <ul className="text-xs text-muted-foreground mt-2 leading-relaxed list-disc pr-5 space-y-0.5">
          <li>لا يتم إنشاء أي اتصال خارجي تلقائياً عند تفعيل المفتاح.</li>
          <li>زر "حفظ وتحقق" يتحقق من اكتمال الحقول فقط، ولا يستدعي أي خدمة.</li>
          <li>
            لتفعيل الربط الفعلي، يلزم تشغيل طبقة الخادم (انظر ملف <code>PRODUCT.md</code>).
          </li>
        </ul>
      </div>
    </div>
  );
}

function ManualFallbackCard({
  ecommerceSyncEnabled,
  shippingTrackingEnabled,
}: {
  ecommerceSyncEnabled: boolean;
  shippingTrackingEnabled: boolean;
}) {
  const flows: Array<{
    icon: React.ElementType;
    title: string;
    description: string;
    to: string;
    cta: string;
  }> = [
    {
      icon: ShoppingCart,
      title: "إدخال الطلبات الإلكترونية يدوياً",
      description: "أنشئ طلباتك واحداً تلو الآخر مع احتساب تكلفة الشحن والمحافظات تلقائياً.",
      to: "/ecommerce-orders",
      cta: "فتح شاشة الطلبات",
    },
    {
      icon: Truck,
      title: "إدارة الشحن يدوياً",
      description: shippingTrackingEnabled
        ? "تسجيل حالات الشحنة وتحديث التسليمات يدوياً — الربط مع شركة الشحن اختياري."
        : "فعّل تتبع الشحن من الإعدادات ثم سجّل حالات الشحنة يدوياً.",
      to: "/courier-ledger",
      cta: "حسابات الشحن",
    },
    {
      icon: Wallet,
      title: "تسجيل المدفوعات يدوياً",
      description:
        "استلم المدفوعات نقداً / تحويل / فودافون كاش وسجّلها في الخزينة المناسبة من شاشة الطلبات.",
      to: "/orders",
      cta: "إدارة الطلبات",
    },
    {
      icon: PackageSearch,
      title: "جرد المخزون يدوياً",
      description: ecommerceSyncEnabled
        ? "مزامنة المنتجات من المتجر معطلة — أضف المنتجات يدوياً أو عبر Excel."
        : "أضف المنتجات يدوياً، أو استورد دفعة واحدة من ملف Excel.",
      to: "/products",
      cta: "المنتجات",
    },
  ];

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-3">
        <BookOpen className="size-5 text-primary" />
        <h3 className="font-display text-lg font-bold">كل شيء متاح بدون أي ربط خارجي</h3>
        <Badge variant="secondary" className="text-[10px]">
          المسار اليدوي
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
        هذه التدفقات متاحة دائماً — سواء كانت خدمات الربط مفعّلة أم لا. كل البيانات تُحفظ محلياً
        وتعمل بدون إنترنت.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {flows.map((f) => {
          const Icon = f.icon;
          return (
            <Link
              key={f.title}
              to={f.to}
              className="group rounded-xl border border-border bg-muted/30 hover:bg-muted/60 hover:border-primary/40 p-4 flex items-start gap-3 transition-all"
            >
              <div className="size-9 rounded-lg bg-background border border-border flex items-center justify-center shrink-0 group-hover:border-primary/60">
                <Icon className="size-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-medium text-sm">{f.title}</h4>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  {f.description}
                </p>
                <span className="text-xs text-primary font-medium mt-1.5 inline-flex items-center gap-1">
                  {f.cta}
                  <ArrowRight className="size-3" />
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function IntegrationAuditLog({
  entries,
  onClear,
  currentUsername,
  currentRole,
}: {
  entries: ReturnType<typeof useAuditStore.getState>["entries"];
  onClear: () => void;
  currentUsername: string;
  currentRole: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div>
          <h3 className="font-semibold">سجل أحداث التكامل</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            آخر {entries.length} حدث متعلق بالتكاملات والطلبات الإلكترونية
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1">
            <ShieldCheck className="size-3" />
            {currentUsername} · {currentRole}
          </Badge>
          {entries.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onClear}>
              مسح السجل
            </Button>
          )}
        </div>
      </div>
      {entries.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          <Globe className="size-8 mx-auto mb-2 opacity-50" />
          <p>لا توجد أحداث مسجلة بعد</p>
          <p className="text-xs mt-1">ستظهر هنا تغييرات الإعدادات وتحديثات الطلبات</p>
        </div>
      ) : (
        <div className="max-h-[500px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">التاريخ</TableHead>
                <TableHead className="text-right">المستخدم</TableHead>
                <TableHead className="text-right">الإجراء</TableHead>
                <TableHead className="text-right">المورد</TableHead>
                <TableHead className="text-right">تفاصيل</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.slice(0, 100).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs">
                    {new Date(e.timestamp).toLocaleString("ar-EG")}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="font-mono">{e.actorUsername}</span>
                    <span className="text-muted-foreground mr-1.5">({e.actorRole})</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{e.action}</code>
                  </TableCell>
                  <TableCell className="text-xs font-mono">{e.resource}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                    {e.notes ?? (e.details ? JSON.stringify(e.details) : "—")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
