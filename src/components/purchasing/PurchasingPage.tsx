import React, { useCallback, useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSubmitGate } from "@/hooks/useSubmitGate";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useStock } from "@/lib/ledger/useStock";
import { appendEvent, balancesByRef } from "@/lib/ledger";
import { buildPurchaseLines } from "@/lib/ledger/purchases";
import { nextDocumentNumber } from "@/services/documentNumber";
import { commitReceipt } from "@/lib/receiving";
import { ProductSearch } from "@/components/products/ProductSearch";
import { formatMoney, formatBalance, formatQty, round } from "@/lib/math";
import { figureOr, moneyFigure, statusOf } from "@/lib/figure";
import { LoadError } from "@/components/ui/load-error";
import { CollectionGate, useCollectionStatus } from "@/components/ui/collection-gate";
import { useBalances } from "@/lib/ledger/useBalances";
import {
  buildSupplierReturnLines,
  purchaseLineKey,
  reconcileSupplierReturn,
  resolveSupplierReturn,
  type PriorSupplierReturn,
  type ResolvedSupplierReturn,
} from "@/lib/ledger/purchases";
import {
  SupplierReturnPicker,
  type SupplierReturnSelection,
} from "@/components/purchasing/SupplierReturnPicker";
import { WholesaleReturnPanel } from "@/components/wholesale/WholesaleReturnPanel";
import { allocateSupplierPayment, openInvoicesFor } from "@/lib/supplierSettlement";
import { commitSupplierPayment, formatSupplierPaymentSuccess } from "@/lib/supplierPaymentCommand";
import { WALLET_LABELS } from "@/types";
import type { WalletType } from "@/types";
import { cn } from "@/lib/utils";

const NEW_SUPPLIER = "__new__";

