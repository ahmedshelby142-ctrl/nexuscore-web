import { useState, useMemo, useEffect } from "react";
import { formatMoney, discountAmountFor, subtract, includedVat, round } from "@/lib/math";
import { useDraftState, clearDrafts } from "@/hooks/useDraftState";
import { productWholesalePrice, getActualStock, getVariantStock, activeProducts } from "@/lib/product";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  FileSpreadsheet,
  Users,
  Plus,
  DollarSign,
  CalendarDays,
  Search,
  Receipt,
  Building2,
  Phone,
  Clock,
  Landmark,
  CheckCircle2,
  X,
  Trash2,
  Printer,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Inbox,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { useBusinessStore } from "@/store/useBusinessStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { useOrderStore } from "@/store/useOrderStore";
import { printTableAsPdf } from "@/lib/pdfGenerator";
import { appendEvent } from "@/lib/ledger";
import { buildWholesaleInvoiceLines, buildClientPaymentLines } from "@/lib/ledger/wholesale";
import { useStock } from "@/lib/ledger/useStock";
import { useBalances } from "@/lib/ledger/useBalances";
import type { WholesaleInvoiceItem, ShippingInfo, WalletType, Product, ShipmentMovement, PromoDiscount } from "@/types";
import { WALLET_LABELS } from "@/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { useShippingRatesStore } from "@/store/useShippingRatesStore";
import { buildWholesaleReturnLines, reconcileWholesaleReturn } from "@/lib/ledger/wholesale";
import { ProductSearch } from "@/components/products/ProductSearch";
import { RotateCcw } from "lucide-react";
import { WholesaleReturnPanel } from "@/components/wholesale/WholesaleReturnPanel";
import { useSettingsStore } from "@/store/useSettingsStore";
import { rateFor, shippedGovernorates } from "@/lib/shippingRates";

type Tab = "invoices" | "clients";

const emptyInvoiceForm = {
  clientId: "",
  paidAmount: 0,
  dueDate: "",
  notes: "",
  wallet: "inStoreSafe" as WalletType,
};

function getInvoiceStatus(
  status: string,
  dueDate: string,
  remaining: number,
): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  if (remaining <= 0) return { label: "مدفوع", variant: "default" };
  if (status === "overdue" || (dueDate && new Date(dueDate) < new Date()))
    return { label: "متأخر", variant: "destructive" };
  if (remaining < 0) return { label: "مدفوع", variant: "default" };
  return { label: "متبقي " + formatMoney(remaining), variant: "secondary" };
}

