import { useMemo, useState } from "react";
import {
  ShoppingBag,
  Truck,
  CheckCircle2,
  RotateCcw,
  Ban,
  Clock,
  Package,
  User,
  MapPin,
  Phone,
  Wallet,
  FileText,
  Printer,
  Inbox,
  Search,
  Loader2,
  X,
  Plus,
  RefreshCw,
  PackageCheck,
  Calendar as CalendarIcon,
  MessageCircle,
} from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useOrderStore } from "@/store/useOrderStore";
import { EmptyState } from "@/components/ui/empty-state";
import { useFinancialStore } from "@/store/useFinancialStore";
import { customerIdOf } from "@/lib/customers";
import { useCustomerStore } from "@/store/useCustomerStore";
import { useShippingRatesStore } from "@/store/useShippingRatesStore";
import { rateFor, clearsShippingDebt } from "@/lib/shippingRates";
import { storeIdentity } from "@/lib/pdfGenerator";
import { appendEvent } from "@/lib/ledger";
import {
  buildOrderDeliveredLines,
  buildReturnPendingLines,
  buildCourierSettlementLines,
  buildOrderCancelledLines,
  buildReturnConfirmedLines,
  buildOrderRTOLines,
  buildOrderPaymentLines,
  buildOrderEditLines,
  orderItemsTotal,
} from "@/lib/ledger/orders";
import { useStock } from "@/lib/ledger/useStock";
import { buildWholesaleInvoiceLines } from "@/lib/ledger/wholesale";
import { productPrice, productWholesalePrice } from "@/lib/product";
import { formatMoney, discountAmountFor, subtract, round } from "@/lib/math";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useBalances } from "@/lib/ledger/useBalances";
import {
  buildWholesaleReturnLines,
  reconcileWholesaleReturn,
} from "@/lib/ledger/wholesale";
import { WholesaleReturnPanel } from "@/components/wholesale/WholesaleReturnPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { OrderSearch } from "@/components/ecommerce/OrderSearch";
import { ProductSearch } from "@/components/products/ProductSearch";
import { ordersInPeriod, searchOrders } from "@/lib/orderSearch";
import { actionsFor, canDo, claimOrder, releaseOrder } from "@/lib/orderLifecycle";
import { courierIdOf } from "@/lib/courierBatch";
import type { EcommerceOrder, EcommerceOrderItem, EcommerceOrderStatus, WalletType } from "@/types";
import { WALLET_LABELS } from "@/types";
import { generateOrdersPdf } from "@/lib/pdfGenerator";

const STATUS_META: Record<
  EcommerceOrderStatus,
  {
    label: string;
    icon: React.ElementType;
    variant: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  pending: { label: "قيد الانتظار", icon: Clock, variant: "secondary" },
  shipped: { label: "مع المندوب", icon: Truck, variant: "default" },
  delivered: { label: "تم التسليم", icon: CheckCircle2, variant: "default" },
  returned: { label: "مرتجع مع المندوب", icon: RotateCcw, variant: "destructive" },
  cancelled: { label: "ملغي", icon: Ban, variant: "outline" },
};

/**
 * Shown when a second click lands while the first is still writing. It is not
 * an error the operator caused — it says "already happening", so nobody
 * concludes the click did nothing and keeps pressing.
 */
const BUSY_MESSAGE = "العملية دي بتتسجّل دلوقتي — استنى لحظة، متضغطش تاني.";

function statusBadge(status: EcommerceOrderStatus) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="gap-1">
      <Icon className="size-3" />
      {meta.label}
    </Badge>
  );
}

