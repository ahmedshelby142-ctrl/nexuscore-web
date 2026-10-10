import { useRef, useState } from "react";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useFeatureStore } from "@/store/useFeatureStore";
import { useAuthStore } from "@/store/useAuthStore";
import { toAppRole } from "@/lib/roles";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { ShippingRateMatrix } from "@/components/shipping/ShippingRateMatrix";
import { GeneralSettingsPanel } from "@/components/settings/GeneralSettingsPanel";
import { WholesaleFeatureSetting } from "@/components/settings/WholesaleFeatureSetting";
import { BranchesPage } from "@/routes/branches";
import { BackupsPage } from "@/routes/backups";
import { UserManagementPanel } from "@/components/auth/UserManagementPanel";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

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
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  /** Not in this release: shown switched off, and cannot be switched on. */
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
      <div className="ml-4 flex-1">
        <h3 className="font-medium">{label}</h3>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        disabled={disabled}
      />
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

export function Settings() {
  const userRole = useAuthStore((s) => s.userRole);
  const { partnershipEnabled, togglePartnership } = useBusinessStore();
  const {
    returnsEnabled,
    ecommerceSyncEnabled,
    depositMandatory,
    toggleReturns,
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
            description="تشغيل أو إيقاف شاشات المرتجعات وربط المتجر الإلكتروني. تتبع الشحن الآلي والعمولات والمزامنة التلقائية غير متاحة حاليًا."
          >
            <div className="divide-y divide-border">
              <SettingRow
                label="نظام المرتجعات والاستبدال المتقدم"
                description="تفعيل نظام متكامل لإدارة مرتجعات العملاء واستبدال المنتجات مع تتبع الأسباب"
                checked={returnsEnabled}
                onCheckedChange={toggleReturns}
              />
              {/* Neither switch was wired to anything: no tracking feed and
                  no commission engine exist in this release. Shown off and
                  locked rather than as working options. The shipping itself
                  (rates, couriers, settlement) is always on and needs no switch. */}
              <SettingRow
                label="تتبع المناديب الآلي"
                description="غير متاح حاليًا — حالات الشحن بتتسجل يدويًا من شاشة الطلبات، وحسابات المناديب من «حسابات الشحن»."
                checked={false}
                onCheckedChange={() => {}}
                disabled
              />
              <SettingRow
                label="حساب عمولات موظفي المبيعات والمناديب"
                description="غير متاح حاليًا."
                checked={false}
                onCheckedChange={() => {}}
                disabled
              />
              <SettingRow
                label="شاشة ربط المتجر الإلكتروني"
                description="إظهار شاشة «ربط المتجر الإلكتروني» في القائمة. الطلبات والمخزون بيتسجلوا يدويًا — المزامنة التلقائية مع Shopify أو متجر مخصص غير متاحة حاليًا."
                checked={ecommerceSyncEnabled}
                onCheckedChange={toggleEcommerceSync}
              />
            </div>
          </SettingsCard>

          <SettingsCard
            title="الهوية البصرية ونوع النشاط"
            badge="Brand Identity"
            description="اختر ملف الألوان المناسب لنشاطك التجاري: أزياء وموضة، جمال ومكياج، مؤسسات متكاملة، أو جملة وتوزيع. جميع القوالب تتميز بنسق فاتح وداكن متكاملين."
          >
            <ThemeSwitcher />
          </SettingsCard>

          <SettingsCard title="ميزات النظام" badge="Features">
            <div className="divide-y divide-border">
              <WholesaleFeatureSetting />
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

          {/* ── قواعد ثابتة، مش إعدادات ──────────────────────────────────
              Stated, never switchable. These decide money, and a toggle here
              would be a way to configure an invalid financial policy — a shop
              could "turn off" the forfeit and start refunding deposits, or
              "turn on" charging the customer for the shop's own mistake.

              Responsibility is chosen per movement, on the document, from
              `RETURN_CAUSES`. What each choice COSTS is fixed. */}
          <SettingsCard
            title="قواعد المرتجعات والاستبدال والعربون"
            badge="Policy"
            description="قواعد ثابتة — بتتسجّل مع كل مرتجع أو استبدال، ومش قابلة للتغيير من هنا."
          >
            <div className="space-y-3 text-sm">
              <div className="rounded-xl border border-border p-3">
                <p className="font-semibold">العربون</p>
                <p className="text-muted-foreground mt-1">
                  العربون <span className="font-semibold">ميترجعش</span> لما العميلة تلغي الطلب أو
                  ترفضه — الرحلة اتعملت واتدفعت. بيتسجّل كإيراد باسم «عربون محتجز»، مش كمبيعات.
                </p>
              </div>
              <div className="rounded-xl border border-border p-3">
                <p className="font-semibold">المسؤول المالي بيتحدد بالسبب، مش بمين طلب</p>
                <ul className="text-muted-foreground mt-1 space-y-1 list-disc pr-4">
                  <li>
                    <span className="font-medium">خطأ من المحل أو عيب في المنتج</span> — التكلفة على
                    المحل، ومش بتتحسب على العميلة.
                  </li>
                  <li>
                    <span className="font-medium">خطأ من المندوب / شركة الشحن</span> — تعويض علينا من
                    شركة الشحن، ومش على العميلة.
                  </li>
                  <li>
                    <span className="font-medium">تغيير رغبة العميلة</span> — دي الحالة الوحيدة اللي
                    الاستبدال أو المرتجع فيها على العميلة.
                  </li>
                </ul>
                <p className="text-muted-foreground mt-2">
                  إن العميلة هي اللي طلبت الاستبدال ده <span className="font-semibold">مش</span> معناه
                  إنها المسؤولة — السبب هو اللي بيحدد.
                </p>
              </div>
              <div className="rounded-xl border border-border p-3">
                <p className="font-semibold">لازم تحدد السبب</p>
                <p className="text-muted-foreground mt-1">
                  مفيش مرتجع أو استبدال بيتأكد من غير سبب — السبب هو اللي بيحدد الشحن على مين،
                  والعربون، والتقارير.
                </p>
              </div>
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
