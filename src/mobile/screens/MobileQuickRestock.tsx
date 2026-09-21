import { useState, useEffect } from "react";
import { PackageCheck, Loader2, Plus, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSubmitGate } from "@/hooks/useSubmitGate";
import { executeQuickRestock, formatQuickRestockSuccess, NEW_SUPPLIER, readSuppliers, type QuickRestockLineInput, type SupplierOption } from "@/lib/receiving";
import { readMobileProductsForRestock } from "@/mobile/data/mobileReaders";
import { useMobilePagedQuery } from "@/mobile/data/useMobilePagedQuery";
import { useIsOffline } from "@/mobile/data/useIsOffline";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { formatMoney } from "@/lib/math";
import { WALLET_LABELS } from "@/types";
import type { WalletType } from "@/types";

/** What the owner typed for one line of the receipt. */
interface LineDraft {
  quantity: string;
  unitCost: string;
  variantName?: string;
}

export function MobileQuickRestock() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [query, setQuery] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(params.get("products")?.split(",").filter(Boolean) ?? []);
  const [lines, setLines] = useState<Record<string, LineDraft>>({});
  const [wallet, setWallet] = useState<WalletType>("inStoreSafe");
  // Empty means "paid in full", exactly as the desktop invoice form reads it.
  // Any smaller number becomes آجل on the supplier. Deliberately NOT a
  // three-way mode switch: cash / partial / credit are one number, and a
  // switch would have invented a second way to say the same thing.
  const [paidInput, setPaidInput] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierPhone, setNewSupplierPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const gate = useSubmitGate();
  // The picked product RECORDS, keyed by id.
  //
  // The screen used to look products up in `page.rows`, the current search
  // page. Picking one cleared the query, the page reloaded to the first 25 by
  // name, and the product just picked was usually not among them — so it could
  // not be found, could not be rendered, and could not be received. Holding the
  // record the moment it is chosen makes the draft independent of whatever the
  // search box happens to be showing.
  const [picked, setPicked] = useState<Record<string, any>>({});

  // Suppliers come from the SERVER, not from `useBusinessStore.suppliers`:
  // mobile never calls `hydrateAll`, so that array is permanently empty and the
  // picker showed nothing at all.
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [suppliersError, setSuppliersError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readSuppliers({ limit: 200 })
      .then((rows) => { if (!cancelled) { setSuppliers(rows); setSuppliersError(null); } })
      .catch((e) => { if (!cancelled) setSuppliersError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Search products for the picker
  const page = useMobilePagedQuery(readMobileProductsForRestock, { search: query });

  // Deep link from المخزون (`/restock?products=a,b`) hands over ids only, so
  // the records behind them have to be fetched before anything can render.
  useEffect(() => {
    const missing = selectedProductIds.filter((id) => !picked[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map((id) => readMobileProductsForRestock({ id, pageSize: 1 })))
      .then((pages) => {
        if (cancelled) return;
        const found: Record<string, any> = {};
        pages.forEach((page, i) => {
          const row = page.rows[0];
          if (row) found[missing[i]] = row;
        });
        if (Object.keys(found).length > 0) setPicked((prev) => ({ ...prev, ...found }));
      })
      .catch(() => { /* a product that cannot be read simply cannot be drafted */ });
    return () => { cancelled = true; };
  }, [selectedProductIds, picked]);

  const draftOf = (id: string) => lines[id] ?? { quantity: "", unitCost: "" };
  const setDraft = (id: string, patch: Partial<LineDraft>) =>
    setLines((prev) => ({ ...prev, [id]: { ...draftOf(id), ...patch } }));

  const removeLine = (id: string) => {
    setLines((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedProductIds((prev) => prev.filter((pid) => pid !== id));
  };

  // ── Draft rows: what the operator SEES ───────────────────────────────────
  //
  // Everything picked, whatever its quantity. This list and `received` used to
  // be the same list, and that was the whole bug: `received` drops any line
  // with quantity <= 0, a freshly picked product has quantity "", so it was
  // dropped before it could be rendered — and the quantity input that would
  // have lifted it above zero only existed INSIDE the row that was being
  // dropped. The screen showed "لا توجد أصناف محددة" forever and no receipt
  // could ever be recorded from the phone.
  //
  // Desktop never had this: `QuickRestockDialog` renders `rows` and submits
  // `received`. Same split, restored here.
  const draftRows = selectedProductIds
    .map((id) => {
      const product = picked[id];
      if (!product) return null;
      const draft = draftOf(id);
      const quantity = parseFloat(draft.quantity) || 0;
      const unitCost = parseFloat(draft.unitCost) || 0;
      const variants: { name: string }[] = product?.metadata?.variants ?? product?.variants ?? [];
      return { id, product, draft, quantity, unitCost, variants, subtotal: quantity * unitCost };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // ── Received lines: what is SUBMITTED ────────────────────────────────────
  const received: QuickRestockLineInput[] = draftRows
    .filter((r) => r.quantity > 0)
    .map((r) => ({
      productId: r.id,
      productName: String(r.product.name ?? ""),
      sku: String(r.product.sku ?? ""),
      quantity: r.quantity,
      unitCost: r.unitCost,
      variantName: r.draft.variantName,
    }));

  const total = received.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
  // Same expression the desktop purchasing screen uses, so the two screens
  // cannot drift on what "paid" means.
  const paidAmount = paidInput.trim() === "" ? total : Math.min(Math.max(0, Number(paidInput) || 0), total);
  const owedAmount = Math.max(0, total - paidAmount);
  const registeringNew = supplierId === NEW_SUPPLIER;
  const supplierReady = registeringNew ? newSupplierName.trim().length > 0 : supplierId !== "";
  // A درجة-bearing product must say WHICH درجة arrived, or a later return off
  // this receipt cannot name it. Mirrors the desktop dialog's same guard.
  const variantsResolved = draftRows.every((r) => r.quantity <= 0 || r.variants.length === 0 || Boolean(r.draft.variantName));
  const offline = useIsOffline();
  // The write already FAILS safely offline — `commitReceipt` awaits the
  // server and throws, so nothing is committed and no success is shown. What
  // it did NOT do was say so before the tap: the button looked live, the
  // operator filled a receipt, pressed توريد, and got a raw network error.
  //
  // This is the whole of the fix. No draft is saved, nothing is queued, and
  // `commitReceipt` remains the only write path — being offline simply means
  // the receipt cannot be taken yet.
  const canSave = received.length > 0 && supplierReady && variantsResolved && !saving && !offline;

  function reset() {
    setLines({});
    setPicked({});
    setSelectedProductIds([]);
    setSupplierId("");
    setNewSupplierName("");
    setNewSupplierPhone("");
    setPaidInput("");
    setSaving(false);
  }

  function close() {
    reset();
    navigate(-1);
  }

  async function receive() {
    if (!canSave || !gate.enter()) return;
    setSaving(true);

    // Supplier resolution, numbering and the write ordering all live in
    // `executeQuickRestock` now. This handler used to resolve the supplier out
    // of `useBusinessStore.suppliers` — an array mobile never hydrates, so it
    // was always empty and every receipt minted a duplicate supplier — and to
    // compute its own `FM-` number from `purchaseInvoices.length`, which on
    // mobile is always 0 and therefore always collided with FM-0001.
    try {
      const result = await executeQuickRestock({
        lines: received,
        supplier: {
          supplierId: registeringNew ? NEW_SUPPLIER : supplierId,
          newSupplierName,
          newSupplierPhone,
        },
        wallet,
        paidAmount,
        // Three states, three labels. `owedAmount > 0 ? "آجل جزئي" : …` —
        // which is what the desktop invoice form still says — calls a receipt
        // with NOTHING paid "partially on credit", and that note is what the
        // supplier's account shows later.
        notes:
          owedAmount <= 0
            ? "توريد سريع من تطبيق الموبايل (دفع نقدي)"
            : paidAmount <= 0
              ? "توريد سريع من تطبيق الموبايل (آجل بالكامل)"
              : "توريد سريع من تطبيق الموبايل (آجل جزئي)",
        idempotencyKey: crypto.randomUUID(),
      });

      toast.success(formatQuickRestockSuccess(result));
      close();
    } catch (e) {
      // `commitReceipt` writes the document first and takes it back if the
      // ledger refuses, so a throw means the receipt does not exist and nothing
      // moved. Its message already names which failure shape happened.
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      gate.exit();
    }
  }

  // ── Product Picker Dialog ──────────────────────────────────────────────
  const pickerRows = page.rows.filter((p: any) => !selectedProductIds.includes(String(p.id)));

  return (
    <section className="mobile-screen">
      <MobileAppBar
        title="توريد سريع"
        leadingAction={
          <button
            type="button"
            className="mobile-icon-button"
            onClick={close}
            aria-label="رجوع"
            disabled={saving}
          >
            <X aria-hidden="true" />
          </button>
        }
        trailingAction={
          <button
            type="button"
            className="mobile-icon-button"
            onClick={() => setShowProductPicker(true)}
            aria-label="إضافة صنف"
            disabled={saving}
          >
            <Plus aria-hidden="true" />
          </button>
        }
      />

      <div className="mobile-screen-body">
        <MobileSearch value={query} onChange={setQuery} placeholder="ابحث عن منتج لإضافته" />

        {/* A deep link hands over ids; the records behind them take a round
            trip. Saying "لا توجد أصناف محددة" while they are in flight tells
            the operator their link did nothing, which is both wrong and the
            exact moment they would give up on the screen. */}
        {draftRows.length === 0 && selectedProductIds.length > 0 ? (
          <SkeletonState count={1} />
        ) : draftRows.length === 0 ? (
          <EmptyState
            titleAr="لا توجد أصناف محددة"
            messageAr="اضغط على '+' لإضافة أصناف للتوريد. يمكنك البحث بالاسم، الكود، أو الباركود."
          />
        ) : (
          <>
            <div className="mobile-entity-list">
              {draftRows.map((row) => (
                <div key={row.id} className="mobile-stock-card">
                  <div className="mobile-stock-card-main flex-1 min-w-0">
                    <strong className="truncate block">{String(row.product.name ?? "—")}</strong>
                    <span className="text-xs text-muted-foreground" dir="ltr">{String(row.product.sku ?? "")}</span>

                    {row.variants.length > 0 && (
                      <div className="space-y-1 mt-2">
                        <Label htmlFor={`restock-variant-${row.id}`} className="text-xs">الدرجة</Label>
                        <Select
                          value={row.draft.variantName ?? ""}
                          onValueChange={(v) => setDraft(row.id, { variantName: v })}
                        >
                          <SelectTrigger id={`restock-variant-${row.id}`} className="h-9">
                            <SelectValue placeholder="اختر الدرجة…" />
                          </SelectTrigger>
                          <SelectContent>
                            {row.variants.map((v: any) => (
                              <SelectItem key={String(v.name)} value={String(v.name)}>
                                {String(v.name)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div className="space-y-1">
                        <Label htmlFor={`restock-qty-${row.id}`} className="text-xs">الكمية</Label>
                        <Input
                          id={`restock-qty-${row.id}`}
                          type="number"
                          min="0"
                          step="1"
                          inputMode="decimal"
                          value={row.draft.quantity}
                          onChange={(e) => setDraft(row.id, { quantity: e.target.value })}
                          className="h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`restock-cost-${row.id}`} className="text-xs">تكلفة الوحدة</Label>
                        <Input
                          id={`restock-cost-${row.id}`}
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          value={row.draft.unitCost}
                          onChange={(e) => setDraft(row.id, { unitCost: e.target.value })}
                          className="h-9 text-sm"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between mt-2 text-sm">
                      <span className="text-muted-foreground">
                        متاح: {Number(row.product.mobileStock ?? 0).toLocaleString("ar-EG")}
                      </span>
                      <span className="font-semibold">
                        {row.subtotal > 0 ? formatMoney(row.subtotal) : "—"}
                      </span>
                    </div>

                    <div className="flex items-center justify-end mt-1">
                      <button
                        type="button"
                        className="text-destructive hover:underline text-sm min-h-[44px] px-2"
                        onClick={() => removeLine(row.id)}
                        disabled={saving}
                      >
                        إزالة
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-4 mt-4">
              <div className="space-y-1.5">
                <Label htmlFor="restock-supplier">المورد</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger id="restock-supplier">
                    <SelectValue placeholder="اختر المورد…" />
                  </SelectTrigger>
                  <SelectContent>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.companyName}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_SUPPLIER}>+ مورد جديد</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  المورد بيتسجّل على التوريدة نفسها، مش على المنتج — نفس الصنف ممكن ييجي من مورد مختلف المرة الجاية.
                </p>
              </div>

              {registeringNew && (
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-dashed border-border p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="new-supplier-name">اسم المورد</Label>
                    <Input
                      id="new-supplier-name"
                      value={newSupplierName}
                      onChange={(e) => setNewSupplierName(e.target.value)}
                      placeholder="مثال: المرادي"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="new-supplier-phone">تليفون (اختياري)</Label>
                    <Input
                      id="new-supplier-phone"
                      value={newSupplierPhone}
                      onChange={(e) => setNewSupplierPhone(e.target.value)}
                      dir="ltr"
                    />
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="restock-wallet">اتدفع من</Label>
                <Select value={wallet} onValueChange={setWallet}>
                  <SelectTrigger id="restock-wallet">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(WALLET_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="restock-paid">المدفوع الآن</Label>
                <Input
                  id="restock-paid"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={paidInput}
                  onChange={(e) => setPaidInput(e.target.value)}
                  placeholder={formatMoney(total)}
                />
                <p className="text-xs text-muted-foreground">
                  سيبها فاضية يعني مدفوعة بالكامل. أي مبلغ أقل هيتسجّل آجل على المورد.
                </p>
              </div>

              <div className="rounded-lg bg-muted/50 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    إجمالي التوريد
                    {received.length > 1 ? ` (${received.length} أصناف)` : ""}
                  </span>
                  <span className="font-bold">{formatMoney(total)}</span>
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-muted-foreground">المدفوع الآن</span>
                  <span className="font-semibold">{formatMoney(paidAmount)}</span>
                </div>
                {/* Shown only when there IS a debt. A permanent "آجل: ٠" would
                    be a financial zero that means nothing — see the same rule
                    in `alertModel`. */}
                {owedAmount > 0 && (
                  <div className="flex items-center justify-between mt-1.5 text-amber-600 dark:text-amber-400">
                    <span>المتبقي آجل على المورد</span>
                    <span className="font-bold">{formatMoney(owedAmount)}</span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-2">
                  {owedAmount > 0
                    ? "بيتسجّل فاتورة واحدة باسم المورد، المدفوع بيخرج من الخزينة والمتبقي بيتسجّل دين عليه في شاشة المشتريات."
                    : "التوريد ده بيتسجّل مدفوع كاش، وبيتسجّل فاتورة واحدة باسم المورد تظهر في حسابه في شاشة المشتريات."}
                </p>
              </div>
            </div>
          </>
        )}

      </div>

      {/* Lifted clear of the fixed bottom nav — see `.mobile-sticky-actions`.
          With plain `sticky bottom-0` the nav sat on top of this bar and ate
          every tap aimed at تسجيل التوريد. */}
      <div className="mobile-sticky-actions">
        <div className="flex justify-end gap-2 w-full">
          <Button variant="outline" onClick={close} disabled={saving}>
            إلغاء
          </Button>
          <Button onClick={() => void receive()} disabled={!canSave} className="flex-1" title={offline ? "لا يوجد اتصال بالسحابة" : undefined}>
            {saving && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
            {saving
              ? "جاري التسجيل…"
              : received.length > 1
              ? `تسجيل توريد ${received.length} أصناف`
              : "تسجيل التوريد"}
          </Button>
        </div>
      </div>

      {/* Product Picker Sheet */}
      {showProductPicker && (
        <Dialog open={true} onOpenChange={(open) => !open && setShowProductPicker(false)}>
          <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <PackageCheck className="size-5" />
                إضافة أصناف للتوريد
              </DialogTitle>
              <DialogDescription>
                ابحث واختر الأصناف اللي وصلت — هتتضاف للتوريدة الحالية
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <MobileSearch value={query} onChange={setQuery} placeholder="ابحث عن منتج…" />
              {offline ? (
                <OfflineState />
              ) : page.loading ? (
                <SkeletonState />
              ) : page.error ? (
                <ErrorState messageAr="تعذّر تحميل المنتجات." onRetry={page.reload} />
              ) : pickerRows.length === 0 ? (
                <EmptyState titleAr="لا توجد أصناف" messageAr="لا توجد أصناف مطابقة لهذا الاختيار." />
              ) : (
                <>
                  <div className="mobile-entity-list">
                    {pickerRows.map((product: any) => (
                      <button
                        key={product.id}
                        type="button"
                        className="mobile-stock-card"
                        onClick={() => {
                          const id = String(product.id);
                          setPicked((prev) => ({ ...prev, [id]: product }));
                          setSelectedProductIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
                          setLines((prev) => (prev[id] ? prev : { ...prev, [id]: { quantity: "", unitCost: "" } }));
                          setShowProductPicker(false);
                          setQuery("");
                        }}
                      >
                        <div className="mobile-stock-card-icon">
                          <PackageCheck aria-hidden="true" />
                        </div>
                        <div className="mobile-stock-card-main">
                          <strong>{product.name}</strong>
                          <span dir="ltr">{product.sku}</span>
                          <div>
                            <span className="mobile-stock-card-meta">
                              متاح: {Number(product.mobileStock ?? 0).toLocaleString("ar-EG")}
                            </span>
                          </div>
                        </div>
                        <span className="mobile-chevron" aria-hidden="true">‹</span>
                      </button>
                    ))}
                  </div>
                  {page.hasMore && (
                    <button
                      type="button"
                      className="mobile-primary-button mobile-load-more"
                      onClick={page.loadMore}
                      disabled={page.loadingMore}
                    >
                      {page.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}
                    </button>
                  )}
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}