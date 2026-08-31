import { useState, useRef, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useDraftState, clearDrafts } from "@/hooks/useDraftState";
import {
  ShoppingCart,
  Plus,
  Minus,
  CheckCircle2,
  AlertCircle,
  Barcode,
  Wallet,
  Trash2,
  User,
  Tags,
} from "lucide-react";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useCustomerStore } from "@/store/useCustomerStore";
import { activeCustomers } from "@/lib/customers";
import { useBalances } from "@/lib/ledger/useBalances";
import { appendEvent } from "@/lib/ledger";
import { buildSaleLines } from "@/lib/ledger/sales";
import {
  buildWholesaleInvoiceLines,
  buildWholesaleReturnLines,
  reconcileWholesaleReturn,
} from "@/lib/ledger/wholesale";
import { WholesaleReturnPanel } from "@/components/wholesale/WholesaleReturnPanel";
import { useStock } from "@/lib/ledger/useStock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { add, multiply, subtract, round, formatQty, includedVat, discountAmountFor } from "@/lib/math";
import { printTableAsPdf, storeIdentity } from "@/lib/pdfGenerator";
import { sellableStock, productPrice, productWholesalePrice, productMinLevel, activeProducts } from "@/lib/product";
import { ProductSearch } from "@/components/products/ProductSearch";
import { CustomerPhoneMatch } from "@/components/ecommerce/CustomerPhoneMatch";
import { POSReturnModal } from "./POSReturnModal";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WalletType, PromoDiscount } from "@/types";
import { WALLET_LABELS } from "@/types";

interface CartItem {
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  variantName?: string;
}

// Bare number (the "ج.م" is in the surrounding markup here), but still routed
// through the shared guard so a non-finite total can never print "NaN".
const formatCurrency = formatQty;

/**
 * Print the فاتورة for the sale that just closed.
 *
 * POS had no invoice printer at all, which meant اسم المحل / الهاتف / العنوان /
 * الرقم الضريبي / نسبة الضريبة from الإعدادات had nowhere to land on this
 * screen. It reuses `printTableAsPdf` — the same generator الجملة and المخزون
 * print through — so the shop header comes from `useSettingsStore` for free.
 *
 * VAT is shown as INCLUDED in the total, never added to it: prices in this app
 * are entered as the final selling price and the total is already in the
 * ledger, so the receipt may only break the tax out, never change the amount.
 */
function printPosInvoice(sold: {
  lines: CartItem[];
  total: number;
  paid: number;
  customer: string;
}): void {
  const { vatRate } = storeIdentity();
  const vat = includedVat(sold.total, vatRate);
  const footer = [
    `الإجمالي: ${formatCurrency(sold.total)} ج.م`,
    vat > 0 ? `منها ضريبة ${vatRate}%: ${formatCurrency(vat)} ج.م` : "",
    `المدفوع: ${formatCurrency(sold.paid)} ج.م`,
    sold.total - sold.paid > 0 ? `المتبقي: ${formatCurrency(sold.total - sold.paid)} ج.م` : "",
  ]
    .filter(Boolean)
    .join(" — ");

  printTableAsPdf({
    title: "فاتورة بيع",
    subtitle: `العميل: ${sold.customer}`,
    columns: [
      {
        label: "الصنف",
        accessor: (i: CartItem) => (i.variantName ? `${i.productName} - ${i.variantName}` : i.productName),
      },
      { label: "الكمية", accessor: (i: CartItem) => i.quantity, align: "center" },
      { label: "سعر الوحدة", accessor: (i: CartItem) => formatCurrency(i.unitPrice), align: "center" },
      {
        label: "الإجمالي",
        accessor: (i: CartItem) => formatCurrency(i.unitPrice * i.quantity),
        align: "center",
      },
    ],
    rows: sold.lines,
    footer,
  });
}

function normalizeProduct(p: any, mode: "retail" | "wholesale" = "retail") {
  return {
    ...p,
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
    sku: String(p.sku ?? ""),
    barcode: String(p.barcode ?? ""),
    category: String(p.category ?? ""),
    // No `quantity` here on purpose. Stock comes from useStock(), which sums
    // the ledger. Reading it off the product record is what let the screen
    // and the truth drift apart.
    // One accessor, not a `??` chain. The chain is what hid the bug: it made
    // each reader responsible for knowing which of several names held the
    // price, and the readers that guessed wrong produced `undefined`.
    unitPrice: mode === "wholesale" ? productWholesalePrice(p) : productPrice(p),
    // No cost here: a sale snapshots `costOf(productId)` from the ledger, and
    // carrying a second cost on the normalised product invited the wrong one.
    minStockLevel: productMinLevel(p),
  };
}