export function OrdersPage() {
  const { orders, updateOrderStatus, updateOrder } = useOrderStore();
  const products = useBusinessStore((s) => s.products);
  const wholesaleClients = useBusinessStore((s) => s.wholesaleClients);
  const addWholesaleInvoice = useBusinessStore((s) => s.addWholesaleInvoice);
  const applyStockMoves = useBusinessStore((s) => s.applyStockMoves);
  const promoDiscounts = useBusinessStore((s) => s.promoDiscounts);
  // A trader's outstanding balance, for reconciling a wholesale return.
  const { amountOf: debtOf, refresh: refreshDebt } = useBalances("receivable_client");
  // Re-read after a payment so الخزنة reflects the new cash immediately.
  const { refresh: refreshWallets } = useBalances("wallet");
  const { qtyOf, costOf, refresh: refreshStock } = useStock();
  // Every shipping fee comes from the Settings matrix — nothing hardcodes one.
  const shippingRates = useShippingRatesStore((s) => s.rows);
  const { reconcileCourierOrder } = useFinancialStore();
  const [filter, setFilter] = useState<EcommerceOrderStatus>("pending");
  const [reconcileDialog, setReconcileDialog] = useState<{ orderId: string; open: boolean }>({
    orderId: "",
    open: false,
  });
  const [targetWallet, setTargetWallet] = useState<WalletType>("inStoreSafe");
  // "deliver" books the sale and leaves the COD with the courier.
  // "settle" also takes the courier's cash in, in the same click.
  const [deliverMode, setDeliverMode] = useState<"deliver" | "settle">("deliver");

  const [saleMode, setSaleMode] = useState<"retail" | "wholesale">("retail");
  const [wholesaleClient, setWholesaleClient] = useState<string>("");
  const [wholesalePaidAmount, setWholesalePaidAmount] = useState<string>("");

  const [isWorking, setIsWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // §3.9 return confirmation — the operator types the customer's name.
  /** تسجيل دفعة إضافية — the order, the amount and which till it lands in. */
  const [payOrderId, setPayOrderId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payWallet, setPayWallet] = useState<WalletType>("vodafoneCash");

  /** المبلغ المدفوع during a trader's return — see WholesaleReturnPanel. */
  const [returnSettleInput, setReturnSettleInput] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<{ orderId: string; open: boolean }>({
    orderId: "",
    open: false,
  });
  const [confirmName, setConfirmName] = useState("");
  // Editing a pending order. `draft` holds the new contents until saved; the
  // order document and the ledger are only touched on confirm.
  const [editOrderId, setEditOrderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EcommerceOrderItem[]>([]);
  const [pendingVariantSelection, setPendingVariantSelection] = useState<{ product: any; qty: number } | null>(null);

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
          productName: product.name,
          quantity: qty,
          unitPrice: product.price,
          unitCost: product.cost ?? 0,
          variantName,
        },
      ];
    });
  };

  const [query, setQuery] = useState("");
  // Native date inputs (§3.8). Empty = no bound, so one end can be set alone.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // Status tab first, then the typed query. Cancel, edit and return-confirm all
  // live on these rows, so search is how they are reached once there are more
  // orders than fit on a screen.
  const ordersInPeriodList = useMemo(
    () => ordersInPeriod(orders, fromDate, toDate),
    [orders, fromDate, toDate],
  );
  const ordersInTab = useMemo(
    () => ordersInPeriodList.filter((order) => order.status === filter),
    [ordersInPeriodList, filter],
  );
  const filteredOrders = useMemo(() => searchOrders(ordersInTab, query), [ordersInTab, query]);

  /**
   * The counters are the SAME list the tabs draw from, counted by status —
   * `ordersInPeriodList`, not `orders`. Counted off the raw list they would
   * keep reporting the whole history while the table showed one week, which is
   * the "card says one thing, table says another" المخازن closed by making the
   * cards and the rows share a filter. Every status the tabs offer gets a
   * counter, including ملغي, so no tab can be entered blind.
   */
  const totals = useMemo(() => {
    const by = (status: EcommerceOrderStatus) =>
      ordersInPeriodList.filter((order) => order.status === status).length;
    return {
      pending: by("pending"),
      shipped: by("shipped"),
      delivered: by("delivered"),
      returned: by("returned"),
      cancelled: by("cancelled"),
    };
  }, [ordersInPeriodList]);

  /**
   * The order as the STORE holds it THIS INSTANT — not as this render saw it.
   *
   * Every handler below re-checks the status before it writes, and that check
   * is worthless against a value captured when the row was drawn: the status
   * moves at the END of an action, so a second click that arrives mid-flight
   * reads the old one and passes. `getState()` is the same escape hatch this
   * file already uses for customers, for the same reason.
   */
  const currentOrder = (orderId: string) =>
    useOrderStore.getState().orders.find((o) => o.id === orderId) ?? null;

  const openDeliver = (orderId: string, mode: "deliver" | "settle") => {
    setDeliverMode(mode);
    setSaleMode("retail");
    setWholesaleClient("");
    setWholesalePaidAmount("");
    setActionError(null);
    setReconcileDialog({ orderId, open: true });
  };

  /**
   * An order may only be edited while it is still PENDING.
   *
   * Once it is with the courier the goods have physically left the shop, so
   * "changing what is in it" is no longer an edit — it is a return, which
   * reverses money as well as stock. This single predicate gates the button,
   * the dialog and the save, so there is one place to check rather than three
   * that could drift apart.
   */
  const canEdit = (order: EcommerceOrder) => canDo(order.status, "edit");

  const openEdit = (order: EcommerceOrder) => {
    if (!canEdit(order)) return;
    setActionError(null);
    setDraft((order.stockItems ?? []).map((line) => ({ ...line })));
    setEditOrderId(order.id);
  };

  const editingOrder = orders.find((o) => o.id === editOrderId) ?? null;
  /** The order the deliver dialog is about, for display only. */
  const deliverOrder = orders.find((o) => o.id === reconcileDialog.orderId) ?? null;

  /**
   * The order the return dialog is about, and its trader if it had one.
   *
   * An online order delivered in وضع الجملة carries `wholesaleClientId`. That
   * is the only signal that its return settles against a debt rather than
   * refunding cash — without it a trader would be handed money they never paid.
   */
  const returningOrder = orders.find((o) => o.id === confirmDialog.orderId) ?? null;
  const returnClientId: string | undefined = (returningOrder as any)?.wholesaleClientId || undefined;
  const returnClientDebt = returnClientId ? debtOf(returnClientId) : 0;
  const returnSettle = reconcileWholesaleReturn(
    returningOrder?.totalAmount ?? 0,
    returnClientDebt,
    returnSettleInput,
  );

  const draftGoods = orderItemsTotal(
    draft.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      unitCost: l.unitCost ?? 0,
    })),
  );

  /**
   * The discount the order was placed with, carried through the edit.
   *
   * Editing used to write back the raw goods total, which silently threw the
   * discount away: the customer had agreed a price, and changing one line
   * quietly put them back on list price — inflating both the COD the courier
   * collects and the revenue booked at delivery.
   *
   * A percentage re-applies to the NEW basket (that is what a % means). If the
   * code has since been deleted, the amount already agreed is honoured but
   * never allowed to exceed the smaller basket.
   */
  const draftDiscount = useMemo(() => {
    if (!editingOrder) return 0;
    const code = promoDiscounts.find((d: any) => d.id === editingOrder.discountCodeId);
    if (code) return discountAmountFor(draftGoods, code.type, code.value);
    return Math.min(editingOrder.discountAmount ?? 0, draftGoods);
  }, [editingOrder, draftGoods, promoDiscounts]);

  const draftTotal = subtract(draftGoods, draftDiscount);

  const saveEdit = async () => {
    // `editingOrder` is the render value the dialog draws from; the SAVE reads
    // the store, so it cannot act on a status this render has not seen yet.
    const order = currentOrder(editOrderId ?? "");
    if (!order) return;
    // Re-checked here and not only on the button: the order could have been
    // handed to the courier in another tab while this dialog sat open.
    if (!canEdit(order)) {
      setActionError("الطلب مع المندوب — مش ممكن يتعدّل. لو رجع، سجّله كمرتجع.");
      return;
    }
    if (draft.length === 0) {
      setActionError(
        "الطلب لازم يحتوي على منتج واحد على الأقل — لو عايز تلغيه، استخدم إلغاء الطلب.",
      );
      return;
    }

    const before = (order.stockItems ?? []).map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      unitCost: l.unitCost ?? 0,
      variantName: (l as any).variantName,
    }));
    const after = draft.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.unitPrice ?? 0,
      unitCost: l.unitCost ?? 0,
      variantName: (l as any).variantName,
    }));

    // Anything newly reserved has to actually be on the shelf. Checked against
    // the ledger, and against what THIS order already holds — raising a line
    // from 2 to 3 needs one more unit available, not three.
    for (const line of after) {
      const had = before.find((b) => b.productId === line.productId)?.quantity ?? 0;
      const extra = line.quantity - had;
      if (extra > 0 && extra > qtyOf(line.productId)) {
        setActionError(
          `مفيش كمية كافية من "${draft.find((d) => d.productId === line.productId)?.productName ?? line.productId}" — متاح ${qtyOf(line.productId)} بس`,
        );
        return;
      }
    }

    const lines = buildOrderEditLines({ before, after });

    // Claimed after the validations and before the first `await`, like every
    // other action here: one order, one write in flight.
    const claim = claimOrder(order.id, order.status, "edit");
    if (claim === "illegal") {
      setActionError("الطلب مع المندوب — مش ممكن يتعدّل. لو رجع، سجّله كمرتجع.");
      return;
    }
    if (claim === "busy") {
      setActionError(BUSY_MESSAGE);
      return;
    }

    setIsWorking(true);
    setActionError(null);
    try {
      if (lines.length > 0) {
        // ONE event holding both directions: stock back for what was removed,
        // stock out for what was added. The original order_placed event is
        // never touched — the ledger is append-only.
        await appendEvent({
          kind: "order_edited",
          actor: "أونلاين",
          refType: "ecommerce_order",
          refId: order.orderNumber,
          payload: {
            customerName: order.customerName,
            before: before.map((l) => ({ productId: l.productId, quantity: l.quantity })),
            after: after.map((l) => ({ productId: l.productId, quantity: l.quantity })),
          },
          lines,
        });
      }

      // The edit as one movement: what the old basket held comes back, what
      // the new basket holds goes out. Plain products move too — the pair of
      // loops this replaced were both gated on `variantName`.
      applyStockMoves([
        ...before.map((b: any) => ({
          productId: b.productId,
          delta: b.quantity,
          variantName: b.variantName,
        })),
        ...after.map((a: any) => ({
          productId: a.productId,
          delta: -a.quantity,
          variantName: a.variantName,
        })),
      ]);

      // The document follows the ledger, not the other way round. Deposit is
      // already paid, so the COD absorbs the change in total.
      updateOrder(order.id, {
        items: draft,
        stockItems: draft,
        discountAmount: draftDiscount || undefined,
        totalAmount: draftTotal,
        cogsAmount: after.reduce((sum, l) => sum + l.unitCost * l.quantity, 0),
        expectedCod: Math.max(0, draftTotal + order.shippingFee - order.depositAmount),
      });

      refreshStock();
      setEditOrderId(null);
    } catch (e) {
      setActionError(
        `التعديل متسجّلش ومفيش حاجة اتغيّرت. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      releaseOrder(order.id);
      setIsWorking(false);
    }
  };

  /**
   * Cancelling a pending order. The stock reserved by `order_placed` has to
   * come back — without this event the units are gone from the shelf with
   * nothing pointing at them, and no screen would ever notice.
   */
  const cancelOrder = async (orderId: string) => {
    const order = currentOrder(orderId);
    if (!order) return;
    const claim = claimOrder(order.id, order.status, "cancel");
    if (claim === "illegal") {
      setActionError("الطلب خرج من المحل — مش ممكن يتلغي. لو رجع، سجّله كمرتجع.");
      return;
    }
    if (claim === "busy") {
      setActionError(BUSY_MESSAGE);
      return;
    }

    setIsWorking(true);
    setActionError(null);
    try {
      await appendEvent({
        kind: "order_cancelled",
        actor: "أونلاين",
        refType: "ecommerce_order",
        refId: order.orderNumber,
        payload: { customerName: order.customerName },
        lines: buildOrderCancelledLines({
          items: (order.stockItems ?? []).map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            // Back at the cost it left at, so the average is unchanged.
            unitCost: line.unitCost ?? 0,
          })),
          // Refund the advance deposit from the wallet it was paid into.
          // Orders placed before `depositWallet` was introduced carry no
          // wallet — those never booked the deposit at placement either, so
          // the builder skips the refund line. That is correct: you cannot
          // reverse something that was never recorded.
          depositAmount: order.depositAmount,
          wallet: order.depositWallet,
        }),
      });
      
      // Called off before it ever shipped — everything goes back on the shelf.
      applyStockMoves(
        (order.stockItems ?? []).map((line: any) => ({
          productId: line.productId,
          delta: line.quantity,
          variantName: line.variantName,
        })),
      );
      
      updateOrderStatus(orderId, "cancelled");
    } catch (e) {
      setActionError(
        `لم يُلغَ الطلب ولم يرجع المخزون. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      releaseOrder(order.id);
      setIsWorking(false);
    }
  };

  /**
   * §3.9: the operator confirms, BY CUSTOMER NAME, that the returned goods
   * physically arrived. Only now does stock go back and the money reverse.
   * The typed name must match the order's — this is the human check the whole
   * pending/confirmed split exists for.
   */
  const confirmReturn = async () => {
    const order = currentOrder(confirmDialog.orderId);
    if (!order) return;

    // This handler had NO status check of ANY kind — the same shape as the two
    // handlers the lifecycle table was written for. It moves stock and refunds
    // money, so a second run does both again.
    const claim = claimOrder(order.id, order.status, "confirmReturn");
    if (claim === "illegal") {
      setActionError("الطلب مش في حالة مرتجع — مفيش مرتجع يتأكد استلامه.");
      return;
    }
    if (claim === "busy") {
      setActionError(BUSY_MESSAGE);
      return;
    }
    if (order.returnConfirmedAt) {
      releaseOrder(order.id);
      setActionError("المرتجع ده اتأكد استلامه قبل كده — المخزون رجع والفلوس اترجّعت.");
      return;
    }

    if (confirmName.trim() !== order.customerName.trim()) {
      releaseOrder(order.id);
      setActionError("اسم العميل غير مطابق — اكتب الاسم زي ما هو في الطلب للتأكيد");
      return;
    }

    // The id the order has carried since §3.7. `customerIdOf` falls back to a
    // phone-key lookup for orders placed BEFORE it, so an old order's return
    // still takes the LTV back off the right person.
    const customerId = customerIdOf(order, useCustomerStore.getState().customers);

    setIsWorking(true);
    setActionError(null);
    try {
      const returnType = order.returnType ?? "refund";

      if (returnType === "rto") {
        await appendEvent({
          kind: "rto_confirmed",
          actor: "أونلاين",
          refType: "ecommerce_order",
          refId: order.orderNumber,
          payload: { customerName: order.customerName, confirmedBy: confirmName.trim() },
          lines: buildOrderRTOLines({
            items: (order.stockItems ?? []).map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              unitCost: line.unitCost ?? 0,
            })),
            returnFee: rateFor(shippingRates, order.governorate, "return"),
            courierId: courierIdOf(order),
            // Refused at the door: the trip was still made and paid for, so the
            // deposit stays and is booked as income rather than sitting in the
            // till unexplained.
            forfeitedDeposit: order.depositAmount ?? 0,
            customerId: customerId ?? undefined,
          }),
        });
      } else {
        // Fallback or explicit refund

        // If the order was never marked delivered, we can't refund a non-existent revenue.
        // We will automatically append the delivery event first to fix the ledger state!
        if (!order.revenueLogged) {
          await appendEvent({
            kind: "order_delivered",
            actor: "أونلاين",
            refType: "ecommerce_order",
            refId: order.orderNumber,
            payload: { customerName: order.customerName, channel: "ecommerce", note: "تسليم تلقائي قبل الاسترجاع" },
            lines: buildOrderDeliveredLines({
              items: (order.stockItems ?? []).map((line) => ({
                productId: line.productId,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                unitCost: line.unitCost ?? 0,
              })),
              goodsTotal: order.totalAmount,
              shippingFee: order.shippingFee,
              depositAmount: order.depositAmount,
              wallet: targetWallet,
              codAmount: order.expectedCod,
              courierId: courierIdOf(order),
              customerId: customerId ?? undefined,
              channel: "ecommerce",
            }),
          });
        }

        // A trader's return settles against their account, not the till. The
        // same تسوية POS does — see `buildWholesaleReturnLines`.
        if (returnClientId) {
          await appendEvent({
            kind: "return_confirmed",
            actor: "أونلاين",
            refType: "wholesale_client",
            refId: returnClientId,
            payload: {
              type: "wholesale_return",
              customerName: order.customerName,
              confirmedBy: confirmName.trim(),
              previousDebt: returnClientDebt,
              returnValue: order.totalAmount,
              paidNow: returnSettle.paidNow,
            },
            lines: buildWholesaleReturnLines({
              items: (order.stockItems ?? []).map((line) => ({
                productId: line.productId,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                unitCost: line.unitCost ?? 0,
              })),
              clientId: returnClientId,
              wallet: targetWallet,
              currentDebt: returnClientDebt,
              paidNow: returnSettle.paidNow,
            }),
          });

          applyStockMoves(
            (order.stockItems ?? []).map((line: any) => ({
              productId: line.productId,
              delta: line.quantity,
              variantName: line.variantName,
            })),
          );
          useOrderStore.getState().updateOrder(order.id, { returnConfirmedAt: new Date() });
          updateOrderStatus(order.id, "returned");
          refreshStock();
          refreshDebt();
          setReturnSettleInput("");
          setConfirmDialog({ open: false, orderId: "" });
          setConfirmName("");
          setIsWorking(false);
          releaseOrder(order.id);
          return;
        }

        await appendEvent({
          kind: "return_confirmed",
          actor: "أونلاين",
          refType: "ecommerce_order",
          refId: order.orderNumber,
          payload: { customerName: order.customerName, confirmedBy: confirmName.trim() },
          lines: buildReturnConfirmedLines({
            items: (order.stockItems ?? []).map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              unitCost: line.unitCost ?? 0,
            })),
            // Refund and revenue reversal are the GOODS. The delivery fee was
            // never our revenue, so there is nothing of it to reverse.
            refundAmount: order.totalAmount,
            // …but the deposit never goes back. Capped at the refund so a
            // deposit larger than the goods cannot turn a return into a charge.
            forfeitedDeposit: Math.min(order.depositAmount ?? 0, order.totalAmount ?? 0),
            wallet: targetWallet,
            revenueAmount: order.totalAmount,
            // The return fee comes from the Settings matrix for this governorate.
            returnFee: rateFor(shippingRates, order.governorate, "return"),
            movement: "return",
            courierId: courierIdOf(order),
            customerId: customerId ?? undefined,
            channel: "ecommerce",
          }),
        });
      }
      
      // This person has now sent an order back. Every future order of theirs is
      // quoted at double shipping — see `shippingFeeFor`.
      if (customerId) useCustomerStore.getState().recordReturn(customerId);

      // The courier brought it back. Same movement as a cancellation.
      applyStockMoves(
        (order.stockItems ?? []).map((line: any) => ({
          productId: line.productId,
          delta: line.quantity,
          variantName: line.variantName,
        })),
      );

      // The status union has no state after `returned`, so the confirmation is
      // stamped on the document instead. Without it the button comes back on
      // the next reload and the goods go back on the shelf a second time —
      // which is what the three `return_confirmed` events on ECO-1786978185609
      // are. `claimOrder` only covers the same session; this survives a restart.
      updateOrder(order.id, { returnConfirmedAt: new Date() });
      setConfirmDialog({ orderId: "", open: false });
      setConfirmName("");
    } catch (e) {
      setActionError(
        `لم يتأكد المرتجع ولم يتغيّر المخزون. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      releaseOrder(order.id);
      setIsWorking(false);
    }
  };

  /**
   * The courier says the order came back. This writes an event with ZERO
   * lines on purpose (§3.9): stock does NOT return on a courier's word. A
   * human confirms the goods physically arrived, and that confirmation is
   * what writes `return_confirmed`.
   */
  const markReturnPending = async (orderId: string, type: "rto" | "refund") => {
    const order = currentOrder(orderId);
    if (!order) return;
    // This had no status check at all: the button was rendered on every row, so
    // a PENDING order could be marked returned — recording that goods had come
    // back from a customer who had never received them. The button is gone from
    // those rows now, and this is the second line of defence.
    const claim = claimOrder(order.id, order.status, "return");
    if (claim === "illegal") {
      setActionError(
        order.status === "returned"
          ? "الطلب ده مسجّل كمرتجع بالفعل — مش هيتسجّل تاني."
          : "الطلب لسه في المحل — مفيش حاجة ترجع. لو عايز تلغيه، استخدم إلغاء الطلب.",
      );
      return;
    }
    if (claim === "busy") {
      setActionError(BUSY_MESSAGE);
      return;
    }

    setIsWorking(true);
    setActionError(null);
    try {
      await appendEvent({
        kind: "order_returned_pending",
        actor: "أونلاين",
        refType: "ecommerce_order",
        refId: order.orderNumber,
        payload: {
          customerName: order.customerName,
          courierName: order.courierName ?? null,
          note: "مرتجع مع المندوب — لم يتم استلامه بعد",
        },
        // Deliberately empty. See buildReturnPendingLines.
        lines: buildReturnPendingLines(),
      });
      updateOrder(orderId, { status: "returned", returnType: type });
    } catch (e) {
      setActionError(`لم تُسجَّل حالة المرتجع. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      releaseOrder(order.id);
      setIsWorking(false);
    }
  };

  // Phase F: PDF export for the current filter view.
  // Uses the central generateOrdersPdf in src/lib/pdfGenerator.ts so
  // the layout stays consistent with the financial + courier reports.
  const handleExportPdf = () => {
    // The export follows the date AND status/search filters.
    // A printout that disagrees with the screen it was printed from is worse than no printout.
    const exported = filteredOrders;
    if (exported.length === 0) {
      alert("لا توجد طلبات لتصديرها");
      return;
    }
    const orderRows = exported.map((o) => ({
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      governorate: o.governorate ?? "—",
      totalAmount: o.totalAmount,
      courierFee: o.courierFee,
      expectedCod: o.expectedCod,
      status: STATUS_META[o.status]?.label ?? o.status,
      createdAt: new Date(o.createdAt),
    }));
    const revenue = exported.reduce((s, o) => s + o.totalAmount, 0);
    const cod = exported.reduce((s, o) => s + o.expectedCod, 0);
    const fees = exported.reduce((s, o) => s + o.courierFee, 0);
    generateOrdersPdf({
      companyName:
        fromDate || toDate
          ? `${storeIdentity().name} — طلبات ${fromDate || "البداية"} إلى ${toDate || "النهاية"}`
          : `${storeIdentity().name} — كل الطلبات`,
      reportDate: new Date(),
      orders: orderRows,
      totals: { orders: exported.length, revenue, cod, fees },
    });
  };

  /** The order the payment dialog is about, and what is still owed on it. */
  const payingOrder = orders.find((o) => o.id === payOrderId) ?? null;
  const payOutstanding = Math.max(0, payingOrder?.expectedCod ?? 0);
  const payValue = Math.min(Math.max(0, Number(payAmount) || 0), payOutstanding);

  const openPayment = (order: any) => {
    setPayOrderId(order.id);
    setPayAmount("");
    // Most top-ups are a transfer, not cash in the shop — start there.
    setPayWallet("vodafoneCash");
    setActionError(null);
  };

  /**
   * Record money the customer sent before delivery.
   *
   * Raises the deposit and drops the COD by the SAME amount, so
   * `deposit + cod === net goods + shipping` still holds and the delivery event
   * balances later. The ledger gets a wallet line for the till actually chosen,
   * so the Treasury shows the cash under the account it really arrived in.
   */
  const confirmPayment = async () => {
    const order = currentOrder(payOrderId ?? "");
    if (!order) return;

    if (payValue <= 0) {
      setActionError("اكتب مبلغ أكبر من صفر.");
      return;
    }
    // Re-read rather than trust the render: the dialog can sit open while the
    // order is delivered in another tab.
    if (payValue > Math.max(0, order.expectedCod ?? 0)) {
      setActionError("المبلغ أكبر من المتبقي على الطلب.");
      return;
    }

    setIsWorking(true);
    setActionError(null);
    try {
      await appendEvent({
        // The existing kind for "a customer paid us". Deliberately NOT
        // `order_placed`: the dashboard counts those as عمليات, so a top-up
        // would invent an order that never happened.
        kind: "client_payment",
        actor: "أونلاين",
        refType: "ecommerce_order",
        refId: order.orderNumber,
        payload: {
          type: "order_additional_payment",
          customerName: order.customerName,
          wallet: payWallet,
          amount: payValue,
        },
        lines: buildOrderPaymentLines({ wallet: payWallet, amount: payValue }),
      });

      useOrderStore.getState().updateOrder(order.id, {
        depositAmount: round((order.depositAmount ?? 0) + payValue),
        expectedCod: round(Math.max(0, (order.expectedCod ?? 0) - payValue)),
        // Remember the till of the FIRST money in, so an order that was never
        // topped up reads exactly as it did before.
        depositWallet: order.depositWallet ?? payWallet,
      });

      refreshWallets();
      setPayOrderId(null);
    } catch (e) {
      setActionError(
        `لم تُسجَّل الدفعة ولم يتغيّر أي رصيد. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setIsWorking(false);
    }
  };

  const confirmDeliver = async () => {
    const order = currentOrder(reconcileDialog.orderId);
    if (!order) return;
    // Delivery is only legal once the goods are with the courier. Re-checked
    // here because this dialog can sit open while the order moves on elsewhere
    // — and CLAIMED here, because the status only becomes `delivered` after the
    // append below resolves. That window is what wrote `ECO-1786978185609`
    // three times.
    const claim = claimOrder(
      order.id,
      order.status,
      deliverMode === "settle" ? "settle" : "deliver",
    );
    if (claim === "illegal") {
      setActionError(
        order.status === "delivered"
          ? "الطلب ده اتسجّل تسليمه قبل كده — مش هيتسجّل تاني."
          : "الطلب لازم يكون مع المندوب الأول — سلّمه للمندوب قبل تسجيل التسليم.",
      );
      return;
    }
    if (claim === "busy") {
      setActionError(BUSY_MESSAGE);
      return;
    }

    // LTV attaches to the id the order has carried since it was placed (§3.7),
    // so a second order from the same phone accumulates on ONE record. The
    // phone-key fallback inside `customerIdOf` covers orders placed before
    // that, which hold only a name and a number. Still `null` for a genuine
    // guest order — no LTV line, rather than an invented id no screen resolves.
    const customerId = customerIdOf(order, useCustomerStore.getState().customers);

    setIsWorking(true);
    setActionError(null);

    try {
      if (saleMode === "retail") {
        // ONE event for the delivery. This is where the sale is booked: the
        // stock already left at order_placed, so no stock line here.
        await appendEvent({
          kind: "order_delivered",
          actor: "أونلاين",
          refType: "ecommerce_order",
          refId: order.orderNumber,
          payload: { customerName: order.customerName, channel: "ecommerce" },
          lines: buildOrderDeliveredLines({
            items: (order.stockItems ?? []).map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              // The cost snapshotted when the stock was reserved, not today's.
              unitCost: line.unitCost ?? 0,
            })),
            // Goods and shipping are kept apart on purpose: only the goods are
            // our revenue. The delivery fee the customer paid passes through to
            // the courier as `payable_courier`.
            goodsTotal: order.totalAmount,
            shippingFee: order.shippingFee,
            depositAmount: order.depositAmount,
            wallet: targetWallet,
            codAmount: order.expectedCod,
            courierId: courierIdOf(order),
            customerId: customerId ?? undefined,
            channel: "ecommerce",
          }),
        });
      } else {
        if (!wholesaleClient) {
          setActionError("اختر عميل الجملة أولاً لتسجيل المديونية.");
          setIsWorking(false);
          return;
        }

        const paidAmount = parseFloat(wholesalePaidAmount) || 0;
        let wholesaleGoodsTotal = 0;
        const wholesaleItems = (order.stockItems ?? []).map((line) => {
          const p = products.find((prod) => prod.id === line.productId);
          const wPrice = p ? productWholesalePrice(p) : line.unitPrice;
          wholesaleGoodsTotal += wPrice * line.quantity;
          return {
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: wPrice,
            unitCost: line.unitCost ?? 0,
          };
        });


        await appendEvent({
          kind: "sale",
          actor: "أونلاين",
          refType: "ecommerce_order",
          refId: order.orderNumber,
          payload: {
            clientName: wholesaleClients.find((c) => c.id === wholesaleClient)?.companyName || "عميل جملة",
            channel: "ecommerce",
            notes: `تحويل طلب أونلاين ${order.orderNumber} لبيع جملة`
          },
          lines: buildWholesaleInvoiceLines({
            items: wholesaleItems,
            clientId: wholesaleClient,
            wallet: targetWallet,
            paidAmount: (order.depositAmount || 0) + paidAmount,
            shippingCharge: order.shippingFee,
            shippingCost: 0, // No direct courier cost here since it goes through courier lifecycle
            skipStockDeduction: true, // Stock was already reserved at order_placed!
          }),
        });

        const totalAmount = wholesaleGoodsTotal + (order.shippingFee || 0);
        const actualPaidAmount = (order.depositAmount || 0) + paidAmount;
        const remainingAmount = totalAmount - actualPaidAmount;
        const status = remainingAmount <= 0 ? "paid" : actualPaidAmount > 0 ? "partial" : "unpaid";
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 30); // Default to 30 days

        addWholesaleInvoice({
          invoiceNumber: `FJ-${Date.now().toString().slice(-4)}`,
          clientId: wholesaleClient,
          clientName: wholesaleClients.find((c) => c.id === wholesaleClient)?.companyName || "عميل جملة",
          items: wholesaleItems.map((i) => {
            const prod = products.find((p) => p.id === i.productId);
            return {
              id: crypto.randomUUID(),
              productId: i.productId,
              productName: prod?.name || "منتج",
              sku: prod?.sku || "",
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              wholesalePrice: i.unitPrice,
              total: i.unitPrice * i.quantity,
            };
          }),
          totalAmount,
          paidAmount: actualPaidAmount,
          remainingAmount,
          status,
          dueDate: dueDate.toISOString(),
          notes: `محولة من طلب أونلاين: ${order.orderNumber}`
        });
      }

      const expectedCod = saleMode === "wholesale" ? (parseFloat(wholesalePaidAmount) || 0) : order.expectedCod;

      // A separate click-through: the courier hands the COD over now. Its own
      // event, because collecting the cash is a different moment from
      // delivering the goods even when they happen a second apart.
      if (deliverMode === "settle" && expectedCod > 0) {
        await appendEvent({
          kind: "courier_settlement",
          actor: "أونلاين",
          refType: "ecommerce_order",
          refId: order.orderNumber,
          payload: { courierName: order.courierName ?? null },
          lines: buildCourierSettlementLines({
            courierId: courierIdOf(order),
            wallet: targetWallet,
            amount: expectedCod,
            commission: order.courierFee,
          }),
        });
        reconcileCourierOrder(reconcileDialog.orderId, targetWallet);
        // The COD is in our hands, so this order is no longer part of any
        // batch the courier owes us (§3.9). Stamped with the same field the
        // batch settlement uses, so "settled" has ONE meaning.
        updateOrder(order.id, { codSettledAt: new Date() });
      }

      // Remember that this went out as a wholesale sale. Without it the return
      // path has no way to know the goods are on a trader's account rather
      // than a retail customer's card, and would refund cash against a debt.
      if (saleMode === "wholesale" && wholesaleClient) {
        updateOrder(order.id, { wholesaleClientId: wholesaleClient });
      }

      // The order that carried the doubled fee has landed and been paid for, so
      // ONE wasted trip is recovered. A customer who returned three orders owes
      // three, and settles them one delivery at a time.
      if (clearsShippingDebt(order) && customerId) {
        useCustomerStore.getState().settleWastedTrip(customerId);
      }

      updateOrderStatus(reconcileDialog.orderId, "delivered");
      setReconcileDialog({ orderId: "", open: false });
    } catch (e) {
      setActionError(
        `لم تُسجَّل العملية ولم يتغيّر أي رصيد. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      releaseOrder(order.id);
      setIsWorking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-display font-bold">صفحة الطلبات</h1>
          <p className="text-muted-foreground mt-1">
            حلقة الطلبات المتصلة بالمخزون والعملاء وشركات الشحن والأرباح
          </p>
          {/* Errors from actions outside the dialog (مرتجع) surface here. */}
          {actionError && !reconcileDialog.open && (
            <div className="mt-3 rounded-lg p-3 bg-red-50 border border-red-200">
              <p className="text-sm font-medium text-red-900">{actionError}</p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            <Badge variant="secondary">انتظار: {totals.pending}</Badge>
            <Badge>مع المندوب: {totals.shipped}</Badge>
            <Badge variant="outline">تم التسليم: {totals.delivered}</Badge>
            <Badge variant="destructive">مرتجع: {totals.returned}</Badge>
            <Badge variant="outline">ملغي: {totals.cancelled}</Badge>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPdf}
            title="تصدير كل الطلبات إلى PDF"
          >
            <Printer className="size-4 ml-2" />
            تصدير PDF
          </Button>
          <Button asChild size="sm">
            {/* @ts-ignore */}
            <Link to="/ecommerce-orders">
              <ShoppingBag className="size-4 ml-2" />
              إضافة طلب جديد
            </Link>
          </Button>
          <Button asChild size="sm" variant="secondary" className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100">
            {/* @ts-ignore */}
            <Link to="/ecommerce-orders">
              <RotateCcw className="size-4 ml-2" />
              إنشاء طلب استبدال
            </Link>
          </Button>
        </div>
      </div>

      <OrderSearch
        value={query}
        onChange={setQuery}
        resultCount={filteredOrders.length}
        totalCount={ordersInTab.length}
      />

      {/* Native date inputs — the platform already has a date picker in every
          locale, including this one. The counters above follow these bounds,
          so the badges and the table always describe the same period. */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="space-y-1">
          <Label htmlFor="orders-from" className="text-xs">
            من تاريخ
          </Label>
          <Input
            id="orders-from"
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="orders-to" className="text-xs">
            إلى تاريخ
          </Label>
          <Input
            id="orders-to"
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            className="w-40"
          />
        </div>
        {(fromDate || toDate) && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
            >
              كل الفترات
            </Button>
            <p className="text-xs text-muted-foreground pb-2">
              الأرقام فوق بتحسب الفترة دي بس ({ordersInPeriodList.length} طلب)
            </p>
          </>
        )}
      </div>

      <Tabs value={filter} onValueChange={(value) => setFilter(value as EcommerceOrderStatus)}>
        <TabsList>
          {(Object.keys(STATUS_META) as EcommerceOrderStatus[]).map((status) => {
            const meta = STATUS_META[status];
            const Icon = meta.icon;
            return (
              <TabsTrigger key={status} value={status}>
                <Icon className="size-4 ml-2" />
                {meta.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value={filter} className="space-y-4">
          <div className="rounded-2xl border border-border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right px-4">رقم الطلب</TableHead>
                  <TableHead className="text-right px-4">العميل</TableHead>
                  <TableHead className="text-right px-4">العنوان</TableHead>
                  <TableHead className="text-right px-4">العناصر</TableHead>
                  <TableHead className="text-center px-4">الإجمالي</TableHead>
                  <TableHead className="text-center px-4">COD المستحق</TableHead>
                  <TableHead className="text-center px-4">الحالة</TableHead>
                  <TableHead className="text-center px-4">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-12">
                      <EmptyState
                        icon={query || fromDate || toDate ? Search : Inbox}
                        title={
                          query || fromDate || toDate
                            ? "لا توجد نتائج مطابقة للبحث"
                            : "لا توجد طلبات في هذا التصنيف"
                        }
                        description={
                          query || fromDate || toDate
                            ? "جرب بحث تاني أو غيّر التواريخ"
                            : "طلباتك هتظهر هنا لما تتنقل للتصنيف ده"
                        }
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredOrders.map((order) => {
                    // The courier is holding money only if this order had COD.
                    // This used to ask a `courierReceivables` document written
                    // at SHIP time, whose `amountDue` is `totalAmount −
                    // courierFee` — not the COD, and created even for a fully
                    // prepaid order where the courier carries nothing.
                    const hasCod = order.expectedCod > 0;
                    const actions = actionsFor(order.status);
                    return (
                      <TableRow key={order.id}>
                        <TableCell className="font-mono px-4 whitespace-nowrap">
                          {order.orderNumber}
                          {order.isExchange && (
                            <Badge variant="secondary" className="mr-2 border-red-200 bg-red-50 text-red-700">
                              استبدال
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="px-4">
                          <div className="flex items-center gap-2">
                            <User className="size-4 text-muted-foreground" />
                            <div>
                              <p className="font-medium whitespace-nowrap">{order.customerName}</p>
                              <p className="text-xs text-muted-foreground">{order.customerPhone}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-4 max-w-[220px]">
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <MapPin className="size-4 shrink-0" />
                            <span className="truncate">{order.address}</span>
                          </div>
                        </TableCell>
                        <TableCell className="px-4">
                          <div className="space-y-1 max-w-[220px]">
                            {order.items.map((item) => (
                              <div key={item.id} className="flex items-center gap-1.5 text-xs">
                                <Package className="size-3 text-muted-foreground shrink-0" />
                                <span className="truncate">
                                  {item.bundleName
                                    ? `${item.bundleName} × ${item.quantity}`
                                    : `${item.productName} × ${item.quantity}`}
                                </span>
                              </div>
                            ))}
                            {order.stockItems && order.stockItems.length > 0 && (
                              <p className="text-[10px] text-muted-foreground pr-5">
                                خصم المخزون:{" "}
                                {order.stockItems
                                  .map((item) => `${item.productName} (${item.quantity})`)
                                  .join("، ")}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono whitespace-nowrap">
                          {formatMoney(order.totalAmount)}
                        </TableCell>
                        <TableCell className="text-center px-4 font-mono whitespace-nowrap text-amber-600">
                          {formatMoney(order.expectedCod)}
                        </TableCell>
                        <TableCell className="text-center px-4">
                          {statusBadge(order.status)}
                        </TableCell>
                        <TableCell className="text-center px-4">
                          {/* Only the actions legal for THIS status are
                              rendered. Nothing relies on `disabled` to hide an
                              illegal transition — an action that cannot happen
                              is not on the screen at all. */}
                          <div className="flex items-center justify-center gap-1 flex-wrap">
                            {actions.includes("ship") && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isWorking}
                                onClick={() => updateOrderStatus(order.id, "shipped")}
                              >
                                تسليم للمندوب
                              </Button>
                            )}

                            {/* The two ways a delivery can end, named for what
                                actually happens to the money. "تسليم وتوريد"
                                said neither. */}
                            {actions.includes("settle") && hasCod && (
                              <Button
                                size="sm"
                                disabled={isWorking}
                                onClick={() => openDeliver(order.id, "settle")}
                              >
                                تم التسليم واستلمنا الفلوس
                              </Button>
                            )}
                            {actions.includes("deliver") && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isWorking}
                                onClick={() => openDeliver(order.id, "deliver")}
                              >
                                تم التسليم والفلوس لسه مع المندوب
                              </Button>
                            )}

                            {/* Only reachable once the goods have left the
                                shop. On a pending order this used to offer to
                                take back stock that was still on the shelf. */}
                            {actions.includes("return") && order.status === "shipped" && (
                              <>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={isWorking}
                                  onClick={() => void markReturnPending(order.id, "rto")}
                                >
                                  رفض الاستلام (مرتجع شحن)
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                                  disabled={isWorking}
                                  onClick={() => void markReturnPending(order.id, "refund")}
                                >
                                  استرجاع بعد الاستلام
                                </Button>
                              </>
                            )}
                            {actions.includes("return") && order.status === "delivered" && (
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={isWorking}
                                onClick={() => void markReturnPending(order.id, "refund")}
                              >
                                استرجاع من العميل
                              </Button>
                            )}

                            {/* §3.9: goods are only back on the shelf once a
                                human confirms it, by customer name. */}
                            {actions.includes("confirmReturn") && !order.returnConfirmedAt && (
                              <Button
                                size="sm"
                                disabled={isWorking}
                                onClick={() => {
                                  setActionError(null);
                                  setConfirmName("");
                                  setConfirmDialog({ orderId: order.id, open: true });
                                }}
                              >
                                تأكيد استلام المرتجع في المخزن
                              </Button>
                            )}
                            {order.returnConfirmedAt && (
                              <span className="text-xs text-muted-foreground">
                                المرتجع استلمناه في المخزن
                              </span>
                            )}

                            {/* Money sent before the courier arrives. Only
                                offered while something is still owed. */}
                            {actions.includes("pay") && order.expectedCod > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isWorking}
                                onClick={() => openPayment(order)}
                              >
                                تسجيل دفعة إضافية
                              </Button>
                            )}

                            {actions.includes("edit") && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isWorking}
                                onClick={() => openEdit(order)}
                              >
                                تعديل الطلب
                              </Button>
                            )}

                            {/* Cancelling a pending order returns its reserved
                                stock through the ledger. */}
                            {actions.includes("cancel") && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isWorking}
                                onClick={() => void cancelOrder(order.id)}
                              >
                                إلغاء الطلب
                              </Button>
                            )}

                            {actions.length === 0 && (
                              <span className="text-xs text-muted-foreground">
                                مفيش إجراءات متاحة
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      {/* Reconcile Dialog */}
      <Dialog
        open={reconcileDialog.open}
        onOpenChange={(open) => setReconcileDialog({ ...reconcileDialog, open })}
      >
        <DialogContent className="sm:max-w-sm">
          {/* The dialog says which of the two things is about to happen. The
              old title ("تسليم الطلب وتوريد المبلغ") was shown for BOTH modes,
              so it described the money arriving even when the money was staying
              with the courier. */}
          <DialogHeader>
            <DialogTitle>
              {deliverMode === "settle"
                ? "المندوب سلّم الطلب واستلمنا الفلوس"
                : "المندوب سلّم الطلب — الفلوس لسه معاه"}
            </DialogTitle>
            <DialogDescription>
              {deliverMode === "settle"
                ? "العميل استلم الطلب، والمندوب ورّد المبلغ. اختر الخزينة اللي الفلوس هتدخلها — هيتخصم منها عمولة الشحن."
                : "العميل استلم الطلب، بس المبلغ لسه مع المندوب ومحسوب عليه. هيتسجّل كمستحق عليه لحد ما يورّده."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex bg-muted p-1 rounded-lg">
              <button
                className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${saleMode === "retail"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted"
                  }`}
                onClick={() => setSaleMode("retail")}
              >
                بيع قطاعي (أونلاين)
              </button>
              <button
                className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${saleMode === "wholesale"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted"
                  }`}
                onClick={() => setSaleMode("wholesale")}
              >
                بيع جملة (تجار)
              </button>
            </div>

            {saleMode === "wholesale" && (
              <>
                <div className="space-y-2">
                  <Label>عميل الجملة <span className="text-red-500">*</span></Label>
                  <Select value={wholesaleClient} onValueChange={setWholesaleClient}>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر تاجر الجملة..." />
                    </SelectTrigger>
                    <SelectContent>
                      {wholesaleClients.map((client) => (
                        <SelectItem key={client.id} value={client.id}>
                          {client.companyName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {deliverMode === "settle" && (
                  <div className="space-y-2">
                    <Label>المبلغ المحصل مع المندوب</Label>
                    <Input
                      type="number"
                      min="0"
                      placeholder={`تلقائياً: ${formatMoney(deliverOrder?.expectedCod ?? 0)}`}
                      value={wholesalePaidAmount}
                      onChange={(e) => setWholesalePaidAmount(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">الباقي سيسجل كدين آجل على التاجر.</p>
                  </div>
                )}
              </>
            )}

            <div className="space-y-2">
              <Label>
                {deliverMode === "settle"
                  ? "الفلوس تدخل في أي خزينة؟"
                  : "خزينة العربون المدفوع مقدماً"}
              </Label>
              <Select value={targetWallet} onValueChange={(v) => setTargetWallet(v as WalletType)}>
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
            {/* The money the courier is actually carrying for THIS order, from
                the order itself — the same number `order_delivered` books as
                `receivable_courier`. It used to print the ship-time document's
                `amountDue` (`totalAmount − courierFee`), which ignores the
                shipping the customer paid AND any deposit already in the till,
                so a prepaid order announced a large hand-over the courier was
                never carrying. That is the figure the owner flagged. */}
            {deliverOrder && (
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                <p className="text-sm text-blue-900">تفاصيل التوريد:</p>
                <p className="text-xs text-blue-700 mt-1">
                  محصّل مع المندوب: {formatMoney(deliverOrder.expectedCod)}
                </p>
                <p className="text-xs text-blue-700 mt-1">
                  عمولة المندوب على الطلب: {formatMoney(deliverOrder.courierFee)}
                </p>
              </div>
            )}
            {actionError && (
              <div className="rounded-lg p-3 bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-900">{actionError}</p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setReconcileDialog({ ...reconcileDialog, open: false })}
              disabled={isWorking}
            >
              إلغاء
            </Button>
            <Button onClick={() => void confirmDeliver()} disabled={isWorking}>
              {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isWorking
                ? "جاري التسجيل..."
                : deliverMode === "settle"
                  ? "تأكيد: تم التسليم والفلوس دخلت الخزينة"
                  : "تأكيد: تم التسليم والفلوس مع المندوب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== RECORD AN ADDITIONAL PAYMENT ===== */}
      <Dialog open={payOrderId !== null} onOpenChange={(open) => !open && setPayOrderId(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>تسجيل دفعة إضافية — {payingOrder?.orderNumber}</DialogTitle>
            <DialogDescription>
              العميل حوّل جزء أو كل المتبقي قبل الشحن. سجّلها هنا عشان المندوب ميطلبش منه الفلوس
              تاني، والمبلغ يدخل الخزنة الصح.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-muted/40 p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">مدفوع مقدماً</span>
                <span className="font-semibold">{formatMoney(payingOrder?.depositAmount ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">المتبقي على المندوب (COD)</span>
                <span className="font-bold text-lg">{formatMoney(payOutstanding)}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="payAmount">المبلغ المدفوع الآن</Label>
              <Input
                id="payAmount"
                type="number"
                min={0}
                max={payOutstanding}
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                placeholder={String(payOutstanding)}
                className="font-bold text-lg"
              />
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setPayAmount(String(payOutstanding))}
              >
                سدّد المتبقي بالكامل ({formatMoney(payOutstanding)})
              </button>
            </div>

            {/* The point of the whole dialog: WHICH account the money landed in.
                Without it every transfer would pile into one till and the
                Treasury would show cash where none arrived. */}
            <div className="space-y-1.5">
              <Label>طريقة الدفع / الخزنة المستلمة</Label>
              <Select value={payWallet} onValueChange={(v) => setPayWallet(v as WalletType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(WALLET_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label as string}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {payValue > 0 && (
              <div className="flex items-center justify-between rounded-xl border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900 px-4 py-3">
                <span className="font-semibold text-green-900 dark:text-green-300">
                  المتبقي بعد الدفعة
                </span>
                <span className="text-xl font-black text-green-800 dark:text-green-300">
                  {formatMoney(Math.max(0, payOutstanding - payValue))}
                </span>
              </div>
            )}

            {actionError && (
              <div className="rounded-lg p-3 bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-900">{actionError}</p>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPayOrderId(null)} disabled={isWorking}>
              إلغاء
            </Button>
            <Button onClick={() => void confirmPayment()} disabled={isWorking || payValue <= 0}>
              {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isWorking ? "جاري التسجيل..." : "تأكيد الدفعة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== EDIT A PENDING ORDER ===== */}
      <Dialog open={editOrderId !== null} onOpenChange={(open) => !open && setEditOrderId(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تعديل الطلب {editingOrder?.orderNumber}</DialogTitle>
            <DialogDescription>
              التعديل متاح طول ما الطلب لسه عندك. أول ما يروح للمندوب، البضاعة تكون خرجت والتعديل
              بيتقفل.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {draft.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                مفيش منتجات في الطلب — ضيف منتج أو الغِ الطلب.
              </p>
            ) : (
              <div className="space-y-2">
                {draft.map((line) => {
                  const original =
                    editingOrder?.stockItems?.find((l) => l.productId === line.productId)
                      ?.quantity ?? 0;
                  // What this order already holds counts as available to it.
                  const ceiling = qtyOf(line.productId) + original;
                  return (
                    <div
                      key={line.productId}
                      className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border"
                    >
                      <div className="flex-1 space-y-1 overflow-hidden">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{line.productName}</p>
                          {line.variantName && (
                            <Badge variant="outline" className="h-5 text-[10px] px-1.5 font-bold border-primary text-primary">
                              {line.variantName}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatMoney(line.unitPrice)} للوحدة — متاح {ceiling}
                        </p>
                      </div>
                      <Input
                        type="number"
                        min="1"
                        max={ceiling}
                        value={line.quantity}
                        onChange={(e) =>
                          setDraft((prev) =>
                            prev.map((l) =>
                              l.productId === line.productId
                                ? {
                                  ...l,
                                  quantity: Math.max(
                                    1,
                                    Math.min(parseInt(e.target.value) || 1, ceiling),
                                  ),
                                }
                                : l,
                            ),
                          )
                        }
                        className="w-20 h-9 text-center"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() =>
                          setDraft((prev) => prev.filter((l) => l.productId !== line.productId))
                        }
                      >
                        حذف
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* The same shared picker as the order form, not a dropdown of the
                whole catalogue. Stock beside each result is `qtyOf` (the
                ledger) and the price is `productPrice` — one click adds the
                line, so there is no "choose then press إضافة" two-step to get
                half-way through. */}
            <div className="space-y-1.5">
              <Label>إضافة منتج</Label>
              <ProductSearch
                products={products}
                onSelect={(product) => {
                  if (product.metadata?.variants?.length > 0) {
                    setPendingVariantSelection({ product, qty: 1 });
                  } else {
                    addItemToDraft(product, 1);
                  }
                }}
                excludeIds={draft.map((l) => l.productId)}
                placeholder="ابحث باسم المنتج أو الكود لإضافته للطلب..."
              />
            </div>

            <div className="rounded-xl border border-border p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">إجمالي المنتجات</span>
                <span className="font-semibold">{formatMoney(draftGoods)}</span>
              </div>
              {draftDiscount > 0 && (
                <div className="flex justify-between text-green-600 dark:text-green-400">
                  <span>الخصم</span>
                  <span className="font-semibold">− {formatMoney(draftDiscount)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">الشحن</span>
                <span>{formatMoney(editingOrder?.shippingFee ?? 0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">المدفوع مقدماً</span>
                <span>− {formatMoney(editingOrder?.depositAmount ?? 0)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-1 mt-1">
                <span className="font-semibold">المتبقي على المندوب</span>
                <span className="font-semibold">
                  {formatMoney(
                    Math.max(
                      0,
                      draftTotal +
                      (editingOrder?.shippingFee ?? 0) -
                      (editingOrder?.depositAmount ?? 0),
                    ),
                  )}
                </span>
              </div>
            </div>

            {actionError && (
              <div className="rounded-lg p-3 bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-900">{actionError}</p>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditOrderId(null)} disabled={isWorking}>
              إلغاء
            </Button>
            <Button onClick={() => void saveEdit()} disabled={isWorking || draft.length === 0}>
              {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isWorking ? "جاري الحفظ..." : "حفظ التعديل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== RETURN CONFIRMATION (§3.9) ===== */}
      <Dialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog({ ...confirmDialog, open })}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>تأكيد استلام المرتجع</DialogTitle>
            <DialogDescription>
              المخزون مش هيرجع غير لما تأكد إن البضاعة وصلت فعلاً. اكتب اسم العميل زي ما هو في
              الطلب.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>اسم العميل</Label>
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder="اكتب اسم العميل بالكامل"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label>الخزينة اللي هيتخصم منها المسترد</Label>
              <Select value={targetWallet} onValueChange={(v) => setTargetWallet(v as WalletType)}>
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
            {/* Delivered on a trader's account: the goods pay down the debt
                instead of the till paying out. Same panel as نقطة البيع. */}
            {returnClientId && (
              <WholesaleReturnPanel
                debt={returnClientDebt}
                returnValue={returningOrder?.totalAmount ?? 0}
                paidInput={returnSettleInput}
                onPaidChange={setReturnSettleInput}
              />
            )}
            {actionError && (
              <div className="rounded-lg p-3 bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-900">{actionError}</p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmDialog({ ...confirmDialog, open: false })}
              disabled={isWorking}
            >
              إلغاء
            </Button>
            <Button
              onClick={() => void confirmReturn()}
              disabled={isWorking || !confirmName.trim()}
            >
              {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isWorking
                ? "جاري التأكيد..."
                : returnClientId
                  ? "تأكيد المرتجع وتسوية الحساب"
                  : "تأكيد الاستلام وإرجاع المخزون"}
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
