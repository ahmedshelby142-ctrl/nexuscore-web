import { WholesalePage } from "@/components/wholesale/WholesalePage";
import { useWholesaleEnabled } from "@/hooks/useWholesaleEnabled";
import { useSettingsStore } from "@/store/useSettingsStore";
import { Button } from "@/components/ui/button";

export function Wholesale() {
  const enabled = useWholesaleEnabled();
  const status = useSettingsStore((s) => s.wholesaleStatus);
  const retry = useSettingsStore((s) => s.pullWholesaleFeature);
  if (!enabled) return <div dir="rtl" role="status" className="rounded-xl border p-6 space-y-3">
    <p>{status === "idle" || status === "loading" ? "جاري التحقق من إتاحة مبيعات الجملة…" : status === "failed" ? "تعذّر التحقق من إتاحة مبيعات الجملة." : "مبيعات الجملة غير متاحة حاليًا لهذا المحل."}</p>
    {status === "failed" && <Button variant="outline" onClick={() => void retry()}>إعادة المحاولة</Button>}
  </div>;
  return <WholesalePage />;
}
