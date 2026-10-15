import { MobileSection } from "./MobileSection";
import { formatArabicCount, formatArabicQuantity } from "@/mobile/viewmodels/formatters";
import type { BundleComponentDetail } from "@/lib/bundleDetails";

export function MobileBundleContents({ components,titleAr="مكونات البوكس",captionAr }: { components: readonly BundleComponentDetail[];titleAr?:string;captionAr?:string }) {
  return <MobileSection titleAr={titleAr}>
    {components.length === 0 ? <p className="mobile-muted">لا توجد مكونات محفوظة لهذا البوكس.</p> : <>
      <p className="mobile-muted">{captionAr??"الكميات التالية داخل بوكس واحد"} · بنود المكونات: {formatArabicCount(components.length)}</p>
      <ul className="space-y-3" aria-label="مكونات البوكس">
        {components.map((component, index) => <li
          key={`${component.productId}:${component.variantName ?? ""}:${index}`}
          className="flex min-w-0 items-start justify-between gap-3 border-b pb-2">
          <div className="min-w-0 break-words">
            <strong>{component.productName}</strong>
            {component.variantName && <p>الدرجة / اللون / المقاس: <bdi>{component.variantName}</bdi></p>}
            {component.sku && <p className="mobile-muted">SKU: <bdi>{component.sku}</bdi></p>}
            {component.unavailable && <p className="mobile-muted">تعذّر تحميل بيانات المنتج الحالية · <bdi>{component.productId || "بدون مرجع"}</bdi></p>}
            {component.variantUnavailable && <p className="mobile-muted">الدرجة المحفوظة غير متاحة حاليًا.</p>}
          </div>
          <span className="shrink-0">{component.quantity === null ? "كمية غير صالحة" : `عدد ${formatArabicQuantity(component.quantity)}`}</span>
        </li>)}
      </ul>
    </>}
  </MobileSection>;
}
