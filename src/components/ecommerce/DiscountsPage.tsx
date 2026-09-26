import React from "react";
import { CollectionGate } from "@/components/ui/collection-gate";
import { useRunOnce } from "@/hooks/useSubmitGate";
import { useState, useEffect, useMemo } from "react";
import { useDraftState, clearDrafts } from "@/hooks/useDraftState";
import { Percent, Tag, Plus, Trash2, CheckCircle2, Ban } from "lucide-react";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useOrderStore } from "@/store/useOrderStore";
import { events } from "@/lib/ledger";
import type { LedgerEvent } from "@/lib/ledger";
import type { PromoDiscount } from "@/types";
import { usageOf, redemptionsFor, isExpired } from "@/lib/discounts";
import { formatMoney } from "@/lib/math";
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
  // `maxUses` and `expiryDate` are real columns that nothing could ever set:
  // the form sent only code/type/value/active, so the limit column was dead and
  // the expiry column was dead. Both are enforced by `claim_discount_use`; this
  // is where they finally become settable.
  const [maxUses, setMaxUses] = useDraftState("discount:maxUses", "");
  const [expiryDate, setExpiryDate] = useDraftState("discount:expiry", "");

  // One in-flight write at a time; see `useRunOnce`.
  const runOnce = useRunOnce();
  const addDiscount = async () => runOnce(async () => {
    const numericValue = parseFloat(value);
    if (!code.trim() || !numericValue || numericValue <= 0) return;
    // Awaited: the fields are only cleared once the row is actually stored.
    try {
      const limit = parseInt(maxUses, 10);
      await addPromoDiscount({
        code: code.trim().toUpperCase(),
        type,
        value: numericValue,
        active: true,
        // Blank means unlimited / never expires, which is what `null` means to
        // `claim_discount_use`. An empty string would reach the numeric column
        // as a cast error and refuse the whole insert.
        maxUses: Number.isFinite(limit) && limit > 0 ? limit : null,
        expiryDate: expiryDate ? new Date(`${expiryDate}T23:59:59`).toISOString() : null,
      });
      setCode("");
      setValue("");
      setMaxUses("");
      setExpiryDate("");
    } catch {
      /* the store announced it; the typed code stays so it can be retried */
    }
  });

  const toggleDiscount = async (id: string) => runOnce(async () => {
    const d = discounts.find((x) => x.id === id);
    // Awaited so a refused toggle surfaces instead of becoming an unhandled
    // rejection with the switch left showing the wrong state.
    if (d) await updatePromoDiscount(id, { active: !d.active }).catch(() => {});
  });

  /** Which code's redemption list is expanded, if any. */
  const [openUsage, setOpenUsage] = useState<string | null>(null);
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
  
  /**
   * The headline total, from the code rows.
   *
   * It used to add up `orders` plus a client-side scan of `events({kind:"sale"})`
   * — which the driver caps at 200 events, newest first. Past that cap the
   * screen silently under-reported every POS discount ever given, which is a
   * large part of "the code worked but the screen did not record it".
   * `totalDiscount` is maintained by `claim_discount_use` and has no cap.
   */
  const totalDiscountedAmount = useMemo(
    () => discounts.reduce((sum, d) => sum + usageOf(d).total, 0),
    [discounts],
  );

  /**
   * The documents behind a code's count — the audit trail, not the count.
   *
   * Still derived from orders and POS events, and still subject to that 200-
   * event cap, which is why it drives a DRILL-DOWN and never the number the
   * limit is enforced against.
   */
  const redemptionsOf = (codeId: string) => redemptionsFor(codeId, orders, posSales);

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
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>حد الاستخدام</Label>
                <Input
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  placeholder="بلا حد"
                />
              </div>
              <div>
                <Label>تاريخ الانتهاء</Label>
                <Input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              سيبهم فاضيين يعني الكود بلا حد استخدام ومن غير تاريخ انتهاء.
            </p>
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
                <TableHead className="text-center px-4">المتبقي</TableHead>
                <TableHead className="text-center px-4">إجمالي المخصوم</TableHead>
                <TableHead className="text-center px-4">الحالة</TableHead>
                <TableHead className="text-center px-4">ينتهي في</TableHead>
                <TableHead className="text-center px-4">تاريخ الإنشاء</TableHead>
                <TableHead className="text-center px-4">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {discounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-12">
                    <CollectionGate tables={["discount_codes"]}>لا توجد أكواد خصم محفوظة</CollectionGate>
                  </TableCell>
                </TableRow>
              ) : (
                discounts.map((discount) => (
                  <React.Fragment key={discount.id}>
                  <TableRow>
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
                    <TableCell className="text-center px-4 font-mono">
                      {/* Straight off the code row — the value `claim_discount_use`
                          increments, which is the same number the limit is
                          enforced against. */}
                      <button
                        type="button"
                        onClick={() =>
                          setOpenUsage(openUsage === discount.id ? null : discount.id)
                        }
                        className="font-bold underline decoration-dotted underline-offset-4 hover:text-primary"
                      >
                        {usageOf(discount).used}
                        {usageOf(discount).limit !== null && (
                          <span className="text-muted-foreground"> / {usageOf(discount).limit}</span>
                        )}
                      </button>
                    </TableCell>
                    <TableCell className="text-center px-4 font-mono text-muted-foreground">
                      {usageOf(discount).remaining === null
                        ? "بلا حد"
                        : usageOf(discount).remaining}
                    </TableCell>
                    <TableCell className="text-center px-4 font-mono font-bold text-red-600">
                      {formatMoney(usageOf(discount).total)}
                    </TableCell>
                    <TableCell className="text-center px-4">
                      {(() => {
                        const u = usageOf(discount);
                        if (!discount.active) return <Badge variant="secondary">معطل</Badge>;
                        if (isExpired(discount)) return <Badge variant="destructive">منتهي</Badge>;
                        if (u.remaining !== null && u.remaining <= 0)
                          return <Badge variant="destructive">استُهلك</Badge>;
                        return <Badge variant="default">نشط</Badge>;
                      })()}
                    </TableCell>
                    <TableCell className="text-center px-4 text-sm text-muted-foreground">
                      {discount.expiryDate
                        ? new Date(discount.expiryDate).toLocaleDateString("ar-EG")
                        : "—"}
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
                  {openUsage === discount.id && (
                    <TableRow key={`${discount.id}-usage`}>
                      <TableCell colSpan={9} className="bg-muted/40 px-4 py-3">
                        {/* The documents behind the count. Derived from the
                            orders and POS sales themselves — the audit trail —
                            never the number the limit is checked against. */}
                        {redemptionsOf(discount.id).length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            {usageOf(discount).used > 0
                              ? "الاستخدامات متسجلة على الكود، بس تفاصيل الطلبات مش ظاهرة هنا (سجل قديم أو خارج آخر ٢٠٠ حركة)."
                              : "الكود ده لسه مااتستخدمش."}
                          </p>
                        ) : (
                          <div className="space-y-1">
                            <p className="text-xs font-semibold text-muted-foreground">
                              الطلبات اللي استخدمت الكود
                            </p>
                            {redemptionsOf(discount.id).map((r, at) => (
                              <div
                                key={`${r.channel}-${r.ref}-${at}`}
                                className="flex items-center justify-between gap-3 text-sm border-b border-border/50 py-1 last:border-0"
                              >
                                <span className="font-mono font-semibold">{r.ref || "—"}</span>
                                <Badge variant="outline">
                                  {r.channel === "pos" ? "نقطة البيع" : "أونلاين"}
                                </Badge>
                                <span className="text-xs text-muted-foreground">
                                  {r.at ? new Date(r.at).toLocaleDateString("ar-EG") : ""}
                                </span>
                                <span className="font-mono font-bold text-red-600">
                                  − {formatMoney(r.amount)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                  </React.Fragment>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
