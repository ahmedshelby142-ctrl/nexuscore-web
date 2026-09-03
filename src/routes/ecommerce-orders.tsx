import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Component, useState, useMemo, useCallback, useEffect, type ReactNode } from "react";
import {
  ShoppingBag,
  Package,
  Boxes,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  MapPin,
  Phone,
  User,
  Inbox,
  Barcode,
  Wallet,
  CornerDownLeft,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useOrderStore, expandStockItems } from "@/store/useOrderStore";
import { useShippingRatesStore } from "@/store/useShippingRatesStore";
import { rateFor, shippingFeeFor } from "@/lib/shippingRates";
import { appendEvent } from "@/lib/ledger";
import { buildOrderPlacedLines } from "@/lib/ledger/orders";
import { useStock } from "@/lib/ledger/useStock";
import type { PromoDiscount } from "@/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ProductSearch } from "@/components/products/ProductSearch";
import { CustomerPhoneMatch } from "@/components/ecommerce/CustomerPhoneMatch";
import { useCustomerStore } from "@/store/useCustomerStore";
import { resolveByPhone } from "@/lib/customers";
import { useBalances } from "@/lib/ledger/useBalances";
import { productPrice, activeProducts, getVariantStock } from "@/lib/product";
import { formatMoney, formatQty, discountAmountFor } from "@/lib/math";
import { useDraftState, clearDrafts } from "@/hooks/useDraftState";
import type { EcommerceOrderItem, WalletType } from "@/types";
import { WALLET_LABELS } from "@/types";

type PaymentMethod = "full_prepaid" | "partial_cod";

function parseLegacyAddress(address: string | undefined): { gov: string, city: string, det: string } {
  if (!address) return { gov: "", city: "", det: "" };
  const parts = address.split("-").map(s => s.trim());
  if (parts.length >= 3) {
    return { gov: parts[0], city: parts[1], det: parts.slice(2).join(" - ") };
  } else if (parts.length === 2) {
    return { gov: "", city: parts[0], det: parts[1] };
  }
  return { gov: "", city: "", det: address };
}

/** Fallback governorate fees when the shipping tariff store is empty */

interface RowItem {
  kind: "product" | "bundle";
  product_id?: string;
  bundle_id?: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  variantName?: string;
  /** Knowingly sold short — نواقص. Confirmed by the user when it was added. */
  backorder?: boolean;
  /**
   * How many units of this line the shelf could not cover, measured when the
   * user accepted the نواقص. This — not the line quantity — is what has to be
   * bought or manufactured, and it is what تقرير النواقص sums.
   */
  shortfall?: number;
}

/**
 * Is this row safe to send to the ledger?
 *
 * The append-only rule means a bad number is permanent, so a row is only
 * allowed through when every number in it is a real, finite, positive one.
 * `Number.isFinite` and not `> 0` alone, because `NaN > 0` is `false` but so
 * is `NaN <= 0` — comparisons silently wave NaN past in both directions.
 */
function rowIsSound(row: RowItem): boolean {
  const identified =
    (row.kind === "product" && !!row.product_id) || (row.kind === "bundle" && !!row.bundle_id);
  return (
    identified &&
    Number.isFinite(row.quantity) &&
    row.quantity !== 0 &&
    Number.isFinite(row.unit_price) &&
    row.unit_price >= 0
  );
}

