import { useState, useEffect, useMemo } from "react";
import { useDraftState, clearDrafts } from "@/hooks/useDraftState";
import { Percent, Tag, Plus, Trash2, CheckCircle2, Ban } from "lucide-react";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useOrderStore } from "@/store/useOrderStore";
import { events } from "@/lib/ledger";
import type { LedgerEvent } from "@/lib/ledger";
import type { PromoDiscount } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function DiscountsPage() {
  const { orders } = useOrderStore();
  const {
    promoDiscounts: discounts,
    addPromoDiscount,
    updatePromoDiscount,
    removePromoDiscount,
  } = useBusinessStore();

  const [code, setCode] = useDraftState("discount:code", "");
  const [type, setType] = useDraftState<PromoDiscount["type"]>("discount:type", "percentage");
  const [value, setValue] = useDraftState("discount:value", "");

  const addDiscount = async () => {
    const numericValue = parseFloat(value);
    if (!code.trim() || !numericValue || numericValue <= 0) return;
    // Awaited: the fields are only cleared once the row is actually stored.
    try {
      await addPromoDiscount({
        code: code.trim().toUpperCase(),
        type,
        value: numericValue,
        active: true,
      });
      setCode("");
      setValue("");
    } catch {
      /* the store announced it; the typed code stays so it can be retried */
    }
  };

  const toggleDiscount = async (id: string) => {
    const d = discounts.find((x) => x.id === id);
    // Awaited so a refused toggle surfaces instead of becoming an unhandled
    // rejection with the switch left showing the wrong state.
    if (d) await updatePromoDiscount(id, { active: !d.active }).catch(() => {});
  };

  const [posSales, setPosSales] = useState<LedgerEvent[]>([]);
  useEffect(() => {
    let mounted = true;
    events({ kind: "sale" }).then((sales) => {
      if (mounted) setPosSales(sales);
    }).catch(console.error);
    return () => { mounted = false; };
  }, []);

  // Dynamic Metrics
  const activeCount = discounts.filter((d) => d.active).length;
  
  const posDiscountTotal = useMemo(() => {
    return posSales.reduce((sum, s) => sum + ((s.payload as any)?.discountAmount || 0), 0);
  }, [posSales]);

  const totalDiscountedAmount = orders.reduce((sum, o) => sum + (o.discountAmount ?? 0), 0) + posDiscountTotal;

  const getDiscountUsage = (codeId: string) => {
    const orderUsages = orders.filter((o) => o.discountCodeId === codeId);
    const posUsages = posSales.filter((s) => (s.payload as any)?.discountCodeId === codeId);
    
    const amount = 
      orderUsages.reduce((sum, o) => sum + (o.discountAmount ?? 0), 0) +
      posUsages.reduce((sum, s) => sum + ((s.payload as any)?.discountAmount || 0), 0);
      
    return { count: orderUsages.length + posUsages.length, amount };
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">صفحة الخصومات</h1>
        <p className="text-muted-foreground mt-1">
          أكواد خصم نسبية أو مبلغ ثابت تطبق على المبيعات والطلبات. يتم احتساب الأثر المالي ديناميكياً من دفتر الحسابات.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-border bg-card p-6 flex items-center gap-4">
          <div className="size-12 rounded-xl bg-blue-100 flex items-center justify-center">
            <Tag className="size-6 text-blue-600" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">إجمالي الأكواد النشطة</p>
            <p className="text-2xl font-bold font-mono">{activeCount}</p>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6 flex items-center gap-4">
          <div className="size-12 rounded-xl bg-green-100 flex items-center justify-center">
            <Percent className="size-6 text-green-600" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">إجمالي الفلوس المخصومة (من الطلبات ونقاط البيع)</p>
            <p className="text-2xl font-bold font-mono text-green-600">
              {totalDiscountedAmount.toLocaleString()} ج.م
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl flex items-center justify-center bg-pink-100">
              <Percent className="size-5 text-pink-600" />
            </div>
            <div>
              <h2 className="font-display text-xl font-bold">إنشاء كود خصم</h2>
              <p className="text-xs text-muted-foreground">يدعم نسبة مئوية أو مبلغ ثابت</p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <Label>الكود</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="SAVE10" />
            </div>
            <div>
              <Label>نوع الخصم</Label>
              <Select value={type} onValueChange={(v) => setType(v as PromoDiscount["type"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">نسبة مئوية %</SelectItem>
                  <SelectItem value="fixed">مبلغ ثابت</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>قيمة الخصم</Label>
              <Input
                type="number"
                min={0}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={type === "percentage" ? "10" : "50"}
              />
            </div>
            <Button className="w-full" onClick={addDiscount}>
              <Plus className="size-4 ml-2" />
              إضافة الخصم
            </Button>
          </div>
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right px-4">الكود</TableHead>
                <TableHead className="text-center px-4">النوع</TableHead>
                <TableHead className="text-center px-4">القيمة</TableHead>
                <TableHead className="text-center px-4">مرات الاستخدام</TableHead>
                <TableHead className="text-center px-4">إجمالي المخصوم</TableHead>
                <TableHead className="text-center px-4">الحالة</TableHead>
                <TableHead className="text-center px-4">تاريخ الإنشاء</TableHead>
                <TableHead className="text-center px-4">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {discounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-12">
                    لا توجد أكواد خصم محفوظة
                  </TableCell>
                </TableRow>
              ) : (
                discounts.map((discount) => (
                  <TableRow key={discount.id}>
                    <TableCell className="px-4 font-mono font-bold">{discount.code}</TableCell>
                    <TableCell className="text-center px-4">
                      <Badge variant="outline">
                        {discount.type === "percentage" ? "نسبة مئوية" : "مبلغ ثابت"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center px-4 font-mono">
                      {discount.type === "percentage"
                        ? `${discount.value}%`
                        : `${discount.value} ج.م`}
                    </TableCell>
                    <TableCell className="text-center px-4 font-mono text-muted-foreground">
                      {getDiscountUsage(discount.id).count}
                    </TableCell>
                    <TableCell className="text-center px-4 font-mono font-bold text-red-600">
                      {getDiscountUsage(discount.id).amount.toLocaleString()} ج.م
                    </TableCell>
                    <TableCell className="text-center px-4">
                      <Badge variant={discount.active ? "default" : "secondary"}>
                        {discount.active ? "نشط" : "معطل"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center px-4 text-sm text-muted-foreground">
                      {new Date(discount.createdAt).toLocaleDateString("ar-EG")}
                    </TableCell>
                    <TableCell className="text-center px-4">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toggleDiscount(discount.id)}
                        >
                          {discount.active ? "تعطيل" : "تفعيل"}
                        </Button>
                        <Button aria-label="حذف كود الخصم"
                          variant="ghost"
                          size="icon"
                          className="size-8 text-destructive"
                          onClick={() => removePromoDiscount(discount.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
