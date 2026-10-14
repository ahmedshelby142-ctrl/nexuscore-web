import { fulfillmentSummary, type OrderFulfillment } from "@/lib/orderFulfillment";

/** The same saved demand in Desktop and Mobile; no local stock allocation. */
export function OrderFulfillmentPanel({ fulfillment }: { fulfillment?: OrderFulfillment | null }) {
  const summary = fulfillmentSummary(fulfillment);
  if (!summary) return null;
  return <section aria-label="حجز الطلب والنواقص" className="rounded-xl border p-3 text-sm" dir="rtl">
    <p className="font-semibold">{summary.ready ? "حجز الطلب مكتمل" : "الطلب ينتظر استكمال التوريد"}</p>
    {!summary.valid ? <p role="alert">تعذّر تأكيد الحجز؛ حدّث بيانات الطلب قبل الشحن.</p> : <>
      <p>وحدات المكونات: مطلوب {summary.requested} — محجوز {summary.allocated} — ناقص {summary.missing}</p>
      <ul>{fulfillment?.demands?.map(d => <li key={d.id}>
        {d.productName || d.productId}{d.variantName ? ` — ${d.variantName}` : ""}: مطلوب {d.quantity}، محجوز {d.allocated}، ناقص {d.missing}
      </li>)}</ul>
      {!summary.ready && <p>الشحن والتسليم متوقفان حتى اكتمال الحجز. التوريد لا يُسجّل بيعًا أو تحصيلًا جديدًا.</p>}
    </>}
  </section>;
}
