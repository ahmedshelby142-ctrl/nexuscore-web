import {SHORTAGE_FOLLOWUP_LABELS} from "@/lib/orderFulfillment";
import {listShortageFollowups,type ShortageFollowup} from "@/services/shortageFollowups";
import {Dialog,DialogContent,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import {ShortageFollowupPanel} from "@/components/ecommerce/ShortageFollowupPanel";
/**
 * تقرير النواقص وطلبات التوريد — Shortages & Backorders.
 *
 * The table. The arithmetic behind it — why the deficit is the measured
 * `shortfall` rather than "ordered minus stock", and why "open" means
 * `pending` only — lives in `lib/shortages.ts`, which is pure and has a
 * self-check beside it.
 */

import { useMemo, useState, useEffect } from "react";
import { AlertTriangle, PackageSearch, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useOrderStore } from "@/store/useOrderStore";
import { computeShortages, type ShortageRow } from "@/lib/shortages";
import { printTableAsPdf } from "@/lib/pdfGenerator";
import { formatQty } from "@/lib/math";

export function ShortagesReport() {
  const products = useBusinessStore((s) => s.products);
  const orders = useOrderStore((s) => s.orders);

  const [query, setQuery] = useState("");
  const [followup,setFollowup]=useState<{orderId:string;orderNumber:string;customerName?:string;customerPhone?:string;demandSummary:string}|null>(null);
  const allRows = useMemo(() => computeShortages(orders, products), [orders, products]);
  const [followupState,setFollowupState]=useState("all"),[followupTick,setFollowupTick]=useState(0);
  const [notesByOrder,setNotesByOrder]=useState<Map<string,ShortageFollowup>>(new Map());
  const [notesLoading,setNotesLoading]=useState(true),[notesError,setNotesError]=useState("");
  const orderIds=[...new Set(allRows.filter(r=>r.allocated!=null).flatMap(r=>r.waitingOrders.map(w=>w.orderId)))].sort().join(",");
  useEffect(()=>{
    let active=true;setNotesLoading(true);setNotesError("");setNotesByOrder(new Map());
    void listShortageFollowups(orderIds?orderIds.split(","):[]).then(rows=>{if(active)setNotesByOrder(new Map(rows.map(r=>[r.order_id,r])));})
      .catch(error=>{if(active)setNotesError(error instanceof Error?error.message:String(error));})
      .finally(()=>{if(active)setNotesLoading(false);});
    return()=>{active=false;};
  },[orderIds,followupTick]);
  const needle=query.trim().toLowerCase();
  const rows=allRows.map(row=>{
    if(followupState==="all"||notesLoading||notesError)return row;
    if(row.allocated==null)return followupState==="legacy_review"?row:null;
    const waitingOrders=row.waitingOrders.filter(w=>(notesByOrder.get(w.orderId)?.state??"waiting")===followupState);
    if(!waitingOrders.length)return null;
    return {...row,waitingOrders,orderCount:waitingOrders.length,required:waitingOrders.reduce((n,w)=>n+Number(w.requested??0),0),
      allocated:waitingOrders.reduce((n,w)=>n+Number(w.allocated??0),0),deficit:waitingOrders.reduce((n,w)=>n+Number(w.missing??0),0)};
  }).filter((r):r is ShortageRow=>!!r&&r.deficit>0).filter(r=>!needle||[r.productName,r.sku,...r.waitingOrders.flatMap(w=>[w.orderNumber,w.customerName,w.customerPhone,notesByOrder.get(w.orderId)?.notes])].join(" ").toLowerCase().includes(needle));
  const totalDeficit=rows.reduce((n,r)=>n+r.deficit,0);

  const handleExportPdf = () =>
    printTableAsPdf({
      title: "تقرير النواقص وطلبات التوريد",
      columns: [
        { label: "المنتج", accessor: (r: ShortageRow) => r.productName },
        { label: "SKU", accessor: (r: ShortageRow) => r.sku, align: "center" },
        { label: "المتاح للبيع", accessor: (r: ShortageRow) => String(r.stock), align: "center" },
        { label: "المخصص للطلبات", accessor: (r: ShortageRow) => r.allocated == null ? "سجل قديم" : String(r.allocated), align: "center" },
        { label: "المطلوب بالطلبات", accessor: (r: ShortageRow) => String(r.required), align: "center" },
        { label: "العجز (للتوريد/التصنيع)", accessor: (r: ShortageRow) => String(r.deficit), align: "center" },
        {
          label: "الطلبات المنتظرة",
          accessor: (r: ShortageRow) =>
            r.waitingOrders.map((o) => `${o.orderNumber} (${o.customerName})`).join("، ") || "—",
        },
      ],
      rows,
      footer: `عدد المنتجات الناقصة: ${rows.length} — إجمالي العجز: ${totalDeficit} وحدة`,
    });

  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs tracking-wider text-muted-foreground">النواقص</p>
          <h3 className="font-display text-2xl font-bold mt-1 flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-600" />
            تقرير النواقص وطلبات التوريد
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            الطلبات الجديدة تعرض المطلوب والمخصص والناقص لكل درجة. النقص يُغلق بتخصيص التوريد الفعلي؛ السجلات القديمة تحتفظ بحسابها التاريخي.
          </p>
        </div>
        {rows.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleExportPdf}>
            <Printer className="size-3.5 ml-2" />
            طباعة
          </Button>
        )}
      </div>

      <label className="mb-3 block text-sm">بحث بالطلب أو العميل أو الهاتف أو المنتج
        <input aria-label="بحث النواقص" value={query} onChange={event=>setQuery(event.target.value)} className="mt-1 block w-full rounded-md border bg-background p-2"/>
      </label>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label>حالة المتابعة<select aria-label="تصفية حالة متابعة النواقص" className="block rounded border bg-background p-2" value={followupState} disabled={notesLoading||!!notesError} onChange={e=>setFollowupState(e.target.value)}>
          <option value="all">كل الحالات</option>{Object.entries(SHORTAGE_FOLLOWUP_LABELS).map(([value,label])=><option key={value} value={value}>{label}</option>)}<option value="legacy_review">سجل قديم للمراجعة</option>
        </select></label>
        <Button variant="outline" size="sm" onClick={()=>setFollowupTick(n=>n+1)} disabled={notesLoading}>تحديث المتابعة</Button>
        {notesError&&<p role="alert">{notesError} — كميات النقص أدناه مستقلة عن قراءة الملاحظات.</p>}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="مفيش نواقص"
          description="مفيش طلب نواقص مفتوح غير مغطّى — كل حاجة اتباعت كان ليها رصيد."
        />
      ) : (
        <>
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-4">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {rows.length} منتج ناقص — إجمالي العجز {formatQty(totalDeficit)} وحدة
            </p>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-right">المنتج</TableHead>
                  <TableHead className="text-center">SKU</TableHead>
                  <TableHead className="text-center">المتاح للبيع</TableHead>
                  <TableHead className="text-center">المخصص</TableHead>
                  <TableHead className="text-center">المطلوب بالطلبات</TableHead>
                  <TableHead className="text-center">العجز (للتوريد/التصنيع)</TableHead>
                  <TableHead className="text-right">الطلبات والعملاء المنتظرين</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={JSON.stringify([row.productId,row.variantName || "",row.allocated == null])} className="bg-amber-50/40 dark:bg-amber-950/10">
                    <TableCell className="font-medium text-right">{row.productName}</TableCell>
                    <TableCell className="text-center text-muted-foreground">{row.sku}</TableCell>
                    <TableCell className="text-center">{formatQty(row.stock)}</TableCell>
                    <TableCell className="text-center">{row.allocated == null ? "سجل قديم" : formatQty(row.allocated)}</TableCell>
                    <TableCell className="text-center font-medium">{formatQty(row.required)}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant="destructive" className="font-bold">
                        {formatQty(row.deficit)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Who is actually waiting — the reason this row exists.
                          A count alone cannot be acted on. */}
                      <div className="flex flex-wrap gap-1 justify-end">
                        {row.waitingOrders.map((o) => (
                          <span key={o.orderId}><Badge variant="outline" className="font-normal">
                            <span className="font-mono text-[10px]">{o.orderNumber}</span>
                            <span className="mr-1">— {o.customerName} {o.customerPhone}</span>
                            {o.requested != null && <span className="mr-1">مطلوب {o.requested} / مخصص {o.allocated} / ناقص {o.missing} — {notesLoading||notesError ? "حالة المتابعة غير مؤكدة" : SHORTAGE_FOLLOWUP_LABELS[notesByOrder.get(o.orderId)?.state??"waiting"]}</span>}
                          </Badge>
                          {o.requested != null && <Button size="sm" variant="ghost" onClick={()=>setFollowup({...o,demandSummary:`${row.productName}: مطلوب ${o.requested}، مخصص ${o.allocated}، ناقص ${o.missing}`})}>متابعة {o.orderNumber}</Button>}
                          </span>
                        ))}
                        {row.waitingOrders.length === 0 && (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      <Dialog open={!!followup} onOpenChange={open=>{if(!open)setFollowup(null)}}>
        <DialogContent><DialogHeader><DialogTitle>متابعة نواقص الطلب</DialogTitle></DialogHeader>
          {followup&&<ShortageFollowupPanel key={followup.orderId} {...followup} onSaved={()=>setFollowupTick(n=>n+1)}/>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
