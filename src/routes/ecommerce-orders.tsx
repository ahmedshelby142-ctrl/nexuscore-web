import { useRunOnce } from "@/hooks/useSubmitGate";
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
import { useSearchParams } from "react-router-dom";
import { appendEvent } from "@/lib/ledger";
import { buildOrderPlacedLines, buildOrderCancelledLines } from "@/lib/ledger/orders";
import {
  exchangeBlock,
  returnedValue,
  priceDifference,
  remainingQuantities,
  EXCHANGE_BLOCK_TEXT,
} from "@/lib/exchange";
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
import { applyDiscountCode } from "@/lib/discounts";
import { claimDiscountUse, releaseDiscountUse } from "@/services/discountUsage";
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
    // `!== 0` used to be the whole test, which let a NEGATIVE quantity through.
    // The exchange flow relied on that to carry the returned item in the same
    // cart as the replacement, and `buildOrderPlacedLines` then refused the
    // event — so every attempted exchange died at the first write, with
    // "quantity must be positive" shown to the operator as if they had typed
    // something wrong. An order reserves goods; there is no such thing as
    // reserving minus one.
    row.quantity > 0 &&
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
  /**
   * The lines of the ORIGINAL order the customer is sending back.
   *
   * Kept apart from `rows` on purpose. They used to be pushed INTO the cart at
   * `quantity: -1`, which is what broke the whole feature: `buildOrderPlacedLines`
   * refuses a non-positive quantity, so the very first ledger write threw and
   * no exchange could ever be saved. It is also wrong on its own terms — a
   * replacement order is a normal order for the NEW goods; the old ones come
   * back through the original order's own return lifecycle, at the moment the
   * courier actually hands them over, not when the swap is typed.
   */
  const [returningLines, setReturningLines] = useDraftState<
    { product_id: string; product_name: string; quantity: number; unit_price: number }[]
  >("eco-order:returningLines", []);
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

  const returnRecords = useBusinessStore((s) => s.returnRecords);

  /**
   * Arrived from an order's own استبدال button, which carries the order it is
   * for. The screen used to be reachable only by a context-free link that
   * opened an empty form, leaving the operator to re-find the order by hand —
   * and the exchange toggle off, so most never did.
   *
   * Runs once per id: `setSearchParams` clears the parameter afterwards so a
   * reload does not re-stamp the form over what the operator has since typed.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const exchangeOf = searchParams.get("exchangeOf");
  useEffect(() => {
    if (!exchangeOf) return;
    const origin = allOrders.find((o) => o.id === exchangeOf);
    if (!origin) {
      // The orders store hydrates from Supabase AFTER first paint, so on a cold
      // load — the link opened in a new tab, pasted, or reloaded — this effect
      // runs once against an empty list. Clearing the parameter there threw the
      // context away before it could ever be used, and the operator landed on a
      // blank form with the exchange toggle off: exactly the context-free
      // screen this link exists to replace. It only appeared to work when
      // navigating from an already-hydrated Order Management.
      //
      // So: keep the parameter and let the effect run again when the orders
      // arrive. Only give up once there ARE orders and none of them match,
      // which means the id is stale or wrong and waiting would hang forever.
      if (allOrders.length > 0) setSearchParams({}, { replace: true });
      return;
    }
    setIsExchange(true);
    setOriginalOrderId(origin.id);
    setCustomerId(origin.customerId || "");
    setCustomerName(origin.customerName || "");
    setCustomerPhone(origin.customerPhone || "");
    if (origin.governorate) setGovernorate(origin.governorate);
    if (origin.city) setCity(origin.city);
    setReturningLines([]);
    setSearchParams({}, { replace: true });
  }, [exchangeOf, allOrders, setSearchParams, setIsExchange, setOriginalOrderId,
      setCustomerId, setCustomerName, setCustomerPhone, setGovernorate, setCity,
      setReturningLines]);

  const deliveredOrdersForCustomer = useMemo(() => {
    if (!customerId) return [];
    // Only the ones that are actually still exchangeable. The list used to
    // offer every delivered order, including ones already swapped or already
    // fully returned, and the screen then let the operator do it again.
    return allOrders.filter(
      (o) =>
        o.customerId === customerId &&
        exchangeBlock(o, returnRecords, allOrders) === null,
    );
  }, [allOrders, customerId, returnRecords]);

  const selectedOriginalOrder = useMemo(() => {
    return allOrders.find(o => o.id === originalOrderId) || null;
  }, [allOrders, originalOrderId]);

  /**
   * The rule, re-asked here rather than trusted from the row that linked in.
   * That row may have been rendered minutes ago, and the same order can be
   * returned or swapped from three other screens in the meantime.
   */
  const originalBlock = useMemo(
    () =>
      selectedOriginalOrder
        ? exchangeBlock(selectedOriginalOrder, returnRecords, allOrders)
        : null,
    [selectedOriginalOrder, returnRecords, allOrders],
  );

  /** How many of each line are still with the customer — the return ceiling. */
  const remainingOnOriginal = useMemo(
    () =>
      selectedOriginalOrder
        ? remainingQuantities(selectedOriginalOrder, returnRecords)
        : new Map<string, number>(),
    [selectedOriginalOrder, returnRecords],
  );

  /** What the returned lines are worth, at what the customer actually PAID. */
  const returningValue = useMemo(
    () =>
      selectedOriginalOrder
        ? returnedValue(
            selectedOriginalOrder,
            returningLines.map((l) => ({
              productId: l.product_id,
              quantity: l.quantity,
              unitPrice: l.unit_price,
            })),
          )
        : 0,
    [selectedOriginalOrder, returningLines],
  );

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

  // One in-flight submit. Three clicks used to file three orders, three
  // customers and three stock deductions — see `useRunOnce`.
  const runOnce = useRunOnce();
  const handleSubmit = useCallback(async () => runOnce(async () => {
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

    // An exchange has to say WHAT it replaces and WHAT is coming back, and the
    // original has to still be eligible right now — the form may have been open
    // for a while, and the same order can be returned from three other screens.
    // Checked here and not only in the UI: this is the last point before a
    // ledger write, and the ledger is append-only.
    if (isExchange) {
      const origin = allOrders.find((o) => o.id === originalOrderId);
      if (!origin) {
        setResult({ success: false, message: "اختر الطلب الأصلي المراد استبداله" });
        return;
      }
      const block = exchangeBlock(origin, returnRecords, allOrders);
      if (block) {
        setResult({ success: false, message: EXCHANGE_BLOCK_TEXT[block] });
        return;
      }
      if (returningLines.length === 0) {
        setResult({
          success: false,
          message: "حدد المنتج اللي راجع من الطلب الأصلي",
        });
        return;
      }
      // Quantities re-checked against what is STILL with the customer. The
      // form is a draft that survives navigation and reloads, so a line marked
      // "return 3" can outlive a return of 2 recorded on another screen. The
      // box clamps as you type; this is the clamp that matters, because it is
      // the last one before the write.
      const left = remainingQuantities(origin, returnRecords);
      for (const line of returningLines) {
        const available = left.get(line.product_id) ?? 0;
        if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
          setResult({
            success: false,
            message: `كمية المرتجع من "${line.product_name}" غير صالحة`,
          });
          return;
        }
        if (line.quantity > available) {
          setResult({
            success: false,
            message: `"${line.product_name}" مع العميل منه ${available} بس — مش ${line.quantity}`,
          });
          return;
        }
      }
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

    // ── The discount use is CLAIMED before anything is reserved ──────────────
    //
    // Atomically, inside a Postgres row lock. The browser cannot check a limit
    // and consume it without a gap, so a sold-out code must not be spendable by
    // two order forms a millisecond apart. Every failure path below gives the
    // claim back, so a refused order never leaves a use burnt — and on a
    // one-use code, never burns the only one.
    let claimedDiscount: { id: string; amount: number } | null = null;
    if (appliedDiscount?.id && discountAmount > 0) {
      try {
        await claimDiscountUse(appliedDiscount.id, discountAmount);
        claimedDiscount = { id: appliedDiscount.id, amount: discountAmount };
      } catch (e) {
        setResult({ success: false, message: e instanceof Error ? e.message : String(e) });
        return;
      }
    }

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
      // The reservation failed, so the use claimed for it goes back.
      if (claimedDiscount) {
        await releaseDiscountUse(claimedDiscount.id, claimedDiscount.amount);
      }
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

    // `addOrder` can REJECT, not just return `{success:false}` — a dropped
    // connection or a refused write throws out of the Supabase client. Nothing
    // caught that, so `runOnce` swallowed it into an unhandled rejection and
    // the operator was shown NOTHING AT ALL: no success, no error, a form that
    // simply sat there while stock had already moved.
    let orderResult: Awaited<ReturnType<typeof addOrder>>;
    try {
      orderResult = await addOrder({
      customerId: customerId || undefined,
      customerName: customer_name.trim(),
      customerPhone: customer_phone.trim(),
      address: [governorate, city, detailedAddress].filter(Boolean).join(" - "),
      governorate,
      // `orders.city` is a real column (migration 012) that NOTHING wrote: the
      // city was only ever put inside `metadata`, which is not a column, so
      // `toRemoteRow` dropped it. The delivery address survived — it is
      // composed into `address` above — but the dedicated column stayed null
      // on every order ever placed, so anything filtering by city found none.
      city,
      metadata: {
        governorate,
        city,
        address: detailedAddress,
      },
      // TOP-LEVEL, not inside `metadata`. `orders.original_order_id` is a real
      // column and IS whitelisted in `cloudSchema`, but the link was only ever
      // written into `metadata`, which is not a column — so `toRemoteRow`
      // dropped it exactly the way it used to drop `city`. The database proves
      // it: of the exchange orders that exist, not one carries a link back.
      //
      // The link is not cosmetic. It is what `movementFor` reads to know the
      // original's return is a SWAP and not a refund, which decides whether the
      // courier's trip is the shop's cost or the customer's.
      ...(isExchange && originalOrderId ? { original_order_id: originalOrderId } : {}),
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
      // A refused write and a thrown one leave the SAME wreckage, so they get
      // the same handler rather than one `return` that skips the cleanup.
      if (!orderResult.success) throw new Error(orderResult.reason);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      /**
       * Put back everything the `order_placed` above took out.
       *
       * The ledger is append-only, so this is a COMPENSATING event, not a
       * rollback — the same shape a cancellation writes, because that is what
       * this is: an order that reserved goods and then never came to exist.
       *
       * Without it, a refused order document left the `order_placed` event and
       * its reservation standing with nothing pointing at them. Proven on
       * QA-STORE by blocking the POST to `/rest/v1/orders`: a unit of
       * QA-EXCH-DEARER left the shelf, in the ledger AND in the mirror, for an
       * order that does not exist and never will.
       *
       * Written inline rather than as a nested `async` helper on purpose: the
       * gate check in `check_online_only` reads handler declarations, and a
       * nested one looks exactly like an ungated handler to it. This code is
       * already inside `runOnce`, and keeping it here keeps that obvious.
       */
      try {
        await appendEvent({
          kind: "order_cancelled",
          actor: "أونلاين",
          refType: "ecommerce_order",
          payload: {
            customerName: customer_name.trim(),
            reason: "order document refused — reservation released",
          },
          lines: buildOrderCancelledLines({
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
        useBusinessStore.getState().applyStockMoves(
          stockItems.map((line: any) => ({
            productId: line.productId,
            delta: line.quantity,
            variantName: line.variantName,
          })),
        );
        // The order does not exist, so neither does the use it claimed.
        if (claimedDiscount) {
          await releaseDiscountUse(claimedDiscount.id, claimedDiscount.amount);
        }
        refreshStock();
        setResult({
          success: false,
          message: `لم يُسجَّل الطلب، والمخزون رجع زي ما كان. ${why}`,
        });
      } catch (releaseError) {
        // The compensation itself failed. Nothing can be rolled back, so the
        // only correct move is to name exactly what is outstanding rather than
        // let it read as an ordinary error.
        if (claimedDiscount) {
          await releaseDiscountUse(claimedDiscount.id, claimedDiscount.amount);
        }
        setResult({
          success: false,
          message:
            `لم يُسجَّل الطلب، لكن المخزون المحجوز لسه متسجّل كخارج. ` +
            `بلّغ المسؤول وراجع حركة المخزون. ${why} / ${
              releaseError instanceof Error ? releaseError.message : String(releaseError)
            }`,
        });
      }
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
    setReturningLines([]);
    setRows([]);
    setDepositAmount("");
    setDepositWallet("instaPay");
    setPaymentMethod("partial_cod");
    setCourierFee("");
    setDiscountCodeInput("");
    setAppliedDiscount(null);
    setIsExchange(false);
    setTimeout(() => setResult(null), 4000);
  }), [
    canSubmit,
    rows,
    customer_name,
    customer_phone,
    customerId,
    governorate,
    // `city`, `detailedAddress`, `isExchange`, `originalOrderId`,
    // `shippingPenaltyApplied` and `updateCustomer` are READ in the body and
    // were missing here, so the callback kept whatever they held the last time
    // one of the other dependencies changed. Typing the city and the address
    // changes no dependency, so filling the الحافظة → المدينة → العنوان fields
    // in that order and pressing حفظ الطلب filed the order with the city and
    // address as they were BEFORE they were typed — usually empty.
    city,
    detailedAddress,
    isExchange,
    originalOrderId,
    // Read in the body by the eligibility re-check. Stale values here would
    // let a swap through against an order that has since been returned.
    returningLines,
    allOrders,
    returnRecords,
    setReturningLines,
    shippingPenaltyApplied,
    updateCustomer,
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
            {/* A shop that has entered no tariff cannot ship anywhere, so this
                dropdown is empty and the submit button is disabled. Saying
                nothing left the user staring at a dead form with no idea why —
                the single worst dead end in the product. */}
            {shippingRates.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-500 leading-relaxed">
                لسه مفيش أسعار شحن متسجّلة، فمفيش محافظات تختار منها ومش هتقدر
                تحفظ الأوردر. ضيفها من الإعدادات ← الشحن الأول.
              </p>
            )}
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

          {/* The rule that hid the button on the order row, re-asked. */}
          {originalBlock && (
            <p className="text-sm rounded-lg p-3 bg-red-50 border border-red-200 text-red-900">
              {EXCHANGE_BLOCK_TEXT[originalBlock]}
            </p>
          )}

          {selectedOriginalOrder && !originalBlock && (
            <div className="mt-4 space-y-3">
              <h4 className="text-sm font-medium">المنتجات في الطلب الأصلي:</h4>
              <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                {selectedOriginalOrder.items.map((item: any, idx: number) => {
                  // Marked for return — held in its OWN list, never in the cart.
                  // A negative cart row is what `buildOrderPlacedLines` threw on.
                  const marked = returningLines.find((l) => l.product_id === item.productId);
                  // Capped at what is still with the customer, not at what was
                  // ordered: returning the same unit twice added it to stock
                  // twice and reversed the revenue twice.
                  const left = remainingOnOriginal.get(item.productId) ?? 0;

                  /**
                   * Per-line quantity, clamped to what is still with the
                   * customer.
                   *
                   * The counter screen (`routes/returns.tsx`) has always had a
                   * quantity box per line, so partial quantities are part of
                   * this ERP's return model, not a new idea. This screen used
                   * to take the whole remaining quantity whenever a line was
                   * marked, which meant a customer swapping ONE of three
                   * identical units had all three reversed — stock, revenue and
                   * LTV — and was refunded for two he still had.
                   */
                  const setQty = (qty: number) => {
                    const clamped = Math.min(Math.max(1, Math.floor(qty) || 1), left);
                    setReturningLines((prev) =>
                      prev.map((l) =>
                        l.product_id === item.productId ? { ...l, quantity: clamped } : l,
                      ),
                    );
                  };

                  return (
                    <div key={idx} className="p-3 flex justify-between items-center gap-3 bg-background text-sm">
                      <div className="space-y-1">
                        <p className="font-medium">{item.productName}</p>
                        <p className="text-xs text-muted-foreground">
                          مع العميل: {left} | السعر: {item.unitPrice} ج.م
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Only once the line is actually coming back. A
                            quantity box on a line nobody is returning is just
                            something else to get wrong. */}
                        {marked && left > 1 && (
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="size-8 p-0"
                              aria-label={`تقليل كمية المرتجع من ${item.productName}`}
                              onClick={() => setQty(marked.quantity - 1)}
                            >
                              −
                            </Button>
                            <input
                              type="number"
                              min={1}
                              max={left}
                              value={marked.quantity}
                              aria-label={`كمية المرتجع من ${item.productName}`}
                              onChange={(e) => setQty(parseInt(e.target.value, 10))}
                              className="h-8 w-14 rounded-md border border-input bg-background px-2 text-center text-sm"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="size-8 p-0"
                              aria-label={`زيادة كمية المرتجع من ${item.productName}`}
                              onClick={() => setQty(marked.quantity + 1)}
                            >
                              +
                            </Button>
                          </div>
                        )}
                        <Button
                          variant={marked ? "default" : "secondary"}
                          size="sm"
                          disabled={left <= 0}
                          onClick={() => {
                            setReturningLines((prev) =>
                              prev.some((l) => l.product_id === item.productId)
                                ? prev.filter((l) => l.product_id !== item.productId)
                                : [
                                    ...prev,
                                    {
                                      product_id: item.productId,
                                      product_name: item.productName,
                                      // Starts at one. The operator raises it;
                                      // taking the whole line by default is how
                                      // a single-unit swap reversed three.
                                      quantity: 1,
                                      unit_price: item.unitPrice,
                                    },
                                  ],
                            );
                          }}
                        >
                          <CornerDownLeft className="size-3.5 mr-1.5" />
                          {left <= 0 ? "اترجع بالفعل" : marked ? "هيترجع ✓" : "استرجاع هذا المنتج"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* The difference, SHOWN and never booked. The two legs each go
                  through at full value — the replacement order when it is
                  delivered, the original when its return is confirmed — and
                  what the books end up with is this number, with this sign. */}
              {returningLines.length > 0 && (
                <div className="rounded-lg border border-border bg-background p-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">قيمة المرتجع (بعد الخصم)</span>
                    <span>{formatMoney(returningValue)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">قيمة البديل</span>
                    <span>{formatMoney(subtotal)}</span>
                  </div>
                  <div className="flex justify-between font-semibold border-t border-border pt-1">
                    <span>
                      {priceDifference(subtotal, returningValue) >= 0
                        ? "العميل يدفع فرق"
                        : "للعميل مسترد"}
                    </span>
                    <span>
                      {formatMoney(Math.abs(priceDifference(subtotal, returningValue)))}
                    </span>
                  </div>
                </div>
              )}
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
            // The visible text next to it is a <Label> with no `htmlFor`, so it
            // named nothing — this announced as an anonymous switch. It decides
            // whether the customer has ALREADY PAID or the courier must collect
            // 250 EGP on delivery, which is the difference between a settled
            // order and a debt. The exchange toggle above is fine: it carries
            // an id its Label points at.
            aria-label="طريقة الدفع: مدفوع مسبقاً أو تحصيل عند الاستلام"
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
              // ONE authority, shared with نقطة البيع. This was
              // `x.code === input && x.active`: no expiry, no usage limit, and
              // a case-sensitive compare against an upper-cased stored code.
              const applied = applyDiscountCode(promoDiscounts, discountCodeInput, subtotal);
              if (applied.ok) {
                setAppliedDiscount(applied.code as PromoDiscount);
                setResult({ success: true, message: "تم تطبيق الخصم بنجاح!" });
              } else {
                setAppliedDiscount(null);
                setResult({ success: false, message: applied.message });
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
