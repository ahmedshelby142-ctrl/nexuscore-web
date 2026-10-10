import { useWholesaleEnabled } from "@/hooks/useWholesaleEnabled";
import { useSettingsStore } from "@/store/useSettingsStore";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

export function WholesaleFeatureSetting() {
  const enabled = useWholesaleEnabled();
  const { wholesaleStatus: status, wholesaleError: error, pullWholesaleFeature, saveWholesaleFeature } = useSettingsStore();
  return (
    <div className="py-4 space-y-3" dir="rtl" aria-busy={status === "loading" || status === "saving"}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 id="wholesale-setting-title" className="font-medium">مبيعات الجملة</h3>
          <p id="wholesale-setting-description" className="text-sm text-muted-foreground mt-1">التحكم في إظهار أو إخفاء قسم مبيعات الجملة من النظام.</p>
        </div>
        <Switch aria-labelledby="wholesale-setting-title" aria-describedby="wholesale-setting-description wholesale-setting-warning" checked={enabled} disabled={status !== "ready"} onCheckedChange={(value) => void saveWholesaleFeature(value)} />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {status === "loading" || status === "idle" ? "جاري تحميل الإعداد…" : status === "saving" ? "جاري حفظ الإعداد…" : enabled ? "تفعيل مبيعات الجملة" : "إيقاف مبيعات الجملة"}
      </p>
      <p id="wholesale-setting-warning" className="text-sm rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 whitespace-pre-line">{"تنبيه: مبيعات الجملة قيد المراجعة الفنية،\nولا يُنصح باستخدامها في العمليات المالية\nحتى اكتمال اختبارها واعتمادها."}</p>
      {error && <div role="alert" className="text-sm text-destructive space-y-2"><p>{error}</p><Button variant="outline" onClick={() => void pullWholesaleFeature()}>إعادة المحاولة</Button></div>}
    </div>
  );
}
