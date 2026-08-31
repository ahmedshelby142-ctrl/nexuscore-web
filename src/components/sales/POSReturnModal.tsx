import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Receipt, ArrowLeftRight } from "lucide-react";
import { events, eventLines, fromPiastres } from "@/lib/ledger";
import type { LedgerEvent } from "@/lib/ledger";
import { useBusinessStore } from "@/store/useBusinessStore";

interface POSReturnModalProps {
  onReturnItem: (product: any, variantName?: string) => void;
  trigger?: React.ReactNode;
}

export function POSReturnModal({ onReturnItem, trigger }: POSReturnModalProps) {
  const products = useBusinessStore(state => state.products);
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [receipts, setReceipts] = useState<(LedgerEvent & { parsedLines?: any[] })[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setError("");
    setReceipts([]);

    try {
      const rawEvents = await events({ refType: "pos_sale", limit: 100 });
      
      const filtered = rawEvents.filter(ev => {
        const payloadStr = JSON.stringify(ev.payload || {});
        return ev.id.includes(searchQuery) || payloadStr.includes(searchQuery);
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

  const loadLines = async (rec: LedgerEvent) => {
    try {
      const lines = await eventLines(rec.id);
      
      // We want revenue lines that have subject_id (which is productId) and amount > 0
      const revenueLines = lines.filter(l => l.account === "revenue" && l.amount_delta > 0);
      
      // Get stock lines to find quantity
      const stockLines = lines.filter(l => l.account === "stock" && l.qty_delta < 0);

      const parsedLines = revenueLines.map(rl => {
        // Find matching stock line
        const sl = stockLines.find(s => s.subject_id === rl.subject_id);
        const qty = sl ? Math.abs(sl.qty_delta) : 1;
        const unitPrice = fromPiastres(rl.amount_delta) / qty;

        const product = products.find((p: any) => String(p.id) === String(rl.subject_id));
        let name = product?.name || "منتج غير معروف";
        let variantName = undefined;

        try {
          if (typeof rec.payload === "object" && rec.payload && "items" in rec.payload) {
            const pItems = (rec.payload as any).items as any[];
            const match = pItems.find(pl => String(pl.productId) === String(rl.subject_id));
            if (match && match.variantName) {
              variantName = match.variantName;
            }
            if (match && match.productName && !product) {
              name = match.productName;
            } else if (match && match.name && !product) {
              name = match.name;
            }
          } else if (typeof rec.payload === "object" && rec.payload && "lines" in rec.payload) {
            const pLines = (rec.payload as any).lines as any[];
            const match = pLines.find(pl => Math.abs(pl.qty) === qty);
            if (match && match.variantName) variantName = match.variantName;
            if (match && match.name && !product) name = match.name;
          }
        } catch {
          // Deliberately swallowed, and narrowly so: everything in this block
          // only resolves a nicer DISPLAY name/variant for the returned line.
          // The refund amount and quantity above do not depend on it, so a
          // malformed payload must degrade to the raw name rather than take
          // the whole return modal down.
        }

        return {
          productId: rl.subject_id,
          name,
          unitPrice,
          qty,
          variantName,
          product
        };
      });

      setReceipts(prev => prev.map(p => p.id === rec.id ? { ...p, parsedLines } : p));
    } catch (e) {
      console.error(e);
    }
  };

  const handleReturn = (line: any, rec: LedgerEvent) => {
    onReturnItem(line.product || { id: line.productId, name: line.name, unitPrice: line.unitPrice }, line.variantName);
    // don't close modal immediately, they might return multiple things
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
        </DialogHeader>

        <div className="flex gap-2 mt-4">
          <Input
            placeholder="ابحث برقم الفاتورة أو رقم هاتف العميل..."
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
          {receipts.map((rec) => (
            <div key={rec.id} className="border border-border rounded-xl p-4 bg-muted/20">
              <div className="flex justify-between items-center mb-3">
                <div>
                  <span className="text-xs font-mono text-muted-foreground ml-2">{rec.id.split("-")[0]}</span>
                  <span className="text-sm font-medium">{new Date(rec.occurredAt).toLocaleDateString("ar-EG")}</span>
                </div>
                {!rec.parsedLines && (
                  <Button variant="ghost" size="sm" onClick={() => loadLines(rec)}>
                    عرض المنتجات
                  </Button>
                )}
              </div>
              <div className="space-y-2">
                {!rec.parsedLines && (
                  <p className="text-xs text-muted-foreground italic">
                    اضغط "عرض المنتجات" لتحميل الفاتورة...
                  </p>
                )}
                {rec.parsedLines && rec.parsedLines.map((line, idx) => (
                  <div key={idx} className="flex items-center justify-between bg-background p-2 rounded border border-border">
                    <div>
                      <p className="text-sm font-medium">
                        {line.name} {line.variantName ? `- (${line.variantName})` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">{line.unitPrice.toLocaleString("ar-EG")} ج.م (الكمية: {line.qty})</p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => handleReturn(line, rec)}>
                      <ArrowLeftRight className="size-3 ml-1" />
                      إرجاع 1
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