export default function CheckoutForm() {
  const rawProducts = useBusinessStore((s) => s.products);
  // Archived customers are not selectable — same rule as the product picker.
  //
  // The SELECTOR subscribes to the raw array and the filtering happens in a
  // `useMemo`, and it has to stay that way. `useCustomerStore((s) =>
  // activeCustomers(s.customers))` reads correctly and BREAKS THE SCREEN:
  // zustand v5 is built on `useSyncExternalStore`, which compares each
  // snapshot with `Object.is`, and `activeCustomers` returns a fresh array
  // every call — so every render produced a "new" snapshot, React re-rendered
  // to catch up, and POS died with "Maximum update depth exceeded" behind
  // "The result of getSnapshot should be cached". A selector must return
  // something referentially stable: a stored field, or a primitive.
  //
  // ponytail: still a plain `<select>` of every customer, and it cannot CREATE
  // one, so a POS sale to a new walk-in attaches no LTV. `CustomerPhoneMatch`
  // (§3.7) is the component this should adopt; that is §3.3 work, flagged in
  // the PLAN rather than half-done here.
  const allCustomers = useCustomerStore((s) => s.customers);
  const customers = useMemo(() => activeCustomers(allCustomers), [allCustomers]);
  // The reported bug: this used to read a STORED wallet balance, so the number
  // beside "الخزينة" never moved after a sale even though the sale itself was
  // written to the ledger correctly. It is now SUM(wallet) for that wallet.
  const {
    amountOf: walletBalance,
    error: walletError,
    refresh: refreshWallets,
  } = useBalances("wallet");

  // `costOf` still comes from the ledger — the weighted average a sale
  // snapshots. Quantities on screen come from `sellableStock`.
  const {
    costOf,
    loading: stockLoading,
    error: stockError,
    refresh: refreshStock,
  } = useStock();

  // Wallet selection for routing revenue
  const [selectedWallet, setSelectedWallet] = useState<WalletType>("inStoreSafe");
  
  const [saleMode, setSaleMode] = useState<"retail" | "wholesale">("retail");
  const [paidAmountInput, setPaidAmountInput] = useState<string>("");

  // Optional — a walk-in sale writes no LTV line (brief §3.13), unless we link a customer.
  const [selectedCustomerId, setSelectedCustomerId] = useDraftState("pos:customer", "");
  const [customerName, setCustomerName] = useDraftState("pos:customerName", "");
  const [customerPhone, setCustomerPhone] = useDraftState("pos:customerPhone", "");

  const { promoDiscounts, wholesaleClients, wholesaleInvoices, addWholesaleInvoice } = useBusinessStore();
  // What the selected تاجر owes us right now. A wholesale return settles
  // against this before any cash changes hands — see `buildWholesaleReturnLines`.
  const { amountOf: debtOf, refresh: refreshDebt } = useBalances("receivable_client");
  // نسبة الضريبة from الإعدادات, read reactively so turning VAT on shows up
  // without a reload. 0 means the shop does not charge it yet — every tax line
  // below simply does not render.
  const vatRate = useSettingsStore((st) => st.vatRate);
  const [discountCodeInput, setDiscountCodeInput] = useDraftState("pos:discountCode", "");
  /** Cash the تاجر hands over during a return, to pay down what is left. */
  const [settlePaidInput, setSettlePaidInput] = useDraftState("pos:settlePaid", "");
  const [appliedDiscount, setAppliedDiscount] = useDraftState<PromoDiscount | null>(
    "pos-checkout:appliedDiscount",
    null,
  );

  const [isReturnMode, setIsReturnMode] = useState(false);

  let products: any[];
  try {
    // Archived products are not sellable: they are out of the catalogue but
    // their ledger history stays, so they must not be scannable or pickable.
    products = activeProducts(rawProducts ?? []).map((p) => normalizeProduct(p, saleMode));
  } catch {
    products = [];
  }

  // A half-built basket is the most expensive thing on this screen to lose —
  // the customer is standing there. It survives a trip to another screen.
  const [cart, setCart] = useDraftState<CartItem[]>("pos:cart", []);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [pendingVariantSelection, setPendingVariantSelection] = useState<{ product: any, qty: number } | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    profitDistribution?: any;
    /** Snapshot of what was just sold, kept so the فاتورة can still be
     * printed after the cart is cleared. */
    sold?: { lines: CartItem[]; total: number; paid: number; customer: string };
  } | null>(null);

  const barcodeRef = useRef<HTMLInputElement>(null);

  /**
   * The بوكس half of a cart line, for the ledger builders.
   *
   * `buildSaleLines` / `buildWholesaleInvoiceLines` already know to charge a
   * bundle's components instead of the bundle — but only if they are told the
   * line IS one. POS never told them, so every box booked stock and COGS
   * against a virtual product that has neither.
   */
  const bundleFieldsFor = (productId: string) => {
    const record: any = rawProducts?.find((p: any) => p.id === productId);
    if (!record?.isBundle || !record.bundleItems?.length) return {};
    return {
      isBundle: true,
      bundleItems: record.bundleItems.map((c: any) => ({
        productId: c.productId,
        quantity: c.quantity,
        unitCost: costOf(c.productId),
      })),
    };
  };

  const handleModeChange = (mode: "retail" | "wholesale") => {
    if (cart.length > 0) {
      if (!confirm("تغيير نظام البيع سيمسح السلة الحالية. هل أنت متأكد؟")) return;
    }
    setSaleMode(mode);
    setCart([]);
    setSelectedCustomerId("");
    setCustomerName("");
    setCustomerPhone("");
    setPaidAmountInput("");
    setDiscountCodeInput("");
    setAppliedDiscount(null);
    setResult(null);
  };

  useEffect(() => {
    barcodeRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!result) barcodeRef.current?.focus();
  }, [cart, result]);

  const selectedProduct = products.find((p) => p.id === selectedProductId);

  const addItemToCart = (product: any, qty: number, variantName?: string) => {
    if (!product) return;
    
    // Intercept if product has variants but none is selected yet
    if (product.metadata?.variants && product.metadata.variants.length > 0 && !variantName) {
      setPendingVariantSelection({ product, qty });
      return;
    }

    const isReturn = qty < 0;
    // `sellableStock` is bundle-aware; `getVariantStock` was not, which is why
    // every بوكس reported نفد المخزون and could never reach the basket.
    const onHand = sellableStock(product, products, variantName);
    
    // For normal sales, block if out of stock
    if (!isReturn && onHand <= 0) {
       setResult({ success: false, message: variantName ? `الدرجة "${variantName}" نفدت من المخزون.` : `نفد من المخزون` });
       return;
    }
    
    const requestedQty = isReturn ? qty : Math.min(qty, onHand);
    const existingItem = cart.find((item) => item.productId === product.id && item.variantName === variantName);
    
    if (existingItem) {
      const totalInCart = existingItem.quantity + requestedQty;
      const allowed = totalInCart < 0 ? totalInCart : Math.min(totalInCart, onHand);
      setCart(
        cart.map((item) => (item.productId === product.id && item.variantName === variantName ? { ...item, quantity: allowed } : item)),
      );
    } else {
      setCart([
        ...cart,
        {
          productId: product.id,
          productName: String(product.name),
          unitPrice: Number(product.unitPrice ?? 0),
          quantity: requestedQty,
          variantName,
        },
      ]);
    }
    setPendingVariantSelection(null);
  };

  /**
   * A scan adds ONE line to the cart. That is all it does.
   *
   * It does not sell anything: no ledger event, no stock movement, no money.
   * The cashier scans several items and then presses "إتمام البيع", which is
   * the only thing in this component that calls `appendEvent`. Firing a sale
   * per scan would write one event per item and make a five-item basket five
   * separate sales.
   */
  const handleBarcodeScan = () => {
    const q = barcodeInput.trim().toLowerCase();
    if (!q) return;

    const match = products.find(
      (p: any) => String(p.sku).toLowerCase() === q || String(p.barcode).toLowerCase() === q,
    );

    // Clear first, always — the next scan must land in an empty field whether
    // this one matched or not, or the two barcodes concatenate.
    setBarcodeInput("");
    barcodeRef.current?.focus();

    if (!match) {
      setResult({ success: false, message: `مفيش منتج بالباركود ده: ${q}` });
      return;
    }

    // A scan can tell the cashier the shelf is empty before they promise it
    // to the customer.
    if (!isReturnMode && sellableStock(match, products) <= 0) {
      setResult({ success: false, message: `"${String(match.name)}" نفد من المخزون` });
      return;
    }

    // Existing line → quantity goes up, no duplicate row. `addItemToCart`
    // already does that, and caps at what the ledger says is on hand.
    addItemToCart(match, isReturnMode ? -1 : 1);
    setResult(null);
  };

  const addManuallyPicked = () => {
    if (!selectedProduct) return;
    addItemToCart(selectedProduct, isReturnMode ? -quantity : quantity);
    setQuantity(1);
    setSelectedProductId("");
    barcodeRef.current?.focus();
  };



  // Removing a line is the one destructive thing on this screen, and the cashier
  // is working fast with a scanner in hand. Ask first — a misclick that wipes a
  // line is only noticed when the total comes out wrong.
  const [pendingRemoval, setPendingRemoval] = useState<CartItem | null>(null);

  const confirmRemoval = () => {
    if (pendingRemoval) removeFromCart(pendingRemoval.productId, pendingRemoval.variantName);
    setPendingRemoval(null);
    barcodeRef.current?.focus();
  };

  const removeFromCart = (productId: string, variantName?: string) => {
    setCart(cart.filter((item) => !(item.productId === productId && item.variantName === variantName)));
  };

  const updateCartQuantity = (productId: string, variantName: string | undefined, newQuantity: number) => {
    const product = products.find((p) => p.id === productId);
    const maxQty = sellableStock(product, products, variantName);
      
    setCart(
      cart.map((item) =>
        item.productId === productId && item.variantName === variantName ? { ...item, quantity: newQuantity < 0 ? newQuantity : Math.min(newQuantity, maxQty) } : item,
      ),
    );
  };

  const subtotal = cart.reduce((total, item) => add(total, multiply(item.unitPrice, item.quantity)), 0);

  // Shared with the ledger — see `discountAmountFor`. Capped at the subtotal,
  // so a 500% code can never drive the total (or the till) negative.
  const discountAmount = useMemo(
    () =>
      appliedDiscount
        ? discountAmountFor(subtotal, appliedDiscount.type, appliedDiscount.value)
        : 0,
    [appliedDiscount, subtotal],
  );

  // `subtract` not `-`: this number goes into the ledger, and the discount is
  // already capped at the subtotal, so the result cannot be negative.
  const calculateTotal = () => Math.max(0, subtract(subtotal, discountAmount));

  // ── التسوية الذكية: a wholesale return settles against the client's debt ──
  //
  // R = what is coming back, D = what they owe, P = cash they hand over today.
  // The debt absorbs R first; P only exists while something is still owed.
  const isWholesaleReturn =
    saleMode === "wholesale" && cart.length > 0 && cart.every((i) => i.quantity < 0);
  const wholesaleReturnValue = isWholesaleReturn
    ? round(cart.reduce((sum, i) => sum + Math.abs(i.quantity) * i.unitPrice, 0))
    : 0;
  const wholesaleDebt = selectedCustomerId ? debtOf(selectedCustomerId) : 0;
  const { remainingDebt: wholesaleRemainingDebt, paidNow: settlePaid } =
    reconcileWholesaleReturn(wholesaleReturnValue, wholesaleDebt, settlePaidInput);

  const handleCompleteSale = async () => {
    if (cart.length === 0) {
      setResult({ success: false, message: "السلة فارغة" });
      return;
    }

    // Re-check against current stock, not against what the screen was
    // rendered with — the cart may have sat open while the same stock moved.
    const stockOfLine = (item: (typeof cart)[number]) =>
      sellableStock(products.find((p) => p.id === item.productId), products, item.variantName);
    const short = cart.find((item) => item.quantity > stockOfLine(item));
    if (short) {
      setResult({
        success: false,
        message: `الكمية المطلوبة من "${short.productName}" أكبر من المخزون (${stockOfLine(short)})`,
      });
      return;
    }

    setIsProcessing(true);
    setResult(null);

    const totalAmount = calculateTotal();

    try {
      if (saleMode === "retail") {
        let finalCustomerId = selectedCustomerId;
        if (customerPhone && !finalCustomerId) {
          finalCustomerId = await useCustomerStore.getState().upsertCustomerFromOrder({
            customerName: customerName.trim(),
            customerPhone: customerPhone.trim(),
            address: "",
          } as any);
        }

        // ONE event. Stock, cash, revenue, cost and LTV all move together or
        // none of them do. There is no separate stock update to fall out of
        // sync with the money — that is the whole point.
        await appendEvent({
          kind: "sale",
          actor: "POS",
          refType: "pos_sale",
          payload: {
            channel: "pos",
            walletId: selectedWallet,
            itemCount: cart.length,
            lines: cart.map((i) => ({ name: i.productName, qty: i.quantity, variantName: i.variantName })),
            customerId: finalCustomerId || undefined,
            customerName: customerName.trim() || undefined,
            customerPhone: customerPhone.trim() || undefined,
            items: cart.map((i) => ({ productId: i.productId, productName: i.productName, unitPrice: i.unitPrice, quantity: i.quantity, variantName: i.variantName })),
            totalAmount: totalAmount,
          },
          lines: buildSaleLines({
            items: cart.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              variantName: item.variantName,
              // Weighted-average cost from the ledger — what was actually paid
              // on receive, not a `costPrice` field off the product record. A
              // stored cost field can be edited after the fact and would
              // silently re-price history that already happened.
              unitCost: costOf(item.productId),
              ...bundleFieldsFor(item.productId),
            })),
            wallet: selectedWallet,
            customerId: finalCustomerId || undefined,
            discountCodeId: appliedDiscount?.id,
            discountAmount: appliedDiscount ? discountAmount : undefined,
          }),
        });
      } else {
        if (!selectedCustomerId) {
          setResult({ success: false, message: "يجب اختيار العميل (التاجر) عند البيع بالجملة" });
          setIsProcessing(false);
          return;
        }
        const client = wholesaleClients.find((c) => c.id === selectedCustomerId);
        if (!client) {
          setResult({ success: false, message: "العميل غير موجود" });
          setIsProcessing(false);
          return;
        }
        
        // A cart of returns only. `buildWholesaleInvoiceLines` refuses negative
        // quantities, so this used to throw and a trader's return could not be
        // processed at all — see `buildWholesaleReturnLines`.
        if (isWholesaleReturn) {
          if (settlePaid > wholesaleRemainingDebt) {
            setResult({ success: false, message: "المبلغ المدفوع أكبر من المديونية المتبقية" });
            setIsProcessing(false);
            return;
          }
          await appendEvent({
            kind: "return_confirmed",
            actor: "POS جملة",
            refType: "wholesale_client",
            refId: selectedCustomerId,
            payload: {
              type: "wholesale_return",
              clientName: client.companyName,
              channel: "pos_wholesale",
              previousDebt: wholesaleDebt,
              returnValue: wholesaleReturnValue,
              paidNow: settlePaid,
            },
            lines: buildWholesaleReturnLines({
              items: cart.map((item) => ({
                productId: item.productId,
                // The cart carries returns as negatives; the builder wants the
                // count of goods coming back.
                quantity: Math.abs(item.quantity),
                unitPrice: item.unitPrice,
                unitCost: costOf(item.productId),
                variantName: item.variantName,
                ...bundleFieldsFor(item.productId),
              })),
              clientId: selectedCustomerId,
              wallet: selectedWallet,
              currentDebt: wholesaleDebt,
              paidNow: settlePaid,
            }),
          });

          // The goods are back on the shelf. Bundles expand at the choke point.
          useBusinessStore.getState().applyStockMoves(
            cart.map((item) => ({
              productId: item.productId,
              delta: Math.abs(item.quantity),
              variantName: item.variantName,
            })),
          );

          refreshStock();
          refreshWallets();
          refreshDebt();
          setResult({
            success: true,
            message: `تم تسجيل المرتجع. المديونية الجديدة: ${formatCurrency(Math.max(0, wholesaleDebt - wholesaleReturnValue - settlePaid))} ج.م`,
          });
          clearDrafts("pos:");
          setCart([]);
          setSelectedCustomerId("");
          setPaidAmountInput("");
          setSettlePaidInput("");
          setIsReturnMode(false);
          setIsProcessing(false);
          return;
        }

        const paid = paidAmountInput === "" ? totalAmount : Number(paidAmountInput);
        if (isNaN(paid) || paid < 0 || paid > totalAmount) {
          setResult({ success: false, message: "المبلغ المدفوع غير صحيح" });
          setIsProcessing(false);
          return;
        }

        const invNum = "FJ-" + String(wholesaleInvoices.length + 1).padStart(4, "0");

        await appendEvent({
          kind: "sale",
          actor: "POS جملة",
          refType: "wholesale_invoice",
          refId: invNum,
          payload: {
            type: "wholesale",
            invoiceNumber: invNum,
            walletId: selectedWallet,
            clientName: client.companyName,
            channel: "pos_wholesale",
            itemCount: cart.length,
            customerId: client.id,
            customerPhone: client.phone,
            customerName: client.name || client.companyName,
            items: cart.map((i) => ({ productId: i.productId, productName: i.productName, unitPrice: i.unitPrice, quantity: i.quantity, variantName: i.variantName })),
          },
          lines: buildWholesaleInvoiceLines({
            items: cart.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              unitCost: costOf(item.productId),
              variantName: item.variantName,
              ...bundleFieldsFor(item.productId),
            })),
            clientId: selectedCustomerId,
            wallet: selectedWallet,
            paidAmount: paid,
            shippingCharge: 0,
            shippingCost: 0,
            // The invoice document is written with the discounted total below;
            // without this the ledger would book the full price and leave the
            // difference sitting on the client as a phantom debt.
            discountAmount: appliedDiscount ? discountAmount : undefined,
          }),
        });

        addWholesaleInvoice({
          invoiceNumber: invNum,
          clientId: selectedCustomerId,
          clientName: client.companyName,
          totalAmount: totalAmount,
          paidAmount: paid,
          remainingAmount: totalAmount - paid,
          dueDate: "",
          notes: "تم تسجيلها عبر الـ POS",
          status: paid >= totalAmount ? "paid" : paid > 0 ? "partial" : "unpaid",
          items: cart.map(i => ({
            id: crypto.randomUUID(),
            productId: i.productId,
            productName: i.productName,
            sku: "", 
            quantity: i.quantity,
            wholesalePrice: i.unitPrice,
            total: i.quantity * i.unitPrice
          })),
        });
      }

      const negativeItems = cart.filter(i => i.quantity < 0);
      const positiveItems = cart.filter(i => i.quantity > 0);
      
      if (negativeItems.length > 0) {
        const isExchange = positiveItems.length > 0;
        const exchangeProduct = isExchange ? positiveItems[0] : null;
        
        // Awaited: the POS sale/refund is already in the ledger by this point,
        // so a lost return RECORD would leave money moved with no document
        // explaining it. `.catch` keeps a failed document from rolling back a
        // completed till operation — the store has already told the user.
        await useBusinessStore.getState().addReturnRecord({
          original_order_id: `pos_${Date.now()}`,
          type: isExchange ? "exchange" : "return",
          customer_name: (saleMode === "retail" ? customerName.trim() : wholesaleClients.find((c) => c.id === selectedCustomerId)?.companyName) || "عميل غير مسجل (نقاط البيع)",
          customer_phone: (saleMode === "retail" ? customerPhone.trim() : wholesaleClients.find((c) => c.id === selectedCustomerId)?.phone) || "",
          governorate: "POS",
          returned_items: negativeItems.map(i => ({
            product_id: i.productId,
            product_name: i.variantName ? `${i.productName} - ${i.variantName}` : i.productName,
            quantity: Math.abs(i.quantity),
            refund_amount: Math.abs(i.quantity * i.unitPrice)
          })),
          ...(isExchange && exchangeProduct ? {
            exchanged_item: {
              product_id: exchangeProduct.productId,
              product_name: exchangeProduct.variantName ? `${exchangeProduct.productName} - ${exchangeProduct.variantName}` : exchangeProduct.productName,
              quantity: exchangeProduct.quantity,
              price: exchangeProduct.unitPrice,
            }
          } : {}),
          financial_difference: totalAmount,
          processed_by: "POS",
          notes: "تم تسجيلها عبر واجهة نقاط البيع (POS)",
        });
      }

      // Every line, variant or not. A negative `quantity` is a مرتجع line and
      // its sign carries through untouched — it puts the goods back.
      useBusinessStore.getState().applyStockMoves(
        cart.map((item) => ({
          productId: item.productId,
          delta: -item.quantity,
          variantName: item.variantName,
        })),
      );

      refreshStock();
      // Re-read the till so the cashier sees this sale land in the wallet they
      // chose, immediately.
      refreshWallets();
      // And the client's debt — a credit sale just changed it, and the very
      // next action may be a return that has to reconcile against it.
      refreshDebt();
      setResult({
        success: true,
        message: "تمت العملية بنجاح!",
        sold: {
          lines: cart,
          total: totalAmount,
          paid:
            saleMode === "retail"
              ? totalAmount
              : paidAmountInput === ""
                ? totalAmount
                : Number(paidAmountInput),
          customer:
            (saleMode === "retail"
              ? customerName.trim()
              : wholesaleClients.find((c) => c.id === selectedCustomerId)?.companyName) ||
            "عميل نقدي",
        },
      });
      // Sold — the basket is in the ledger now, so the draft must not survive.
      clearDrafts("pos:");
      setCart([]);
      setSelectedCustomerId("");
      setCustomerName("");
      setCustomerPhone("");
      setAppliedDiscount(null);
      setDiscountCodeInput("");
      setPaidAmountInput("");
      setIsReturnMode(false);
    } catch (e) {
      // A rejected append wrote nothing, so the cart is still valid and the
      // cashier can retry. Say that rather than leaving them guessing.
      setResult({
        success: false,
        message: `لم تُسجَّل العملية ولم يتغيّر أي رصيد. ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-4">
      {result && (
        <div
          className={`rounded-xl p-4 flex items-start gap-3 ${result.success ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}
        >
          {result.success ? (
            <CheckCircle2 className="size-5 text-green-600 mt-0.5" />
          ) : (
            <AlertCircle className="size-5 text-red-600 mt-0.5" />
          )}
          <div className="flex-1">
            <p className={`font-semibold ${result.success ? "text-green-900" : "text-red-900"}`}>
              {result.message}
            </p>
          </div>
          {result.sold && (
            <Button variant="outline" size="sm" onClick={() => printPosInvoice(result.sold!)}>
              طباعة الفاتورة
            </Button>
          )}
        </div>
      )}

      {walletError && (
        <div className="rounded-xl p-4 flex items-start gap-3 bg-red-50 border border-red-200">
          <AlertCircle className="size-5 text-red-600 mt-0.5" />
          <div>
            <p className="font-semibold text-red-900">تعذّرت قراءة أرصدة الخزائن</p>
            <p className="text-sm text-red-800 mt-1">
              الرصيد المعروض مش موثوق — راجعه قبل ما تقفل الوردية. {walletError}
            </p>
          </div>
        </div>
      )}

      {stockError && (
        <div className="rounded-xl p-4 flex items-start gap-3 bg-red-50 border border-red-200">
          <AlertCircle className="size-5 text-red-600 mt-0.5" />
          <div>
            <p className="font-semibold text-red-900">تعذّرت قراءة المخزون</p>
            <p className="text-sm text-red-800 mt-1">
              الأرقام المعروضة مش موثوقة — متبعش قبل ما ده يتصلّح. {stockError}
            </p>
          </div>
        </div>
      )}

      {/* Speed lane on the right (RTL: first), the basket pinned beside it.
          Nothing below changes what a sale DOES — same handlers, same one
          `appendEvent`. This is where the cashier looks, not what runs. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-[calc(100vh-80px)] overflow-hidden items-start">
        {/* =======================
            RIGHT COLUMN: Working Area (lg:col-span-8)
            ======================= */}
        <div className="lg:col-span-8 space-y-6 overflow-y-auto h-full pr-2 pb-4">
          
          {/* Top: Mode Tabs & Return Mode Toggle */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Mode Toggle */}
            <Tabs 
              value={saleMode} 
              onValueChange={(v) => handleModeChange(v as "retail" | "wholesale")}
              className="w-full"
            >
              <TabsList className="flex w-full h-full p-1 bg-muted/50 rounded-xl border border-border">
                <TabsTrigger 
                  value="retail" 
                  className="flex-1 py-2.5 font-semibold text-gray-700 data-[state=active]:text-gray-900 data-[state=active]:font-bold dark:data-[state=active]:text-white text-lg rounded-lg"
                >
                  قطاعي
                </TabsTrigger>
                <TabsTrigger 
                  value="wholesale" 
                  className="flex-1 py-2.5 font-semibold text-gray-700 data-[state=active]:text-gray-900 data-[state=active]:font-bold dark:data-[state=active]:text-white text-lg rounded-lg"
                >
                  جملة
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Return Mode Toggle */}
            <div className={cn(
              "flex items-center justify-between px-4 py-2.5 rounded-xl border transition-colors shadow-sm h-full",
              isReturnMode ? "bg-red-50/50 border-red-200" : "bg-card border-border"
            )}>
              <div className="flex flex-col">
                <label className="text-base font-bold text-gray-900 dark:text-white">وضع المرتجع</label>
                <p className="text-[11px] text-muted-foreground mt-0.5">تفعيل لإضافة مرتجعات</p>
              </div>
              <div className="flex items-center gap-4">
                <POSReturnModal
                  onReturnItem={(product, variantName) => {
                    if (!isReturnMode) setIsReturnMode(true);
                    addItemToCart(product, -1, variantName);
                  }}
                />
                <Switch
                  checked={isReturnMode}
                  onCheckedChange={setIsReturnMode}
                  className="data-[state=checked]:bg-red-500"
                />
              </div>
            </div>
          </div>

          {/* Barcode Scanner */}
          <div className="p-5 rounded-xl border-2 border-primary/30 bg-primary/5 shadow-sm">
            <label className="text-lg font-bold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
              <Barcode className="size-6 text-primary" />
              اضرب الباركود أو ابحث
            </label>
            <div className="flex gap-3">
              <input
                ref={barcodeRef}
                type="text"
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleBarcodeScan();
                  }
                }}
                onBlur={(e) => {
                  if (!e.relatedTarget) barcodeRef.current?.focus();
                }}
                placeholder="امسح الباركود..."
                className="flex-1 h-16 rounded-xl border-2 border-input bg-background px-4 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary text-center text-2xl font-mono tracking-widest"
                autoComplete="off"
                dir="ltr"
              />
              <Button onClick={handleBarcodeScan} className="h-16 px-10 text-xl font-bold gap-2 rounded-xl">
                <Plus className="size-6" />
                إضافة
              </Button>
            </div>
          </div>

          {/* Manual Search */}
          <div className="p-4 rounded-xl border border-border bg-muted/50">
            <div className="grid grid-cols-1 gap-6">
              <div>
                <label className="text-sm font-bold text-gray-900 dark:text-white mb-2 block">
                  اختر المنتج يدوياً
                </label>
                <ProductSearch
                  products={rawProducts ?? []}
                  onSelect={(product) => {
                    setSelectedProductId(product.id);
                    setQuantity(1);
                  }}
                  placeholder="ابحث بالاسم أو الكود أو الباركود..."
                />
                {selectedProduct && (
                  <p className="text-xs mt-2">
                    المختار: <span className="font-bold">{String(selectedProduct.name)}</span> —{" "}
                    {Number(selectedProduct.unitPrice ?? 0).toLocaleString("ar-EG")} ج.م
                  </p>
                )}
                {selectedProduct && sellableStock(selectedProduct, products) <= 0 && (
                  <p className="text-xs text-destructive mt-1 font-bold">هذا المنتج نفد من المخزون</p>
                )}
              </div>
              <div>
                <label className="text-sm font-bold text-gray-900 dark:text-white mb-2 block">الكمية</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setQuantity(quantity - 1)}
                    className="size-11 rounded-xl border border-border bg-card flex items-center justify-center hover:bg-muted"
                  >
                    <Minus className="size-5" />
                  </button>
                  <input
                    type="number"
                    value={quantity}
                    onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
                    className={cn(
                      "flex-1 h-11 text-center rounded-xl border border-input bg-background text-lg font-bold focus:outline-none focus:ring-2 focus:ring-primary/20",
                      quantity < 0 && "text-red-600"
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setQuantity(Math.min(quantity + 1, selectedProduct ? sellableStock(selectedProduct, products) : 1))}
                    disabled={selectedProduct ? quantity >= sellableStock(selectedProduct, products) : true}
                    className="size-11 rounded-xl border border-border bg-card flex items-center justify-center hover:bg-muted disabled:opacity-50"
                  >
                    <Plus className="size-5" />
                  </button>
                </div>
              </div>
            </div>
            
            <Button
              onClick={addManuallyPicked}
              className="w-full mt-6 h-14 text-xl font-bold rounded-xl"
              disabled={!selectedProduct || sellableStock(selectedProduct, products) <= 0}
            >
              <Plus className="size-5 ml-2" />
              إضافة للسلة
            </Button>
          </div>

          {/* Manual Customer Entry (Fallback) */}
          {saleMode === "retail" && !selectedCustomerId && (
            <div className="p-4 rounded-xl border border-border bg-card">
              <label className="text-sm font-bold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <User className="size-4" />
                تسجيل بيانات العميل (يدوي)
              </label>
              <div className="flex flex-col gap-3">
                <Input
                  placeholder="رقم الموبايل (اختياري)"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  dir="ltr"
                  className="text-left font-mono"
                />
                <Input
                  placeholder="اسم العميل (اختياري)"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* =======================
            LEFT COLUMN: Ticket / Cart (lg:col-span-4)
            ======================= */}
        <div className="col-span-1 lg:col-span-4 flex flex-col h-[calc(100vh-120px)] bg-card border-l border-r border-border shadow-[0_0_15px_rgba(0,0,0,0.05)] rounded-lg">
          
          {/* Header: Treasury & CRM */}
          <div className="p-4 border-b border-border bg-muted/30 shrink-0 space-y-3">
            <div>
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Wallet className="size-3.5" />
                الخزينة المستهدفة
              </label>
              <select
                value={selectedWallet}
                onChange={(e) => setSelectedWallet(e.target.value as WalletType)}
                className="flex h-9 w-full rounded border-0 bg-background/50 px-2 py-1 text-sm font-semibold shadow-sm ring-1 ring-inset ring-border focus:ring-2 focus:ring-inset focus:ring-primary"
              >
                {Object.entries(WALLET_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label} - {formatCurrency(walletBalance(key))} ج.م
                  </option>
                ))}
              </select>
            </div>

            {/* CRM Customer Dropdown */}
            <div>
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <User className="size-3.5" />
                {saleMode === "retail" ? "العميل (اختياري) — اختيار من قاعدة العملاء" : "بيانات التاجر *"}
              </label>
              {saleMode === "retail" ? (
                <select
                  value={selectedCustomerId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedCustomerId(id);
                    if (id) {
                      const customer = customers.find((c: any) => c.id === id);
                      if (customer) {
                        setCustomerName(customer.name || "");
                        setCustomerPhone(customer.phone || "");
                      }
                    } else {
                      setCustomerName("");
                      setCustomerPhone("");
                    }
                  }}
                  className="flex h-9 w-full rounded border-0 bg-background/50 px-2 py-1 text-sm font-semibold shadow-sm ring-1 ring-inset ring-border focus:ring-2 focus:ring-inset focus:ring-primary"
                >
                  <option value="">-- عميل غير مسجل (Walk-in) --</option>
                  {customers.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {c.name} {c.phone ? `- ${c.phone}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={selectedCustomerId}
                  onChange={(e) => setSelectedCustomerId(e.target.value)}
                  className="flex h-9 w-full rounded border-0 bg-background/50 px-2 py-1 text-sm font-semibold shadow-sm ring-1 ring-inset ring-border focus:ring-2 focus:ring-inset focus:ring-primary"
                >
                  <option value="">اختر التاجر...</option>
                  {wholesaleClients.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {String(c.companyName ?? "")}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Body: Scrollable Cart */}
          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1 bg-gray-50/50 dark:bg-zinc-950/50">
            {cart.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground flex flex-col items-center justify-center">
                <ShoppingCart className="size-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm font-semibold">التذكرة فارغة</p>
              </div>
            ) : (
              cart.map((item) => {
                const product = products.find((p) => p.id === item.productId);
                const onHand = sellableStock(product, products, item.variantName);

                return (
                  <div
                    key={`${item.productId}-${item.variantName || 'default'}`}
                    className={cn(
                      "flex flex-col p-3 rounded-lg border bg-background shadow-sm",
                      item.quantity < 0 ? "bg-red-50/50 border-red-200" : "border-border"
                    )}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <h4 className={cn("font-bold text-sm leading-tight", item.quantity < 0 && "text-red-700")}>
                        {item.productName}
                        {item.variantName && (
                          <span className="block mt-1 text-[10px] bg-muted w-max px-1.5 py-0.5 rounded text-muted-foreground border border-border">
                            {item.variantName}
                          </span>
                        )}
                      </h4>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded shrink-0 -mr-1 -mt-1"
                        onClick={() => setPendingRemoval(item)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    
                    <div className="flex items-center justify-between mt-auto">
                      <p className="text-xs text-muted-foreground font-semibold">
                        {item.unitPrice.toLocaleString("ar-EG")} ج.م
                      </p>
                      <div className="flex items-center gap-0.5 bg-muted/60 rounded p-0.5">
                        <button
                          type="button"
                          onClick={() => updateCartQuantity(item.productId, item.variantName, Math.abs(item.quantity) - 1 > 0 ? (item.quantity < 0 ? -(Math.abs(item.quantity) - 1) : item.quantity - 1) : 0)}
                          className="size-6 rounded-sm bg-background flex items-center justify-center hover:bg-muted shadow-sm border border-border/50"
                        >
                          <Minus className="size-3" />
                        </button>
                        <span className={cn("w-7 text-center text-xs font-bold", item.quantity < 0 && "text-red-600")}>
                          {Math.abs(item.quantity)}
                        </span>
                        <button
                          onClick={() => updateCartQuantity(item.productId, item.variantName, item.quantity < 0 ? -(Math.abs(item.quantity) + 1) : item.quantity + 1)}
                          disabled={!isReturnMode && item.quantity >= onHand}
                          className="size-6 rounded-sm bg-background flex items-center justify-center hover:bg-muted shadow-sm border border-border/50 disabled:opacity-40"
                        >
                          <Plus className="size-3" />
                        </button>
                      </div>
                      <p className="text-sm font-bold">
                        {(item.unitPrice * Math.abs(item.quantity)).toLocaleString("ar-EG")} ج.م
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer: Totals & Checkout Button */}
          <div className="p-4 bg-muted/30 border-t border-border shrink-0 space-y-3">
            {/* Discount Code */}
            <div>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={discountCodeInput}
                  onChange={(e) => setDiscountCodeInput(e.target.value.toUpperCase())}
                  placeholder="كود الخصم..."
                  className="flex h-8 flex-1 rounded border border-input bg-background px-2 py-1 text-xs shadow-sm font-mono tracking-wider"
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="h-8 px-3 text-xs font-bold"
                  onClick={() => {
                    if (!discountCodeInput.trim()) {
                      setAppliedDiscount(null);
                      return;
                    }
                    const d = promoDiscounts.find(
                      (x) => x.code === discountCodeInput.trim() && x.active,
                    );
                    if (d) {
                      setAppliedDiscount(d);
                    } else {
                      setAppliedDiscount(null);
                      alert("كود الخصم غير موجود أو معطل");
                    }
                  }}
                >
                  تطبيق
                </Button>
              </div>
              {appliedDiscount && (
                <div className="mt-1.5 text-[10px] font-bold text-green-700 bg-green-50 px-2 py-1 rounded border border-green-200 text-center">
                  خصم نشط: {formatCurrency(discountAmount)}
                </div>
              )}
            </div>

            {/* التسوية الذكية — shared with الطلبات and الجملة so all three
                screens explain the same arithmetic. */}
            {isWholesaleReturn && (
              <div className="pt-3 border-t border-border/50">
                <WholesaleReturnPanel
                  debt={wholesaleDebt}
                  returnValue={wholesaleReturnValue}
                  paidInput={settlePaidInput}
                  onPaidChange={setSettlePaidInput}
                  clientMissing={!selectedCustomerId}
                />
              </div>
            )}

            {/* Totals */}
            <div className={cn("pt-3 border-t border-border/50 space-y-4", isWholesaleReturn && "hidden")}>
              <div className="flex items-center justify-between text-base font-semibold text-gray-700 dark:text-gray-300">
                <span>الإجمالي الفرعي</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex items-center justify-between text-base font-semibold text-green-600">
                  <span>الخصم</span>
                  <span>− {formatCurrency(discountAmount)}</span>
                </div>
              )}
              {/* الزيرو-VAT: hidden entirely while نسبة الضريبة is 0, which is
                  where the shop is today. Set a rate in الإعدادات and the line
                  appears here and on the receipt — the math never changed. */}
              {includedVat(calculateTotal(), vatRate) > 0 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>منها ضريبة القيمة المضافة ({vatRate}%)</span>
                  <span>{formatCurrency(includedVat(calculateTotal(), vatRate))}</span>
                </div>
              )}
              <div className="flex items-center justify-between pt-2">
                <span className="text-xl font-extrabold text-gray-900 dark:text-white">الإجمالي المطلوب</span>
                <span className="text-3xl font-black text-primary">{formatCurrency(calculateTotal())}</span>
              </div>
              
              {saleMode === "wholesale" && (
                <div className="pt-3 mt-3 space-y-4 border-t border-border/50">
                  <div className="flex items-center justify-between">
                    <label className="text-base font-semibold text-gray-700 dark:text-gray-300">المدفوع (الآجل)</label>
                    <input
                      type="number"
                      min="0"
                      max={calculateTotal()}
                      value={paidAmountInput}
                      onChange={(e) => setPaidAmountInput(e.target.value)}
                      placeholder={String(calculateTotal())}
                      className="h-10 w-28 rounded border border-input bg-background px-3 text-base font-bold focus:ring-1 focus:ring-primary text-left"
                      dir="ltr"
                    />
                  </div>
                  <div className="flex items-center justify-between text-base font-semibold text-destructive">
                    <span>المتبقي للديون</span>
                    <span>
                      {formatCurrency(
                        calculateTotal() - (paidAmountInput === "" ? calculateTotal() : Number(paidAmountInput))
                      )}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Action Button */}
            {(() => {
              const hasPositive = cart.some(i => i.quantity > 0);
              const hasNegative = cart.some(i => i.quantity < 0);
              const isExchange = hasPositive && hasNegative;
              const isReturnOnly = hasNegative && !hasPositive;
              
              let btnText = "إتمام البيع";
              let btnColor = "bg-green-600 hover:bg-green-700 hover:shadow-green-500/20";
              
              if (isExchange) {
                btnText = "إتمام الاستبدال";
                btnColor = "bg-indigo-600 hover:bg-indigo-700 hover:shadow-indigo-500/20";
              } else if (isReturnOnly || isReturnMode) {
                btnText = "إتمام المرتجع";
                btnColor = "bg-red-600 hover:bg-red-700 hover:shadow-red-500/20";
              }
              
              return (
                <Button
                  onClick={handleCompleteSale}
                  disabled={cart.length === 0 || isProcessing}
                  className={cn(
                    "w-full h-16 text-2xl font-black mt-2 text-white shadow-xl rounded-xl transition-all",
                    btnColor
                  )}
                >
                  {isProcessing ? "جاري..." : btnText}
                </Button>
              );
            })()}
          </div>
        </div>
      </div>

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>متأكد إنك عايز تشيل المنتج ده من السلة؟</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemoval
                ? `هيتشال "${pendingRemoval.productName}" (${pendingRemoval.quantity} × ${pendingRemoval.unitPrice.toLocaleString("ar-EG")} ج.م) من السلة. المخزون مش هيتأثر — لسه مفيش بيعة اتسجّلت.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingRemoval(null)}>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoval}>تأكيد</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              const isAvailable = (v.stock || 0) > 0;
              return (
                <Button
                  key={idx}
                  variant="outline"
                  className={cn(
                    "flex flex-col items-center justify-center h-auto py-3 gap-1",
                    !isAvailable && "opacity-50 cursor-not-allowed"
                  )}
                  disabled={!isAvailable}
                  onClick={() => {
                    const product = pendingVariantSelection.product;
                    const qty = pendingVariantSelection.qty;
                    setPendingVariantSelection(null);
                    setTimeout(() => {
                      addItemToCart(product, qty, v.name);
                    }, 0);
                  }}
                >
                  <span className="font-bold">{v.name}</span>
                  <span className="text-xs text-muted-foreground">
                    المتاح: {v.stock || 0}
                  </span>
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
