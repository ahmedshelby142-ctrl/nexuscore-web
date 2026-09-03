import React, { useState } from "react";
import { Package, Plus, Trash2, Loader2, Save, FileText, Users, CreditCard, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSubmitGate } from "@/hooks/useSubmitGate";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useStock } from "@/lib/ledger/useStock";
import { appendEvent } from "@/lib/ledger";
import { buildPurchaseLines } from "@/lib/ledger/purchases";
import { ProductSearch } from "@/components/products/ProductSearch";
import { formatMoney, formatQty, round } from "@/lib/math";
import { useBalances } from "@/lib/ledger/useBalances";
import {
  buildSupplierReturnLines,
  reconcileSupplierReturn,
} from "@/lib/ledger/purchases";
import { WholesaleReturnPanel } from "@/components/wholesale/WholesaleReturnPanel";
import { WALLET_LABELS } from "@/types";
import { cn } from "@/lib/utils";

const NEW_SUPPLIER = "__new__";

export function PurchasingPage() {
  const { suppliers, addSupplier, addPurchaseInvoice, purchaseInvoices, products, applyStockMoves } = useBusinessStore();
  const { qtyOf, costOf, refresh: refreshStock } = useStock();
  // What we owe each supplier — the account the آجل half of a receipt feeds.
  const { amountOf: debtOf, total: totalSupplierDebt, refresh: refreshDebt } =
    useBalances("payable_supplier");

  // Dashboard Stats
  const totalInvoices = purchaseInvoices.length;
  const totalSuppliers = suppliers.length;
  const totalVolume = purchaseInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [draft, setDraft] = useState<any[]>([]);
  const [wallet, setWallet] = useState<any>("inStoreSafe");
  const [supplierId, setSupplierId] = useState("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierPhone, setNewSupplierPhone] = useState("");
  const [saving, setSaving] = useState(false);
  /**
   * المدفوع نقداً, as typed. Blank means "pay it all" — the overwhelmingly
   * common case, and what this screen used to hardcode.
   *
   * Without this field `paidAmount` was always the full total, so
   * `payable_supplier` could never be created: the credit half of
   * `buildPurchaseLines` was unreachable and no receipt could ever be آجل.
   */
  const [paidInput, setPaidInput] = useState("");

  // Variant Modal State
  const [pendingVariantSelection, setPendingVariantSelection] = useState<any | null>(null);

  // Detail Modals State
  const [selectedInvoice, setSelectedInvoice] = useState<any | null>(null);
  const [selectedSupplier, setSelectedSupplier] = useState<any | null>(null);

  const supplierMetrics = selectedSupplier ? (() => {
    const invs = purchaseInvoices.filter(i => i.supplierId === selectedSupplier.id);
    const totalVolume = invs.reduce((sum, i) => sum + i.totalAmount, 0);
    return { invs, totalVolume };
  })() : null;

  // One submit at a time. See `useSubmitGate` — `saving`/`returning` state
  // cannot do this on its own.
  const receiveGate = useSubmitGate();
  const returnGate = useSubmitGate();

  const registeringNew = supplierId === NEW_SUPPLIER;
  const supplierReady = registeringNew ? newSupplierName.trim().length > 0 : supplierId !== "";
  const total = round(draft.reduce((sum, l) => sum + (l.quantity * l.unitCost), 0));
  /** Blank = paid in full. Clamped so a typo can never owe a negative amount. */
  const paidAmount = paidInput.trim() === "" ? total : Math.min(Math.max(0, Number(paidInput) || 0), total);
  const owedAmount = round(total - paidAmount);
  const canSave = draft.length > 0 && draft.every(l => l.quantity > 0 && l.unitCost >= 0) && supplierReady && !saving;

  const addItemToDraft = (product: any, qty: number, variantName?: string) => {
    setDraft((prev) => {
      const existing = prev.find((l) => l.productId === product.id && l.variantName === variantName);
      if (existing) {
        return prev.map((l) =>
          l.productId === product.id && l.variantName === variantName
            ? { ...l, quantity: l.quantity + qty }
            : l,
        );
      }
      return [
        ...prev,
        {
          productId: product.id,
          product: product, 
          productName: product.name,
          quantity: qty,
          unitCost: product.cost ?? 0,
          variantName,
        },
      ];
    });
  };

  // ── مرتجع مورد: goods going back, settled against what we owe them ────────
  const [isReturnOpen, setIsReturnOpen] = useState(false);
  const [returnSupplierId, setReturnSupplierId] = useState("");
  const [returnItems, setReturnItems] = useState<any[]>([]);
  const [returnPaidInput, setReturnPaidInput] = useState("");
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);

  const returnValue = round(returnItems.reduce((sum, i) => sum + i.quantity * i.unitCost, 0));
  const returnSupplierDebt = returnSupplierId ? debtOf(returnSupplierId) : 0;
  const returnSettle = reconcileSupplierReturn(returnValue, returnSupplierDebt, returnPaidInput);

  function openReturnModal() {
    setReturnSupplierId("");
    setReturnItems([]);
    setReturnPaidInput("");
    setReturnError(null);
    setIsReturnOpen(true);
  }

  function addReturnItem(product: any) {
    setReturnItems((prev) => {
      const at = prev.findIndex((i) => i.productId === product.id);
      if (at >= 0) {
        const next = [...prev];
        next[at] = { ...next[at], quantity: next[at].quantity + 1 };
        return next;
      }
      return [
        ...prev,
        {
          productId: product.id,
          productName: product.name,
          quantity: 1,
          // The weighted average on the shelf — what these units actually cost
          // us. Sending them back at anything else moves value that never moved.
          unitCost: costOf(product.id),
        },
      ];
    });
  }

  async function submitReturn() {
    if (!returnSupplierId) {
      setReturnError("اختر المورد أولاً");
      return;
    }
    if (returnItems.length === 0) {
      setReturnError("أضف منتج واحد على الأقل للمرتجع");
      return;
    }
    const short = returnItems.find((i) => i.quantity > qtyOf(i.productId));
    if (short) {
      setReturnError(
        `الكمية المرتجعة من "${short.productName}" أكبر من الموجود في المخزن (${qtyOf(short.productId)})`,
      );
      return;
    }

    if (!returnGate.enter()) return;
    setReturning(true);
    setReturnError(null);
    try {
      const supplier = suppliers.find((sp) => sp.id === returnSupplierId);
      await appendEvent({
        // Deliberately the EXISTING `purchase` kind, not a new one.
        //
        // Adding a kind means rebuilding `ledger_events` on every installed
        // database to widen its CHECK constraint (see migration 002) — a heavy,
        // risky operation on append-only financial history, for a label. The
        // lines already say exactly what happened: stock leaves, the payable
        // falls. And the P&L's `purchases` figure sums `stock` restricted to
        // this kind, so a return netting against it makes that number MORE
        // correct — goods bought minus goods sent back.
        //
        // `refType` is what distinguishes the two in the event log.
        kind: "purchase",
        actor: "المشتريات",
        refType: "supplier_return",
        refId: returnSupplierId,
        payload: {
          supplierName: supplier?.companyName ?? "",
          previousDebt: returnSupplierDebt,
          returnValue,
          paidNow: returnSettle.paidNow,
        },
        lines: buildSupplierReturnLines({
          items: returnItems.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitCost: i.unitCost,
          })),
          supplierId: returnSupplierId,
          wallet,
          currentDebt: returnSupplierDebt,
          paidNow: returnSettle.paidNow,
        }),
      });

      applyStockMoves(returnItems.map((i) => ({ productId: i.productId, delta: -i.quantity })));

      refreshStock();
      refreshDebt();
      setIsReturnOpen(false);
    } catch (e) {
      setReturnError(
        `لم يُسجَّل المرتجع ولم يتغيّر أي رصيد. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setReturning(false);
      returnGate.exit();
    }
  }

  async function receive() {
    if (!canSave || !receiveGate.enter()) return;
    setSaving(true);
    try {
      // AWAITED. `addSupplier` writes to Supabase and only then returns the
      // stored row; calling it bare handed back a pending Promise, so
      // `supplier.id` was `undefined` and the invoice below belonged to nobody.
      // `Supplier` is `any` (see src/types/index.ts), so nothing caught it.
      const supplier = registeringNew
        ? await addSupplier({
            companyName: newSupplierName.trim(),
            contactPerson: "",
            phone: newSupplierPhone.trim(),
          })
        : suppliers.find((s) => s.id === supplierId);
      if (!supplier?.id) throw new Error("المورد مش موجود");

      const invoiceNumber = "FM-" + String(purchaseInvoices.length + 1).padStart(4, "0");

      await appendEvent({
        kind: "purchase",
        actor: "الكاشير",
        refType: "supplier_invoice",
        refId: invoiceNumber,
        payload: {
          invoiceNumber,
          supplierName: supplier.companyName,
          itemCount: draft.length,
          wallet,
          via: "purchasing_page",
        },
        lines: buildPurchaseLines({
          items: draft.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitCost: l.unitCost,
            variantName: l.variantName,
          })),
          wallet,
          supplierId: supplier.id,
          paidAmount,
        }),
      });

      // Goods arriving. Plain products count too — that is what the old
      // `if (line.variantName)` guard here silently excluded.
      applyStockMoves(
        draft.map((line) => ({
          productId: line.productId,
          delta: line.quantity,
          variantName: line.variantName,
        })),
      );

      await addPurchaseInvoice({
        invoiceNumber,
        supplierId: supplier.id,
        supplierName: supplier.companyName,
        items: draft.map((l) => ({
          id: crypto.randomUUID(),
          productId: l.productId,
          productName: l.productName,
          sku: l.product.sku,
          quantity: l.quantity,
          unitCost: l.unitCost,
          total: l.quantity * l.unitCost,
        })),
        totalAmount: total,
        paidAmount,
        remainingAmount: owedAmount,
        dueDate: new Date().toISOString().slice(0, 10),
        status: owedAmount <= 0 ? "paid" : paidAmount > 0 ? "partial" : "unpaid",
        notes: owedAmount > 0 ? "فاتورة مشتريات (آجل جزئي)" : "فاتورة مشتريات (دفع نقدي)",
      });

      refreshStock();
      refreshDebt();
      setDraft([]);
      setPaidInput("");
      setSupplierId("");
      setNewSupplierName("");
      setNewSupplierPhone("");
      setIsModalOpen(false);
      toast.success("تم تسجيل الفاتورة بنجاح");
    } catch (e) {
      toast.error(`خطأ: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
      receiveGate.exit();
    }
  }

  return (
    <>
    <div className="space-y-6 print:hidden">
      {/* Header and Actions */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold">المشتريات والموردين</h1>
          <p className="text-muted-foreground mt-1">إدارة فواتير المشتريات، الموردين وتوريد المخزون</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={openReturnModal}>
            <RotateCcw className="ml-2 size-4" />
            مرتجع مورد
          </Button>
          <Button onClick={() => setIsModalOpen(true)}>
            <Plus className="ml-2 size-4" />
            تسجيل فاتورة مشتريات
          </Button>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-blue-100 text-blue-700 rounded-full">
                <FileText className="size-6" />
              </div>
              <div>
                <p className="text-gray-800 dark:text-gray-200 font-bold text-lg">فواتير المشتريات</p>
                <h3 className="text-2xl font-bold">{totalInvoices}</h3>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-green-100 text-green-700 rounded-full">
                <CreditCard className="size-6" />
              </div>
              <div>
                <p className="text-gray-800 dark:text-gray-200 font-bold text-lg">إجمالي قيمة المشتريات</p>
                <h3 className="text-2xl font-bold">{formatMoney(totalVolume)}</h3>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-purple-100 text-purple-700 rounded-full">
                <Users className="size-6" />
              </div>
              <div>
                <p className="text-gray-800 dark:text-gray-200 font-bold text-lg">عدد الموردين</p>
                <h3 className="text-2xl font-bold">{totalSuppliers}</h3>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Dashboard Tabs */}
      <Tabs defaultValue="invoices" className="space-y-4">
        <TabsList>
          <TabsTrigger value="invoices" className="font-semibold text-gray-700 data-[state=active]:text-black data-[state=active]:font-bold dark:data-[state=active]:text-white text-base">فواتير المشتريات</TabsTrigger>
          <TabsTrigger value="suppliers" className="font-semibold text-gray-700 data-[state=active]:text-black data-[state=active]:font-bold dark:data-[state=active]:text-white text-base">الموردين</TabsTrigger>
        </TabsList>
        <TabsContent value="invoices" className="space-y-4">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">رقم الفاتورة</TableHead>
                  <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">المورد</TableHead>
                  <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">التاريخ</TableHead>
                  <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">الحالة</TableHead>
                  <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">الإجمالي</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchaseInvoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                      لا توجد فواتير مشتريات
                    </TableCell>
                  </TableRow>
                ) : (
                  purchaseInvoices.slice().reverse().map((inv) => (
                    <TableRow key={inv.id} className="cursor-pointer hover:bg-gray-50 transition-colors" onClick={() => setSelectedInvoice(inv)}>
                      <TableCell className="text-right px-4 font-mono font-bold text-gray-900 dark:text-white">{inv.invoiceNumber}</TableCell>
                      <TableCell className="text-right px-4">{inv.supplierName}</TableCell>
                      <TableCell className="text-right px-4">
                        {new Date(inv.createdAt).toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" })}
                      </TableCell>
                      <TableCell className="text-right px-4">
                        <Badge variant={inv.status === "paid" ? "default" : "secondary"}>
                          {inv.status === "paid" ? "مسددة" : inv.status === "unpaid" ? "آجل" : "مسددة جزئياً"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right px-4 font-mono font-bold text-gray-900 dark:text-white">
                        {formatMoney(inv.totalAmount)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="suppliers" className="space-y-4">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">الشركة / المورد</TableHead>
                  <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">الشخص المسئول</TableHead>
                  <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">رقم التليفون</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppliers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-12 text-center text-muted-foreground">
                      لا يوجد موردين
                    </TableCell>
                  </TableRow>
                ) : (
                  suppliers.map((sup) => (
                    <TableRow key={sup.id} className="cursor-pointer hover:bg-gray-50 transition-colors" onClick={() => setSelectedSupplier(sup)}>
                      <TableCell className="text-right px-4 font-bold">{sup.companyName}</TableCell>
                      <TableCell className="text-right px-4">{sup.contactPerson || "-"}</TableCell>
                      <TableCell dir="ltr" className="text-right px-4 font-mono font-bold text-gray-900 dark:text-white">{sup.phone || "-"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Invoice Creation Modal */}
      {/* مرتجع مورد — goods back to the supplier, settled against our debt */}
      <Dialog open={isReturnOpen} onOpenChange={setIsReturnOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>مرتجع مورد</DialogTitle>
            <DialogDescription>
              البضاعة الراجعة بتخصم من مديونيتنا للمورد الأول، والزيادة بس بترجع كاش لخزينتنا.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>المورد</Label>
              <select
                value={returnSupplierId}
                onChange={(e) => setReturnSupplierId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">اختر المورد...</option>
                {suppliers.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {sp.companyName}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label>المنتجات الراجعة</Label>
              <ProductSearch
                products={products}
                onSelect={addReturnItem}
                placeholder="ابحث عن المنتج الراجع للمورد..."
                allowOutOfStock
              />
            </div>

            {returnItems.length > 0 && (
              <div className="rounded-xl border border-border divide-y">
                {returnItems.map((item) => (
                  <div key={item.productId} className="flex items-center justify-between gap-3 p-3">
                    <span className="font-medium flex-1">{item.productName}</span>
                    <span className="text-xs text-muted-foreground">
                      متوسط التكلفة {formatMoney(item.unitCost)}
                    </span>
                    <Input
                      type="number"
                      min={1}
                      max={qtyOf(item.productId)}
                      value={item.quantity}
                      onChange={(e) =>
                        setReturnItems((prev) =>
                          prev.map((i) =>
                            i.productId === item.productId
                              ? { ...i, quantity: parseInt(e.target.value) || 0 }
                              : i,
                          ),
                        )
                      }
                      className="w-20 text-center"
                    />
                    <span className="font-bold w-24 text-left">
                      {formatMoney(item.quantity * item.unitCost)}
                    </span>
                    <Button aria-label="حذف سطر الفاتورة"
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive"
                      onClick={() =>
                        setReturnItems((prev) => prev.filter((i) => i.productId !== item.productId))
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {returnItems.length > 0 && (
              <WholesaleReturnPanel
                variant="supplier"
                debt={returnSupplierDebt}
                returnValue={returnValue}
                paidInput={returnPaidInput}
                onPaidChange={setReturnPaidInput}
                clientMissing={!returnSupplierId}
              />
            )}

            {returnError && (
              <div className="rounded-lg p-3 bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-900">{returnError}</p>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsReturnOpen(false)} disabled={returning}>
              إلغاء
            </Button>
            <Button
              onClick={() => void submitReturn()}
              disabled={
                returning ||
                !returnSupplierId ||
                returnItems.length === 0 ||
                returnItems.some((i) => i.quantity <= 0)
              }
            >
              {returning ? "جاري التسجيل..." : "تأكيد المرتجع وتسوية الحساب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isModalOpen} onOpenChange={(val) => {
        setIsModalOpen(val);
        if (!val) {
          setDraft([]);
          setSupplierId("");
          setNewSupplierName("");
          setNewSupplierPhone("");
        }
      }}>
        <DialogContent className="max-w-5xl h-[90vh] flex flex-col overflow-hidden" dir="rtl">
          <DialogHeader className="shrink-0">
            <DialogTitle>فاتورة مشتريات جديدة</DialogTitle>
            <DialogDescription>أضف المنتجات وحدد بيانات السداد والمورد</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-[1fr_300px] gap-6 p-1 mt-4">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>المنتجات</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ProductSearch
                    products={products}
                    onSelect={(product) => {
                      if (product.metadata?.variants?.length > 0) {
                        setPendingVariantSelection({ product, qty: 1 });
                      } else {
                        addItemToDraft(product, 1);
                      }
                    }}
                    excludeIds={draft.filter(d => !d.variantName).map((l) => l.productId)}
                    placeholder="ابحث باسم المنتج أو الكود لإضافته للفاتورة..."
                    allowOutOfStock={true}
                  />

                  {draft.length > 0 ? (
                    <div className="rounded-md border border-border divide-y divide-border">
                      {draft.map((line, idx) => (
                        <div key={`${line.productId}-${line.variantName}-${idx}`} className="p-3 flex items-center justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-sm truncate">{line.productName}</p>
                            {line.variantName && (
                              <span className="inline-block mt-0.5 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold">
                                {line.variantName}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="w-24">
                              <Label className="text-[10px] text-muted-foreground mb-1 block">الكمية</Label>
                              <Input
                                type="number"
                                min="1"
                                value={line.quantity}
                                // `|| 1`, not `|| 0`, was the bug: `parseInt("0") || 1`
                                // is 1, so typing a quantity of zero silently
                                // received ONE unit and billed for it, and the
                                // field could not be cleared to retype — it
                                // snapped back to 1 mid-edit. 0 is now kept, and
                                // `canSave` (quantity > 0) refuses to save it.
                                onChange={(e) => setDraft(prev => prev.map((l, i) => i === idx ? { ...l, quantity: parseInt(e.target.value) || 0 } : l))}
                                className="h-8"
                              />
                            </div>
                            <div className="w-28">
                              <Label className="text-[10px] text-muted-foreground mb-1 block">تكلفة الوحدة</Label>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={line.unitCost}
                                onChange={(e) => setDraft(prev => prev.map((l, i) => i === idx ? { ...l, unitCost: parseFloat(e.target.value) || 0 } : l))}
                                className="h-8"
                              />
                            </div>
                            <div className="w-24 text-left">
                              <Label className="text-[10px] text-muted-foreground mb-1 block">الإجمالي</Label>
                              <p className="font-medium text-sm pt-1">{formatMoney(line.quantity * line.unitCost)}</p>
                            </div>
                            <Button aria-label="حذف سطر المرتجع"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive self-end"
                              onClick={() => setDraft(prev => prev.filter((_, i) => i !== idx))}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-8 text-center border border-dashed rounded-lg bg-muted/30">
                      <Package className="mx-auto h-8 w-8 text-muted-foreground opacity-50 mb-2" />
                      <p className="text-sm text-muted-foreground">لم يتم إضافة منتجات للفاتورة</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>بيانات المورد</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>المورد</Label>
                    <select
                      value={supplierId}
                      onChange={(e) => setSupplierId(e.target.value)}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="">اختر المورد…</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.companyName}
                        </option>
                      ))}
                      <option value={NEW_SUPPLIER}>+ مورد جديد</option>
                    </select>
                  </div>

                  {registeringNew && (
                    <div className="space-y-3 pt-2 border-t border-border mt-2">
                      <div className="space-y-1.5">
                        <Label>اسم المورد</Label>
                        <Input
                          value={newSupplierName}
                          onChange={(e) => setNewSupplierName(e.target.value)}
                          placeholder="مثال: شركة النور"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>رقم التليفون (اختياري)</Label>
                        <Input
                          value={newSupplierPhone}
                          onChange={(e) => setNewSupplierPhone(e.target.value)}
                          dir="ltr"
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>السداد</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>دفع نقدي من خزينة</Label>
                    <select
                      value={wallet}
                      onChange={(e) => setWallet(e.target.value as any)}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {Object.entries(WALLET_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label as string}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <Label>المدفوع نقداً</Label>
                    <Input
                      type="number"
                      min={0}
                      max={total}
                      value={paidInput}
                      onChange={(e) => setPaidInput(e.target.value)}
                      placeholder={String(total)}
                      className="font-bold"
                    />
                    <p className="text-xs text-muted-foreground">
                      سيبها فاضية يعني مدفوعة بالكامل. أي مبلغ أقل هيتسجّل آجل على المورد.
                    </p>
                  </div>

                  <div className="pt-4 border-t border-border space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">إجمالي الفاتورة</span>
                      <span className="text-xl font-bold text-primary">{formatMoney(total)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">المدفوع</span>
                      <span className="font-semibold">{formatMoney(paidAmount)}</span>
                    </div>
                    {owedAmount > 0 && (
                      <div className="flex items-center justify-between text-base rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-3 py-2">
                        <span className="font-bold text-amber-900 dark:text-amber-300">
                          المتبقي آجل على المورد
                        </span>
                        <span className="font-black text-amber-900 dark:text-amber-300">
                          {formatMoney(owedAmount)}
                        </span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Button 
                className="w-full h-12 text-base font-bold shadow-lg" 
                size="lg" 
                disabled={!canSave} 
                onClick={() => void receive()}
              >
                {saving ? (
                  <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                ) : (
                  <>
                    <Save className="mr-2 h-5 w-5" />
                    حفظ الفاتورة
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Variant Selection Modal */}
      <Dialog
        open={pendingVariantSelection !== null}
        onOpenChange={(open) => !open && setPendingVariantSelection(null)}
      >
        <DialogContent className="sm:max-w-md z-[9999]" dir="rtl">
          <DialogHeader>
            <DialogTitle>اختر الدرجة / اللون</DialogTitle>
            <DialogDescription>
              يوجد تفاصيل إضافية لهذا المنتج. يرجى تحديد الخيار المطلوب لإضافته للفاتورة:
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-4">
            {pendingVariantSelection?.product?.metadata?.variants?.map((v: any, idx: number) => {
              return (
                <Button
                  key={idx}
                  variant="outline"
                  className="flex flex-col items-center justify-center h-auto py-3 gap-1"
                  onClick={() => {
                    if (!pendingVariantSelection) return;
                    const product = pendingVariantSelection.product;
                    const qty = pendingVariantSelection.qty;
                    setPendingVariantSelection(null);
                    setTimeout(() => {
                      addItemToDraft(product, qty, v.name);
                    }, 0);
                  }}
                >
                  <span className="font-bold">{v.name}</span>
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>

    {/* Invoice Details & Print Dialog */}
    <Dialog open={!!selectedInvoice} onOpenChange={(open) => !open && setSelectedInvoice(null)}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto print:[&>button]:hidden">
        <DialogHeader className="print:hidden">
          <DialogTitle>فاتورة مشتريات: {selectedInvoice?.invoiceNumber}</DialogTitle>
          <DialogDescription>
            المورد: {selectedInvoice?.supplierName} | التاريخ: {selectedInvoice?.createdAt ? new Date(selectedInvoice.createdAt).toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" }) : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">المنتج</TableHead>
                <TableHead className="text-center px-4 text-gray-900 dark:text-white font-bold">الكمية</TableHead>
                <TableHead className="text-center px-4 text-gray-900 dark:text-white font-bold">تكلفة الوحدة</TableHead>
                <TableHead className="text-left px-4 text-gray-900 dark:text-white font-bold">الإجمالي</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {selectedInvoice?.items?.map((item: any) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium text-right px-4">{item.productName}</TableCell>
                  <TableCell className="text-center px-4 font-bold text-gray-900 dark:text-white">{item.quantity}</TableCell>
                  <TableCell className="text-center px-4">{formatMoney(item.unitCost)}</TableCell>
                  <TableCell className="text-left px-4 font-mono font-bold text-gray-900 dark:text-white">{formatMoney(item.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          
          <div className="flex justify-between items-center bg-muted/30 p-4 rounded-xl border border-border">
            <span className="font-bold">الإجمالي الكلي:</span>
            <span className="font-bold text-lg font-mono text-gray-900 dark:text-white">{formatMoney(selectedInvoice?.totalAmount || 0)}</span>
          </div>

          <div className="flex justify-end pt-2 print:hidden">
            <Button onClick={() => { setTimeout(() => window.print(), 100); }}>
              طباعة الإيصال (PDF)
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Supplier 360 CRM Dialog */}
    <Dialog open={!!selectedSupplier} onOpenChange={(open) => !open && setSelectedSupplier(null)}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>ملف المورد: {selectedSupplier?.companyName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-6 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">عدد أوامر التوريد (POs)</p>
              <p className="text-2xl font-bold mt-2 text-gray-900 dark:text-white">{supplierMetrics?.invs.length || 0}</p>
            </div>
            <div className="rounded-xl border bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">إجمالي التعاملات</p>
              <p className="text-2xl font-bold mt-2 text-gray-900 dark:text-white">{formatMoney(supplierMetrics?.totalVolume || 0)}</p>
            </div>
          </div>
          
          <div>
            <h4 className="font-bold mb-3 text-lg">سجل أوامر التوريد</h4>
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">رقم الفاتورة</TableHead>
                    <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">التاريخ</TableHead>
                    <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">الإجمالي</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {supplierMetrics?.invs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">لا يوجد سجل توريد</TableCell>
                    </TableRow>
                  ) : (
                    supplierMetrics?.invs.map((inv: any) => (
                      <TableRow key={inv.id}>
                        <TableCell className="text-right px-4 font-mono font-bold text-gray-900 dark:text-white">{inv.invoiceNumber}</TableCell>
                        <TableCell className="text-right px-4">{new Date(inv.createdAt).toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" })}</TableCell>
                        <TableCell className="text-right px-4 font-mono font-bold text-gray-900 dark:text-white">{formatMoney(inv.totalAmount)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Print-only Invoice Template */}
    {selectedInvoice && (
      <div className="hidden print:block absolute top-0 left-0 w-full min-h-screen bg-white text-black p-8 z-[99999]" dir="rtl">
        <div className="text-center mb-8 border-b-2 border-black pb-4">
          <h1 className="text-3xl font-bold mb-2">أمر توريد (PO)</h1>
        </div>
        
        <div className="flex justify-between mb-8">
          <div>
            <p className="font-bold text-lg mb-1">بيانات المورد:</p>
            <p>الشركة: {selectedInvoice.supplierName}</p>
          </div>
          <div className="text-left">
            <p className="font-bold text-lg mb-1">بيانات الفاتورة:</p>
            <p>رقم الفاتورة: {selectedInvoice.invoiceNumber}</p>
            <p>التاريخ: {new Date(selectedInvoice.createdAt).toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" })}</p>
          </div>
        </div>

        <table className="w-full text-right border-collapse mb-8">
          <thead>
            <tr className="border-b-2 border-black">
              <th className="py-2 px-2 text-right">المنتج</th>
              <th className="py-2 px-2 text-center">الكمية</th>
              <th className="py-2 px-2 text-center">التكلفة</th>
              <th className="py-2 px-2 text-left">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {selectedInvoice.items?.map((item: any, i: number) => (
              <tr key={i} className="border-b border-gray-300">
                <td className="py-2 px-2 font-medium">{item.productName}</td>
                <td className="py-2 px-2 text-center font-bold">{item.quantity}</td>
                <td className="py-2 px-2 text-center">{item.unitCost.toLocaleString("ar-EG")}</td>
                <td className="py-2 px-2 text-left font-mono font-bold">{item.total.toLocaleString("ar-EG")}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-between items-center border-t-2 border-black pt-4">
          <p className="text-xl font-bold">الإجمالي الكلي:</p>
          <p className="text-2xl font-bold font-mono">{selectedInvoice.totalAmount.toLocaleString("ar-EG")} ج.م</p>
        </div>
      </div>
    )}
    </>
  );
}
