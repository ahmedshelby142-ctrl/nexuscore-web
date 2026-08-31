/**
 * توريد سريع — receive stock without leaving the products list.
 *
 * The owner's most frequent action after "what is on the shelf?" is "I just
 * got more of this". Sending her to شاشة المشتريات to build a full invoice for
 * one line item is the reason stock went stale in the first place.
 *
 * It writes ONE `purchase` event through `buildPurchaseLines` — the SAME
 * builder the invoice screen uses. There is no second receive path: change the
 * shape of a receipt there and this changes with it.
 *
 * It also asks WHO it came from, and writes the matching purchase invoice
 * document through the same `addPurchaseInvoice` the invoice screen uses — so
 * a fast receive shows up in that supplier's totals and history exactly like a
 * typed invoice. Without it, every quick توريد was invisible in
 * المشتريات والموردين.
 *
 * The supplier belongs to the EVENT, never to the product: the same item comes
 * from المرادي this week and someone else the next, so a "default supplier"
 * field on `Product` would be wrong the first time a second supplier is used.
 *
 * Deliberately cash-paid. The credit split, due date and notes belong to the
 * full invoice form (§3.5); the dialog says so in Arabic rather than silently
 * dropping the option.
 */

import { useRef, useState } from "react";
import { PackageCheck, Loader2 } from "lucide-react";
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
import { appendEvent } from "@/lib/ledger";
import { buildPurchaseLines } from "@/lib/ledger/purchases";
import { useBusinessStore } from "@/store/useBusinessStore";
import { formatMoney } from "@/lib/math";
import { WALLET_LABELS } from "@/types";
import type { Product, Supplier, WalletType } from "@/types";

/** Sentinel for "this supplier is not registered yet". */
const NEW_SUPPLIER = "__new__";

interface QuickRestockDialogProps {
  /**
   * The products being received. One from a product row, several from المخازن's
   * bulk selection — the same dialog, because a receipt of many lines is what
   * `buildPurchaseLines` already takes. Empty/null closes it.
   */
  products: Product[] | null;
  onClose: () => void;
  /** Re-read the ledger so the rows' quantities move immediately. */
  onReceived: () => void;
}

/** What the owner typed for one line of the receipt. */
interface LineDraft {
  quantity: string;
  unitCost: string;
  variantName?: string;
}

