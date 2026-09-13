import { useRef, useState, useEffect } from "react";
import { PackageCheck, Loader2, Search, Plus, Trash2, X } from "lucide-react";
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
import { executeQuickRestock, formatQuickRestockSuccess, NEW_SUPPLIER, type QuickRestockLineInput, type QuickRestockSupplierInput } from "@/lib/receiving";
import { readMobileProductsForRestock } from "@/mobile/data/mobileReaders";
import { useMobilePagedQuery } from "@/mobile/data/useMobilePagedQuery";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";
import { MobileSearch } from "@/mobile/components/MobileSearch";
import { FilterSheet } from "@/mobile/components/FilterSheet";
import { EmptyState, ErrorState, OfflineState, SkeletonState } from "@/mobile/components/States";
import { formatMoney } from "@/lib/math";
import { WALLET_LABELS } from "@/types";
import type { Product, Supplier, WalletType } from "@/types";
import { useBusinessStore } from "@/store/useBusinessStore";

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
  const [supplierId, setSupplierId] = useState("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierPhone, setNewSupplierPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const gate = useSubmitGate();
  const ledgerWritten = useRef(false);

  // Get suppliers from store for the select dropdown
  const suppliers = useBusinessStore((s) => s.suppliers);

  // Search products for the picker
  const page = useMobilePagedQuery(readMobileProductsForRestock, { search: query });

  // Initialize lines for pre-selected products (from stock screen deep-link)
  useEffect(() => {
    if (selectedProductIds.length > 0 && Object.keys(lines).length === 0) {
      const initialLines: Record<string, LineDraft> = {};
      selectedProductIds.forEach((id) => {
        initialLines[id] = { quantity: "", unitCost: "" };
      });
      setLines(initialLines);
    }
  }, [selectedProductIds, lines]);

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

  const received = Object.entries(lines)
    .map(([id, draft]) => {
      const quantity = parseFloat(draft.quantity) || 0;
      const unitCost = parseFloat(draft.unitCost) || 0;
      if (quantity <= 0) return null;
      // Find product from page rows
      const product = page.rows.find((p: any) => String(p.id) === id);
      if (!product) return null;
      return {
        productId: id,
        productName: product.name,
        sku: product.sku,
        quantity,
        unitCost,
        variantName: draft.variantName,
      };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);

  const total = received.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
  const registeringNew = supplierId === NEW_SUPPLIER;
  const supplierReady = registeringNew ? newSupplierName.trim().length > 0 : supplierId !== "";
  const canSave = received.length > 0 && supplierReady && !saving;

  function reset() {
    setLines({});
    setSelectedProductIds([]);
    setSupplierId("");
    setNewSupplierName("");
    setNewSupplierPhone("");
    setSaving(false);
  }

  function close() {
    reset();
    navigate(-1);
  }

  async function receive() {
    if (!canSave || !gate.enter()) return;
    setSaving(true);

    const { suppliers, addSupplier, purchaseInvoices } = useBusinessStore.getState();
    
    let supplier: Supplier | undefined;
    try {
      supplier = registeringNew
        ? await addSupplier({
            companyName: newSupplierName.trim(),
            contactPerson: "",
            phone: newSupplierPhone.trim(),
          })
        : suppliers.find((s) => s.id === supplierId);

      if (!supplier?.id) throw new Error("المورد مش موجود");
    } catch (e) {
      toast.error(
        `المورد متسجّلش، وبالتالي التوريد مااتسجّلش. المخزون زي ما هو. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      setSaving(false);
      gate.exit();
      return;
    }

    try {
      const invoiceNumber = "FM-" + String(purchaseInvoices.length + 1).padStart(4, "0");

      const result = await executeQuickRestock({
        lines: received,
        supplier: { supplierId: registeringNew ? NEW_SUPPLIER : supplierId, newSupplierName, newSupplierPhone },
        wallet,
        notes: "توريد سريع من تطبيق الموبايل",
        idempotencyKey: crypto.randomUUID(),
      });

      ledgerWritten.current = true;

      toast.success(formatQuickRestockSuccess(result));
      close();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);

      if (ledgerWritten.current) {
        toast.error(detail);
        close();
      } else {
        toast.error(`التوريد متسجّلش، والمخزون زي ما هو. ${detail}`);
      }
    } finally {
      ledgerWritten.current = false;
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

        {received.length === 0 ? (
          <EmptyState
            titleAr="لا توجد أصناف محددة"
            messageAr="اضغط على '+' لإضافة أصناف للتوريد. يمكنك البحث بالاسم، الكود، أو الباركود."
          />
        ) : (
          <>
            <div className="mobile-entity-list">
              {received.map((line) => (
                <div
                  key={line.productId}
                  className="mobile-stock-card"
                >
                  <div className="mobile-stock-card-main flex-1 min-w-0">
                    <strong className="truncate block">{line.productName}</strong>
                    <span className="text-xs text-muted-foreground" dir="ltr">{line.sku}</span>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div className="space-y-1">
                        <Label htmlFor={`restock-qty-${line.productId}`} className="text-xs">الكمية</Label>
                        <Input
                          id={`restock-qty-${line.productId}`}
                          type="number"
                          min="0"
                          step="1"
                          inputMode="decimal"
                          value={draftOf(line.productId).quantity}
                          onChange={(e) => setDraft(line.productId, { quantity: e.target.value })}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`restock-cost-${line.productId}`} className="text-xs">تكلفة الوحدة</Label>
                        <Input
                          id={`restock-cost-${line.productId}`}
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          value={draftOf(line.productId).unitCost}
                          onChange={(e) => setDraft(line.productId, { unitCost: e.target.value })}
                          className="h-8 text-sm"
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-2 text-sm">
                      <span className="text-muted-foreground">
                        متاح: {(page.rows.find((p: any) => String(p.id) === line.productId)?.mobileStock ?? 0).toLocaleString("ar-EG")}
                      </span>
                      <button
                        type="button"
                        className="text-destructive hover:underline text-sm"
                        onClick={() => removeLine(line.productId)}
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
                    <SelectItem value="">اختر المورد…</SelectItem>
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

              <div className="rounded-lg bg-muted/50 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    إجمالي التوريد
                    {received.length > 1 ? ` (${received.length} أصناف)` : ""}
                  </span>
                  <span className="font-bold">{formatMoney(total)}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  التوريد ده بيتسجّل مدفوع كاش، وبيتسجّل فاتورة واحدة باسم المورد تظهر في حسابه في
                  شاشة المشتريات. لو التوريد على الحساب (آجل)، سجّله من شاشة المشتريات.
                </p>
              </div>
            </div>
          </>
        )}

        {page.hasMore && !showProductPicker && (
          <button
            type="button"
            className="mobile-primary-button mobile-load-more"
            onClick={page.loadMore}
            disabled={page.loadingMore}
          >
            {page.loadingMore ? "جارٍ التحميل…" : "تحميل المزيد"}
          </button>
        )}
      </div>

      <div className="sticky bottom-0 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-4">
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={saving}>
            إلغاء
          </Button>
          <Button onClick={() => void receive()} disabled={!canSave} className="flex-1">
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
              {typeof navigator !== "undefined" && !navigator.onLine ? (
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
                          setSelectedProductIds((prev) => [...prev, String(product.id)]);
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