export function PurchasingPage() {
  const {
    suppliers,
    addSupplier,
    addPurchaseInvoice,
    updatePurchaseInvoice,
    removePurchaseInvoice,
    purchaseInvoices,
    products,
    applyStockMoves,
  } = useBusinessStore();
  // `costOf` is deliberately NOT read here any more. It is the shelf's weighted
  // average, and pricing a supplier return with it is the bug this screen was
  // fixed for — the cost now comes off the purchase invoice line.
  const { qtyOf, refresh: refreshStock } = useStock();
  // What we owe each supplier — the account the آجل half of a receipt feeds.
  const supplierDebt = useBalances("payable_supplier");
  const { amountOf: debtOf, total: totalSupplierDebt, refresh: refreshDebt } = supplierDebt;

  // Dashboard Stats — counts and sums of the hydrated documents, so they are
  // only numbers once those tables have actually been read.
  const docsRead = useCollectionStatus(["purchase_invoices", "suppliers"]).read;
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
    // The still-open ones, oldest first — the same order a payment settles
    // them in, so what the operator sees is what the allocator will do.
    const open = openInvoicesFor(invs as never, selectedSupplier.id);
    // THE LEDGER decides what is owed. `remainingAmount` on the documents is
    // the per-invoice breakdown of this number, never a second opinion on it.
    const owed = debtOf(selectedSupplier.id);
    return { invs, totalVolume, open, owed };
  })() : null;

  // One submit at a time. See `useSubmitGate` — `saving`/`returning` state
  // cannot do this on its own.
  const receiveGate = useSubmitGate();
  const returnGate = useSubmitGate();
  const payGate = useSubmitGate();

  // ── تسوية المورد ──────────────────────────────────────────────────────────
  const [isPayOpen, setIsPayOpen] = useState(false);
  const [payWallet, setPayWallet] = useState<WalletType>("inStoreSafe");
  const [payInput, setPayInput] = useState("");
  const [payNote, setPayNote] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const payAmount = Math.max(0, Number(payInput) || 0);
  /** The plan the operator is about to confirm. Recomputed as they type. */
  const payPlan = useMemo(() => {
    if (!selectedSupplier || payAmount <= 0) return null;
    try {
      return allocateSupplierPayment(supplierMetrics?.open ?? [], payAmount);
    } catch {
      return null;
    }
  }, [selectedSupplier, payAmount, supplierMetrics?.open]);

  const canPay = Boolean(selectedSupplier) && payAmount > 0 && !paying;

  async function paySupplier() {
    if (!selectedSupplier || !canPay || !payGate.enter()) return;
    setPaying(true);
    setPayError(null);
    try {
      const result = await commitSupplierPayment({
        supplierId: selectedSupplier.id,
        supplierName: selectedSupplier.companyName,
        wallet: payWallet,
        amount: payAmount,
        invoices: purchaseInvoices as never,
        note: payNote.trim(),
        actor: "المشتريات",
      });
      toast.success(formatSupplierPaymentSuccess(result));
      setIsPayOpen(false);
      setPayInput("");
      setPayNote("");
      // Both halves of what changed: the ledger balance and the documents.
      refreshDebt();
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
      payGate.exit();
    }
  }

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

  // ── مرتجع مورد: invoice-driven, settled against what we owe them ──────────
  //
  // The flow is المورد → فواتيره → بند → كمية, and the selection below is a map
  // of `invoiceId::lineKey → quantity` rather than a list of products. There is
  // no shape here that can hold a product this supplier never supplied, and no
  // place for a cost that did not come off the receipt.
  const [isReturnOpen, setIsReturnOpen] = useState(false);
  const [returnSupplierId, setReturnSupplierId] = useState("");
  const [returnSelection, setReturnSelection] = useState<SupplierReturnSelection>({});
  const [returnPaidInput, setReturnPaidInput] = useState("");
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);

  /**
   * What has already gone back, straight out of the ledger.
   *
   * Not a stored counter: `return_records` is writable only by ADMIN /
   * POS_ECOMMERCE / ECOMMERCE_ONLY while `/purchasing` belongs to ACCOUNTANT,
   * so a counter kept there would silently stop capping for the very role that
   * does this job. The `stock −` lines of past `supplier_return` events are
   * readable by every member and are the movement itself. See `balancesByRef`.
   */
  const [priorReturns, setPriorReturns] = useState<PriorSupplierReturn[]>([]);
  const [priorReturnsError, setPriorReturnsError] = useState<string | null>(null);

  const loadPriorReturns = useCallback(async () => {
    try {
      const rows = await balancesByRef({
        account: "stock",
        kind: "purchase",
        refType: "supplier_return",
      });
      setPriorReturns(rows);
      setPriorReturnsError(null);
      return rows;
    } catch (e) {
      // Refuse to guess. An unknown ceiling reads as zero and would let the
      // same goods go back twice, so the screen says so and blocks instead.
      setPriorReturnsError(
        `تعذّر قراءة المرتجعات السابقة، فمش هنقدر نحسب المتبقي. ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }, []);

  /** This supplier's purchase invoices, newest first. */
  const returnSupplierInvoices = useMemo(
    () =>
      purchaseInvoices
        .filter((i: any) => i.supplierId === returnSupplierId)
        .slice()
        .sort(
          (a: any, b: any) =>
            new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
        ),
    [purchaseInvoices, returnSupplierId],
  );

  const returnRequests = useMemo(
    () =>
      Object.entries(returnSelection)
        .filter(([, qty]) => qty > 0)
        .map(([key, quantity]) => {
          const at = key.indexOf("::");
          return { invoiceId: key.slice(0, at), lineKey: key.slice(at + 2), quantity };
        }),
    [returnSelection],
  );

  /**
   * The selection proved against those invoices — or the reason it cannot be.
   *
   * Resolved on every render so the operator sees a refusal while they can
   * still fix it, and so the تسوية panel is drawn from the same numbers the
   * ledger will book. The submit path resolves again: this is a preview.
   */
  const resolvedReturn = useMemo(() => {
    if (!returnSupplierId || returnRequests.length === 0) {
      return { ok: null, error: null } as const;
    }
    try {
      return {
        ok: resolveSupplierReturn({
          supplierId: returnSupplierId,
          requests: returnRequests,
          invoices: returnSupplierInvoices,
          priorReturns,
          onHand: qtyOf,
        }),
        error: null,
      } as const;
    } catch (e) {
      return { ok: null, error: e instanceof Error ? e.message : String(e) } as const;
    }
  }, [returnSupplierId, returnRequests, returnSupplierInvoices, priorReturns, qtyOf]);

  const returnValue = resolvedReturn.ok?.returnValue ?? 0;
  const returnSupplierDebt = returnSupplierId ? debtOf(returnSupplierId) : 0;
  const returnSettle = reconcileSupplierReturn(returnValue, returnSupplierDebt, returnPaidInput);

  function openReturnModal() {
    setReturnSupplierId("");
    setReturnSelection({});
    setReturnPaidInput("");
    setReturnError(null);
    // Both as they are NOW. `useBalances` is a snapshot, and the تسوية panel
    // decides between "this clears what we owe" and "they refund us cash" from
    // the debt — a stale zero turns a settlement into a cash receipt.
    refreshDebt();
    refreshStock();
    void loadPriorReturns().catch(() => {});
    setIsReturnOpen(true);
  }

  async function submitReturn() {
    if (!returnSupplierId) {
      setReturnError("اختر المورد أولاً");
      return;
    }
    if (priorReturnsError) {
      setReturnError(priorReturnsError);
      return;
    }
    if (resolvedReturn.error) {
      setReturnError(resolvedReturn.error);
      return;
    }
    if (returnRequests.length === 0) {
      setReturnError("اختر بند من فاتورة وحدد الكمية المرتجعة");
      return;
    }
    // The تسوية splits this return between "clears what we owe" and "they
    // refund us cash" FROM the debt. A debt read that failed answers 0, and a
    // return posted against that 0 books cash we never received instead of
    // reducing the payable. Refuse rather than post it.
    if (statusOf(supplierDebt) !== "ready") {
      setReturnError(
        supplierDebt.error
          ? "تعذّرت قراءة رصيد المورد من الدفتر، فالمرتجع مش هيتسجل لحد ما يتقري. جرّب تاني."
          : "رصيد المورد لسه بيتحمّل. جرّب تاني بعد لحظة.",
      );
      if (supplierDebt.error) refreshDebt();
      return;
    }

    if (!returnGate.enter()) return;
    setReturning(true);
    setReturnError(null);
    try {
      // Re-read the ledger's ceiling and re-resolve against it, rather than
      // trusting what this tab rendered. `useSubmitGate` stops a double click;
      // it cannot stop a tab left open since another device sent the same goods
      // back. This is what makes that second submission fail on the ceiling.
      const fresh = await loadPriorReturns();
      const resolved = resolveSupplierReturn({
        supplierId: returnSupplierId,
        requests: returnRequests,
        invoices: returnSupplierInvoices,
        priorReturns: fresh,
        onHand: qtyOf,
      });

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
        // The SOURCE INVOICE, not the supplier. This is the load-bearing
        // change: it is what stops the return being an orphan (§10), and it is
        // the key `balancesByRef` groups by to derive the ceiling. Pointing it
        // at the supplier — as it used to — made every one of that supplier's
        // returns indistinguishable from the others.
        refId: resolved.lines[0].invoiceNumber,
        payload: {
          supplierId: returnSupplierId,
          supplierName: supplier?.companyName ?? "",
          invoiceNumber: resolved.lines[0].invoiceNumber,
          previousDebt: returnSupplierDebt,
          returnValue: resolved.returnValue,
          paidNow: returnSettle.paidNow,
          items: resolved.lines.map((l) => ({
            productId: l.productId,
            productName: l.productName,
            quantity: l.quantity,
            unitCost: l.unitCost,
          })),
        },
        lines: buildSupplierReturnLines({
          resolved,
          wallet,
          currentDebt: returnSupplierDebt,
          paidNow: returnSettle.paidNow,
        }),
      });

      // The goods left the shelf. The ledger recorded it above; this is the
      // mirror catching up.
      applyStockMoves(
        resolved.lines.map((l) => ({
          productId: l.productId,
          delta: -l.quantity,
          variantName: l.variantName,
        })),
      );

      // The human-readable half: the receipt now says how much of each line has
      // gone back. Deliberately NOT the ceiling — the ledger is — so a failure
      // here cannot let the same goods be returned twice. Best-effort for that
      // reason, with the operator told if it did not land.
      try {
        await stampReturnOnInvoice(resolved);
      } catch (e) {
        toast.error(
          `المرتجع اتسجل والحسابات اتظبطت، بس سجل الفاتورة مااتحدّثش. ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      refreshStock();
      refreshDebt();
      await loadPriorReturns().catch(() => {});
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

  /**
   * Write what went back onto the purchase invoice itself.
   *
   * The return document the brief asks for (§10), built out of the receipt
   * rather than a new table: `purchase_invoices` is already store-scoped,
   * already synced, already writable by exactly the roles that do purchasing,
   * and it is the one row that inherently names the supplier, the invoice, the
   * product, the quantity and the original unit cost.
   *
   * `returnedQuantity` here is a RECORD, never the ceiling — the ledger is. A
   * read-modify-write on jsonb is not atomic, so if this were load-bearing two
   * concurrent returns could both read zero. Because it is not, the worst a
   * lost update can do is make the screen understate what has gone back until
   * the next read, while the ledger still refuses the over-return.
   */
  async function stampReturnOnInvoice(resolved: ResolvedSupplierReturn) {
    const invoiceId = resolved.lines[0].invoiceId;
    const invoice = purchaseInvoices.find((i: any) => i.id === invoiceId);
    if (!invoice) return;

    const byKey = new Map(resolved.lines.map((l) => [l.lineKey, l.quantity]));
    await updatePurchaseInvoice(invoiceId, {
      items: (invoice.items ?? []).map((line: any) => {
        const back = byKey.get(purchaseLineKey(line)) ?? 0;
        if (back <= 0) return line;
        return {
          ...line,
          returnedQuantity: (Number(line.returnedQuantity) || 0) + back,
          lastReturnedAt: new Date().toISOString(),
        };
      }),
      // …and the open balance, which this write used to leave alone. Measured
      // on QA-STORE: `payable_supplier` for محمود held 2,600 — a 3,000 فاتورة
      // آجل less a 400 return — while FM-0003 still read «متبقي ٣٬٠٠٠». The
      // ledger is the authority either way, but the invoice list was showing
      // an amount that had already gone back.
      //
      // `resolved.returnValue` is the same rounded figure `buildSupplierReturnLines`
      // credited to the ledger, so the two cannot differ by a piastre.
      remainingAmount: Math.max(
        0,
        (Number(invoice.remainingAmount) || 0) - resolved.returnValue,
      ),
    });
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

      // The cost the goods leave at, frozen per line, plus the بوكس recipe.
      // `buildPurchaseLines` has always known how to charge a bundle to its
      // COMPONENTS, but this screen never told it the line WAS one — so a
      // bundle received here booked stock and cost against a virtual product
      // that has neither.
      const ledgerItems = draft.map((i: any) => {
        const record: any = products.find((p: any) => p.id === i.productId);
        const bundle =
          record?.isBundle && record.bundleItems?.length
            ? {
                isBundle: true,
                bundleItems: record.bundleItems.map((c: any) => ({
                  productId: c.productId,
                  quantity: c.quantity,
                  unitCost: c.unitCost ?? 0,
                })),
              }
            : {};
        return {
          productId: i.productId,
          productName: i.productName,
          sku: i.product?.sku ?? "",
          quantity: i.quantity,
          unitCost: i.unitCost,
          variantName: i.variantName,
          ...bundle,
        };
      });

      // ONE shared write path — `commitReceipt`. It draws an invoice number
      // that is not already taken, writes the DOCUMENT before the ledger, and
      // takes the document back if the ledger refuses. That ordering and that
      // numbering used to live here and nowhere else, while desktop quick
      // restock and the mobile receipt carried their own broken copies.
      await commitReceipt({
        supplierId: supplier.id,
        supplierName: supplier.companyName,
        items: ledgerItems,
        wallet,
        paidAmount,
        dueDate: new Date().toISOString().slice(0, 10),
        notes: owedAmount > 0 ? "فاتورة مشتريات (آجل جزئي)" : "فاتورة مشتريات (دفع نقدي)",
        actor: "الكاشير",
        via: "purchasing_page",
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
      {/*
        `flex-wrap` on both rows. Measured live at 390px: the action row was
        335px but sat at left:-99, so in RTL it ran off the START edge and the
        PRIMARY action — تسجيل فاتورة مشتريات — was cut in half. The screen's
        main verb was the thing you could not press.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-display font-bold">المشتريات والموردين</h1>
          <p className="text-muted-foreground mt-1">إدارة فواتير المشتريات، الموردين وتوريد المخزون</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
                <h3 className="text-2xl font-bold">{figureOr(() => String(totalInvoices), docsRead)}</h3>
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
                <h3 className="text-2xl font-bold">{moneyFigure(totalVolume, docsRead)}</h3>
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
                <h3 className="text-2xl font-bold">{figureOr(() => String(totalSuppliers), docsRead)}</h3>
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
                      <CollectionGate tables={["purchase_invoices"]}>لا توجد فواتير مشتريات</CollectionGate>
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
                      <CollectionGate tables={["suppliers"]}>لا يوجد موردين</CollectionGate>
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
              <Label>الفاتورة والبنود الراجعة</Label>
              <SupplierReturnPicker
                invoices={returnSupplierInvoices}
                priorReturns={priorReturns}
                selection={returnSelection}
                onSelectionChange={setReturnSelection}
                onHand={qtyOf}
                supplierMissing={!returnSupplierId}
              />
            </div>

            {priorReturnsError && (
              <div className="rounded-lg p-3 bg-amber-50 border border-amber-200">
                <p className="text-sm font-medium text-amber-900">{priorReturnsError}</p>
              </div>
            )}

            {resolvedReturn.ok && resolvedReturn.ok.lines.length > 0 && (
              <div className="rounded-xl border border-border divide-y">
                {resolvedReturn.ok.lines.map((line) => (
                  <div
                    key={`${line.invoiceId}::${line.lineKey}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{line.productName}</span>
                      {/* The source receipt and its cost stay on screen right
                          up to the confirm button — this is the number the
                          whole fix is about. */}
                      <p className="text-xs text-muted-foreground">
                        من فاتورة {line.invoiceNumber} · تكلفة الشراء {formatMoney(line.unitCost)}
                      </p>
                    </div>
                    <span className="text-sm font-semibold">× {line.quantity}</span>
                    <span className="w-24 text-left font-bold">
                      {formatMoney(line.quantity * line.unitCost)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {resolvedReturn.ok && resolvedReturn.ok.lines.length > 0 && (
              <WholesaleReturnPanel
                variant="supplier"
                debt={returnSupplierDebt}
                debtRead={supplierDebt}
                returnValue={returnValue}
                paidInput={returnPaidInput}
                onPaidChange={setReturnPaidInput}
                clientMissing={!returnSupplierId}
              />
            )}

            {(returnError || resolvedReturn.error) && (
              <div className="rounded-lg p-3 bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-900">
                  {returnError ?? resolvedReturn.error}
                </p>
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
                !!priorReturnsError ||
                !!resolvedReturn.error ||
                !resolvedReturn.ok?.lines.length
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-xl border bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">عدد أوامر التوريد (POs)</p>
              <p className="text-2xl font-bold mt-2 text-gray-900 dark:text-white">{supplierMetrics?.invs.length || 0}</p>
            </div>
            <div className="rounded-xl border bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">إجمالي التعاملات</p>
              <p className="text-2xl font-bold mt-2 text-gray-900 dark:text-white">{formatMoney(supplierMetrics?.totalVolume || 0)}</p>
            </div>
            {/* The balance, from `payable_supplier`. This card did not exist,
                which is why a supplier account could only be read as a list of
                invoices and never as "what do we still owe this person". */}
            <div className="rounded-xl border bg-amber-50 dark:bg-amber-950/30 border-amber-200 p-4">
              <p className="text-sm text-amber-800 dark:text-amber-500">الرصيد المستحق</p>
              <p className="text-2xl font-bold mt-2 text-amber-700 dark:text-amber-400">
                {figureOr(
                  () => formatBalance(supplierMetrics?.owed ?? 0, { owed: "علينا", credit: "لنا" }),
                  supplierDebt,
                )}
              </p>
              {supplierDebt.error && (
                <LoadError
                  className="mt-3"
                  message="تعذّرت قراءة الرصيد من الدفتر."
                  detail={supplierDebt.error}
                  onRetry={refreshDebt}
                  busy={supplierDebt.loading}
                />
              )}
              <Button
                size="sm"
                className="mt-3 w-full"
                // Pre-filling a payment from a balance that did not load would
                // pre-fill nothing and look like "nothing owed".
                disabled={statusOf(supplierDebt) !== "ready"}
                onClick={() => {
                  // Pre-filled with the whole outstanding balance: paying in
                  // full is the common case, and a credit balance pre-fills
                  // nothing because there is nothing to pay.
                  setPayInput(
                    (supplierMetrics?.owed ?? 0) > 0 ? String(round(supplierMetrics!.owed)) : "",
                  );
                  setPayError(null);
                  setIsPayOpen(true);
                }}
              >
                <CreditCard className="size-4 ml-2" />
                تسجيل دفعة / تسوية
              </Button>
            </div>
          </div>

          {/* الفواتير الآجلة — what the balance above is actually made of. */}
          {(supplierMetrics?.open.length ?? 0) > 0 && (
            <div>
              <h4 className="font-bold mb-3 text-lg">الفواتير الآجلة</h4>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">رقم الفاتورة</TableHead>
                      <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">الاستحقاق</TableHead>
                      <TableHead className="text-right px-4 text-gray-900 dark:text-white font-bold">المتبقي</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {supplierMetrics?.open.map((inv: any) => (
                      <TableRow key={inv.id}>
                        <TableCell className="text-right px-4 font-mono font-bold text-gray-900 dark:text-white">{inv.invoiceNumber}</TableCell>
                        <TableCell className="text-right px-4">{inv.dueDate || "—"}</TableCell>
                        <TableCell className="text-right px-4 font-mono font-bold text-amber-700 dark:text-amber-400">
                          {formatMoney(inv.remainingAmount ?? 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          
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
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground"><CollectionGate tables={["purchase_invoices"]}>لا يوجد سجل توريد</CollectionGate></TableCell>
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

    {/* تسوية المورد — the settlement the supplier account never had */}
    <Dialog open={isPayOpen} onOpenChange={(open) => { if (!paying) setIsPayOpen(open); }}>
      <DialogContent className="sm:max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle>تسجيل دفعة للمورد</DialogTitle>
          <DialogDescription>
            {selectedSupplier?.companyName} — الرصيد الحالي{" "}
            {figureOr(
              () => formatBalance(supplierMetrics?.owed ?? 0, { owed: "علينا", credit: "لنا" }),
              supplierDebt,
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pay-amount">المبلغ المدفوع</Label>
            <Input
              id="pay-amount"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={payInput}
              onChange={(e) => setPayInput(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-wallet">الخزينة</Label>
            <Select value={payWallet} onValueChange={(v) => setPayWallet(v as WalletType)}>
              <SelectTrigger id="pay-wallet">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(WALLET_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-note">ملاحظة (اختياري)</Label>
            <Input id="pay-note" value={payNote} onChange={(e) => setPayNote(e.target.value)} />
          </div>

          {/* What this payment will actually do, before it does it. The
              allocation is oldest-invoice-first — see `openInvoicesFor`. */}
          {payPlan && (
            <div className="rounded-xl border bg-muted/30 p-3 space-y-1.5 text-sm">
              {payPlan.allocations.length === 0 ? (
                <p className="text-muted-foreground">مفيش فواتير آجلة مفتوحة للمورد ده.</p>
              ) : (
                payPlan.allocations.map((a) => (
                  <div key={a.invoiceId} className="flex justify-between gap-2">
                    <span className="font-mono">{a.invoiceNumber}</span>
                    <span>
                      {formatMoney(a.applied)}
                      {a.applied < a.outstanding ? ` من ${formatMoney(a.outstanding)}` : " (تسدّدت كاملة)"}
                    </span>
                  </div>
                ))
              )}
              {payPlan.unapplied > 0 && (
                <p className="text-amber-700 dark:text-amber-400 pt-1 border-t border-border">
                  {formatMoney(payPlan.unapplied)} زيادة عن المستحق — هتتسجّل رصيد مقدَّم للمورد.
                </p>
              )}
            </div>
          )}

          {payError && <p className="text-sm text-red-600">{payError}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setIsPayOpen(false)} disabled={paying}>
            إلغاء
          </Button>
          <Button onClick={paySupplier} disabled={!canPay}>
            {paying ? <Loader2 className="size-4 ml-2 animate-spin" /> : <CreditCard className="size-4 ml-2" />}
            تأكيد الدفعة
          </Button>
        </DialogFooter>
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
