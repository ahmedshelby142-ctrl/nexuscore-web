import { useRef, useState } from "react";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useFeatureStore } from "@/store/useFeatureStore";
import { useAuthStore } from "@/store/useAuthStore";
import { toAppRole } from "@/lib/roles";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { ShippingRateMatrix } from "@/components/shipping/ShippingRateMatrix";
import { GeneralSettingsPanel } from "@/components/settings/GeneralSettingsPanel";
import { BranchesPage } from "@/routes/branches";
import { BackupsPage } from "@/routes/backups";
import { UserManagementPanel } from "@/components/auth/UserManagementPanel";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ShoppingBag, Store } from "lucide-react";

function SettingsCard({
  title,
  badge,
  description,
  children,
}: {
  title: string;
  badge?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {badge && (
          <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2.5 py-1 rounded-full border border-border/50">
            {badge}
          </span>
        )}
      </div>
      {description && (
        <p className="text-sm text-muted-foreground mt-1 mb-6 max-w-xl">{description}</p>
      )}
      {children}
    </div>
  );
}

function SettingRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
      <div className="ml-4 flex-1">
        <h3 className="font-medium">{label}</h3>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/**
 * A tab panel that mounts on first visit and then STAYS mounted, hidden.
 *
 * Plain `TabsContent` unmounts the moment you switch away, which would throw
 * away a half-filled فرع form and re-run the staff fetch in الصلاحيات on every
 * visit. Mounting all five up front has the opposite problem — the staff fetch
 * would fire even for an owner who only came to edit أسعار الشحن. So: lazy the
 * first time, sticky afterwards.
 */
function KeepAliveTab({
  value,
  current,
  children,
}: {
  value: string;
  current: string;
  children: React.ReactNode;
}) {
  const seen = useRef(false);
  if (value === current) seen.current = true;

  return (
    <TabsContent
      value={value}
      forceMount={seen.current || undefined}
      className="mt-6 space-y-6 data-[state=inactive]:hidden"
    >
      {seen.current ? children : null}
    </TabsContent>
  );
}

const channels = [
  {
    name: "Shopify",
    icon: ShoppingBag,
    status: "🟢 مزامنة تلقائية نشطة (بدون موظف داتا إنتري)",
    color: "text-green-600 dark:text-green-400",
  },
  {
    name: "متجر مخصص (Custom Webstore)",
    icon: Store,
    status: "🟢 مزامنة تلقائية نشطة (بدون موظف داتا إنتري)",
    color: "text-green-600 dark:text-green-400",
  },
];