/** Error boundary that catches render crashes and shows a controlled fallback */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center space-y-4">
          <AlertCircle className="size-10 mx-auto text-destructive/70" />
          <div>
            <p className="text-lg font-semibold text-destructive">تعذر تحميل لوحة الطلبات</p>
            <p className="text-sm text-muted-foreground mt-1">
              {this.state.error?.message || "حدث خطأ غير متوقع أثناء تهيئة المكون"}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            إعادة تحميل الصفحة
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function EcommerceOrdersInner() {
  // A selector, not a try/catch around the hook call. The old version typed
  // `store` as `unknown` (5 of the repo's 42 typecheck errors lived here),
  // which made `products` `any[]` — and that is precisely why `p.retail_price`
  // compiled while being `undefined` at runtime. The ErrorBoundary above this
  // component already handles a store that fails to initialise, in Arabic.
  const products = useBusinessStore((s) => s.products);

  // ── Live state from global stores ──────────────────────────
  // The Settings matrix is the only source of a shipping price.
  const shippingRates = useShippingRatesStore((s) => s.rows);
  const addOrder = useOrderStore((s) => s.addOrder);
  const allOrders = useOrderStore((s) => s.orders);
  const updateCustomer = useCustomerStore((s) => s.updateCustomer);
  // Stock and cost from the ledger — the same numbers POS and جملة sell against.
  const { costOf, refresh: refreshStock } = useStock();
  const { promoDiscounts } = useBusinessStore();

  const bundles = useMemo(() => activeProducts(products).filter((p) => p.isBundle), [products]);
  // Search-first customer entry (§3.7). The directory is read here and the
  // matching happens in `@/lib/customers`; this screen only shows the choice.
  const customers = useCustomerStore((s) => s.customers);
  // Lifetime spend per customer id, so two people with the same first name are
  // still telling apart. SUM(customer_ltv) — never a stored field.
  const { amountOf: ltvOf } = useBalances("customer_ltv");

  // Every field the user types is a DRAFT: it survives navigating to another
  // screen and back, and an accidental reload, and dies with the session.
  // Losing a half-entered order because someone checked a price on another
  // screen was the single most-reported complaint about this app.
  const [customer_name, setCustomerName] = useDraftState("eco-order:name", "");
  const [customer_phone, setCustomerPhone] = useDraftState("eco-order:phone", "");
  // Which EXISTING customer she picked out of the phone search, if any. A
  // draft like every other field, so half a form survives a trip to another
  // screen — including the person it is for.
  const [customerId, setCustomerId] = useDraftState("eco-order:customerId", "");
  const [governorate, setGovernorate] = useDraftState("eco-order:governorate", "");
  const [city, setCity] = useDraftState("eco-order:city", "");
  const [detailedAddress, setDetailedAddress] = useDraftState("eco-order:detailedAddress", "");
  const [isExchange, setIsExchange] = useDraftState("eco-order:isExchange", false);
  const [originalOrderId, setOriginalOrderId] = useDraftState("eco-order:originalOrderId", "");
  const [rows, setRows] = useDraftState<RowItem[]>("eco-order:rows", []);
  const [paymentMethod, setPaymentMethod] = useDraftState<PaymentMethod>("eco-order:paymentMethod", "full_prepaid");
  
  const [pendingVariantSelection, setPendingVariantSelection] = useState<{ product: any; qty: number } | null>(null);

  const [deposit_amount, setDepositAmount] = useDraftState("eco-order:deposit", "");
  const [depositWallet, setDepositWallet] = useDraftState<WalletType>("eco-order:depositWallet", "instaPay");
  const [courierName, setCourierName] = useDraftState("eco-order:courierName", "");
  const [courierFee, setCourierFee] = useDraftState("eco-order:courierFee", "");
  
  const [discountCodeInput, setDiscountCodeInput] = useDraftState("eco-order:discountCode", "");
  const [appliedDiscount, setAppliedDiscount] = useDraftState<PromoDiscount | null>(
    "eco-order:appliedDiscount",
    null,
  );

  useEffect(() => {
    const digits = customer_phone.replace(/\D/g, "");
    if (digits.length === 11 && !customerId) {
      const match = resolveByPhone(customers, customer_phone);
      if (match.kind === "one") {
        const c = match.customer;
        setCustomerId(c.id);
        setCustomerName(c.name);
        setCustomerPhone(c.phone);
        const custProfile = c as any;
        const parsed = parseLegacyAddress(custProfile.address);
        if (parsed.gov) setGovernorate(parsed.gov);
        if (parsed.city) setCity(parsed.city);
        if (parsed.det) setDetailedAddress(parsed.det);
      }
    }
  }, [customer_phone, customers, customerId, setCustomerId, setCustomerName, setCustomerPhone, setDetailedAddress, setGovernorate, setCity]);

  const deliveredOrdersForCustomer = useMemo(() => {
    if (!customerId) return [];
    return allOrders.filter(o => o.customerId === customerId && o.status === "delivered");
  }, [allOrders, customerId]);

  const selectedOriginalOrder = useMemo(() => {
    return allOrders.find(o => o.id === originalOrderId) || null;
  }, [allOrders, originalOrderId]);

  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const governorateFees = useMemo(
    () => shippingRates.map((r) => ({ name: r.governorate, fee: r.delivery })),
    [shippingRates],
  );

  const governorateTiers = useMemo(() => {
    const map = new Map<number, { fee: number; names: string[] }>();
    for (const g of governorateFees) {
      const entry = map.get(g.fee) ?? { fee: g.fee as number, names: [] as string[] };
      entry.names.push(g.name);
      map.set(g.fee, entry);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([fee, entry]) => ({ tier: `${fee} ج.م`, names: entry.names, fee }));
  }, [governorateFees]);

  /**
   * The customer this order is for, matched on phone, so their history can
   * price the delivery. `null` until a known number is typed.
   */
  const matchedCustomer = useMemo(() => {
    const key = customer_phone.trim();
    if (!key) return null;
    return (
      useCustomerStore.getState().customers.find((c: any) => c.phone?.trim() === key) ?? null
    );
  }, [customer_phone]);

  const baseShippingFee = useMemo(
    () => rateFor(shippingRates, governorate, isExchange ? "exchange" : "delivery"),
    [governorate, shippingRates, isExchange],
  );

  /**
   * Doubled for a customer who has returned an order before.
   *
   * A return costs the shop the trip out AND the trip back while the customer
   * pays nothing, so the second time they order, the delivery is priced at what
   * their deliveries actually risk costing. Goods are never marked up — only
   * the shipping.
   */
  const shipping_fee = useMemo(
    () => shippingFeeFor(baseShippingFee, matchedCustomer),
    [baseShippingFee, matchedCustomer],
  );

  const shippingPenaltyApplied = shipping_fee > baseShippingFee;

  const subtotal = useMemo(
    () => rows.reduce((s, r) => s + r.quantity * r.unit_price, 0),
    [rows],
  );

  // Same shared rule as POS and الجملة — capped at the subtotal and rounded to
  // piastres, so the screen and the ledger cannot differ by float dust.
  const discountAmount = useMemo(
    () =>
      appliedDiscount
        ? discountAmountFor(subtotal, appliedDiscount.type, appliedDiscount.value)
        : 0,
    [appliedDiscount, subtotal],
  );

  const total_price = useMemo(
    () => Math.max(0, subtotal - discountAmount),
    [subtotal, discountAmount],
  );

  const depositVal = useMemo(() => {
    if (paymentMethod === "full_prepaid") return total_price + shipping_fee;
    return parseFloat(deposit_amount) || 0;
  }, [paymentMethod, deposit_amount, total_price, shipping_fee]);

  const remaining_balance = useMemo(
    () => total_price + shipping_fee - depositVal,
    [total_price, shipping_fee, depositVal],
  );

  const addProductRow = useCallback(
    (product: (typeof products)[number], variantName?: string) => {
      if (product.metadata?.variants && product.metadata.variants.length > 0 && !variantName) {
        setPendingVariantSelection({ product, qty: 1 });
        return;
      }

      // النواقص. An online order is always a promise for later, so a short
      // line is a real business choice here — but it is the user's choice to
      // make, out loud, not something the form does quietly.
      const available = getVariantStock(product, variantName);
      const inCart = rows
        .filter((r) => r.product_id === product.id && r.variantName === variantName)
        .reduce((sum, r) => sum + r.quantity, 0);
      // DERIVED from the line's total, never accumulated — the quantity box
      // can change that total without passing through here.
      const shortfall = Math.max(0, inCart + 1 - available);
      let backorder = false;
      if (shortfall > 0) {
        // ponytail: native confirm(). Swap in a styled dialog only if this
        // ever needs more than one yes/no.
        if (
          !window.confirm(
            "هذا المنتج غير متوفر في المخزون حالياً. هل تريد إضافته كطلب نواقص (Backorder)؟",
          )
        ) {
          return;
        }
        backorder = true;
      }

      setRows((prev) => {
        if (prev.length >= 50) return prev;
        const existing = prev.find((r) => r.product_id === product.id && r.variantName === variantName);
        if (existing) {
          const next = prev.map((r) => ({ ...r }));
          const at = next.findIndex((r) => r.product_id === product.id && r.variantName === variantName);
          next[at].quantity += 1;
          next[at].backorder = next[at].backorder || backorder;
          next[at].shortfall = shortfall;
          return next;
        }
        return [
          ...prev,
          {
            kind: "product" as const,
            product_id: product.id,
            product_name: product.name,
            quantity: 1,
            unit_price: productPrice(product),
            variantName: variantName,
            backorder,
            shortfall,
          },
        ];
      });
    },
    [rows, setRows],
  );

  const addBundleRow = useCallback(
    (bundleId: string) => {
      const bundle = bundles.find((b) => b.id === bundleId);
      if (!bundle) return;
      setRows((prev) => {
        if (prev.length >= 50) return prev;
        const at = prev.findIndex((r) => r.kind === "bundle" && r.bundle_id === bundle.id);
        if (at >= 0) {
          const next = prev.map((r) => ({ ...r }));
          next[at].quantity += 1;
          return next;
        }
        return [
          ...prev,
          {
            kind: "bundle" as const,
            bundle_id: bundle.id,
            product_name: bundle.name,
            quantity: 1,
            unit_price: productPrice(bundle),
          },
        ];
      });
    },
    [bundles, setRows],
  );

  const setRowQty = useCallback(
    (idx: number, quantity: number) => {
      setRows((prev) => {
        const next = prev.map((r) => ({ ...r }));
        const row = next[idx];
        // Typing a quantity is the same decision as adding that many, so the
        // نواقص figure is re-derived rather than left at whatever the
        // add-to-cart path last measured. Bundles have no single product to
        // measure against, and a negative row is a مرتجع, not a shortage.
        const available =
          row.kind === "product" && row.product_id
            ? getVariantStock(products.find((p) => p.id === row.product_id), row.variantName)
            : Infinity;
        const shortfall = Math.max(0, quantity - available);
        // `backorder` is NOT set here: that flag means "the user was asked
        // and said yes". Typing a big number is not an answer, so an
        // unflagged line that goes short this way is stopped at submit.
        next[idx] = { ...row, quantity, shortfall };
        return next;
      });
    },
    [products, setRows],
  );

  const removeRow = useCallback(
    (idx: number) => {
      setRows((prev) => prev.filter((_, i) => i !== idx));
    },
    [setRows],
  );

  const canSubmit = useMemo(() => {
    if (!customer_name.trim() || !customer_phone.trim() || !governorate) return false;
    if (rows.length === 0 || !rows.every(rowIsSound)) return false;
    if (!Number.isFinite(total_price) || !Number.isFinite(shipping_fee)) return false;
    if (!Number.isFinite(depositVal) || !Number.isFinite(remaining_balance)) return false;
    return true;
  }, [
    customer_name,
    customer_phone,
    governorate,
    rows,
    total_price,
    shipping_fee,
    depositVal,
    remaining_balance,
    discountAmount,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      setResult({ success: false, message: "يرجى إكمال جميع الحقول المطلوبة" });
      return;
    }
    const unsound = rows.find((r) => !rowIsSound(r));
    if (unsound) {
      setResult({
        success: false,
        message: `سعر أو كمية "${unsound.product_name || "أحد المنتجات"}" غير صالح — احذف السطر وأضفه من جديد`,
      });
      return;
    }
    const validRows = rows.filter(rowIsSound);
    const items: EcommerceOrderItem[] = validRows.map((r) => {
      if (r.kind === "bundle") {
        const bundle = bundles.find((b) => b.id === r.bundle_id);
        return {
          id: crypto.randomUUID(),
          productId: "",
          productName: r.product_name,
          sku: bundle?.sku || "",
          quantity: r.quantity,
          unitPrice: r.unit_price,
          bundleId: r.bundle_id,
          bundleName: r.product_name,
        };
      }

      const product = products.find((p) => p.id === r.product_id);
      return {
        id: crypto.randomUUID(),
        productId: r.product_id || "",
        productName: r.product_name,
        sku: product?.sku || "",
        quantity: r.quantity,
        unitPrice: r.unit_price,
        variantName: r.variantName,
        shortfall: r.shortfall,
      };
    });

    const courierFeeValue = parseFloat(courierFee) || shipping_fee;

    const stockItems = expandStockItems(items).map((line) => ({
      ...line,
      unitCost: costOf(line.productId),
    }));

    // Products the user accepted as نواقص are exempt — that confirmation IS
    // the decision to sell short. Everything else still has to be on the shelf.
    const backordered = new Set(
      rows.filter((r) => r.backorder && r.product_id).map((r) => r.product_id as string),
    );
    const needed = new Map<string, number>();
    for (const line of stockItems) {
      needed.set(line.productId, (needed.get(line.productId) ?? 0) + line.quantity);
    }
    for (const [productId, quantity] of needed) {
      if (backordered.has(productId)) continue;
      const onHand = getVariantStock(products.find((p) => p.id === productId));
      if (quantity > onHand) {
        const name = stockItems.find((l) => l.productId === productId)?.productName ?? productId;
        setResult({
          success: false,
          message: `الكمية المطلوبة من "${name}" أكبر من المخزون (${onHand})`,
        });
        return;
      }
    }

    const cogsAmount = stockItems.reduce(
      (sum, line) => sum + (line.unitCost ?? 0) * line.quantity,
      0,
    );

    try {
      await appendEvent({
        kind: "order_placed",
        actor: "أونلاين",
        refType: "ecommerce_order",
        payload: {
          customerName: customer_name.trim(),
          governorate,
          itemCount: stockItems.length,
        },
        lines: buildOrderPlacedLines({
          items: stockItems.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            unitCost: line.unitCost ?? 0,
          })),
          depositAmount: depositVal,
          wallet: depositVal > 0 ? depositWallet : undefined,
        }),
      });
    } catch (e) {
      setResult({
        success: false,
        message: `لم يُسجَّل الطلب ولم يتغيّر المخزون. ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    // The goods leave the shelf when the order is taken — the same moment the
    // `order_placed` event above reserves them. Cancel and return put them
    // back (OrdersPage), so this is the half that makes those symmetric.
    useBusinessStore.getState().applyStockMoves(
      stockItems.map((line: any) => ({
        productId: line.productId,
        delta: -line.quantity,
        variantName: line.variantName,
      })),
    );

    const orderResult = await addOrder({
      customerId: customerId || undefined,
      customerName: customer_name.trim(),
      customerPhone: customer_phone.trim(),
      address: [governorate, city, detailedAddress].filter(Boolean).join(" - "),
      governorate,
      metadata: {
        governorate,
        city,
        address: detailedAddress,
        ...(isExchange && originalOrderId ? { original_order_id: originalOrderId } : {}),
      },
      paymentMethod,
      shippingFee: shipping_fee,
      // Marks this order as the one recovering a previous wasted trip. Delivery
      // reads it to know the debt is settled — see `clearsShippingDebt`.
      shippingPenaltyApplied: shippingPenaltyApplied || undefined,
      items,
      stockItems,
      cogsAmount,
      totalAmount: total_price,
      discountCodeId: appliedDiscount?.id,
      discountAmount: appliedDiscount ? discountAmount : undefined,
      depositAmount: depositVal,
      depositWallet: depositVal > 0 ? depositWallet : undefined,
      expectedCod: remaining_balance,
      courierName,
      courierFee: courierFeeValue,
      status: "pending",
      isExchange,
    });

    if (!orderResult.success) {
      setResult({ success: false, message: orderResult.reason });
      return;
    }

    if (customerId) {
      // Awaited: the success message below says the customer was updated, so
      // it must not be shown while that write is still in flight (or refused).
      await updateCustomer(customerId, {
        address: [governorate, city, detailedAddress].filter(Boolean).join(" - ")
      }).catch(() => {});
    }

    refreshStock();

    setResult({
      success: true,
      message: "تم حفظ الطلب وتحديث المخزون والعميل وشركة الشحن تلقائياً!",
    });
    clearDrafts("eco-order:");
    setCustomerName("");
    setCustomerPhone("");
    setCustomerId("");
    setGovernorate("");
    setCity("");
    setDetailedAddress("");
    setIsExchange(false);
    setOriginalOrderId("");
    setRows([]);
    setDepositAmount("");
    setDepositWallet("instaPay");
    setPaymentMethod("partial_cod");
    setCourierFee("");
    setDiscountCodeInput("");
    setAppliedDiscount(null);
    setIsExchange(false);
    setTimeout(() => setResult(null), 4000);
  }, [
    canSubmit,
    rows,
    customer_name,
    customer_phone,
    customerId,
    governorate,
    shipping_fee,
    total_price,
    depositVal,
    remaining_balance,
    addOrder,
    bundles,
    products,
    costOf,
    refreshStock,
    courierFee,
    courierName,
    paymentMethod,
    appliedDiscount,
    discountAmount,
    discountCodeInput,
    setDiscountCodeInput,
    setAppliedDiscount,
    depositWallet,
    setRows,
    setCustomerName,
    setCustomerPhone,
    setCustomerId,
    setGovernorate,
    setCity,
    setDetailedAddress,
    setIsExchange,
    setOriginalOrderId,
    setDepositAmount,
    setDepositWallet,
    setPaymentMethod,
    setCourierFee,
    setResult
  ]);

  const selCount = rows.filter((r) => r.product_id).length;

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center gap-3">
        <div
          className="size-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "var(--gradient-primary)" }}
        >
          <ShoppingBag className="size-5 text-primary-foreground" />
        </div>
        <div className="min-w-0">
          <h2 className="text-3xl font-display font-bold leading-tight">إدخال طلب أونلاين يدوي</h2>
          <p className="text-muted-foreground mt-1">
            إنشاء طلب إلكتروني يدوي للعملاء — حساب الشحن والعربون والمتبقي تلقائياً
          </p>
        </div>
        <div className="flex items-center gap-2 mr-auto bg-muted/50 p-2 rounded-xl border border-border">
          <Label htmlFor="exchange-mode" className="text-sm font-medium cursor-pointer select-none">
            طلب استبدال
          </Label>
          <Switch
            id="exchange-mode"
            checked={isExchange}
            onCheckedChange={setIsExchange}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-sm font-semibold text-muted-foreground tracking-wide">بيانات العميل</p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <User className="size-3.5 text-muted-foreground shrink-0" />
                اسم العميل <span className="text-destructive">*</span>
              </span>
              {customerId && (
                <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200">
                  عميل مسجل
                </Badge>
              )}
            </label>
            <input
              value={customer_name}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="أدخل اسم العميل"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <Phone className="size-3.5 text-muted-foreground shrink-0" />
              رقم الهاتف <span className="text-destructive">*</span>
            </label>
            <input
              value={customer_phone}
              onChange={(e) => {
                setCustomerPhone(e.target.value);
                if (customerId) setCustomerId("");
              }}
              placeholder="أدخل رقم الهاتف"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <MapPin className="size-3.5 text-muted-foreground shrink-0" />
              المحافظة <span className="text-destructive">*</span>
            </label>
            <select
              value={governorate}
              onChange={(e) => setGovernorate(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">-- اختر المحافظة --</option>
              {governorateTiers.map((tier) => (
                <optgroup key={tier.fee} label={tier.tier}>
                  {tier.names.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <MapPin className="size-3.5 text-muted-foreground shrink-0" />
              المدينة / المنطقة
            </label>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="مثال: مدينة نصر، سموحة"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <MapPin className="size-3.5 text-muted-foreground shrink-0" />
              العنوان بالتفصيل <span className="text-destructive">*</span>
            </label>
            <input
              value={detailedAddress}
              onChange={(e) => setDetailedAddress(e.target.value)}
              placeholder="اسم الشارع، رقم العمارة، الشقة"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <CustomerPhoneMatch
          customers={customers}
          phone={customer_phone}
          linkedId={customerId}
          ltvOf={ltvOf}
          onPick={(c) => {
            setCustomerId(c.id);
            setCustomerName(c.name);
            setCustomerPhone(c.phone);
            const custProfile = c as any;
            const parsed = parseLegacyAddress(custProfile.address);
            if (parsed.gov) setGovernorate(parsed.gov);
            if (parsed.city) setCity(parsed.city);
            if (parsed.det) setDetailedAddress(parsed.det);
          }}
          onUnlink={() => setCustomerId("")}
        />
      </div>

      {isExchange && (
        <div className="rounded-2xl border border-border bg-card p-6 space-y-4 bg-muted/20">
          <p className="text-sm font-semibold text-muted-foreground tracking-wide">تفاصيل الطلب الأصلي</p>
          
          <div className="space-y-1.5">
            <label className="text-sm font-medium">اختر الطلب المراد استبداله</label>
            <select
              value={originalOrderId}
              onChange={(e) => setOriginalOrderId(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">-- اختر الطلب --</option>
              {deliveredOrdersForCustomer.map(o => (
                <option key={o.id} value={o.id}>
                  طلب رقم {o.orderNumber} - {o.totalAmount} ج.م - بتاريخ {new Date(o.createdAt).toLocaleDateString("ar-EG")}
                </option>
              ))}
            </select>
            {deliveredOrdersForCustomer.length === 0 && customerId && (
              <p className="text-xs text-muted-foreground">لم يتم العثور على طلبات سابقة مستلمة لهذا العميل.</p>
            )}
            {deliveredOrdersForCustomer.length === 0 && !customerId && (
              <p className="text-xs text-muted-foreground">قم بتحديد العميل أولاً لعرض طلباته السابقة.</p>
            )}
          </div>

          {selectedOriginalOrder && (
            <div className="mt-4 space-y-3">
              <h4 className="text-sm font-medium">المنتجات في الطلب الأصلي:</h4>
              <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                {selectedOriginalOrder.items.map((item, idx) => {
                  const cartItem = rows.find(r => r.kind === 'product' && r.product_id === item.productId);
                  const isReturned = cartItem && cartItem.quantity < 0;

                  return (
                    <div key={idx} className="p-3 flex justify-between items-center bg-background text-sm">
                      <div className="space-y-1">
                        <p className="font-medium">{item.productName}</p>
                        <p className="text-xs text-muted-foreground">الكمية: {item.quantity} | السعر: {item.unitPrice} ج.م</p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!!isReturned}
                        onClick={() => {
                          setRows(prev => [
                            ...prev,
                            {
                              kind: "product",
                              product_id: item.productId,
                              product_name: item.productName,
                              quantity: -1,
                              unit_price: item.unitPrice
                            }
                          ])
                        }}
                      >
                        <CornerDownLeft className="size-3.5 mr-1.5" />
                        {isReturned ? "تم الاسترجاع" : "استرجاع هذا المنتج"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-sm font-semibold text-muted-foreground tracking-wide">طريقة الدفع</p>
        <div className="flex items-center justify-between p-4 rounded-xl border border-border bg-muted/30">
          <div className="space-y-0.5">
            <Label className="text-base font-medium cursor-pointer">
              {paymentMethod === "full_prepaid"
                ? "مدفوع بالكامل مسبقاً (فودافون كاش / فيزا)"
                : "الدفع عند الاستلام (COD)"}
            </Label>
            <p className="text-xs text-muted-foreground">
              {paymentMethod === "full_prepaid"
                ? "العميل دفع كامل المبلغ — المستحق للمندوب: 0 ج.م"
                : "العميل سيدفع عند الاستلام — يمكن تحصيل عربون مقدم"}
            </p>
          </div>
          <Switch
            checked={paymentMethod === "full_prepaid"}
            onCheckedChange={(on) => {
              setPaymentMethod(on ? "full_prepaid" : "partial_cod");
              setDepositAmount("");
            }}
          />
        </div>

        {paymentMethod === "partial_cod" && (
          <div className="p-4 rounded-xl border border-dashed border-border bg-muted/20 space-y-2">
            <Label className="text-sm font-medium">قيمة العربون المدفوع (إن وجد)</Label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={deposit_amount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="0 (بدون عربون)"
              className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">أدخل 0 إذا لم يتم تحصيل أي عربون</p>
            {depositVal > 0 && (
              <div className="mt-3 space-y-1">
                <Label className="text-sm font-medium">وصل في أي خزينة؟</Label>
                <select
                  value={depositWallet}
                  onChange={(e) => setDepositWallet(e.target.value as WalletType)}
                  className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {Object.entries(WALLET_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">الخزينة اللي العربون دخل فيها فعلاً</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-sm font-semibold text-muted-foreground tracking-wide">المنتجات</p>

        <ProductSearch
          products={products}
          onSelect={addProductRow}
          excludeIds={rows.filter((r) => r.product_id).map((r) => r.product_id as string)}
          placeholder="ابحث باسم المنتج أو الكود لإضافته للطلب..."
          /* Out-of-stock stays pickable: `addProductRow` asks before it adds. */
          allowOutOfStock
        />

        {bundles.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value=""
              onChange={(e) => e.target.value && addBundleRow(e.target.value)}
              className="flex-1 h-10 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">-- إضافة بوكس / تجميعة --</option>
              {bundles.map((bundle) => (
                <option key={bundle.id} value={bundle.id}>
                  {bundle.name} — {formatMoney(bundle.unitPrice)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-2">
            {rows.length === 0 ? (
              <div className="py-6">
                <EmptyState icon={Package} title="لسه مفيش منتجات في الطلب" description="ابحث فوق وأضف أول منتج" />
              </div>
            ) : (
            rows.map((row, i) => (
              <div
                key={row.product_id || row.bundle_id || i}
                className="flex items-center gap-3 p-3 rounded-xl border border-border bg-muted/30"
              >
                <div className="min-w-0 flex-1 space-y-1 overflow-hidden">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{row.product_name}</p>
                    {row.variantName && (
                      <Badge variant="outline" className="h-5 text-[10px] px-1.5 font-bold border-primary text-primary">
                        {row.variantName}
                      </Badge>
                    )}
                    {row.backorder && (
                      <Badge
                        variant="outline"
                        className="h-5 gap-1 px-1.5 text-[10px] font-bold border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                        title="غير متوفر بالمخزون — مسجّل كطلب نواقص"
                      >
                        <AlertTriangle className="size-3" />
                        نواقص
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.kind === "bundle" ? "بوكس" : "منتج"} — {formatMoney(row.unit_price)} للوحدة
                    {row.kind === "product" && row.product_id
                      ? ` — متاح ${formatQty(getVariantStock(products.find((p) => p.id === row.product_id), row.variantName))}`
                      : ""}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setRowQty(i, row.quantity - 1)}
                    className="size-8 rounded border border-input bg-background flex items-center justify-center hover:bg-accent text-sm"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    value={row.quantity}
                    onChange={(e) => setRowQty(i, parseInt(e.target.value) || 0)}
                    className={cn(
                      "w-14 h-8 text-center rounded border border-input bg-background text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring",
                      row.quantity < 0 && "text-red-600 font-bold"
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setRowQty(i, row.quantity + 1)}
                    className="size-8 rounded border border-input bg-background flex items-center justify-center hover:bg-accent text-sm"
                  >
                    +
                  </button>
                </div>

                <span className="text-sm font-mono min-w-[90px] text-left shrink-0">
                  {formatMoney(row.quantity * row.unit_price)}
                </span>
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="size-8 rounded flex items-center justify-center text-destructive hover:bg-destructive/10 shrink-0"
                  aria-label="حذف المنتج"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))
          )}
        </div>

        {selCount > 0 && (
          <p className="text-xs text-muted-foreground">عدد العناصر المختارة: {selCount}</p>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-sm font-semibold text-muted-foreground tracking-wide">الخصومات</p>
        <div className="flex gap-2 items-center">
          <input
            value={discountCodeInput}
            onChange={(e) => setDiscountCodeInput(e.target.value.toUpperCase())}
            placeholder="أدخل كود الخصم (إن وجد)"
            className="flex h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            type="button"
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
                setResult({ success: true, message: "تم تطبيق الخصم بنجاح!" });
              } else {
                setAppliedDiscount(null);
                setResult({ success: false, message: "كود الخصم غير موجود أو غير نشط" });
              }
              setTimeout(() => setResult(null), 4000);
            }}
          >
            تطبيق
          </Button>
        </div>
        {appliedDiscount && (
          <div className="p-3 rounded-lg border border-green-200 bg-green-50 text-sm text-green-800 flex justify-between items-center">
            <span>
              تم تفعيل كود الخصم (
              {appliedDiscount.type === "percentage"
                ? `${appliedDiscount.value}%`
                : `${appliedDiscount.value} ج.م`}
              )
            </span>
            <span className="font-bold">خصم: {formatMoney(discountAmount)}</span>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-xl flex items-center justify-center bg-blue-100 shrink-0">
            <Boxes className="size-5 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-muted-foreground tracking-wide">
              بيانات شركة الشحن
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              يتم تحديث مستحق المندوب تلقائياً عند تسليم الطلب
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">شركة الشحن / المندوب</Label>
            <input
              value={courierName}
              onChange={(e) => setCourierName(e.target.value)}
              placeholder="اسم شركة الشحن"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">عمولة/تكلفة الشحن (إن وجدت)</Label>
            <input
              type="number"
              min={0}
              value={courierFee}
              onChange={(e) => setCourierFee(e.target.value)}
              placeholder={formatQty(shipping_fee)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-sm font-semibold text-muted-foreground tracking-wide">
          ملخص الطلب والحسبة المالية
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-xl border border-border bg-muted/40 p-4 space-y-1">
            <div className="flex items-center justify-between text-muted-foreground text-sm">
              <span>الإجمالي الفرعي للمنتجات</span>
              <span>{formatMoney(subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex items-center justify-between text-green-600 text-sm font-medium">
                <span>الخصم المطبق</span>
                <span>− {formatMoney(discountAmount)}</span>
              </div>
            )}
            <div className="flex items-center justify-between font-bold text-lg pt-2 border-t border-border">
              <span>الإجمالي بعد الخصم</span>
              <span>{formatMoney(total_price)}</span>
            </div>
          </div>
          <div
            className={
              shippingPenaltyApplied
                ? "rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-1"
                : "rounded-xl border border-border bg-muted/40 p-4 space-y-1"
            }
          >
            <p className="text-xs text-muted-foreground">رسوم الشحن</p>
            <p className="text-xl font-bold">{formatMoney(shipping_fee)}</p>
            {/* A doubled fee must never be silent — the operator will be asked
                why the number changed, and "the system did it" is not an
                answer they can give the customer. */}
            {shippingPenaltyApplied && (
              <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                شحن مضاعف لتعويض رحلة شحن ضائعة — متبقي{" "}
                {matchedCustomer?.returned_orders_count} رحلة على العميل
                (الأساسي {formatMoney(baseShippingFee)})
              </p>
            )}
          </div>
          <div className="rounded-xl border border-border bg-muted/40 p-4 space-y-1">
            <p className="text-xs text-muted-foreground">
              {paymentMethod === "full_prepaid"
                ? "مدفوع مسبقاً (فودافون كاش / فيزا)"
                : "العربون المدفوع"}
            </p>
            {paymentMethod === "full_prepaid" ? (
              <p className="text-xl font-bold text-green-600 dark:text-green-400">
                {formatMoney(depositVal)}
              </p>
            ) : (
              <p
                className={cn(
                  "text-xl font-bold",
                  depositVal > 0 ? "text-green-600 dark:text-green-400" : "text-muted-foreground",
                )}
              >
                {depositVal > 0 ? formatMoney(depositVal) : "لم يُدفع عربون"}
              </p>
            )}
          </div>
          <div className="rounded-xl border-2 border-amber-400/40 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-1">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
              المتبقي للمندوب
            </p>
            <p
              className={cn(
                "text-2xl font-bold",
                remaining_balance > 0
                  ? "text-amber-600 dark:text-amber-300"
                  : "text-green-600 dark:text-green-400",
              )}
            >
              {formatMoney(remaining_balance)}
            </p>
            <p className="text-[10px] text-muted-foreground">
              ({formatQty(total_price)} + {formatQty(shipping_fee)}) − {formatQty(depositVal)}
            </p>
          </div>
        </div>

        {paymentMethod === "full_prepaid" && (
          <div className="rounded-xl bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 p-4 flex items-center gap-3">
            <CheckCircle2 className="size-5 text-green-600 shrink-0" />
            <p className="text-sm font-medium text-green-900 dark:text-green-300">
              مدفوع بالكامل مسبقاً — المتبقي للمندوب: 0 ج.م
            </p>
          </div>
        )}
      </div>

      {result && (
        <div
          className={cn(
            "rounded-xl p-4 flex items-start gap-3 border",
            result.success
              ? "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",
          )}
        >
          {result.success ? (
            <CheckCircle2 className="size-5 text-green-600 mt-0.5 shrink-0" />
          ) : (
            <AlertCircle className="size-5 text-red-600 mt-0.5 shrink-0" />
          )}
          <p
            className={cn(
              "text-sm font-medium",
              result.success
                ? "text-green-900 dark:text-green-300"
                : "text-red-900 dark:text-red-300",
            )}
          >
            {result.message}
          </p>
        </div>
      )}

      <Button
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        className="w-full h-12 text-base font-semibold"
        size="lg"
      >
        <CheckCircle2 className="size-5 ml-2" />
        تأكيد وحفظ الطلب
      </Button>
      
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
                    // Out of stock stays pickable — addProductRow asks first.
                    !isAvailable && "border-amber-400"
                  )}
                  onClick={() => {
                    if (!pendingVariantSelection) return;
                    const product = pendingVariantSelection.product;
                    setPendingVariantSelection(null);
                    setTimeout(() => {
                      addProductRow(product, v.name);
                    }, 0);
                  }}
                >
                  <span className="font-bold">{v.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {isAvailable ? `متاح: ${v.stock}` : "نفد من المخزون"}
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

export function EcommerceOrders() {
  return (
    <ErrorBoundary>
      <EcommerceOrdersInner />
    </ErrorBoundary>
  );
}
