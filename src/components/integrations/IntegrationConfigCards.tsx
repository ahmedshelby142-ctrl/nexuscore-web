import { useState } from "react";
import {
  Wallet,
  Truck,
  Globe2,
  Shield,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  ExternalLink,
  Copy,
  Save,
  KeyRound,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Server,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useIntegrationsStore, maskSecret } from "@/store/useIntegrationsStore";
import type { ShippingProvider, OnlineOrderSource } from "@/types";
import { testConnection as testPaymob } from "@/lib/api/integrations/paymob";
import { testConnection as testBosta } from "@/lib/api/integrations/bosta";
import { testConnection as testShopify } from "@/lib/api/integrations/shopify";

interface CredentialFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  onChange: (v: string) => void;
  required?: boolean;
  secret?: boolean;
  mono?: boolean;
}

function CredentialField({
  id,
  label,
  value,
  placeholder,
  hint,
  onChange,
  required,
  secret,
  mono,
}: CredentialFieldProps) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center gap-2">
        <KeyRound className="size-3.5 text-muted-foreground" />
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type={secret && !show ? "password" : "text"}
          value={value}
          placeholder={placeholder ?? "—" + " أدخل القيمة"}
          onChange={(e) => onChange(e.target.value)}
          className={mono ? "font-mono text-sm" : ""}
          dir={mono ? "ltr" : undefined}
        />
        {secret && (
          <Button aria-label="إظهار أو إخفاء المفتاح"
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setShow((s) => !s)}
            title={show ? "إخفاء" : "إظهار"}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {value && secret && !show && (
        <p className="text-[10px] text-muted-foreground/70 font-mono" dir="ltr">
          {maskSecret(value)}
        </p>
      )}
    </div>
  );
}

interface IntegrationCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  enabled: boolean;
  verified: boolean;
  lastVerifiedAt?: Date;
  onToggle: (enabled: boolean) => void;
  onTest?: () => void;
  onReset: () => void;
  docsUrl?: string;
  activationSteps: string[];
  /** Environment variable names this integration reads at runtime. */
  envVars: string[];
  children: React.ReactNode;
}