export function Settings() {
  const userRole = useAuthStore((s) => s.userRole);
  const { partnershipEnabled, togglePartnership } = useBusinessStore();
  const {
    returnsEnabled,
    shippingTrackingEnabled,
    salesCommissionsEnabled,
    ecommerceSyncEnabled,
    depositMandatory,
    toggleReturns,
    toggleShippingTracking,
    toggleSalesCommissions,
    toggleEcommerceSync,
    toggleDepositMandatory,
  } = useFeatureStore();
  const [tab, setTab] = useState("general");

  // Non-owner staff see only personal theme preferences
  // Unreachable via the router (/settings is ADMIN-only in lib/roles.ts);
  // kept as a defence-in-depth fallback if the map ever opens it up.
  if (toAppRole(userRole) !== "ADMIN") {
    return (
      <div className="space-y-6 max-w-4xl mx-auto w-full">
        <div className="pb-1">
          <h2 className="text-3xl font-display font-bold tracking-tight">
            التفضيلات الشخصية والمظهر
          </h2>
          <p className="text-muted-foreground mt-1">
            تخصيص ألوان واجهة النظام — الوضع الفاتح / الداكن
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <ThemeSwitcher simplified />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto w-full">
      <div className="pb-1">
        <h2 className="text-3xl font-display font-bold tracking-tight">الإعدادات</h2>
        <p className="text-muted-foreground mt-1">
          تكوين النظام والميزات والفروع والصلاحيات والنسخ الاحتياطي
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} dir="rtl">
        <TabsList className="h-auto flex-wrap justify-start gap-1 p-1">
          <TabsTrigger value="general" className="px-4 py-2">
            عام
          </TabsTrigger>
          <TabsTrigger value="shipping" className="px-4 py-2">
            الشحن
          </TabsTrigger>
          <TabsTrigger value="branches" className="px-4 py-2">
            الفروع
          </TabsTrigger>
          <TabsTrigger value="roles" className="px-4 py-2">
            الصلاحيات
          </TabsTrigger>
          <TabsTrigger value="backups" className="px-4 py-2">
            النسخ الاحتياطي
          </TabsTrigger>
        </TabsList>

        {/* ── عام ─────────────────────────────────────────────────────── */}
        <KeepAliveTab value="general" current={tab}>
          <SettingsCard
            title="بيانات المحل"
            badge="General"
            description="معلومات المحل الأساسية والإعدادات الضريبية التي تظهر في الفواتير."
          >
            <GeneralSettingsPanel />
          </SettingsCard>

          <SettingsCard
            title="تكوين موديول التجزئة والأونلاين"
            badge="Retail & E‑commerce"
            description="تشغيل أو إيقاف ميزات التجزئة المتقدمة والربط الإلكتروني وإدارة الشحن والعمولات."
          >
            <div className="divide-y divide-border">
              <SettingRow
                label="نظام المرتجعات والاستبدال المتقدم"
                description="تفعيل نظام متكامل لإدارة مرتجعات العملاء واستبدال المنتجات مع تتبع الأسباب"
                checked={returnsEnabled}
                onCheckedChange={toggleReturns}
              />
              <SettingRow
                label="إدارة شحن المحافظات وتتبع المناديب"
                description="جدولة الشحن للمحافظات، تعيين مناديب، وتتبع حالة التوصيل في الوقت الفعلي"
                checked={shippingTrackingEnabled}
                onCheckedChange={toggleShippingTracking}
              />
              <SettingRow
                label="حساب عمولات موظفي المبيعات والمناديب"
                description="احتساب العمولات تلقائياً لكل عملية بيع بناءً على نسب مئوية مخصصة لكل موظف"
                checked={salesCommissionsEnabled}
                onCheckedChange={toggleSalesCommissions}
              />
              <SettingRow
                label="الربط الإلكتروني والمزامنة الذكية للمتاجر الأونلاين"
                description="ربط المتجر الإلكتروني (Shopify، متجر مخصص) ومزامنة الطلبات والمخزون تلقائياً"
                checked={ecommerceSyncEnabled}
                onCheckedChange={toggleEcommerceSync}
              />
            </div>
          </SettingsCard>

          {ecommerceSyncEnabled && (
            <SettingsCard
              title="قنوات الربط النشطة"
              badge="Connected Channels"
              description="القنوات الإلكترونية المتصلة حاليًا — يتم تحديث الطلبات والمخزون تلقائياً دون تدخل موظف."
            >
              <div className="space-y-3">
                {channels.map((ch) => (
                  <div
                    key={ch.name}
                    className="flex items-center gap-4 rounded-xl border border-border bg-muted/40 p-4"
                  >
                    <div className="size-10 rounded-lg flex items-center justify-center bg-background border border-border">
                      <ch.icon className="size-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">{ch.name}</p>
                      <p className={cn("text-sm mt-0.5", ch.color)}>{ch.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            </SettingsCard>
          )}

          <SettingsCard
            title="الهوية البصرية ونوع النشاط"
            badge="Brand Identity"
            description="اختر ملف الألوان المناسب لنشاطك التجاري: أزياء وموضة، جمال ومكياج، مؤسسات متكاملة، أو جملة وتوزيع. جميع القوالب تتميز بنسق فاتح وداكن متكاملين."
          >
            <ThemeSwitcher />
          </SettingsCard>

          <SettingsCard title="ميزات النظام" badge="Features">
            <div className="divide-y divide-border">
              <SettingRow
                label="تفعيل نظام الشراكة"
                description="تفعيل هذا الخيار يسمح بإدارة الشركاء وتوزيع الأرباح بينهم"
                checked={partnershipEnabled}
                onCheckedChange={togglePartnership}
              />
              <SettingRow
                label="تفعيل شرط العربون الإلزامي للأوردرات الأونلاين"
                description="عند تفعيله، يطلب النظام إدخال قيمة العربون المدفوع قبل تأكيد أي طلب — مع تعطيل زر الإرسال في حال عدم الإدخال"
                checked={depositMandatory}
                onCheckedChange={toggleDepositMandatory}
              />
            </div>
          </SettingsCard>
        </KeepAliveTab>

        {/* ── الشحن ───────────────────────────────────────────────────── */}
        <KeepAliveTab value="shipping" current={tab}>
          <SettingsCard
            title="أسعار الشحن"
            badge="Shipping"
            description="سعر لكل محافظة ولكل نوع حركة: توصيل، مرتجع، استبدال. ده المصدر الوحيد لأي رسم شحن في النظام."
          >
            <ShippingRateMatrix />
          </SettingsCard>
        </KeepAliveTab>

        {/* ── الفروع ──────────────────────────────────────────────────── */}
        <KeepAliveTab value="branches" current={tab}>
          <BranchesPage />
        </KeepAliveTab>

        {/* ── الصلاحيات ───────────────────────────────────────────────── */}
        <KeepAliveTab value="roles" current={tab}>
          <UserManagementPanel />
        </KeepAliveTab>

        {/* ── النسخ الاحتياطي ─────────────────────────────────────────── */}
        <KeepAliveTab value="backups" current={tab}>
          <BackupsPage />
        </KeepAliveTab>
      </Tabs>
    </div>
  );
}
