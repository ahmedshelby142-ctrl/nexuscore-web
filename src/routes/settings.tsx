import { useState } from "react";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useSubscriptionStore } from "@/store/useSubscriptionStore";
import { useFeatureStore } from "@/store/useFeatureStore";
import { useAuthStore } from "@/store/useAuthStore";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { ShippingRateMatrix } from "@/components/shipping/ShippingRateMatrix";
import { GeneralSettingsPanel } from "@/components/settings/GeneralSettingsPanel";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { DEV_RESET_AVAILABLE, resetTestData } from "@/lib/devReset";
import { ShoppingBag, Store, Trash2 } from "lucide-react";

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
  // Dev-only test-data reset. `import.meta.env.DEV` keeps it out of the
  // production bundle entirely; the Rust command refuses the call in a
  // release build as well.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const { partnershipEnabled, togglePartnership } = useBusinessStore();
  const { isProPlan, setProPlan } = useSubscriptionStore();
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

  // Non-owner staff see only personal theme preferences
  if (userRole !== "owner") {
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
    <div className="space-y-6 max-w-4xl mx-auto w-full">
      <div className="pb-1">
        <h2 className="text-3xl font-display font-bold tracking-tight">الإعدادات</h2>
        <p className="text-muted-foreground mt-1">تكوين النظام والميزات والهوية البصرية</p>
      </div>

      <SettingsCard
        title="بيانات المحل"
        badge="General"
        description="معلومات المحل الأساسية والإعدادات الضريبية التي تظهر في الفواتير."
      >
        <GeneralSettingsPanel />
      </SettingsCard>

      <SettingsCard
        title="أسعار الشحن"
        badge="Shipping"
        description="سعر لكل محافظة ولكل نوع حركة: توصيل، مرتجع، استبدال. ده المصدر الوحيد لأي رسم شحن في النظام."
      >
        <ShippingRateMatrix />
      </SettingsCard>

      <SettingsCard
        title="الهوية البصرية ونوع النشاط"
        badge="Brand Identity"
        description="اختر ملف الألوان المناسب لنشاطك التجاري: أزياء وموضة، جمال ومكياج، مؤسسات متكاملة، أو جملة وتوزيع. جميع القوالب تتميز بنسق فاتح وداكن متكاملين."
      >
        <ThemeSwitcher />
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

      <SettingsCard title="حالة الاشتراك" badge="Subscription">
        <div className="divide-y divide-border">
          <SettingRow
            label="الخطة الاحترافية (Pro Plan)"
            description="تفعيل هذا الخيار يفتح ميزات التكامل متعدد القنوات والتحليلات المتقدمة"
            checked={isProPlan}
            onCheckedChange={setProPlan}
          />

          {isProPlan && (
            <div className="rounded-lg bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 p-4">
              <p className="text-sm font-medium text-green-900 dark:text-green-300">
                ✓ الخطة الاحترافية مفعلة
              </p>
              <p className="text-xs text-green-700 dark:text-green-400 mt-1">
                يمكنك الآن استخدام ميزات التكامل متعدد القنوات والتحليلات المتقدمة
              </p>
            </div>
          )}
        </div>
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

      {DEV_RESET_AVAILABLE && (
        <SettingsCard title="أدوات التطوير" badge="Dev">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-medium">تصفير بيانات التجربة</p>
              <p className="text-sm text-muted-foreground mt-1">
                يمسح دفتر الحسابات (كل الحركات) والمنتجات والعملاء والطلبات والإعدادات المحفوظة،
                ويرجّع البرنامج زي أول تشغيل. للتجربة بس — مش موجود في النسخة النهائية.
              </p>
              {resetError && <p className="text-sm text-destructive mt-2">{resetError}</p>}
            </div>
            <Button variant="destructive" className="gap-2" onClick={() => setResetOpen(true)}>
              <Trash2 className="size-4" />
              تصفير بيانات التجربة
            </Button>
          </div>

          <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>متأكد إنك عايز تصفّر كل بيانات التجربة؟</AlertDialogTitle>
                <AlertDialogDescription>
                  هيتمسح كل حاجة: الحركات في الدفتر، المنتجات، العملاء، الطلبات، الخزائن
                  والإعدادات. البرنامج هيرجع لأول تشغيل وهيطلب تسجيل الدخول من جديد. مفيش رجوع في
                  الخطوة دي.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>إلغاء</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    setResetError(null);
                    // The page reloads on success, so there is nothing to do
                    // after this but report a failure.
                    void resetTestData().catch((err: unknown) => {
                      setResetError(
                        `التصفير مانجحش، ومحصلش أي مسح. ${err instanceof Error ? err.message : String(err)}`,
                      );
                      setResetOpen(false);
                    });
                  }}
                >
                  تأكيد التصفير
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SettingsCard>
      )}
    </div>
  );
}
