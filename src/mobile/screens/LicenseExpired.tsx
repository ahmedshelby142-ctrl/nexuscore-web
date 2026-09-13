import { AlertTriangle, RefreshCw } from "lucide-react";
import { Navigate } from "react-router-dom";
import { isUsable } from "@/lib/license/evaluate";
import { useStoreLicense } from "@/store/useStoreLicense";

export function MobileLicenseExpired() {
  const { decision, resolved, checking, refresh } = useStoreLicense();

  if (resolved && decision && isUsable(decision.verdict)) {
    return <Navigate to="/" replace />;
  }

  const title =
    decision?.verdict === "suspended"
      ? "تم إيقاف الوصول مؤقتاً"
      : decision?.verdict === "unlicensed"
        ? "لا يوجد ترخيص نشط"
        : "انتهى ترخيص المتجر";

  return (
    <main className="mobile-state mobile-license-state" dir="rtl" aria-live="polite">
      <AlertTriangle className="mobile-license-icon" aria-hidden="true" />
      <h1>{title}</h1>
      <p>{decision?.messageAr ?? "جارٍ التحقق من حالة الترخيص…"}</p>
      <button type="button" className="mobile-primary-button" disabled={checking} onClick={() => void refresh()}>
        <RefreshCw className={checking ? "mobile-spin" : ""} aria-hidden="true" />
        {checking ? "جارٍ التحقق…" : "إعادة التحقق"}
      </button>
      <small>لا يمكن تجديد أو تغيير الترخيص من تطبيق العمليات.</small>
    </main>
  );
}
