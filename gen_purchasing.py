
import sys

content = """import React, { useState } from "react";
import { Package, Plus, Trash2, Loader2, Save } from "lucide-react";
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
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useStock } from "@/lib/ledger/useStock";
import { appendEvent } from "@/lib/ledger";
import { buildPurchaseLines } from "@/lib/ledger/purchases";
import { ProductSearch } from "@/components/products/ProductSearch";
import { formatMoney } from "@/lib/math";
import { WALLET_LABELS } from "@/types";
import { cn } from "@/lib/utils";

const NEW_SUPPLIER = "__new__";

export default function PurchasingPage() {
  const { suppliers, addSupplier, addPurchaseInvoice, purchaseInvoices, products, updateProduct } = useBusinessStore();
  const { qtyOf, refresh: refreshStock } = useStock();

  const [draft, setDraft] = useState<any[]>([]);
  const [wallet, setWallet] = useState<any>("inStoreSafe");
  const [supplierId, setSupplierId] = useState("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierPhone, setNewSupplierPhone] = useState("");
  const [saving, setSaving] = useState(false);

  // Variant Modal State
  const [pendingVariantSelection, setPendingVariantSelection] = useState<any | null>(null);

  const registeringNew = supplierId === NEW_SUPPLIER;
  const supplierReady = registeringNew ? newSupplierName.trim().length > 0 : supplierId !== "";
  const total = draft.reduce((sum, l) => sum + (l.quantity * l.unitCost), 0);
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
          product: product, // keep full product for variant stock updates
          productName: product.name,
          quantity: qty,
          unitCost: product.cost ?? 0,
          variantName,
        },
      ];
    });
  };

  async function receive() {
    if (!canSave) return;
    setSaving(true);
    try {
      const supplier = registeringNew
        ? addSupplier({
            companyName: newSupplierName.trim(),
            contactPerson: "",
            phone: newSupplierPhone.trim(),
          })
        : suppliers.find((s) => s.id === supplierId);
      if (!supplier) throw new Error("المورد مش موجود");

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
          paidAmount: total,
        }),
      });

      // Update variant stock
      for (const line of draft) {
        if (line.variantName && line.product.metadata?.variants) {
          const variants = [...line.product.metadata.variants];
          const variant = variants.find((v: any) => v.name === line.variantName);
          if (variant) {
            variant.stock = (variant.stock || 0) + line.quantity;
            updateProduct(line.productId, {
              metadata: { ...line.product.metadata, variants }
            });
          }
        }
      }

      addPurchaseInvoice({
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
        paidAmount: total,
        remainingAmount: 0,
        dueDate: new Date().toISOString().slice(0, 10),
        status: "paid",
        notes: "فاتورة مشتريات (دفع نقدي)",
      });

      refreshStock();
      setDraft([]);
      setSupplierId("");
      setNewSupplierName("");
      setNewSupplierPhone("");
      toast.success("تم تسجيل الفاتورة بنجاح");
    } catch (e) {
      toast.error(`خطأ: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">فاتورة مشتريات</h1>
          <p className="text-muted-foreground">إنشاء فاتورة مشتريات جديدة وتوريد المخزون</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-6">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>المنتجات</CardTitle>
              <CardDescription>ابحث عن المنتجات وأضفها للفاتورة</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <ProductSearch
                  products={products}
                  qtyOf={qtyOf}
                  onSelect={(product) => {
                    if (product.metadata?.variants?.length > 0) {
                      setPendingVariantSelection({ product, qty: 1 });
                    } else {
                      addItemToDraft(product, 1);
                    }
                  }}
                  excludeIds={draft.filter(d => !d.variantName).map((l) => l.productId)}
                  placeholder="ابحث باسم المنتج أو الكود لإضافته للفاتورة..."
                />
              </div>

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
                            onChange={(e) => setDraft(prev => prev.map((l, i) => i === idx ? { ...l, quantity: parseInt(e.target.value) || 1 } : l))}
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
                        <Button
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

              <div className="pt-4 border-t border-border flex items-center justify-between">
                <span className="font-medium">إجمالي الفاتورة</span>
                <span className="text-xl font-bold text-primary">{formatMoney(total)}</span>
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

      {/* Variant Selection Modal */}
      <Dialog
        open={pendingVariantSelection !== null}
        onOpenChange={(open) => !open && setPendingVariantSelection(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>اختر الدرجة / اللون</DialogTitle>
            <DialogDescription>
              يوجد تفاصيل إضافية لهذا المنتج. يرجى تحديد الخيار المطلوب:
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
  );
}
"""

with open("src/components/purchasing/PurchasingPage.tsx", "w", encoding="utf-8") as f:
    f.write(content)