export function WholesalePage() {
  const {
    products,
    wholesaleClients,
    wholesaleInvoices,
    addWholesaleClient,
    addWholesaleInvoice,
    recordWholesalePayment,
    applyStockMoves,
    promoDiscounts,
  } = useBusinessStore();

  const { costOf, refresh: refreshStock } = useStock();

  const {
    amountOf: debtOf,
    total: totalReceivables,
    error: debtError,
    refresh: refreshDebt,
  } = useBalances("receivable_client");

  const [activeTab, setActiveTab] = useState<Tab>("invoices");
  const [searchQuery, setSearchQuery] = useState("");

  const [isInvoiceOpen, setIsInvoiceOpen] = useDraftState("wholesale:invoiceOpen", false);
  const [invoiceForm, setInvoiceForm] = useDraftState("wholesale:invoiceForm", emptyInvoiceForm);
  const [invoiceItems, setInvoiceItems] = useDraftState<WholesaleInvoiceItem[]>(
    "wholesale:invoiceItems",
    [],
  );
  const [selectedProductId, setSelectedProductId] = useState("");
  const [qtyBox, setItemQty] = useState(1);
  const [pendingVariantSelection, setPendingVariantSelection] = useState<{ product: Product; qty: number } | null>(null);
  const [shippingInfo, setShippingInfo] = useDraftState<ShippingInfo>("wholesale:shipping", {
    requiresShipping: false,
    customerCharge: 0,
    actualCost: 0,
  });
  
  const [clientSearchOpen, setClientSearchOpen] = useState(false);
  const [productSearchOpen, setProductSearchOpen] = useState(false);
  const { rows: shippingRows } = useShippingRatesStore();
  // The بوكس of Phase 3: a discount code on a B2B invoice. Same store, same
  // `discountAmountFor`, same ledger term as POS — nothing bespoke here.
  const [discountCodeInput, setDiscountCodeInput] = useDraftState("wholesale:discountCode", "");
  const [appliedDiscount, setAppliedDiscount] = useDraftState<PromoDiscount | null>(
    "wholesale:appliedDiscount",
    null,
  );
  // The printed فاتورة used to say a hardcoded "راديانت" no matter whose
  // shop this was. It says what الإعدادات say now.
  const shop = useSettingsStore();
  const [selectedGov, setSelectedGov] = useState<string>("");
  const [selectedMovement, setSelectedMovement] = useState<ShipmentMovement>("delivery");
  const [selectedAddressId, setSelectedAddressId] = useState<string>("new");
  const [newAddress, setNewAddress] = useState({ governorate: "", city: "", region: "", details: "" });
  
  const selectedInvoiceClientData = wholesaleClients.find((c) => c.id === invoiceForm.clientId);
  const clientAddresses: any[] = useMemo(
    () => selectedInvoiceClientData?.addresses ?? [],
    [selectedInvoiceClientData],
  );


  const [isNewClientOpen, setIsNewClientOpen] = useState(false);
  const [newClientForm, setNewClientForm] = useDraftState("wholesale:newClient", {
    companyName: "",
    contactPerson: "",
    phone: "",
    email: "",
  });

  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedMerchant, setSelectedMerchant] = useState<any | null>(null);

  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [paymentInvoiceId, setPaymentInvoiceId] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState(0);
  const [paymentWallet, setPaymentWallet] = useState<WalletType>("inStoreSafe");
  const [isPaying, setIsPaying] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [invoiceToPrint, setInvoiceToPrint] = useState<any | null>(null);

  useEffect(() => {
    const handleAfterPrint = () => setInvoiceToPrint(null);
    window.addEventListener("afterprint", handleAfterPrint);
    return () => window.removeEventListener("afterprint", handleAfterPrint);
  }, []);

  const stats = useMemo(() => {
    const totalRevenue = wholesaleInvoices.reduce((s, i) => s + i.totalAmount, 0);
    const activeClients = wholesaleClients.length;
    return { totalRevenue, activeClients };
  }, [wholesaleInvoices, wholesaleClients]);

  const clientTotals = useMemo(() => {
    const totals = new Map<string, { invoiced: number; paid: number }>();
    for (const inv of wholesaleInvoices) {
      const acc = totals.get(inv.clientId) ?? { invoiced: 0, paid: 0 };
      acc.invoiced += inv.totalAmount;
      acc.paid += inv.paidAmount;
      totals.set(inv.clientId, acc);
    }
    return totals;
  }, [wholesaleInvoices]);

  const totalsOf = (clientId: string) =>
    clientTotals.get(clientId) ?? { invoiced: 0, paid: 0 };

  const selectedProduct = products.find((p) => p.id === selectedProductId);
  const paymentInvoice = wholesaleInvoices.find((i) => i.id === paymentInvoiceId);

  const goodsTotal = useMemo(
    () => invoiceItems.reduce((s, i) => s + i.total, 0),
    [invoiceItems],
  );

  // Measured on the GOODS only. A promo on merchandise does not change what
  // the courier costs, which is the same rule `buildWholesaleInvoiceLines`
  // applies when it books the receivable.
  const discountAmount = useMemo(
    () =>
      appliedDiscount
        ? discountAmountFor(goodsTotal, appliedDiscount.type, appliedDiscount.value)
        : 0,
    [appliedDiscount, goodsTotal],
  );

  const invoiceTotal = useMemo(
    () =>
      subtract(goodsTotal, discountAmount) +
      (shippingInfo.requiresShipping ? shippingInfo.customerCharge : 0),
    [goodsTotal, discountAmount, shippingInfo],
  );
  const remainingAfterPaid = Math.max(0, subtract(invoiceTotal, invoiceForm.paidAmount));

  function resetInvoiceForm() {
    clearDrafts("wholesale:");
    setDiscountCodeInput("");
    setAppliedDiscount(null);
    setInvoiceForm(emptyInvoiceForm);
    setInvoiceItems([]);
    setSelectedProductId("");
    setItemQty(1);
    setShippingInfo({ requiresShipping: false, customerCharge: 0, actualCost: 0 });
    setSelectedGov("");
    setSelectedMovement("delivery");
    setSelectedAddressId("new");
    setNewAddress({ governorate: "", city: "", region: "", details: "" });
  }

  // ── مرتجع تاجر: a direct B2B return, settled against the client's account ──
  const [isReturnOpen, setIsReturnOpen] = useState(false);
  const [returnClientId, setReturnClientId] = useState("");
  const [returnItems, setReturnItems] = useState<any[]>([]);
  const [returnSettleInput, setReturnSettleInput] = useState("");
  const [returnError, setReturnError] = useState<string | null>(null);
  const [isReturning, setIsReturning] = useState(false);

  const returnValue = useMemo(
    () => round(returnItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0)),
    [returnItems],
  );
  const returnClientDebt = returnClientId ? debtOf(returnClientId) : 0;
  const returnSettle = reconcileWholesaleReturn(returnValue, returnClientDebt, returnSettleInput);

  function openReturnModal() {
    setReturnClientId("");
    setReturnItems([]);
    setReturnSettleInput("");
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
          unitPrice: productWholesalePrice(product),
        },
      ];
    });
  }

  async function submitReturn() {
    if (!returnClientId) {
      setReturnError("اختر التاجر أولاً");
      return;
    }
    if (returnItems.length === 0) {
      setReturnError("أضف منتج واحد على الأقل للمرتجع");
      return;
    }

    setIsReturning(true);
    setReturnError(null);
    try {
      const client = wholesaleClients.find((c) => c.id === returnClientId);
      await appendEvent({
        kind: "return_confirmed",
        actor: "جملة",
        refType: "wholesale_client",
        refId: returnClientId,
        payload: {
          type: "wholesale_return",
          clientName: client?.companyName ?? "",
          channel: "wholesale",
          previousDebt: returnClientDebt,
          returnValue,
          paidNow: returnSettle.paidNow,
        },
        lines: buildWholesaleReturnLines({
          items: returnItems.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            unitCost: costOf(i.productId),
          })),
          clientId: returnClientId,
          wallet: "inStoreSafe",
          currentDebt: returnClientDebt,
          paidNow: returnSettle.paidNow,
        }),
      });

      // The goods are back. Bundles expand at the choke point.
      applyStockMoves(
        returnItems.map((i) => ({ productId: i.productId, delta: i.quantity })),
      );

      refreshStock();
      refreshDebt();
      setIsReturnOpen(false);
    } catch (e) {
      setReturnError(
        `لم يُسجَّل المرتجع ولم يتغيّر أي رصيد. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setIsReturning(false);
    }
  }

  function openInvoiceModal() {
    resetInvoiceForm();
    setIsInvoiceOpen(true);
  }

  function addItemToInvoice(product?: Product, variantName?: string, qty?: number) {
    const prod = product || selectedProduct;
    if (!prod) return;
    const itemQty = qty ?? qtyBox;

    if (prod.metadata?.variants && prod.metadata.variants.length > 0 && !variantName) {
      setPendingVariantSelection({ product: prod, qty: itemQty });
      return;
    }

    // النواقص (backorder). Selling what is not on the shelf is only a real
    // option when the goods are being shipped — there is a gap between the
    // invoice and the handover to fill it. Over the counter there is no gap,
    // so a short line stays blocked.
    const available = getVariantStock(prod, variantName);
    const alreadyInCart = invoiceItems
      .filter((i: any) => i.productId === prod.id && i.variantName === variantName)
      .reduce((sum: number, i: any) => sum + i.quantity, 0);
    // What the shelf cannot cover once this addition lands. DERIVED from the
    // line's total, never accumulated — the quantity box below can change that
    // total without ever passing through here, and an accumulated figure would
    // quietly stop matching it.
    const shortfall = Math.max(0, alreadyInCart + itemQty - available);
    let backorder = false;

    if (shortfall > 0) {
      if (!shippingInfo.requiresShipping) {
        toast.error(
          `"${prod.name}${variantName ? ` - ${variantName}` : ""}" — المتاح ${available} فقط. فعّل الشحن لتسجيله كطلب نواقص.`,
        );
        return;
      }
      // ponytail: native confirm(). A styled dialog here needs a pending-item
      // state machine for one yes/no — swap it in if the wording ever has to
      // be richer than one line.
      if (
        !window.confirm(
          "هذا المنتج غير متوفر في المخزون حالياً. هل تريد إضافته كطلب نواقص (Backorder)؟",
        )
      ) {
        return;
      }
      backorder = true;
    }

    const existing = invoiceItems.find((i) => i.productId === prod.id && (!variantName || i.productName.endsWith(`- ${variantName}`)));
    if (existing) {
      setInvoiceItems(
        invoiceItems.map((i) =>
          i.productId === prod.id && (!variantName || i.productName.endsWith(`- ${variantName}`))
            ? {
                ...i,
                quantity: i.quantity + itemQty,
                total: (i.quantity + itemQty) * i.wholesalePrice,
                backorder: i.backorder || backorder,
                shortfall,
              }
            : i,
        ),
      );
    } else {
      setInvoiceItems([
        ...invoiceItems,
        {
          id: crypto.randomUUID(),
          productId: prod.id,
          productName: prod.name + (variantName ? ` - ${variantName}` : ""),
          variantName: variantName,
          sku: prod.sku,
          quantity: itemQty,
          wholesalePrice: productWholesalePrice(prod),
          total: itemQty * productWholesalePrice(prod),
          backorder,
          shortfall,
        },
      ]);
    }
    setSelectedProductId("");
    setItemQty(1);
  }

  function updateInvoiceItem(productId: string, variantName: string | undefined, field: "quantity" | "wholesalePrice", value: number) {
    setInvoiceItems(items => items.map((item: any) => {
      if (item.productId === productId && item.variantName === variantName) {
        const qty = field === "quantity" ? value : item.quantity;
        const price = field === "wholesalePrice" ? value : item.wholesalePrice;
        // Typing 50 into the box is the same decision as adding 50, so the
        // نواقص figure is re-derived here rather than left at whatever the
        // add-to-invoice path last measured.
        const available = getVariantStock(products.find((p) => p.id === productId), variantName);
        const shortfall = Math.max(0, qty - available);
        // `backorder` is NOT set here: that flag means "the user was asked and
        // said yes". Typing a big number is not an answer, so an unflagged
        // line that goes short this way is stopped by the submit guard.
        return { ...item, [field]: value, total: qty * price, shortfall };
      }
      return item;
    }));
  }

  function removeInvoiceItem(productId: string, variantName?: string) {
    setInvoiceItems((prev) =>
      prev.filter((i) => !(i.productId === productId && i.variantName === variantName)),
    );
  }

  // Auto-calculate shipping cost — uses functional updater to avoid
  // depending on shippingInfo itself (which would cause an infinite loop).
  const requiresShipping = shippingInfo.requiresShipping;
  useEffect(() => {
    if (!requiresShipping) return;
    let activeGov = "";
    if (selectedAddressId === "new") {
      activeGov = newAddress.governorate || "";
    } else {
      const addr = clientAddresses.find((a: any) => a.id === selectedAddressId);
      if (addr?.governorate) activeGov = addr.governorate;
    }
    const cost = activeGov ? rateFor(shippingRows, activeGov, selectedMovement) : 0;
    setShippingInfo((prev) => ({
      ...prev,
      customerCharge: cost,
      actualCost: cost,
    }));
  }, [requiresShipping, selectedAddressId, newAddress.governorate, clientAddresses, selectedMovement, shippingRows]);


  async function submitInvoice() {
    if (!invoiceForm.clientId || invoiceItems.length === 0) return;
    const client = wholesaleClients.find((c) => c.id === invoiceForm.clientId);
    if (!client) return;
    const invNum = "FJ-" + String(wholesaleInvoices.length + 1).padStart(4, "0");

    // A line the user knowingly accepted as نواقص is allowed through short —
    // that is the whole point of the confirmation. Everything else is not.
    const stockOfLine = (i: any) =>
      getVariantStock(products.find((p) => p.id === i.productId), i.variantName);
    const short = invoiceItems.find((i: any) => !i.backorder && i.quantity > stockOfLine(i));
    if (short) {
      toast.error(
        `الكمية المطلوبة من "${short.productName}" أكبر من المخزون (${stockOfLine(short)})`,
      );
      return;
    }

    setIsSubmitting(true);

    try {
      await appendEvent({
        kind: "sale",
        actor: "جملة",
        refType: "wholesale_invoice",
        refId: invNum,
        payload: {
          invoiceNumber: invNum,
          clientName: client.companyName,
          channel: "wholesale",
          itemCount: invoiceItems.length,
        },
        lines: buildWholesaleInvoiceLines({
          items: invoiceItems.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitPrice: i.wholesalePrice,
            unitCost: costOf(i.productId),
          })),
          clientId: invoiceForm.clientId,
          wallet: invoiceForm.wallet,
          paidAmount: invoiceForm.paidAmount,
          shippingCharge: shippingInfo.requiresShipping ? shippingInfo.customerCharge : 0,
          discountAmount: appliedDiscount ? discountAmount : undefined,
          shippingCost: shippingInfo.requiresShipping ? shippingInfo.actualCost : 0,
        }),
      });
    } catch (e) {
      toast.error(`الفاتورة متسجلتش والمخزون زي ما هو. ${e instanceof Error ? e.message : String(e)}`);
      setIsSubmitting(false);
      return;
    }

    // The goods left with the client. The ledger recorded it as a sale
    // above; without this the record kept selling the same units forever.
    // نواقص lines move too — the shelf floors at 0 and what is still owed
    // shows up in تقرير النواقص, which is the whole point of flagging them.
    applyStockMoves(
      invoiceItems.map((i: any) => ({
        productId: i.productId,
        delta: -i.quantity,
        variantName: i.variantName,
      })),
    );

    addWholesaleInvoice({
      invoiceNumber: invNum,
      clientId: invoiceForm.clientId,
      clientName: client.companyName,
      items: invoiceItems,
      // Both kept: the printed فاتورة shows what the goods were and what came
      // off, and `totalAmount` is what the client actually owes.
      goodsTotal,
      discountAmount,
      totalAmount: invoiceTotal,
      paidAmount: invoiceForm.paidAmount,
      remainingAmount: remainingAfterPaid,
      dueDate: invoiceForm.dueDate,
      status:
        invoiceForm.paidAmount >= invoiceTotal
          ? "paid"
          : invoiceForm.paidAmount > 0
            ? "partial"
            : "unpaid",
      notes: invoiceForm.notes || undefined,
    });

    refreshStock();
    refreshDebt();

    // Route shipping-required invoices to Order Management
    if (shippingInfo.requiresShipping) {
      let activeGov = "";
      let fullAddress = "";
      if (selectedAddressId === "new") {
        activeGov = newAddress.governorate;
        fullAddress = [newAddress.governorate, newAddress.city, newAddress.region, newAddress.details].filter(Boolean).join(" - ");
      } else {
        const addr = clientAddresses.find((a: any) => a.id === selectedAddressId);
        if (addr) {
          activeGov = addr.governorate || "";
          fullAddress = [addr.governorate, addr.city, addr.region, addr.details].filter(Boolean).join(" - ");
        }
      }

      await useOrderStore.getState().addOrder({
        customerName: client.companyName,
        customerPhone: client.phone || "",
        customerAddress: fullAddress,
        governorate: activeGov,
        items: invoiceItems.map((i: any) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          unitPrice: i.wholesalePrice,
          variantName: i.variantName,
          shortfall: i.shortfall,
        })),
        // `variantName` and `shortfall` ride along: the first is what every
        // restock path keys on, the second is what تقرير النواقص sums.
        stockItems: invoiceItems.map((i: any) => ({
          id: crypto.randomUUID(),
          productId: i.productId,
          productName: i.productName,
          sku: i.sku || "",
          quantity: i.quantity,
          unitPrice: i.wholesalePrice,
          variantName: i.variantName,
          shortfall: i.shortfall,
        })),
        totalAmount: invoiceTotal,
        shippingFee: shippingInfo.customerCharge,
        courierFee: shippingInfo.actualCost,
        status: "processing",
        source: "wholesale",
        notes: `فاتورة جملة ${invNum} - ${client.companyName}`,
        cogsAmount: invoiceItems.reduce((sum, i) => sum + i.quantity * costOf(i.productId), 0),
      });
      toast.success(`تم إنشاء طلب شحن في إدارة الطلبات للفاتورة ${invNum}`);
    }

    setIsSubmitting(false);
    setIsInvoiceOpen(false);
    resetInvoiceForm();
  }

  function openPayment(invoiceId: string) {
    setPaymentInvoiceId(invoiceId);
    setPaymentAmount(0);
    setPaymentWallet("inStoreSafe");
    setIsPaymentOpen(true);
  }

  async function submitPayment() {
    if (!paymentInvoiceId || paymentAmount <= 0) return;
    const invoice = wholesaleInvoices.find((i) => i.id === paymentInvoiceId);
    if (!invoice) return;

    setIsPaying(true);

    try {
      await appendEvent({
        kind: "client_payment",
        actor: "جملة",
        refType: "wholesale_invoice",
        refId: invoice.invoiceNumber,
        payload: {
          invoiceNumber: invoice.invoiceNumber,
          clientName: invoice.clientName,
        },
        lines: buildClientPaymentLines({
          clientId: invoice.clientId,
          wallet: paymentWallet,
          amount: paymentAmount,
        }),
      });
    } catch (e) {
      toast.error(
        `لم تُسجَّل الدفعة ولم يتغيّر أي رصيد. ${e instanceof Error ? e.message : String(e)}`,
      );
      setIsPaying(false);
      return;
    }

    recordWholesalePayment(paymentInvoiceId, paymentAmount);
    refreshDebt();
    setIsPaying(false);
    setIsPaymentOpen(false);
    setPaymentInvoiceId(null);
  }

  const selectedClientInvoices = wholesaleInvoices.filter((i) => i.clientId === selectedClientId);
  const selectedClientData = wholesaleClients.find((c) => c.id === selectedClientId);

  const filteredInvoices = useMemo(() => {
    if (!searchQuery.trim()) return wholesaleInvoices;
    const q = searchQuery.toLowerCase();
    return wholesaleInvoices.filter(
      (i) => i.invoiceNumber.toLowerCase().includes(q) || i.clientName.toLowerCase().includes(q),
    );
  }, [wholesaleInvoices, searchQuery]);

  const filteredClients = useMemo(() => {
    if (!searchQuery.trim()) return wholesaleClients;
    const q = searchQuery.toLowerCase();
    return wholesaleClients.filter(
      (c) =>
        c.companyName.toLowerCase().includes(q) ||
        c.contactPerson.toLowerCase().includes(q) ||
        c.phone.includes(q),
    );
  }, [wholesaleClients, searchQuery]);

  const handleExportPdf = () => {
    if (activeTab === "invoices") {
      printTableAsPdf({
        title: "فواتير الجملة",
        subtitle: `حتى ${format(new Date(), "dd/MM/yyyy")}`,
        columns: [
          { label: "رقم الفاتورة", accessor: (i) => i.invoiceNumber },
          { label: "العميل", accessor: (i) => i.clientName },
          { label: "التاريخ", accessor: (i) => format(new Date(i.createdAt), "dd/MM/yyyy") },
          { label: "الإجمالي", accessor: (i) => formatMoney(i.totalAmount), align: "center" },
          { label: "المدفوع", accessor: (i) => formatMoney(i.paidAmount), align: "center" },
          { label: "المتبقي", accessor: (i) => formatMoney(i.remainingAmount), align: "center" },
        ],
        rows: filteredInvoices,
        footer: `إجمالي الفواتير: ${filteredInvoices.length} — قيمة: ${formatMoney(
          filteredInvoices.reduce((s, i) => s + i.totalAmount, 0),
        )}`,
      });
    } else {
      printTableAsPdf({
        title: "عملاء الجملة",
        columns: [
          { label: "اسم الشركة", accessor: (c) => c.companyName },
          { label: "المسؤول", accessor: (c) => c.contactPerson },
          { label: "الهاتف", accessor: (c) => c.phone, align: "center" },
          { label: "إجمالي مفوتر", accessor: (c) => formatMoney(totalsOf(c.id).invoiced), align: "center" },
          { label: "مدفوع", accessor: (c) => formatMoney(totalsOf(c.id).paid), align: "center" },
          { label: "متبقي", accessor: (c) => formatMoney(debtOf(c.id)), align: "center" },
        ],
        rows: filteredClients,
        footer: `إجمالي العملاء: ${filteredClients.length}`,
      });
    }
  };

  return (
    <>
    <div className="space-y-6 print:hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">مبيعات الجملة والعملاء</h1>
          <p className="text-muted-foreground mt-1">إدارة فواتير الجملة وحسابات العملاء</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" onClick={handleExportPdf} className="gap-2 h-10 px-5">
            <Printer className="size-4" />
            تصدير PDF
          </Button>
          <Button variant="outline" onClick={openReturnModal} className="gap-2 h-10 px-5">
            <RotateCcw className="size-4" />
            مرتجع تاجر
          </Button>
          {activeTab === "invoices" && (
            <Button onClick={openInvoiceModal} className="gap-2 h-10 px-5">
              <Plus className="size-4" />
              إنشاء فاتورة جملة
            </Button>
          )}
        </div>
      </div>

      {debtError && (
        <div className="rounded-xl p-4 flex items-start gap-3 bg-red-50 border border-red-200">
          <AlertCircle className="size-5 text-red-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-red-900">تعذّرت قراءة مديونيات العملاء</p>
            <p className="text-sm text-red-800 mt-1">
              الأرقام المعروضة مش موثوقة — متحصّلش قبل ما ده يتصلّح. {debtError}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs tracking-wider text-muted-foreground">إيرادات الجملة</p>
                <p className="font-display text-3xl font-semibold mt-2">
                  {formatMoney(stats.totalRevenue)}
                </p>
              </div>
              <div
                className="size-10 rounded-xl flex items-center justify-center"
                style={{
                  backgroundColor: "color-mix(in oklab, var(--chart-1) 15%, transparent)",
                  color: "var(--chart-1)",
                }}
              >
                <Landmark className="size-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs tracking-wider text-muted-foreground">الديون المستحقة</p>
                <p className="font-display text-3xl font-semibold mt-2">
                  {formatMoney(totalReceivables)}
                </p>
              </div>
              <div
                className="size-10 rounded-xl flex items-center justify-center"
                style={{
                  backgroundColor: "color-mix(in oklab, #f59e0b 15%, transparent)",
                  color: "#f59e0b",
                }}
              >
                <Receipt className="size-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs tracking-wider text-muted-foreground">العملاء النشطون</p>
                <p className="font-display text-3xl font-semibold mt-2">{stats.activeClients}</p>
              </div>
              <div
                className="size-10 rounded-xl flex items-center justify-center"
                style={{
                  backgroundColor: "color-mix(in oklab, var(--chart-2) 15%, transparent)",
                  color: "var(--chart-2)",
                }}
              >
                <Building2 className="size-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2 border-b border-border pb-0">
        <button
          onClick={() => {
            setActiveTab("invoices");
            setSearchQuery("");
            setSelectedClientId(null);
          }}
          className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "invoices"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <FileSpreadsheet className="size-4 inline ml-1.5" />
          فواتير الجملة
        </button>
        <button
          onClick={() => {
            setActiveTab("clients");
            setSearchQuery("");
            setSelectedClientId(null);
          }}
          className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "clients"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Users className="size-4 inline ml-1.5" />
          دليل العملاء والآجل
        </button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder={
            activeTab === "invoices"
              ? "بحث برقم الفاتورة أو اسم العميل..."
              : "بحث باسم الشركة أو رقم الهاتف..."
          }
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pr-9"
        />
      </div>

      {activeTab === "invoices" && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right px-4">رقم الفاتورة</TableHead>
                  <TableHead className="text-right px-4">العميل</TableHead>
                  <TableHead className="text-right px-4">الإجمالي</TableHead>
                  <TableHead className="text-right px-4">المدفوع</TableHead>
                  <TableHead className="text-right px-4">المتبقي</TableHead>
                  <TableHead className="text-right px-4">تاريخ الاستحقاق</TableHead>
                  <TableHead className="text-right px-4">الحالة</TableHead>
                  <TableHead className="text-right px-4">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredInvoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-12">
                      <EmptyState
                        icon={searchQuery ? Search : Inbox}
                        title={searchQuery ? "لا توجد نتائج مطابقة للبحث" : "مفيش فواتير جملة"}
                        description={searchQuery ? "جرب بحث تاني" : "الفواتير اللي هتسجلها هتظهر هنا"}
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredInvoices.map((inv) => {
                    const st = getInvoiceStatus(inv.status, inv.dueDate, inv.remainingAmount);
                    const isOverdue = st.variant === "destructive";
                    return (
                      <TableRow key={inv.id} className={isOverdue ? "bg-red-50/50" : ""}>
                        <TableCell className="text-right font-mono text-xs font-medium px-4 whitespace-nowrap">
                          {inv.invoiceNumber}
                        </TableCell>
                        <TableCell className="text-right px-4 whitespace-nowrap">
                          {inv.clientName}
                        </TableCell>
                        <TableCell className="text-right px-4 whitespace-nowrap font-bold text-gray-900 dark:text-white">
                          {formatMoney(inv.totalAmount)}
                        </TableCell>
                        <TableCell className="text-right px-4 whitespace-nowrap font-bold text-gray-900 dark:text-white">
                          {formatMoney(inv.paidAmount)}
                        </TableCell>
                        <TableCell
                          className={
                            "text-right px-4 whitespace-nowrap font-bold text-gray-900 dark:text-white" +
                            (inv.remainingAmount > 0 ? " text-amber-600 dark:text-amber-500" : "")
                          }
                        >
                          {formatMoney(inv.remainingAmount)}
                        </TableCell>
                        <TableCell className="text-right px-4 whitespace-nowrap text-sm">
                          {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("ar-EG") : "—"}
                        </TableCell>
                        <TableCell className="text-right px-4">
                          <Badge variant={st.variant}>{st.label}</Badge>
                        </TableCell>
                        <TableCell className="text-center px-4">
                          <div className="flex items-center justify-center gap-2">
                            {inv.remainingAmount > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={() => openPayment(inv.id)}
                              >
                                <DollarSign className="size-3 ml-1" />
                                تسجيل دفعة
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() => {
                                setInvoiceToPrint(inv);
                                setTimeout(() => window.print(), 100);
                              }}
                            >
                              <Printer className="size-3 ml-1" />
                              طباعة الفاتورة (PDF)
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {activeTab === "clients" && (
        <div className="grid grid-cols-1 gap-6">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right px-4">اسم الشركة</TableHead>
                    <TableHead className="text-right px-4">جهة الاتصال</TableHead>
                    <TableHead className="text-right px-4">رقم الهاتف</TableHead>
                    <TableHead className="text-right px-4">إجمالي الفواتير</TableHead>
                    <TableHead className="text-right px-4">المدفوع</TableHead>
                    <TableHead className="text-right px-4">المتبقي</TableHead>
                    <TableHead className="text-right px-4">حالة الحساب</TableHead>
                    <TableHead className="text-right px-4">الإجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredClients.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-12">
                        <EmptyState
                          icon={searchQuery ? Search : Inbox}
                          title={searchQuery ? "لا توجد نتائج مطابقة للبحث" : "مفيش عملاء متسجلين"}
                          description={searchQuery ? "جرب بحث تاني" : "ابدأ بإضافة عميل جديد"}
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredClients.map((client) => {
                      const owed = debtOf(client.id);
                      const { invoiced, paid } = totalsOf(client.id);
                      const hasDebt = owed > 0;
                      const hasOverdue = wholesaleInvoices.some(
                        (i) =>
                          i.clientId === client.id &&
                          i.remainingAmount > 0 &&
                          i.dueDate &&
                          new Date(i.dueDate) < new Date(),
                      );
                      return (
                        <TableRow
                          key={client.id}
                          className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors ${hasOverdue ? "bg-red-50/50 dark:bg-red-950/20" : ""}`}
                          onClick={() => setSelectedMerchant(client)}
                        >
                          <TableCell className="font-medium text-right px-4 whitespace-nowrap">
                            {client.companyName}
                          </TableCell>
                          <TableCell className="text-right px-4 whitespace-nowrap text-sm">
                            {client.contactPerson}
                          </TableCell>
                          <TableCell
                            dir="ltr"
                            className="text-right px-4 whitespace-nowrap text-sm"
                          >
                            {client.phone}
                          </TableCell>
                          <TableCell className="text-right px-4 whitespace-nowrap font-bold text-gray-900 dark:text-white">
                            {formatMoney(invoiced)}
                          </TableCell>
                          <TableCell className="text-right px-4 whitespace-nowrap font-bold text-gray-900 dark:text-white">
                            {formatMoney(paid)}
                          </TableCell>
                          <TableCell
                            className={
                              "text-right px-4 whitespace-nowrap font-bold text-gray-900 dark:text-white" +
                              (hasDebt ? " text-amber-600 dark:text-amber-500" : "")
                            }
                          >
                            {formatMoney(owed)}
                          </TableCell>
                          <TableCell className="text-right px-4">
                            <Badge
                              variant={
                                hasOverdue ? "destructive" : hasDebt ? "secondary" : "default"
                              }
                            >
                              {hasOverdue ? "حساب متأخر" : hasDebt ? "عليه رصيد" : "حساب جيد"}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className="text-center px-4"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-center">
                              <Button variant="ghost" size="icon" className="size-8" asChild>
                                <a href={`tel:${client.phone}`}>
                                  <Phone className="size-3.5" />
                                </a>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {selectedClientId && selectedClientData && (
            <Card>
              <div className="p-5 border-b border-border flex items-center justify-between">
                <div>
                  <h3 className="font-display text-lg font-bold">
                    {selectedClientData.companyName}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    سجل الفواتير — {selectedClientData.contactPerson} | {selectedClientData.phone}
                  </p>
                </div>
                <div className="text-left">
                  <p className="text-sm text-muted-foreground">إجمالي الديون</p>
                  <p className="font-bold text-lg">
                    {formatMoney(debtOf(selectedClientData.id))}
                  </p>
                </div>
              </div>
              <CardContent className="p-0">
                {selectedClientInvoices.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title="لا توجد فواتير لهذا العميل"
                    className="py-12"
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right px-4">الفاتورة</TableHead>
                        <TableHead className="text-center px-4">التاريخ</TableHead>
                        <TableHead className="text-center px-4">الإجمالي</TableHead>
                        <TableHead className="text-center px-4">المدفوع</TableHead>
                        <TableHead className="text-center px-4">المتبقي</TableHead>
                        <TableHead className="text-center px-4">دفعة</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedClientInvoices.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-mono text-xs px-4 whitespace-nowrap">
                            {inv.invoiceNumber}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap text-sm">
                            {new Date(inv.createdAt).toLocaleDateString("ar-EG")}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap">
                            {formatMoney(inv.totalAmount)}
                          </TableCell>
                          <TableCell className="text-center px-4 whitespace-nowrap">
                            {formatMoney(inv.paidAmount)}
                          </TableCell>
                          <TableCell
                            className={
                              "text-center px-4 whitespace-nowrap" +
                              (inv.remainingAmount > 0 ? " font-semibold text-amber-600" : "")
                            }
                          >
                            {formatMoney(inv.remainingAmount)}
                          </TableCell>
                          <TableCell className="text-center px-4">
                            <div className="flex items-center justify-center gap-2">
                              {inv.remainingAmount > 0 && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 text-xs"
                                  onClick={() => openPayment(inv.id)}
                                >
                                  <DollarSign className="size-3 ml-1" />
                                  تسجيل دفعة
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={() => {
                                  setInvoiceToPrint(inv);
                                  setTimeout(() => window.print(), 100);
                                }}
                              >
                                <Printer className="size-3 ml-1" />
                                طباعة (PDF)
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          {wholesaleClients.length === 0 && (
            <div className="text-center py-6">
              <Button variant="outline" onClick={() => setIsNewClientOpen(true)}>
                <Plus className="size-4 ml-2" />
                إضافة عميل جديد
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={isInvoiceOpen}
        onOpenChange={(open) => {
          setIsInvoiceOpen(open);
          if (!open) resetInvoiceForm();
        }}
      >
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>إنشاء فاتورة جملة</DialogTitle>
            <DialogDescription>أدخل بيانات الفاتورة والمنتجات</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-muted/20 p-4 rounded-xl border">
              <div className="space-y-1.5 text-right">
                <Label>العميل</Label>
                <div className="flex gap-2">
                  <Popover open={clientSearchOpen} onOpenChange={setClientSearchOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" role="combobox" aria-expanded={clientSearchOpen} className="flex-1 justify-between">
                        {invoiceForm.clientId ? wholesaleClients.find((c) => c.id === invoiceForm.clientId)?.companyName : "ابحث عن عميل..."}
                        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[300px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="ابحث بالاسم أو التليفون..." />
                        <CommandList>
                          <CommandEmpty>لم يتم العثور على عميل.</CommandEmpty>
                          <CommandGroup>
                            {wholesaleClients.map((c) => (
                              <CommandItem
                                key={c.id}
                                value={`${c.companyName} ${c.phone}`}
                                onSelect={() => {
                                  setInvoiceForm({ ...invoiceForm, clientId: c.id });
                                  setClientSearchOpen(false);
                                }}
                              >
                                <Check className={cn("mr-2 size-4", invoiceForm.clientId === c.id ? "opacity-100" : "opacity-0")} />
                                {c.companyName}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <Button variant="outline" size="icon" className="size-9 shrink-0" onClick={() => setIsNewClientOpen(true)}>
                    <Plus className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5 text-right">
                <Label htmlFor="dueDate">تاريخ استحقاق الباقي</Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={invoiceForm.dueDate}
                  onChange={(e) => setInvoiceForm({ ...invoiceForm, dueDate: e.target.value })}
                />
              </div>
            </div>


            <div className="rounded-xl border border-border p-4 space-y-4">
              <div className="space-y-1.5 text-right">
                <Label className="font-semibold">إضافة منتجات</Label>
                <Popover open={productSearchOpen} onOpenChange={setProductSearchOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" aria-expanded={productSearchOpen} className="w-full justify-between text-muted-foreground">
                      ابحث عن منتج بالاسم أو الباركود...
                      <Search className="ml-2 size-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="ابحث بالاسم، SKU، أو الباركود..." />
                      <CommandList>
                        <CommandEmpty>لم يتم العثور على منتجات.</CommandEmpty>
                        <CommandGroup>
                          {activeProducts(products).map((p) => {
                            const stock = getActualStock(p);
                            return (
                              <CommandItem
                                key={p.id}
                                value={`${p.name} ${p.sku} ${p.barcode}`}
                                onSelect={() => {
                                  if (p.metadata?.variants?.length > 0) {
                                    setPendingVariantSelection({ product: p, qty: 1 });
                                  } else {
                                    addItemToInvoice(p);
                                  }
                                  setProductSearchOpen(false);
                                }}
                              >
                                <div className="flex justify-between w-full">
                                  <span>{p.name}</span>
                                  <span className={cn("text-muted-foreground", stock <= 0 && "text-destructive font-medium")}>
                                    {formatMoney(productWholesalePrice(p))} ({stock <= 0 ? "نفد المخزون" : `المخزون: ${stock}`})
                                  </span>
                                </div>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {invoiceItems.length > 0 && (
                <div className="border rounded-lg overflow-hidden mt-4">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="text-right">المنتج</TableHead>
                        <TableHead className="text-right w-24">الكمية</TableHead>
                        <TableHead className="text-right w-32">سعر الوحدة</TableHead>
                        <TableHead className="text-right w-32">الإجمالي</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoiceItems.map((item) => (
                        <TableRow key={item.productId + (item.variantName || '')}>
                          <TableCell className="font-medium text-right">
                            {item.productName} {item.variantName ? `(${item.variantName})` : ''}
                            {item.backorder && (
                              <Badge
                                variant="outline"
                                className="mr-2 h-5 gap-1 border-amber-400 bg-amber-50 px-1.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                              >
                                <AlertTriangle className="size-3" />
                                نواقص
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <Input 
                              type="number" 
                              min="1" 
                              value={item.quantity} 
                              onChange={(e) => updateInvoiceItem(item.productId, item.variantName, "quantity", parseInt(e.target.value) || 1)}
                              className="h-8 text-center"
                            />
                          </TableCell>
                          <TableCell>
                            <Input 
                              type="number" 
                              min="0" 
                              value={item.wholesalePrice} 
                              onChange={(e) => updateInvoiceItem(item.productId, item.variantName, "wholesalePrice", parseFloat(e.target.value) || 0)}
                              className="h-8 text-center"
                            />
                          </TableCell>
                          <TableCell className="font-semibold text-right">{formatMoney(item.total)}</TableCell>
                          <TableCell>
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => removeInvoiceItem(item.productId, item.variantName)}>
                              <Trash2 className="size-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            {/* Shipping Engine (Talabat Style) */}
            <div className="rounded-xl border border-border p-4 bg-muted/20 space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-base font-semibold cursor-pointer flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={shippingInfo.requiresShipping}
                    onChange={(e) => setShippingInfo({ ...shippingInfo, requiresShipping: e.target.checked })}
                    className="size-4 accent-primary"
                  />
                  معلومات الشحن
                </Label>
              </div>
              
              {shippingInfo.requiresShipping && (
                <div className="space-y-4 pt-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5 text-right">
                      <Label>عنوان الشحن</Label>
                      <Select value={selectedAddressId} onValueChange={setSelectedAddressId}>
                        <SelectTrigger><SelectValue placeholder="اختر عنواناً" /></SelectTrigger>
                        <SelectContent>
                          {clientAddresses.map((addr: any) => (
                            <SelectItem key={addr.id} value={addr.id}>
                              {addr.governorate} - {addr.city} ({addr.region})
                            </SelectItem>
                          ))}
                          <SelectItem value="new" className="text-primary font-medium">
                            + إضافة عنوان جديد
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5 text-right">
                      <Label>نوع الشحن</Label>
                      <Select value={selectedMovement} onValueChange={(v) => setSelectedMovement(v as ShipmentMovement)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="delivery">توصيل عادي</SelectItem>
                          <SelectItem value="exchange">استبدال</SelectItem>
                          <SelectItem value="return">مرتجع</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {selectedAddressId === "new" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 border rounded-lg bg-background">
                      <div className="space-y-1.5 text-right">
                        <Label>المحافظة</Label>
                        <Select 
                          value={newAddress.governorate} 
                          onValueChange={(v) => setNewAddress({ ...newAddress, governorate: v })}
                        >
                          <SelectTrigger><SelectValue placeholder="اختر المحافظة" /></SelectTrigger>
                          <SelectContent>
                            {shippedGovernorates(shippingRows).map(gov => (
                              <SelectItem key={gov} value={gov}>{gov}</SelectItem>
                            ))}
                            {shippedGovernorates(shippingRows).length === 0 && (
                              <SelectItem value="__none" disabled>لا توجد محافظات — أضفها من الإعدادات</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5 text-right">
                        <Label>المدينة</Label>
                        <Input 
                          value={newAddress.city} 
                          onChange={(e) => setNewAddress({ ...newAddress, city: e.target.value })} 
                          placeholder="مثال: نصر" 
                        />
                      </div>
                      <div className="space-y-1.5 text-right">
                        <Label>المنطقة</Label>
                        <Input 
                          value={newAddress.region} 
                          onChange={(e) => setNewAddress({ ...newAddress, region: e.target.value })} 
                          placeholder="مثال: الحي العاشر" 
                        />
                      </div>
                      <div className="space-y-1.5 text-right">
                        <Label>العنوان بالتفصيل</Label>
                        <Input 
                          value={newAddress.details} 
                          onChange={(e) => setNewAddress({ ...newAddress, details: e.target.value })} 
                          placeholder="الشارع، العمارة، الدور..." 
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end pt-2 border-t border-border">
                    <div className="space-y-1.5 text-right w-1/3">
                      <Label>تكلفة الشحن المحسوبة (ج.م)</Label>
                      <Input
                        type="number"
                        value={shippingInfo.customerCharge}
                        onChange={(e) => setShippingInfo({ ...shippingInfo, customerCharge: parseFloat(e.target.value) || 0 })}
                        className="font-semibold text-lg"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border p-4 space-y-3">
              <p className="text-sm font-medium">كود الخصم</p>
              <div className="flex gap-2">
                <Input
                  value={discountCodeInput}
                  onChange={(e) => setDiscountCodeInput(e.target.value.toUpperCase())}
                  placeholder="كود الخصم..."
                  className="font-mono tracking-wider"
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="px-6 shrink-0"
                  onClick={() => {
                    if (!discountCodeInput.trim()) {
                      setAppliedDiscount(null);
                      return;
                    }
                    const found = promoDiscounts.find(
                      (d: any) => d.code === discountCodeInput.trim() && d.active,
                    );
                    setAppliedDiscount(found ?? null);
                    if (!found) alert("كود الخصم غير موجود أو معطل");
                  }}
                >
                  تطبيق
                </Button>
              </div>
              {appliedDiscount && discountAmount > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900 px-3 py-2 text-sm">
                  <span className="font-medium text-green-800 dark:text-green-300">
                    خصم نشط ({appliedDiscount.type === "percentage"
                      ? `${appliedDiscount.value}%`
                      : `${appliedDiscount.value} ج.م`})
                  </span>
                  <span className="font-bold text-green-700 dark:text-green-400">
                    − {formatMoney(discountAmount)}
                  </span>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border p-4 space-y-3">
              <p className="text-sm font-medium">شروط الدفع</p>
              {discountAmount > 0 && (
                <div className="space-y-1 text-sm border-b border-border pb-3">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>إجمالي البضاعة</span>
                    <span>{formatMoney(goodsTotal)}</span>
                  </div>
                  <div className="flex items-center justify-between text-green-600 dark:text-green-400 font-medium">
                    <span>الخصم</span>
                    <span>− {formatMoney(discountAmount)}</span>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>المبلغ الإجمالي</Label>
                  <div className="h-9 rounded-md border border-input bg-muted/50 px-3 flex items-center text-sm font-semibold">
                    {formatMoney(invoiceTotal)}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="paidAmount">المدفوع مقدمًا</Label>
                  <Input
                    id="paidAmount"
                    type="number"
                    min="0"
                    max={invoiceTotal}
                    value={invoiceForm.paidAmount || ""}
                    onChange={(e) =>
                      setInvoiceForm({
                        ...invoiceForm,
                        paidAmount: Math.min(parseFloat(e.target.value) || 0, invoiceTotal),
                      })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>المتبقي</Label>
                  <div
                    className={`h-9 rounded-md border px-3 flex items-center text-sm font-semibold ${remainingAfterPaid > 0 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-green-200 bg-green-50 text-green-700"}`}
                  >
                    {formatMoney(remainingAfterPaid)}
                  </div>
                </div>
                {invoiceForm.paidAmount > 0 && (
                  <div className="space-y-1.5">
                    <Label>الخزينة اللي هيتحصّل فيها</Label>
                    <Select
                      value={invoiceForm.wallet}
                      onValueChange={(v) =>
                        setInvoiceForm({ ...invoiceForm, wallet: v as WalletType })
                      }
                    >
                      <SelectTrigger>
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
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="notes">ملاحظات</Label>
                <Input
                  id="notes"
                  value={invoiceForm.notes}
                  onChange={(e) => setInvoiceForm({ ...invoiceForm, notes: e.target.value })}
                  placeholder="ملاحظات إضافية للفاتورة (اختياري)"
                />
              </div>
            </div>
          </div>



          <DialogFooter className="mt-6 flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setIsInvoiceOpen(false);
                resetInvoiceForm();
              }}
              disabled={isSubmitting}
            >
              إلغاء
            </Button>
            <Button
              onClick={() => void submitInvoice()}
              disabled={!invoiceForm.clientId || invoiceItems.length === 0 || isSubmitting}
            >
              {isSubmitting && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
              {isSubmitting ? "جاري الحفظ..." : "حفظ الفاتورة وتسجيل الرصيد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isNewClientOpen} onOpenChange={setIsNewClientOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة عميل جديد</DialogTitle>
            <DialogDescription>أدخل بيانات الشركة أو العميل</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="companyName">اسم الشركة / العميل</Label>
              <Input
                id="companyName"
                value={newClientForm.companyName}
                onChange={(e) =>
                  setNewClientForm({ ...newClientForm, companyName: e.target.value })
                }
                placeholder="شركة النور للتجارة"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contactPerson">جهة الاتصال</Label>
              <Input
                id="contactPerson"
                value={newClientForm.contactPerson}
                onChange={(e) =>
                  setNewClientForm({ ...newClientForm, contactPerson: e.target.value })
                }
                placeholder="أحمد محمد"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">رقم الهاتف</Label>
              <Input
                id="phone"
                dir="ltr"
                value={newClientForm.phone}
                onChange={(e) => setNewClientForm({ ...newClientForm, phone: e.target.value })}
                placeholder="+20 100 000 0000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newClientEmail">البريد الإلكتروني</Label>
              <Input
                id="newClientEmail"
                type="email"
                dir="ltr"
                value={newClientForm.email}
                onChange={(e) => setNewClientForm({ ...newClientForm, email: e.target.value })}
                placeholder="info@example.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsNewClientOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={() => {
                if (!newClientForm.companyName.trim() || !newClientForm.phone.trim()) return;
                addWholesaleClient({
                  companyName: newClientForm.companyName.trim(),
                  contactPerson:
                    newClientForm.contactPerson.trim() || newClientForm.companyName.trim(),
                  phone: newClientForm.phone.trim(),
                  email: newClientForm.email.trim() || undefined,
                });
                setNewClientForm({ companyName: "", contactPerson: "", phone: "", email: "" });
                setIsNewClientOpen(false);
              }}
              disabled={!newClientForm.companyName.trim() || !newClientForm.phone.trim()}
            >
              إضافة العميل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isPaymentOpen} onOpenChange={setIsPaymentOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>تسجيل دفعة للفاتورة {paymentInvoice?.invoiceNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>المبلغ المراد دفعه</Label>
              <Input
                type="number"
                min="0"
                max={paymentInvoice?.remainingAmount}
                value={paymentAmount || ""}
                onChange={(e) =>
                  setPaymentAmount(
                    Math.min(parseFloat(e.target.value) || 0, paymentInvoice?.remainingAmount ?? 0),
                  )
                }
                placeholder="0.00"
              />
              {paymentInvoice && (
                <p className="text-xs text-muted-foreground">
                  المتبقي على الفاتورة: {formatMoney(paymentInvoice.remainingAmount)}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>الخزينة اللي هيتحصّل فيها</Label>
              <Select value={paymentWallet} onValueChange={(v) => setPaymentWallet(v as WalletType)}>
                <SelectTrigger>
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
          </div>
          <DialogFooter className="mt-6 flex gap-2">
            <Button variant="outline" onClick={() => setIsPaymentOpen(false)} disabled={isPaying}>
              إلغاء
            </Button>
            <Button onClick={() => void submitPayment()} disabled={paymentAmount <= 0 || isPaying}>
              {isPaying && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
              {isPaying ? "جاري التسجيل..." : "تسجيل الدفعة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Variant Selection Modal */}
      <Dialog 
        open={pendingVariantSelection !== null} 
        onOpenChange={(open) => !open && setPendingVariantSelection(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>اختر الدرجة / اللون</DialogTitle>
            <DialogDescription>
              "{pendingVariantSelection?.product.name}" متاح بدرجات مختلفة. اختر الدرجة للفاتورة.
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid grid-cols-2 gap-3 py-4">
            {pendingVariantSelection?.product?.metadata?.variants?.map((v: any, idx: number) => {
              const short = (v.stock || 0) < pendingVariantSelection.qty;
              // Short variants stay pickable when the invoice ships — the
              // نواقص confirmation in `addItemToInvoice` is what decides.
              const blocked = short && !shippingInfo.requiresShipping;
              return (
                <Button
                  key={idx}
                  variant="outline"
                  className={cn(
                    "flex flex-col items-center justify-center h-auto py-4 gap-2",
                    blocked && "opacity-50 grayscale",
                    short && !blocked && "border-amber-400",
                  )}
                  disabled={blocked}
                  onClick={() => {
                    if (!pendingVariantSelection) return;
                    const { product, qty } = pendingVariantSelection;
                    setPendingVariantSelection(null);
                    addItemToInvoice(product, v.name, qty);
                  }}
                >
                  <span className="font-bold">{v.name}</span>
                  <span className="text-xs text-muted-foreground">
                    المتاح: {v.stock}
                  </span>
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>

    {/* Merchant Profile Modal */}
    <Dialog open={!!selectedMerchant} onOpenChange={(open) => !open && setSelectedMerchant(null)}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto print:shadow-none print:border-none print:w-full print:max-w-none print:p-0 print:m-0 print:[&>button]:hidden">
        {selectedMerchant && (() => {
          const mInvoices = wholesaleInvoices.filter((i) => i.clientId === selectedMerchant.id);
          const mVolume = mInvoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
          const mPaid = mInvoices.reduce((sum, inv) => sum + (inv.paidAmount || 0), 0);
          const mOwed = mInvoices.reduce((sum, inv) => sum + (inv.remainingAmount ?? ((inv.totalAmount || 0) - (inv.paidAmount || 0))), 0);
          const hasOverdue = mInvoices.some(
            (i) => i.remainingAmount > 0 && i.dueDate && new Date(i.dueDate) < new Date(),
          );
          
          return (
            <>
              <DialogHeader>
                <div className="hidden print:block text-center text-2xl font-black mb-6 border-b pb-4">كشف حساب عميل - Statement of Account</div>
                <DialogTitle className="flex items-center gap-3">
                  <span className="text-2xl font-bold">{selectedMerchant.companyName}</span>
                  <Badge variant={mOwed > 0 ? "destructive" : "default"} className={mOwed === 0 ? "bg-green-600 hover:bg-green-700" : ""}>
                    {mOwed > 0 ? "عليه مديونية" : "حساب جيد"}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="flex items-center gap-4 text-base pt-1">
                  <span className="flex items-center gap-1.5"><User className="size-4" /> {selectedMerchant.contactPerson}</span>
                  <span className="flex items-center gap-1.5"><Phone className="size-4" /> {selectedMerchant.phone}</span>
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 py-4">
                <Card className="bg-muted/30 print:break-inside-avoid print:border-gray-300">
                  <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                    <p className="text-sm text-muted-foreground mb-1">عدد الطلبات</p>
                    <p className="text-2xl font-bold text-gray-900 dark:text-white">{mInvoices.length}</p>
                  </CardContent>
                </Card>
                <Card className="bg-muted/30 print:break-inside-avoid print:border-gray-300">
                  <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                    <p className="text-sm text-muted-foreground mb-1">إجمالي التعاملات</p>
                    <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatMoney(mVolume)}</p>
                  </CardContent>
                </Card>
                <Card className="bg-muted/30 print:break-inside-avoid print:border-gray-300">
                  <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                    <p className="text-sm text-muted-foreground mb-1">إجمالي المدفوع</p>
                    <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatMoney(mPaid)}</p>
                  </CardContent>
                </Card>
                <Card className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 print:break-inside-avoid print:border-gray-300">
                  <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                    <p className="text-sm text-amber-800 dark:text-amber-500 mb-1">المتبقي / المديونية</p>
                    <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">{formatMoney(mOwed)}</p>
                  </CardContent>
                </Card>
              </div>

              <div className="border rounded-lg overflow-hidden mt-2">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="text-right px-4">رقم الفاتورة</TableHead>
                      <TableHead className="text-right px-4">التاريخ</TableHead>
                      <TableHead className="text-right px-4">الإجمالي</TableHead>
                      <TableHead className="text-right px-4">المدفوع</TableHead>
                      <TableHead className="text-right px-4">المتبقي</TableHead>
                      <TableHead className="text-right px-4">الحالة</TableHead>
                      <TableHead className="text-right px-4 print:hidden">إجراءات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mInvoices.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                          لا توجد فواتير مسجلة
                        </TableCell>
                      </TableRow>
                    ) : (
                      mInvoices.map((inv) => {
                        const st = getInvoiceStatus(inv.status, inv.dueDate, inv.remainingAmount);
                        return (
                          <TableRow key={inv.id}>
                            <TableCell className="font-mono text-xs px-4">{inv.invoiceNumber}</TableCell>
                            <TableCell className="text-right px-4">{new Date(inv.createdAt).toLocaleDateString("ar-EG")}</TableCell>
                            <TableCell className="text-right px-4 font-bold text-gray-900 dark:text-white">{formatMoney(inv.totalAmount)}</TableCell>
                            <TableCell className="text-right px-4 font-bold text-gray-900 dark:text-white">{formatMoney(inv.paidAmount)}</TableCell>
                            <TableCell className="text-right px-4 font-bold text-gray-900 dark:text-white">{formatMoney(inv.remainingAmount)}</TableCell>
                            <TableCell className="text-right px-4"><Badge variant={st.variant}>{st.label}</Badge></TableCell>
                            <TableCell className="text-right px-4 print:hidden">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={() => {
                                  setInvoiceToPrint(inv);
                                  setTimeout(() => window.print(), 100);
                                }}
                              >
                                <Printer className="size-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          );
        })()}
      </DialogContent>
    </Dialog>

    {/* مرتجع تاجر — a direct B2B return, reconciled against the account */}
    <Dialog open={isReturnOpen} onOpenChange={setIsReturnOpen}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>مرتجع تاجر</DialogTitle>
          <DialogDescription>
            البضاعة الراجعة بتخصم من حساب التاجر الأول، والباقي بس بيترد كاش.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5 text-right">
            <Label>التاجر</Label>
            <Select value={returnClientId} onValueChange={setReturnClientId}>
              <SelectTrigger>
                <SelectValue placeholder="اختر التاجر..." />
              </SelectTrigger>
              <SelectContent>
                {wholesaleClients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.companyName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 text-right">
            <Label>المنتجات الراجعة</Label>
            <ProductSearch
              products={products}
              onSelect={addReturnItem}
              placeholder="ابحث عن المنتج الراجع..."
              allowOutOfStock
            />
          </div>

          {returnItems.length > 0 && (
            <div className="rounded-xl border border-border divide-y">
              {returnItems.map((item) => (
                <div key={item.productId} className="flex items-center justify-between gap-3 p-3">
                  <span className="font-medium flex-1">{item.productName}</span>
                  <span className="text-sm text-muted-foreground">
                    {formatMoney(item.unitPrice)}
                  </span>
                  <Input
                    type="number"
                    min={1}
                    value={item.quantity}
                    onChange={(e) =>
                      setReturnItems((prev) =>
                        prev.map((i) =>
                          i.productId === item.productId
                            ? { ...i, quantity: Math.max(1, parseInt(e.target.value) || 1) }
                            : i,
                        ),
                      )
                    }
                    className="w-20 text-center"
                  />
                  <span className="font-bold w-24 text-left">
                    {formatMoney(item.quantity * item.unitPrice)}
                  </span>
                  <Button
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
              debt={returnClientDebt}
              returnValue={returnValue}
              paidInput={returnSettleInput}
              onPaidChange={setReturnSettleInput}
              clientMissing={!returnClientId}
            />
          )}

          {returnError && (
            <div className="rounded-lg p-3 bg-red-50 border border-red-200">
              <p className="text-sm font-medium text-red-900">{returnError}</p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setIsReturnOpen(false)} disabled={isReturning}>
            إلغاء
          </Button>
          <Button
            onClick={() => void submitReturn()}
            disabled={isReturning || !returnClientId || returnItems.length === 0}
          >
            {isReturning ? "جاري التسجيل..." : "تأكيد المرتجع وتسوية الحساب"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Invoice Print Template */}
    {invoiceToPrint && (
      <div dir="rtl" className="hidden print:block absolute top-0 left-0 w-full bg-white text-black p-8 z-50 min-h-screen font-sans">
        {/* Header */}
        <div className="flex justify-between items-start border-b-2 border-gray-800 pb-6 mb-8">
          <div>
            <h1 className="text-4xl font-bold text-gray-900 mb-2">
              {shop.storeName?.trim() || "فاتورة"}
            </h1>
            <p className="text-xl text-gray-600">فاتورة مبيعات جملة</p>
            {shop.phoneNumber?.trim() && (
              <p className="text-sm text-gray-500 mt-1">هاتف: {shop.phoneNumber}</p>
            )}
            {shop.address?.trim() && (
              <p className="text-sm text-gray-500">{shop.address}</p>
            )}
            {shop.taxNumber?.trim() && (
              <p className="text-sm text-gray-500">الرقم الضريبي: {shop.taxNumber}</p>
            )}
          </div>
          <div className="text-left space-y-1">
            <p className="text-sm text-gray-500">رقم الفاتورة</p>
            <p className="text-xl font-bold">{invoiceToPrint.invoiceNumber}</p>
            <p className="text-sm text-gray-500 mt-2">التاريخ</p>
            <p className="font-medium">
              {new Date(invoiceToPrint.createdAt).toLocaleDateString("ar-EG")}
            </p>
          </div>
        </div>

        {/* Customer Info */}
        <div className="bg-gray-50 p-6 rounded-lg mb-8 border border-gray-200">
          <h2 className="text-lg font-bold text-gray-800 mb-4 border-b border-gray-200 pb-2">بيانات العميل</h2>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-gray-500">اسم الشركة / العميل</p>
              <p className="text-lg font-bold mt-1">{invoiceToPrint.clientName}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">رقم الهاتف</p>
              <p className="text-lg font-bold mt-1">
                {wholesaleClients.find((c) => c.id === invoiceToPrint.clientId)?.phone || "—"}
              </p>
            </div>
          </div>
        </div>

        {/* Line Items Table */}
        <div className="mb-8">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-gray-800 text-white">
                <th className="p-3 border border-gray-800 w-12 text-center">م</th>
                <th className="p-3 border border-gray-800">الصنف</th>
                <th className="p-3 border border-gray-800">الدرجة / اللون</th>
                <th className="p-3 border border-gray-800 text-center">الكمية</th>
                <th className="p-3 border border-gray-800 text-center">سعر الوحدة</th>
                <th className="p-3 border border-gray-800 text-center">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {invoiceToPrint.items?.map((item: any, idx: number) => (
                <tr key={idx} className="border-b border-gray-300">
                  <td className="p-3 border border-gray-300 text-center">{idx + 1}</td>
                  <td className="p-3 border border-gray-300 font-medium">
                    {item.productName.split(" - ")[0]}
                  </td>
                  <td className="p-3 border border-gray-300">
                    {item.variantName || "—"}
                  </td>
                  <td className="p-3 border border-gray-300 text-center font-mono">
                    {item.quantity}
                  </td>
                  <td className="p-3 border border-gray-300 text-center">
                    {formatMoney(item.wholesalePrice)}
                  </td>
                  <td className="p-3 border border-gray-300 text-center font-bold">
                    {formatMoney(item.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Financial Summary */}
        <div className="flex justify-end">
          <div className="w-80 bg-gray-50 rounded-lg border border-gray-300 overflow-hidden">
            <div className="p-4 space-y-3">
              {/* Only shown when there was one — an invoice with no discount
                  reads exactly as it did before. */}
              {invoiceToPrint.discountAmount > 0 && (
                <>
                  <div className="flex justify-between items-center text-gray-600">
                    <span>إجمالي البضاعة</span>
                    <span className="font-bold text-gray-900">
                      {formatMoney(invoiceToPrint.goodsTotal ?? invoiceToPrint.totalAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-gray-600">
                    <span>الخصم</span>
                    <span className="font-bold text-gray-900">
                      − {formatMoney(invoiceToPrint.discountAmount)}
                    </span>
                  </div>
                </>
              )}
              <div className="flex justify-between items-center text-gray-600">
                <span>الإجمالي</span>
                <span className="font-bold text-gray-900">{formatMoney(invoiceToPrint.totalAmount)}</span>
              </div>
              {/* الزيرو-VAT: the shop has no commercial register yet, so نسبة
                  الضريبة is 0 and this line does not exist on the paper at all.
                  Set a rate in الإعدادات and it appears — no code change. */}
              {includedVat(invoiceToPrint.totalAmount, shop.vatRate) > 0 && (
                <div className="flex justify-between items-center text-gray-600">
                  <span>منها ضريبة القيمة المضافة ({shop.vatRate}%)</span>
                  <span className="font-bold text-gray-900">
                    {formatMoney(includedVat(invoiceToPrint.totalAmount, shop.vatRate))}
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center text-gray-600">
                <span>المدفوع مقدماً</span>
                <span className="font-bold text-gray-900">{formatMoney(invoiceToPrint.paidAmount)}</span>
              </div>
            </div>
            <div className="bg-gray-800 text-white p-4 flex justify-between items-center">
              <span className="font-bold">المتبقي</span>
              <span className="text-xl font-bold">{formatMoney(invoiceToPrint.remainingAmount)}</span>
            </div>
          </div>
        </div>

        <div className="mt-16 text-center text-gray-500 text-sm border-t border-gray-200 pt-8">
          <p>شكراً لتعاملكم معنا</p>
          <p dir="ltr" className="mt-2 text-xs">Powered by Radiant Biz Panel</p>
        </div>
      </div>
    )}
    </>
  );
}