function IntegrationCard({
  icon: Icon,
  title,
  description,
  enabled,
  verified,
  lastVerifiedAt,
  onToggle,
  onTest,
  onReset,
  docsUrl,
  activationSteps,
  envVars,
  children,
}: IntegrationCardProps) {
  const [showGuide, setShowGuide] = useState(false);
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 p-5 border-b border-border bg-muted/30">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div
            className="size-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "var(--gradient-primary)" }}
          >
            <Icon className="size-5 text-primary-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-base">{title}</h3>
              <Badge variant="outline" className="text-[10px] gap-1">
                <Sparkles className="size-3" /> جاهز للربط
              </Badge>
              {enabled ? (
                <Badge variant="default" className="text-[10px]">
                  مفعّل
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">
                  معطّل
                </Badge>
              )}
              {verified ? (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 text-green-600 border-green-300"
                >
                  <CheckCircle2 className="size-3" /> تم التحقق
                </Badge>
              ) : enabled ? (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 text-amber-600 border-amber-300"
                >
                  <AlertCircle className="size-3" /> يحتاج تحقق
                </Badge>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
            {lastVerifiedAt && (
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                آخر تحقق: {new Date(lastVerifiedAt).toLocaleString("ar-EG")}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch checked={enabled} onCheckedChange={onToggle} aria-label={`تفعيل ${title}`} />
          {docsUrl && (
            <a href={docsUrl} target="_blank" rel="noreferrer">
              <Button variant="ghost" size="icon" title="التوثيق">
                <ExternalLink className="size-4" />
              </Button>
            </a>
          )}
          <Button variant="ghost" size="icon" onClick={onReset} title="إعادة التعيين">
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </div>
      <div
        className={`p-5 space-y-4 ${enabled ? "" : "opacity-60 pointer-events-none select-none"}`}
      >
        {children}
        {onTest && (
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <Button variant="outline" size="sm" onClick={onTest}>
              <Save className="size-3.5 ml-1.5" />
              حفظ وتحقق من اكتمال الحقول
            </Button>
          </div>
        )}

        {/* Activation guide — tells the user how to make this integration real */}
        <div className="rounded-lg border border-dashed border-border bg-muted/30 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowGuide((s) => !s)}
            className="w-full flex items-center justify-between p-3 text-xs font-medium hover:bg-muted/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Server className="size-3.5 text-muted-foreground" />
              دليل التفعيل (للمطور / المنفذ)
            </span>
            {showGuide ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
          {showGuide && (
            <div className="p-3 pt-0 text-xs text-muted-foreground space-y-2">
              <p className="leading-relaxed">
                البطاقة تحفظ الإعدادات محلياً. لتفعيلها فعلياً، يلزم تشغيل طبقة الخادم (التوثيق
                الكامل في <code>PRODUCT.md</code>):
              </p>
              <ol className="list-decimal pr-5 space-y-1 leading-relaxed">
                {activationSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {envVars.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <p className="font-medium text-foreground mb-1">متغيرات البيئة المقابلة:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {envVars.map((v) => (
                      <code
                        key={v}
                        className="text-[10px] font-mono bg-background border border-border px-1.5 py-0.5 rounded"
                        dir="ltr"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Paymob Card ─────────────────────────────────────────────────

export function PaymobSettingsCard() {
  const { paymob, updatePaymob, togglePaymob, markPaymobVerified, resetPaymob } =
    useIntegrationsStore();
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [isTesting, setIsTesting] = useState(false);

  const handleTest = async () => {
    if (!paymob.apiKey || !paymob.integrationId) {
      setTestResult({ ok: false, msg: "أدخل API Key و Integration ID أولاً" });
      markPaymobVerified(false);
      return;
    }
    
    setIsTesting(true);
    try {
      const result = await testPaymob({
        apiKey: paymob.apiKey,
        integrationId: paymob.integrationId,
      });
      setTestResult(result);
      if (result.ok) {
        markPaymobVerified(true);
      } else {
        markPaymobVerified(false);
      }
    } catch (error) {
      setTestResult({ ok: false, msg: "حدث خطأ غير متوقع أثناء الفحص" });
      markPaymobVerified(false);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <IntegrationCard
      icon={Wallet}
      title="بوابة الدفع — Paymob"
      description="استلام المدفوعات الإلكترونية (فيزا / ماستركارد / محافظ / فوري / فاليو) عبر Paymob"
      enabled={paymob.enabled}
      verified={paymob.verified}
      lastVerifiedAt={paymob.lastVerifiedAt}
      onToggle={togglePaymob}
      onTest={isTesting ? undefined : handleTest}
      onReset={resetPaymob}
      docsUrl="https://docs.paymob.com/"
      activationSteps={[
        "شغّل طبقة الخادم (Express/NestJS) وانشر دالة src/lib/api/integrations.server.ts كـ endpoint.",
        "ضع PAYMOB_API_KEY / PAYMOB_HMAC_SECRET في ملف .env (لا تُضفها في الواجهة).",
        "في Paymob Dashboard → Settings → Webhooks، عيّن Callback URL إلى نقطة نهاية webhook الخاصة بك.",
        "نفّذ صيغة HMAC الكاملة في supabase/functions/handle-paymob-webhook/index.ts للتحقق من الاستدعاءات.",
      ]}
      envVars={[
        "PAYMOB_API_KEY",
        "PAYMOB_HMAC_SECRET",
        "PAYMOB_INTEGRATION_ID",
        "PAYMOB_PUBLIC_KEY",
      ]}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>البيئة</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={paymob.environment === "sandbox" ? "default" : "outline"}
              size="sm"
              onClick={() => updatePaymob({ environment: "sandbox" })}
              className="flex-1"
            >
              اختباري
            </Button>
            <Button
              type="button"
              variant={paymob.environment === "production" ? "default" : "outline"}
              size="sm"
              onClick={() => updatePaymob({ environment: "production" })}
              className="flex-1"
            >
              إنتاجي
            </Button>
          </div>
        </div>
        <CredentialField
          id="paymob-integration-id"
          label="Integration ID"
          mono
          value={paymob.integrationId}
          placeholder="مثال: 12345"
          hint="رقم تكامل Paymob (Card / Wallet / Kiosk)"
          onChange={(v) => updatePaymob({ integrationId: v })}
        />
        <CredentialField
          id="paymob-api-key"
          label="API Key"
          secret
          mono
          value={paymob.apiKey}
          placeholder="sk_test_… أو sk_live_…"
          hint="مفتاح API السري من لوحة Paymob"
          onChange={(v) => updatePaymob({ apiKey: v })}
          required
        />
        <CredentialField
          id="paymob-public-key"
          label="Public Key"
          mono
          value={paymob.publicKey}
          placeholder="pk_test_… أو pk_live_…"
          hint="المفتاح العام (آمن للمشاركة مع الواجهة الأمامية)"
          onChange={(v) => updatePaymob({ publicKey: v })}
        />
        <CredentialField
          id="paymob-hmac"
          label="HMAC Secret"
          secret
          mono
          value={paymob.hmacSecret}
          placeholder="مفتاح HMAC لتوقيع الويب هوك"
          hint="يستخدم للتحقق من استدعاءات Paymob العكسية"
          onChange={(v) => updatePaymob({ hmacSecret: v })}
        />
        <CredentialField
          id="paymob-callback"
          label="Callback URL"
          mono
          value={paymob.callbackUrl}
          placeholder="https://yourapp.com/api/paymob/callback"
          hint="الرابط الذي يستدعيه Paymob عند اكتمال الدفع"
          onChange={(v) => updatePaymob({ callbackUrl: v })}
        />
      </div>
      <div className="space-y-1.5">
        <Label>طرق الدفع المقبولة</Label>
        <div className="flex flex-wrap gap-2">
          {(["card", "wallet", "kiosk", "fawry", "valu"] as const).map((m) => {
            const on = paymob.acceptedMethods.includes(m);
            return (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={on ? "default" : "outline"}
                onClick={() =>
                  updatePaymob({
                    acceptedMethods: on
                      ? paymob.acceptedMethods.filter((x) => x !== m)
                      : [...paymob.acceptedMethods, m],
                  })
                }
              >
                {m === "card" && "بطاقة"}
                {m === "wallet" && "محفظة"}
                {m === "kiosk" && "كيوسك"}
                {m === "fawry" && "فوري"}
                {m === "valu" && "فاليو"}
              </Button>
            );
          })}
        </div>
      </div>
      {testResult && (
        <div
          className={`text-xs rounded-lg p-3 ${
            testResult.ok
              ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="inline size-3.5 ml-1" />
          ) : (
            <AlertCircle className="inline size-3.5 ml-1" />
          )}
          {testResult.msg}
        </div>
      )}
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
        <Shield className="size-4 shrink-0 mt-0.5 text-primary" />
        <p>
          مفاتيح Paymob تُحفظ محلياً ويمكن استبدالها بمتغيرات بيئة (PAYMOB_API_KEY /
          PAYMOB_HMAC_SECRET) في الإنتاج. لا تشارك المفتاح السري في الواجهة الأمامية — استخدم الخادم
          فقط.
        </p>
      </div>
    </IntegrationCard>
  );
}

// ── Shipping Card ──────────────────────────────────────────────

export function ShippingIntegrationCard() {
  const { shipping, updateShipping, toggleShipping, markShippingVerified, resetShipping } =
    useIntegrationsStore();
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [isTesting, setIsTesting] = useState(false);

  const handleTest = async () => {
    if (!shipping.apiKey) {
      setTestResult({ ok: false, msg: "أدخل API Key لشركة الشحن أولاً" });
      markShippingVerified(false);
      return;
    }
    
    setIsTesting(true);
    try {
      const result = await testBosta({
        apiKey: shipping.apiKey,
        storeId: shipping.storeId ?? undefined,
      });
      setTestResult(result);
      if (result.ok) {
        markShippingVerified(true);
      } else {
        markShippingVerified(false);
      }
    } catch (error) {
      setTestResult({ ok: false, msg: "حدث خطأ غير متوقع أثناء الفحص" });
      markShippingVerified(false);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <IntegrationCard
      icon={Truck}
      title="شركة الشحن والتوصيل"
      description="إنشاء الشحنات وتتبع حالتها ومطابقة التحصيلات تلقائياً"
      enabled={shipping.enabled}
      verified={shipping.verified}
      lastVerifiedAt={shipping.lastVerifiedAt}
      onToggle={toggleShipping}
      onTest={isTesting ? undefined : handleTest}
      onReset={resetShipping}
      activationSteps={[
        "شغّل طبقة الخادم وانشر دالة createShipment على مزود الشحن المختار (Bosta / Aramex / MyShipping).",
        "ضع SHIPPING_API_KEY / SHIPPING_STORE_ID / SHIPPING_WEBHOOK_SECRET في .env.",
        "في حسابك لدى شركة الشحن، عيّن Webhook URL ليشير إلى supabase/functions/handle-shipping-webhook.",
        "فعّل خيار 'إنشاء شحنة تلقائياً' فقط بعد اختبار يدوي ناجح على شحنة تجريبية.",
      ]}
      envVars={[
        "SHIPPING_API_KEY",
        "SHIPPING_STORE_ID",
        "SHIPPING_WEBHOOK_SECRET",
        "SHIPPING_WEBHOOK_URL",
      ]}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>مزود الشحن</Label>
          <select
            value={shipping.provider}
            onChange={(e) => updateShipping({ provider: e.target.value as ShippingProvider })}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="bosta">Bosta</option>
            <option value="aramex">Aramex</option>
            <option value="myshipping">MyShipping</option>
            <option value="souqpress">SouqPress</option>
            <option value="custom">مزود مخصص (Custom API)</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>البيئة</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={shipping.environment === "sandbox" ? "default" : "outline"}
              size="sm"
              onClick={() => updateShipping({ environment: "sandbox" })}
              className="flex-1"
            >
              اختباري
            </Button>
            <Button
              type="button"
              variant={shipping.environment === "production" ? "default" : "outline"}
              size="sm"
              onClick={() => updateShipping({ environment: "production" })}
              className="flex-1"
            >
              إنتاجي
            </Button>
          </div>
        </div>
        <CredentialField
          id="ship-api-key"
          label="API Key"
          secret
          mono
          value={shipping.apiKey}
          placeholder="المفتاح السري من شركة الشحن"
          onChange={(v) => updateShipping({ apiKey: v })}
          required
        />
        <CredentialField
          id="ship-store-id"
          label="Store / Merchant ID"
          mono
          value={shipping.storeId ?? ""}
          placeholder="معرّف التاجر"
          onChange={(v) => updateShipping({ storeId: v })}
        />
        <CredentialField
          id="ship-webhook-secret"
          label="Webhook Secret"
          secret
          mono
          value={shipping.webhookSecret}
          placeholder="مفتاح توقيع الويب هوك"
          hint="يستخدم للتحقق من تحديثات شركة الشحن"
          onChange={(v) => updateShipping({ webhookSecret: v })}
        />
        <CredentialField
          id="ship-webhook-url"
          label="Webhook URL"
          mono
          value={shipping.webhookUrl}
          placeholder="https://yourapp.com/api/shipping/webhook"
          hint="الرجل الذي تستدعيه شركة الشحن لتحديث الحالة"
          onChange={(v) => updateShipping({ webhookUrl: v })}
        />
      </div>
      <div className="space-y-3 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <div>
            <Label>تتبع تلقائي للشحنات</Label>
            <p className="text-xs text-muted-foreground">
              يقوم النظام بسحب تحديثات الحالة دورياً من واجهة شركة الشحن
            </p>
          </div>
          <Switch
            checked={shipping.autoTrack}
            onCheckedChange={(v) => updateShipping({ autoTrack: v })}
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label>إنشاء شحنة تلقائياً</Label>
            <p className="text-xs text-muted-foreground">
              عند تأكيد طلب إلكتروني، يتم إنشاء شحنة عبر API شركة الشحن دون تدخل يدوي
            </p>
          </div>
          <Switch
            checked={shipping.autoCreateShipment}
            onCheckedChange={(v) => updateShipping({ autoCreateShipment: v })}
          />
        </div>
      </div>
      {testResult && (
        <div
          className={`text-xs rounded-lg p-3 ${
            testResult.ok
              ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="inline size-3.5 ml-1" />
          ) : (
            <AlertCircle className="inline size-3.5 ml-1" />
          )}
          {testResult.msg}
        </div>
      )}
    </IntegrationCard>
  );
}

// ── Online Order Intake Card ───────────────────────────────────

export function OnlineOrderIntakeCard() {
  const {
    onlineOrderIntake,
    updateOnlineOrderIntake,
    toggleOnlineOrderIntake,
    markOnlineOrderIntakeVerified,
    resetOnlineOrderIntake,
  } = useIntegrationsStore();
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [isTesting, setIsTesting] = useState(false);

  const handleTest = async () => {
    if (!onlineOrderIntake.storeUrl) {
      setTestResult({ ok: false, msg: "أدخل رابط المتجر أولاً" });
      markOnlineOrderIntakeVerified(false);
      return;
    }
    
    setIsTesting(true);
    try {
      const result = await testShopify({
        storeUrl: onlineOrderIntake.storeUrl,
        apiKey: onlineOrderIntake.apiKey,
        apiSecret: onlineOrderIntake.apiSecret ?? undefined,
      });
      setTestResult(result);
      if (result.ok) {
        markOnlineOrderIntakeVerified(true);
      } else {
        markOnlineOrderIntakeVerified(false);
      }
    } catch (error) {
      setTestResult({ ok: false, msg: "حدث خطأ غير متوقع أثناء الفحص" });
      markOnlineOrderIntakeVerified(false);
    } finally {
      setIsTesting(false);
    }
  };

  const copyWebhook = () => {
    navigator.clipboard?.writeText(onlineOrderIntake.webhookUrl);
  };

  return (
    <IntegrationCard
      icon={Globe2}
      title="استلام الطلبات الإلكترونية"
      description="مزامنة الطلبات من المتجر الإلكتروني (Shopify / WooCommerce / متجر مخصص) عبر API أو Webhook"
      enabled={onlineOrderIntake.enabled}
      verified={onlineOrderIntake.verified}
      lastVerifiedAt={onlineOrderIntake.lastVerifiedAt}
      onToggle={toggleOnlineOrderIntake}
      onTest={isTesting ? undefined : handleTest}
      onReset={resetOnlineOrderIntake}
      activationSteps={[
        "اختر المصدر (Shopify / WooCommerce / متجر مخصص) — الجدول والـ schema يحفظان استعدادات لكل مصدر.",
        "شغّل supabase/functions/handle-ecommerce-order على البنية التحتية كـ Edge Function أو Deno Deploy.",
        "في إعدادات المتجر، عيّن Webhook URL ليُشير إلى نقطة النهاية، واستخدم HMAC Secret المُولّد في الحقل أدناه.",
        "لاحقاً، عند وجود موقع فعلي: فعّل 'الاستلام التلقائي' وستدخل الطلبات إلى النظام دون موظف داتا إنتري.",
      ]}
      envVars={[
        "ONLINE_ORDER_API_KEY",
        "ONLINE_ORDER_HMAC_SECRET",
        "ONLINE_ORDER_WEBHOOK_URL",
        "ONLINE_ORDER_STORE_URL",
      ]}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>المصدر</Label>
          <select
            value={onlineOrderIntake.source}
            onChange={(e) =>
              updateOnlineOrderIntake({ source: e.target.value as OnlineOrderSource })
            }
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="custom_webstore">متجر مخصص (Custom Webstore)</option>
            <option value="shopify">Shopify</option>
            <option value="woocommerce">WooCommerce</option>
            <option value="manual">يدوي فقط (Manual entry)</option>
          </select>
        </div>
        <CredentialField
          id="oo-store-url"
          label="رابط المتجر"
          mono
          value={onlineOrderIntake.storeUrl}
          placeholder="https://mystore.com"
          onChange={(v) => updateOnlineOrderIntake({ storeUrl: v })}
          required
        />
        <CredentialField
          id="oo-api-key"
          label="API Key"
          secret
          mono
          value={onlineOrderIntake.apiKey}
          placeholder="مفتاح API للمتجر الإلكتروني"
          onChange={(v) => updateOnlineOrderIntake({ apiKey: v })}
        />
        <CredentialField
          id="oo-api-secret"
          label="API Secret (اختياري)"
          secret
          mono
          value={onlineOrderIntake.apiSecret ?? ""}
          placeholder="مفتاح سري إضافي (إن وجد)"
          onChange={(v) => updateOnlineOrderIntake({ apiSecret: v })}
        />
        <CredentialField
          id="oo-webhook-secret"
          label="Webhook Secret"
          secret
          mono
          value={onlineOrderIntake.webhookSecret}
          placeholder="مفتاح توقيع الويب هوك"
          hint="يستخدم للتحقق من الطلبات الواردة من المتجر"
          onChange={(v) => updateOnlineOrderIntake({ webhookSecret: v })}
        />
        <CredentialField
          id="oo-webhook-url"
          label="Webhook URL"
          mono
          value={onlineOrderIntake.webhookUrl}
          placeholder="https://yourapp.com/api/orders/intake"
          onChange={(v) => updateOnlineOrderIntake({ webhookUrl: v })}
        />
        <div className="space-y-1.5 md:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <Label>الاستلام التلقائي</Label>
              <p className="text-xs text-muted-foreground">
                الطلبات الجديدة تدخل النظام تلقائياً دون موظف داتا إنتري
              </p>
            </div>
            <Switch
              checked={onlineOrderIntake.allowAutoIngest}
              onCheckedChange={(v) => updateOnlineOrderIntake({ allowAutoIngest: v })}
            />
          </div>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <Label>إرسال تحديثات الحالة</Label>
              <p className="text-xs text-muted-foreground">
                يقوم النظام بإبلاغ المتجر عند تغيير حالة الطلب (تم الشحن / تم التسليم / مرتجع)
              </p>
            </div>
            <Switch
              checked={onlineOrderIntake.pushStatusUpdates}
              onCheckedChange={(v) => updateOnlineOrderIntake({ pushStatusUpdates: v })}
            />
          </div>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <Label>سحب دوري (Polling)</Label>
              <p className="text-xs text-muted-foreground">
                يقوم النظام بسحب طلبات جديدة من المتجر كل فترة محددة
              </p>
            </div>
            <Switch
              checked={onlineOrderIntake.pollEnabled}
              onCheckedChange={(v) => updateOnlineOrderIntake({ pollEnabled: v })}
            />
          </div>
        </div>
        {onlineOrderIntake.pollEnabled && (
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="oo-poll-interval">فترة السحب (بالدقائق)</Label>
            <Input
              id="oo-poll-interval"
              type="number"
              min={5}
              max={1440}
              value={onlineOrderIntake.pollIntervalMinutes}
              onChange={(e) =>
                updateOnlineOrderIntake({ pollIntervalMinutes: Number(e.target.value) || 15 })
              }
            />
          </div>
        )}
      </div>
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={copyWebhook}
          disabled={!onlineOrderIntake.webhookUrl}
        >
          <Copy className="size-3.5 ml-1.5" />
          نسخ رابط الويب هوك
        </Button>
      </div>
      {testResult && (
        <div
          className={`text-xs rounded-lg p-3 ${
            testResult.ok
              ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="inline size-3.5 ml-1" />
          ) : (
            <AlertCircle className="inline size-3.5 ml-1" />
          )}
          {testResult.msg}
        </div>
      )}
    </IntegrationCard>
  );
}