export function QuickRestockDialog({ products, onClose, onReceived }: QuickRestockDialogProps) {
  const { suppliers, addSupplier, addPurchaseInvoice, purchaseInvoices } = useBusinessStore();
  const [lines, setLines] = useState<Record<string, LineDraft>>({});
  const [wallet, setWallet] = useState<WalletType>("inStoreSafe");
  const [supplierId, setSupplierId] = useState("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierPhone, setNewSupplierPhone] = useState("");
  const [saving, setSaving] = useState(false);
  /** Did `appendEvent` succeed? Decides which failure message is the true one. */
  const ledgerWritten = useRef(false);

  const rows = products ?? [];
  const draftOf = (id: string) => lines[id] ?? { quantity: "", unitCost: "" };
  const setDraft = (id: string, patch: Partial<LineDraft>) =>
    setLines((prev) => ({ ...prev, [id]: { ...draftOf(id), ...patch } }));

  /** Only the lines the owner actually filled in are received. */
  const received = rows
    .map((p) => ({
      product: p,
      quantity: parseFloat(draftOf(p.id).quantity) || 0,
      unitCost: parseFloat(draftOf(p.id).unitCost) || 0,
      variantName: draftOf(p.id).variantName,
    }))
    .filter((line) => line.quantity > 0);

  const total = received.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
  const registeringNew = supplierId === NEW_SUPPLIER;
  // A receipt always came from somebody. Naming them is what keeps the
  // supplier's account complete, so it is required — with the inline option
  // below so a first-time supplier is never a dead end.
  const supplierReady = registeringNew ? newSupplierName.trim().length > 0 : supplierId !== "";
  const canSave =
    received.length > 0 && 
    received.every((l) => l.unitCost >= 0 && (!l.product.metadata?.variants?.length || l.variantName)) && 
    supplierReady && 
    !saving;

  function reset() {
    setLines({});
    setSupplierId("");
    setNewSupplierName("");
    setNewSupplierPhone("");
    setSaving(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function receive() {
    if (!canSave) return;
    setSaving(true);

    // Staged on purpose. Each step depends on the one before it, and the error
    // the user sees has to say WHICH stage failed — "nothing was saved" and
    // "the stock is in but the invoice is not" are different facts and lead to
    // different next actions.
    let supplier: Supplier | undefined;
    try {
      // ── 1. The supplier (parent) ────────────────────────────────────────
      // AWAITED. This used to be a bare call to an async action, so `supplier`
      // was a pending Promise: `supplier.id` and `supplier.companyName` were
      // both `undefined`, and the receipt below was written against a supplier
      // that had no id. The invoice then never appeared in anyone's account.
      // TypeScript could not catch it because `Supplier` is `any` — see the
      // note at the top of src/types/index.ts.
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
      return;
    }

    try {

      // Same numbering as the invoice screen, off the same list, so the
      // sequence stays continuous however the receipt was entered.
      const invoiceNumber = "FM-" + String(purchaseInvoices.length + 1).padStart(4, "0");

      // ONE event. Same builder as the invoice screen: stock + (qty AND value,
      // which is what keeps the weighted-average cost derivable) and the cash
      // leaving the chosen wallet. Paid in full, so no supplier debt is booked.
      await appendEvent({
        kind: "purchase",
        actor: "توريد",
        refType: "supplier_invoice",
        refId: invoiceNumber,
        payload: {
          invoiceNumber,
          supplierName: supplier.companyName,
          itemCount: received.length,
          wallet,
          via: "quick_restock",
        },
        // Many lines or one — `buildPurchaseLines` has always taken an items
        // array, so a bulk receive is the SAME single event, not a loop of
        // events. A loop would make five products five receipts, any of which
        // could half-fail.
        lines: buildPurchaseLines({
          items: received.map((l) => ({
            productId: l.product.id,
            quantity: l.quantity,
            unitCost: l.unitCost,
            variantName: l.variantName,
          })),
          wallet,
          supplierId: supplier.id,
          paidAmount: total,
        }),
      });

      // Past this point the ledger HAS the event: stock and cash have moved.
      ledgerWritten.current = true;

      // The same movement a توريد makes, and the same hole it used to have:
      // this loop was gated on `variantName`, so a bulk restock of plain
      // products moved the ledger and left the record untouched.
      useBusinessStore.getState().applyStockMoves(
        received.map((line) => ({
          productId: line.product.id,
          delta: line.quantity,
          variantName: line.variantName,
        })),
      );

      // ── 3. The document, only after the event ───────────────────────────
      // A supplier invoice with no stock behind it is the drift we delete
      // everywhere else. This is what makes the receipt show up in that
      // supplier's totals and history.
      //
      // Awaited and caught SEPARATELY: by this point the stock and the money
      // are already in the ledger, so telling the user "nothing was saved"
      // would be a lie that makes them enter the receipt twice.
      await addPurchaseInvoice({
        invoiceNumber,
        supplierId: supplier.id,
        supplierName: supplier.companyName,
        items: received.map((l) => ({
          id: crypto.randomUUID(),
          productId: l.product.id,
          productName: l.product.name,
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
        notes: "توريد سريع من شاشة المنتجات",
      });

      toast.success(
        received.length > 1
          ? `اتسجّل توريد ${received.length} أصناف باسم ${supplier.companyName}`
          : `اتسجّل التوريد باسم ${supplier.companyName}`,
      );

      // Re-read the ledger so the rows' quantities move immediately.
      onReceived();
      close();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);

      // `appendEvent` is all-or-nothing, and it runs before the invoice. So a
      // failure here is one of two different situations, and the user needs to
      // know which: if the ledger took the event, the stock and the cash HAVE
      // moved and re-entering the receipt would double it.
      if (ledgerWritten.current) {
        toast.error(
          `المخزون والفلوس اتسجّلوا، لكن فاتورة المورد متسجّلتش. ` +
            `متعملش التوريد تاني — سجّل الفاتورة من شاشة المشتريات. ${detail}`,
        );
        // The stock DID move, so the list must still refresh.
        onReceived();
        close();
      } else {
        toast.error(`التوريد متسجّلش، والمخزون زي ما هو. ${detail}`);
      }
    } finally {
      ledgerWritten.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={rows.length > 0} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="size-5" />
            {rows.length > 1 ? `توريد ${rows.length} أصناف` : "توريد سريع"}
          </DialogTitle>
          <DialogDescription>
            {rows.length > 1
              ? "املا الكمية والتكلفة للأصناف اللي وصلت — الصنف اللي تسيبه فاضي مش هيتسجّل. كله بيتسجّل كحركة توريد واحدة."
              : rows[0]
                ? `إضافة كمية جديدة لـ "${rows[0].name}" — هتتسجل كحركة توريد فعلية`
                : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            {rows.map((p, i) => (
              <div
                key={p.id}
                className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_7rem] gap-2 sm:items-end rounded-lg border border-border p-3"
              >
                <div className="min-w-0 flex flex-col justify-center gap-1.5">
                  <p className="font-medium truncate">{p.name}</p>
                  {p.metadata?.variants && p.metadata.variants.length > 0 && (
                    <select
                      className="h-7 text-xs rounded-md border border-input bg-background px-2"
                      value={draftOf(p.id).variantName || ""}
                      onChange={(e) => setDraft(p.id, { variantName: e.target.value })}
                    >
                      <option value="">-- اختر درجة/لون --</option>
                      {p.metadata.variants.map((v: any, idx: number) => (
                        <option key={idx} value={v.name}>{v.name}</option>
                      ))}
                    </select>
                  )}
                  <p className="text-[10px] text-muted-foreground font-mono" dir="ltr">
                    {p.barcode || p.sku}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`restock-qty-${p.id}`}>الكمية</Label>
                  <Input
                    id={`restock-qty-${p.id}`}
                    type="number"
                    min="0"
                    inputMode="decimal"
                    value={draftOf(p.id).quantity}
                    onChange={(e) => setDraft(p.id, { quantity: e.target.value })}
                    autoFocus={i === 0}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`restock-cost-${p.id}`}>تكلفة الوحدة</Label>
                  <Input
                    id={`restock-cost-${p.id}`}
                    type="number"
                    min="0"
                    inputMode="decimal"
                    value={draftOf(p.id).unitCost}
                    onChange={(e) => setDraft(p.id, { unitCost: e.target.value })}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="restock-supplier">المورد</Label>
            <select
              id="restock-supplier"
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
            <p className="text-xs text-muted-foreground">
              المورد بيتسجّل على التوريدة نفسها، مش على المنتج — نفس الصنف ممكن ييجي من مورد
              مختلف المرة الجاية.
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
            <select
              id="restock-wallet"
              value={wallet}
              onChange={(e) => setWallet(e.target.value as WalletType)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {Object.entries(WALLET_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
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

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={close} disabled={saving}>
            إلغاء
          </Button>
          <Button onClick={() => void receive()} disabled={!canSave}>
            {saving && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
            {saving
              ? "جاري التسجيل…"
              : received.length > 1
                ? `تسجيل توريد ${received.length} أصناف`
                : "تسجيل التوريد"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
