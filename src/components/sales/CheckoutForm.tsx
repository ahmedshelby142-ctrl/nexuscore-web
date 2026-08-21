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
} from "lucide-react";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useCustomerStore } from "@/store/useCustomerStore";
import { activeCustomers } from "@/lib/customers";
import { useBalances } from "@/lib/ledger/useBalances";
import { appendEvent } from "@/lib/ledger";
import { buildSaleLines } from "@/lib/ledger/sales";
import { buildWholesaleInvoiceLines } from "@/lib/ledger/wholesale";
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
import { add, multiply, formatQty } from "@/lib/math";
import { productPrice, productWholesalePrice, productMinLevel, activeProducts } from "@/lib/product";
import { ProductSearch } from "@/components/products/ProductSearch";
import { CustomerPhoneMatch } from "@/components/ecommerce/CustomerPhoneMatch";
import { POSReturnModal } from "./POSReturnModal";
import { Switch } from "@/components/ui/switch";
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

  // Stock is summed from the ledger, never read off the product record.
  const {
    qtyOf,
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
  const [discountCodeInput, setDiscountCodeInput] = useDraftState("pos:discountCode", "");
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
  } | null>(null);

  const barcodeRef = useRef<HTMLInputElement>(null);

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
    const onHand = variantName && product.metadata?.variants 
      ? product.metadata.variants.find((v: any) => v.name === variantName)?.stock || 0
      : qtyOf(String(product?.id ?? ""));
    
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

    // Stock comes from the ledger, so a scan can tell the cashier the shelf is
    // empty before they promise it to the customer.
    if (!isReturnMode && qtyOf(String(match.id)) <= 0) {
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
    const maxQty = variantName && product?.metadata?.variants
      ? product.metadata.variants.find((v: any) => v.name === variantName)?.stock || 0
      : qtyOf(productId);
      
    setCart(
      cart.map((item) =>
        item.productId === productId && item.variantName === variantName ? { ...item, quantity: newQuantity < 0 ? newQuantity : Math.min(newQuantity, maxQty) } : item,
      ),
    );
  };

  const subtotal = cart.reduce((total, item) => add(total, multiply(item.unitPrice, item.quantity)), 0);

  const discountAmount = useMemo(() => {
    if (!appliedDiscount) return 0;
    if (appliedDiscount.type === "percentage") {
      return subtotal * (appliedDiscount.value / 100);
    }
    return Math.min(appliedDiscount.value, subtotal);
  }, [appliedDiscount, subtotal]);

  const calculateTotal = () => Math.max(0, subtotal - discountAmount);

  const handleCompleteSale = async () => {
    if (cart.length === 0) {
      setResult({ success: false, message: "السلة فارغة" });
      return;
    }

    // Re-check against the ledger, not against what the screen was rendered
    // with. The cart may have been sitting open while another device sold the
    // same stock.
    const short = cart.find((item) => item.quantity > qtyOf(item.productId));
    if (short) {
      setResult({
        success: false,
        message: `الكمية المطلوبة من "${short.productName}" أكبر من المخزون (${qtyOf(short.productId)})`,
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
          finalCustomerId = useCustomerStore.getState().upsertCustomerFromOrder({
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
            itemCount: cart.length,
            lines: cart.map((i) => ({ name: i.productName, qty: i.quantity, variantName: i.variantName })),
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
            invoiceNumber: invNum,
            clientName: client.companyName,
            channel: "pos_wholesale",
            itemCount: cart.length,
          },
          lines: buildWholesaleInvoiceLines({
            items: cart.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              unitCost: costOf(item.productId),
              variantName: item.variantName,
            })),
            clientId: selectedCustomerId,
            wallet: selectedWallet,
            paidAmount: paid,
            shippingCharge: 0,
            shippingCost: 0,
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

      refreshStock();
      // Re-read the till so the cashier sees this sale land in the wallet they
      // chose, immediately.
      refreshWallets();
      setResult({ success: true, message: "تمت العملية بنجاح!" });
      // Sold — the basket is in the ledger now, so the draft must not survive.
      clearDrafts("pos:");
      setCart([]);
      setAppliedDiscount(null);
      setDiscountCodeInput("");
      setPaidAmountInput("");
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
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className="xl:col-span-2 space-y-4">
          {/* Mode Toggle */}
          <div className="flex bg-muted/50 p-1 rounded-xl border border-border">
            <button
              onClick={() => handleModeChange("retail")}
              className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all ${
                saleMode === "retail"
                  ? "bg-background shadow text-primary"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              قطاعي
            </button>
            <button
              onClick={() => handleModeChange("wholesale")}
              className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all ${
                saleMode === "wholesale"
                  ? "bg-background shadow text-primary"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              جملة
            </button>
          </div>

          {/* Retail CRM / Walk-in Customer */}
          {saleMode === "retail" && (
            <div className="p-4 rounded-xl border border-border bg-card space-y-4">
              <label className="text-sm font-medium block">تسجيل بيانات العميل (اختياري)</label>
              
              {!selectedCustomerId ? (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    placeholder="رقم الموبايل"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    dir="ltr"
                    className="text-left"
                  />
                  <Input
                    placeholder="اسم العميل"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                  />
                </div>
              ) : null}

              <CustomerPhoneMatch
                customers={customers}
                phone={customerPhone}
                linkedId={selectedCustomerId}
                onPick={(c) => {
                  setSelectedCustomerId(c.id);
                  setCustomerName(c.name);
                  setCustomerPhone(c.phone);
                }}
                onUnlink={() => {
                  setSelectedCustomerId("");
                  setCustomerName("");
                }}
              />
            </div>
          )}

          {/* Return Mode Toggle */}
          <div className={cn(
            "flex items-center justify-between p-4 rounded-xl border transition-colors shadow-sm",
            isReturnMode ? "bg-red-50/50 border-red-200" : "bg-card border-border"
          )}>
            <div className="flex flex-col gap-1">
              <label className="text-base font-bold text-foreground">وضع المرتجع</label>
              <p className="text-xs text-muted-foreground">عند تفعيل هذا الخيار، سيتم تسجيل المنتجات المضافة كمرتجعات</p>
            </div>
            <div className="flex items-center gap-4">
              <POSReturnModal
                onReturnItem={(product) => {
                  if (!isReturnMode) setIsReturnMode(true);
                  addItemToCart(product, -1);
                }}
              />
              <div className="flex items-center gap-2">
                <Switch
                  checked={isReturnMode}
                  onCheckedChange={setIsReturnMode}
                  className="data-[state=checked]:bg-red-500"
                />
              </div>
            </div>
          </div>

          {/* Barcode Scanner — Primary Speed Lane */}
          <div className="p-4 rounded-xl border-2 border-primary/30 bg-primary/5">
            <label className="text-base font-bold mb-2 flex items-center gap-2">
              <Barcode className="size-5" />
              اضرب الباركود أو ابحث عن المنتج
            </label>
            <div className="flex gap-2">
              <input
                ref={barcodeRef}
                type="text"
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                onKeyDown={(e) => {
                  // Scanners type the code then send Enter. Without preventDefault
                  // that Enter can submit or trigger the default button.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleBarcodeScan();
                  }
                }}
                onBlur={(e) => {
                  // Take focus back so the scanner keeps working without a click —
                  // but only when focus went nowhere. If the cashier clicked
                  // another field, `relatedTarget` is that field and stealing focus
                  // would make the rest of the screen unusable.
                  if (!e.relatedTarget) barcodeRef.current?.focus();
                }}
                placeholder="امسح الباركود ضوئياً أو اكتب SKU..."
                className="flex-1 h-12 rounded-lg border-2 border-input bg-background px-4 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary text-center text-lg font-mono tracking-widest"
                autoComplete="off"
                dir="ltr"
              />
              <Button onClick={handleBarcodeScan} className="h-12 px-6 gap-2">
                <Plus className="size-5" />
                إضافة
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              اضغط Enter للإضافة الفورية — المنتج سيُضاف تلقائياً مع أول باركود مطابق
            </p>
          </div>

          {/* Manual Product Selection — Fallback */}
          <div className="p-4 rounded-xl border border-border bg-muted/50">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className="text-sm font-medium mb-2 block">
                  اختر المنتج يدوياً (للمنتجات ذات الباركود التالف)
                </label>
                {/* The same `ProductSearch` الطلبات, المرتجعات and الأصناف pick
                with — name/SKU/barcode, ledger stock beside each result. It
                replaced a dropdown of the whole catalogue, which a shop with
                hundreds of products had to scroll (brief §2). */}
                <ProductSearch
                  products={rawProducts ?? []}
                  qtyOf={qtyOf}
                  onSelect={(product) => {
                    setSelectedProductId(product.id);
                    setQuantity(1);
                  }}
                  placeholder="ابحث بالاسم أو الكود أو الباركود..."
                />
                {selectedProduct && (
                  <p className="text-xs mt-2">
                    المختار: <span className="font-medium">{String(selectedProduct.name)}</span> —{" "}
                    {Number(selectedProduct.unitPrice ?? 0).toLocaleString("ar-EG")} ج.م
                  </p>
                )}
                {selectedProduct && qtyOf(selectedProduct.id) <= 0 && (
                  <p className="text-xs text-destructive mt-1">هذا المنتج نفد من المخزون</p>
                )}
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">الكمية</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setQuantity(quantity - 1)}
                    className="size-10 rounded-xl border border-border bg-card flex items-center justify-center hover:bg-muted"
                  >
                    <Minus className="size-4" />
                  </button>
                  <input
                    type="number"
                    value={quantity}
                    onChange={(e) =>
                      setQuantity(
                        parseInt(e.target.value) || 0
                      )
                    }
                    className={cn(
                      "w-16 h-10 text-center rounded-xl border border-input bg-background font-medium focus:outline-none focus:ring-2 focus:ring-primary/20",
                      quantity < 0 && "text-red-600 font-bold"
                    )}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setQuantity(
                        Math.min(quantity + 1, selectedProduct ? qtyOf(selectedProduct.id) : 1),
                      )
                    }
                    disabled={selectedProduct ? quantity >= qtyOf(selectedProduct.id) : true}
                    className="size-10 rounded-xl border border-border bg-card flex items-center justify-center hover:bg-muted disabled:opacity-50"
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
                {selectedProduct && (
                  <p className="text-xs text-muted-foreground mt-1">
                    الحد الأقصى: {qtyOf(selectedProduct.id)}
                  </p>
                )}
              </div>
            </div>
            
            {/* ── Discounts ───────────────────────────────────────── */}
            <div className="pt-4 border-t border-border">
              <label className="text-sm font-semibold mb-2 block">كود الخصم (إن وجد)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={discountCodeInput}
                  onChange={(e) => setDiscountCodeInput(e.target.value.toUpperCase())}
                  placeholder="SAVE10..."
                  className="flex h-9 flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
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
                <div className="mt-2 text-xs font-semibold text-green-700 bg-green-50 p-2 rounded border border-green-200">
                  تم تفعيل كود الخصم (
                  {appliedDiscount.type === "percentage"
                    ? `${appliedDiscount.value}%`
                    : `${appliedDiscount.value} ج.م`}
                  ) — تم خصم: {formatCurrency(discountAmount)}
                </div>
              )}
            </div>
            
            <Button
              onClick={addManuallyPicked}
              className="w-full mt-4"
              disabled={!selectedProduct || qtyOf(selectedProduct.id) <= 0}
            >
              <Plus className="size-4 ml-2" />
              إضافة للسلة
            </Button>
          </div>
        </div>

        <div className="space-y-4 xl:sticky xl:top-4">
          {/* Cart — pinned beside the scan lane, with the total always in view so
          the cashier never has to scroll to read what to charge. */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
              <h4 className="font-semibold flex items-center gap-2">
                <ShoppingCart className="size-4" />
                السلة ({cart.length})
              </h4>
              <span className="text-xl font-bold">
                {calculateTotal().toLocaleString("ar-EG")} ج.م
              </span>
            </div>
            {cart.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <ShoppingCart className="size-8 mx-auto mb-2 opacity-50" />
                <p>السلة فارغة</p>
              </div>
            ) : (
              <div className="space-y-2">
                {cart.map((item) => {
                  const product = products.find((p) => p.id === item.productId);
                  const onHand = item.variantName && product?.metadata?.variants
                    ? product.metadata.variants.find((v: any) => v.name === item.variantName)?.stock || 0
                    : qtyOf(item.productId);
                  
                  return (
                    <div
                      key={`${item.productId}-${item.variantName || 'default'}`}
                      className={cn(
                        "flex items-center justify-between p-3 rounded-lg border",
                        item.quantity < 0 ? "bg-red-50/30 border-red-200" : "bg-background border-border"
                      )}
                    >
                      <div className="flex-1">
                        <h4 className={cn("font-medium flex items-center gap-2", item.quantity < 0 && "text-red-700")}>
                          {item.productName}
                          {item.variantName && (
                            <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground border border-border">
                              {item.variantName}
                            </span>
                          )}
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          {item.unitPrice.toLocaleString("ar-EG")} ج.م × {Math.abs(item.quantity)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => updateCartQuantity(item.productId, item.variantName, Math.abs(item.quantity) - 1 > 0 ? (item.quantity < 0 ? -(Math.abs(item.quantity) - 1) : item.quantity - 1) : 0)}
                            className="size-7 rounded-lg border border-border bg-background flex items-center justify-center hover:bg-muted"
                          >
                            <Minus className="size-3" />
                          </button>
                          <span className={cn("w-6 text-center text-sm font-medium", item.quantity < 0 && "text-red-600 font-bold")}>
                            {Math.abs(item.quantity)}
                          </span>
                          <button
                            aria-label="زيادة الكمية"
                            onClick={() => updateCartQuantity(item.productId, item.variantName, item.quantity < 0 ? -(Math.abs(item.quantity) + 1) : item.quantity + 1)}
                            disabled={!isReturnMode && item.quantity >= onHand}
                            className="h-10 w-10 rounded-lg border border-input bg-background flex items-center justify-center hover:bg-accent active:scale-95 transition disabled:opacity-30"
                          >
                            <Plus className="size-4" />
                          </button>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 text-destructive hover:text-destructive hover:bg-destructive/10 text-lg rounded-full"
                          aria-label="شيل المنتج من السلة"
                          onClick={() => setPendingRemoval(item)}
                        >
                          <Trash2 className="size-5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Payment — wallet, customer, total, and the one button that writes the
          sale. Same handler as before; only its home on the screen changed. */}
          <div className="rounded-2xl border border-border bg-card p-4">
            {/* Wallet Selection */}
            <div className="mb-4">
              <label className="text-sm font-medium mb-2 block flex items-center gap-2">
                <Wallet className="size-4" />
                الخزينة المستهدفة
              </label>
              <select
                value={selectedWallet}
                onChange={(e) => setSelectedWallet(e.target.value as WalletType)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {Object.entries(WALLET_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label} - {formatCurrency(walletBalance(key))} ج.م
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                الحساب اللي هيتسجّل فيه كاش البيعة دي. الرقم جنب الاسم هو رصيد الحساب دلوقتي، وبيزيد
                بقيمة البيعة أول ما تتسجّل — وده اللي بتراجعيه على الدرج أو على الموبايل آخر اليوم.
              </p>
            </div>

            {/* Customer */}
            <div className="mb-4">
              <label className="text-sm font-medium mb-2 block">
                {saleMode === "wholesale" ? "العميل (تاجر الجملة) *" : "العميل (اختياري)"}
              </label>
              <select
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {saleMode === "retail" ? (
                  <>
                    <option value="">عميل عابر — بدون تسجيل</option>
                    {customers.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {String(c.name ?? "")}
                      </option>
                    ))}
                  </>
                ) : (
                  <>
                    <option value="">اختر التاجر...</option>
                    {wholesaleClients.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {String(c.companyName ?? "")}
                      </option>
                    ))}
                  </>
                )}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {saleMode === "wholesale" 
                  ? "تسجيل التاجر إجباري لتقييد المديونية والفاتورة في حسابه." 
                  : "اختيار عميل بيحدّث إجمالي مشترياته (LTV) في قاعدة العملاء"}
              </p>
            </div>
            
            <div className="p-4 bg-muted/40 rounded-xl space-y-2 mb-4">
              <div className="flex items-center justify-between text-muted-foreground text-sm">
                <span>الإجمالي الفرعي</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex items-center justify-between text-green-600 font-medium text-sm">
                  <span>الخصم المطبق</span>
                  <span>− {formatCurrency(discountAmount)}</span>
                </div>
              )}
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="font-bold">الإجمالي النهائي</span>
                <span className="text-xl font-bold">{formatCurrency(calculateTotal())}</span>
              </div>
              
              {saleMode === "wholesale" && (
                <div className="pt-2 border-t border-border mt-2 space-y-3">
                  <div>
                    <label className="text-sm font-medium mb-1 block">المبلغ المدفوع</label>
                    <input
                      type="number"
                      min="0"
                      max={calculateTotal()}
                      value={paidAmountInput}
                      onChange={(e) => setPaidAmountInput(e.target.value)}
                      placeholder={String(calculateTotal())}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      لو سيبته فاضي، هيعتبر دفع الإجمالي كامل.
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-destructive font-medium text-sm">
                    <span>المتبقي (آجل)</span>
                    <span>
                      {formatCurrency(
                        calculateTotal() - (paidAmountInput === "" ? calculateTotal() : Number(paidAmountInput))
                      )}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <Button
              onClick={handleCompleteSale}
              disabled={cart.length === 0 || isProcessing}
              className="w-full h-12 text-base"
              size="lg"
            >
              {isProcessing ? "جاري المعالجة..." : "إتمام البيع"}
            </Button>
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
