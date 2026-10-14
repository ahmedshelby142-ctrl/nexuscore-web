/**
 * استرجاع بفاتورة — pick a past POS receipt and bring one of its lines back.
 *
 * The lines come from the sale DOCUMENT (`payload.items`), never from the
 * ledger's aggregate rows and never from today's catalog. See the header of
 * `@/lib/posReturn` for what the old reconstruction did and why every one of
 * its three symptoms had the same cause.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Receipt, ArrowLeftRight } from "lucide-react";
import { events, eventLines } from "@/lib/ledger";
import type { LedgerEvent } from "@/lib/ledger";
import { formatMoney } from "@/lib/math";
import {PosReceiptDetails} from "./PosReceiptDetails";
import { posDocumentNumber } from "@/lib/documentIdentity";
import { useBusinessStore } from "@/store/useBusinessStore";
import {
  priorReturnsFrom,
  remainingSaleLines,
  costedReturnLine,
  originalPosCustomer,
  type PriorPosReturn,
  type ReturnableSaleLine,
} from "@/lib/posReturn";

/** What the cart is handed back: the historical line, plus where it came from. */
export interface PosReturnPick {
  line: ReturnableSaleLine;
  sourceEventId: string;
  sourceDocumentNumber: string;
  customer: ReturnType<typeof originalPosCustomer>;
  /** Today's catalog row, when it still exists — for stock and variants only. */
  product?: any;
}

interface POSReturnModalProps {
  onReturnItem: (pick: PosReturnPick) => void;
  trigger?: React.ReactNode;
}

export function POSReturnModal({ onReturnItem, trigger }: POSReturnModalProps) {
  const products = useBusinessStore((state) => state.products);
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [receipts, setReceipts] = useState<LedgerEvent[]>([]);
  const [priorReturns, setPriorReturns] = useState<PriorPosReturn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewReceipt,setViewReceipt]=useState<string|null>(null);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setError("");
    setReceipts([]);setViewReceipt(null);

    try {
      const rawEvents = await events({ refType: "pos_sale", receiptSearch: searchQuery.trim() });

      // Every past return, whichever receipt it belongs to, so the returnable
      // ceiling below is the real one. Derived from the events themselves —
      // there is no counter to drift.
      setPriorReturns(priorReturnsFrom(rawEvents as any));

      const query = searchQuery.trim().toLowerCase();
      const filtered = rawEvents.filter((ev) => {
        // A return is itself a `pos_sale`; it is not a receipt to return from.
        if ((ev.payload as any)?.returnOfEventId) return false;
        const payloadStr = JSON.stringify(ev.payload || {}).toLowerCase();
        return ev.id.toLowerCase().includes(query) || payloadStr.includes(query);
      });

      setReceipts(filtered);
      if (filtered.length === 0) {
        setError("لم يتم العثور على فواتير تطابق بحثك.");
      }
    } catch (e) {
      setError("حدث خطأ أثناء البحث عن الفواتير.");
    } finally {
      setLoading(false);
    }
  };

  const handleReturn = async (line: ReturnableSaleLine, rec: LedgerEvent) => {
    setLoading(true);
    try {
    const product = products.find((p: any) => String(p.id) === String(line.productId));
    const costed = costedReturnLine(rec, line, await eventLines(rec.id), Boolean(product?.isBundle));
    onReturnItem({
      line: costed,
      sourceEventId: rec.id,
      sourceDocumentNumber: posDocumentNumber(rec),
      customer: originalPosCustomer(rec),
      // Passed for stock/variant handling only. The NAME and the PRICE come
      // off the receipt — a product renamed or repriced since the sale must
      // not rewrite what the customer was charged.
      product,
    });
    setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            استرجاع بفاتورة
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            <Receipt className="size-5" />
            البحث في فواتير البيع (استرجاع)
          </DialogTitle>
          <DialogDescription>ابحث بالرقم المحفوظ أو الهاتف، ثم اختر البند من فاتورته الأصلية. تعرض النتائج حتى 100 فاتورة مطابقة.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 mt-4">
          <Input
            placeholder="ابحث برقم الفاتورة أو رقم هاتف العميل..."
            aria-label="رقم الفاتورة أو هاتف العميل"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <Button onClick={handleSearch} disabled={loading}>
            <Search className="size-4 ml-2" />
            بحث
          </Button>
        </div>

        {error && <p className="text-red-500 text-sm mt-2">{error}</p>}

        <div className="space-y-4 mt-6">
          {receipts.map((rec) => {
            // No async load step: the lines are already in the event's own
            // payload. The old "عرض المنتجات" button existed because the lines
            // had to be fetched separately and then guessed at.
            const lines = remainingSaleLines(rec as any, priorReturns);
            const customerName = (rec.payload as any)?.customerName;

            return (
              <div key={rec.id} className="border border-border rounded-xl p-4 bg-muted/20">
                <div className="flex justify-between items-center mb-3 gap-2 flex-wrap">
                  <div>
                    <span className="text-xs font-mono text-muted-foreground ml-2">
                      <bdi>{posDocumentNumber(rec)}</bdi>
                    </span>
                    <span className="text-sm font-medium">
                      {new Date(rec.occurredAt).toLocaleString("ar-EG")}
                    </span>
                  </div>
                  {customerName && (
                    <span className="text-xs text-muted-foreground">{customerName}</span>
                  )}
                </div>

                <Button type="button" variant="outline" size="sm" onClick={()=>setViewReceipt(viewReceipt===rec.id?null:rec.id)}>عرض الإيصال المحفوظ</Button>
                {viewReceipt===rec.id&&<PosReceiptDetails eventId={rec.id}/>}
                <div className="space-y-2">
                  {lines.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">
                      الفاتورة دي مفيهاش تفاصيل أصناف محفوظة — الاسترجاع منها لازم يتعمل يدوي.
                    </p>
                  )}
                  {lines.map((line) => (
                    <div
                      key={line.key}
                      className="flex items-center justify-between gap-2 bg-background p-2 rounded border border-border"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {line.productName}
                          {line.variantName ? ` — (${line.variantName})` : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatMoney(line.unitPrice)} × {line.sold}
                          {line.returned > 0 ? ` — رجع منها ${line.returned}` : ""}
                        </p>
                      </div>
                      {line.remaining > 0 ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="shrink-0"
                          disabled={loading}
                          onClick={() => handleReturn(line, rec)}
                        >
                          <ArrowLeftRight className="size-3 ml-1" />
                          إرجاع 1 (فاضل {line.remaining})
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground shrink-0">رجعت كلها</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
