import { useState } from "react";
import { format } from "date-fns";
import {
  RotateCcw,
  Search,
  Package,
  ArrowLeftRight,
  CheckCircle2,
  AlertCircle,
  User,
  Phone,
  Hash,
  Printer,
  Loader2,
  Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { useBusinessStore } from "@/store/useBusinessStore";
import { useOrderStore } from "@/store/useOrderStore";
import { useCustomerStore } from "@/store/useCustomerStore";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { printTableAsPdf } from "@/lib/pdfGenerator";
import { appendEvent } from "@/lib/ledger";
import { searchOrders } from "@/lib/orderSearch";
import { ProductSearch } from "@/components/products/ProductSearch";
import { productPrice } from "@/lib/product";
import { formatMoney } from "@/lib/math";
import { claimOrder, releaseOrder } from "@/lib/orderLifecycle";
import { customerIdOf } from "@/lib/customers";
import { OrderSearch } from "@/components/ecommerce/OrderSearch";
import { buildReturnConfirmedLines, buildOrderRTOLines, buildOrderDeliveredLines } from "@/lib/ledger/orders";
import { buildSaleLines } from "@/lib/ledger/sales";
import { useStock } from "@/lib/ledger/useStock";
import type { EcommerceOrder, ReturnRecord, WalletType } from "@/types";
import { WALLET_LABELS } from "@/types";

interface ReturnEntry {
  product_id: string;
  product_name: string;
  /** How many the customer is sending back. */
  quantity: number;
  /** How many were on the original order — the ceiling for a return. */
  ordered: number;
  unit_price: number;
  /** Cost snapshotted when the order took the stock out. */
  unit_cost: number;
}

export function Returns() {
  const { products, addReturnRecord } = useBusinessStore();
  // Subscribed, not read via getState(), so the pending-replacement banner
  // below reappears the moment one is recorded and after any reload.
  const returnRecords = useBusinessStore((s) => s.returnRecords);
  const pendingReplacements = returnRecords.filter((r) => r.pending_replacement);

  // The real orders — this screen used to search `manualOrders`, which nothing
  // ever wrote, so no order could ever be found. Only delivered orders can be
  // returned: anything earlier is a cancel or a courier return, not this.
  const orders = useOrderStore((s) => s.orders);
  const deliveredOrders = orders.filter((o) => o.status === "delivered");

  const { qtyOf, costOf, refresh: refreshStock } = useStock();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<EcommerceOrder | null>(null);
  const [wallet, setWallet] = useState<WalletType>("inStoreSafe");
  const [isWorking, setIsWorking] = useState(false);
  const [returnEntries, setReturnEntries] = useState<ReturnEntry[]>([]);
  const [exchangeMode, setExchangeMode] = useState(false);
  const [exchange_product_id, setExchangeProductId] = useState("");
  const [exchangeQty, setExchangeQty] = useState(1);
  const [notes, setNotes] = useState("");
  

  const returnedOrders = orders.filter((o) => o.status === "returned" && !o.returnConfirmedAt);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; orderId: string }>({ open: false, orderId: "" });
  const [confirmName, setConfirmName] = useState("");
  

  const handleConfirmCourierReturn = async () => {
    const order = orders.find(o => o.id === confirmDialog.orderId);
    if (!order) return;

    const claim = claimOrder(order.id, order.status, "confirmReturn");
    if (claim === "illegal") {
      toast.error("الطلب مش في حالة مرتجع — مفيش مرتجع يتأكد استلامه.");
      return;
    }
    if (claim === "busy") {
      toast.error("جاري المعالجة");
      return;
    }
    if (order.returnConfirmedAt) {
      releaseOrder(order.id);
      toast.error("المرتجع ده اتأكد استلامه قبل كده — المخزون رجع والفلوس اترجّعت.");
      return;
    }
    if (confirmName.trim() !== order.customerName.trim()) {
      releaseOrder(order.id);
      toast.error("اسم العميل غير مطابق — اكتب الاسم زي ما هو في الطلب للتأكيد");
      return;
    }

    const customerId = customerIdOf(order, useCustomerStore.getState().customers);
    setIsWorking(true);
    

    try {
      const returnType = order.returnType ?? "refund";
      
      if (returnType === "rto") {
        await appendEvent({
          kind: "rto_confirmed",
          actor: "شركة الشحن",
          refType: "ecommerce_order",
          refId: order.orderNumber,
          payload: { customerName: order.customerName, type: "courier_return", itemCount: order.stockItems?.length || 0 },
          lines: buildOrderRTOLines({
            items: (order.stockItems || []).map(i => ({
              productId: i.productId,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              unitCost: i.unitCost ?? 0,
            })),
            returnFee: 0,
            courierId: order.courierId,
          }),
        });
      } else {
        if (!order.revenueLogged) {
          await appendEvent({
            kind: "order_delivered",
            actor: "شركة الشحن",
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
              wallet: "inStoreSafe",
              codAmount: order.expectedCod,
              courierId: order.courierId,
              customerId: customerId ?? undefined,
              channel: "ecommerce",
            }),
          });
        }
        
        await appendEvent({
          kind: "return_confirmed",
          actor: "شركة الشحن",
          refType: "ecommerce_order",
          refId: order.orderNumber,
          payload: { customerName: order.customerName, type: "courier_return", itemCount: order.stockItems?.length || 0 },
          lines: buildReturnConfirmedLines({
            items: (order.stockItems || []).map(i => ({ ...i, unitCost: i.unitCost ?? 0 })),
            refundAmount: order.totalAmount,
            wallet: "inStoreSafe",
            revenueAmount: order.totalAmount,
            returnFee: 0,
            customerId: customerId || undefined,
            channel: "ecommerce",
            courierId: order.courierId,
          }),
        });
      }

      useOrderStore.getState().updateOrder(order.id, { returnConfirmedAt: new Date().toISOString() as unknown as Date });
      refreshStock();
      setConfirmDialog({ open: false, orderId: "" });
      setConfirmName("");
    } catch (e) {
      toast.error(`فشل التأكيد: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsWorking(false);
      releaseOrder(order.id);
    }
  };

  // Results follow the query — no "بحث" button to press, and no mode to pick.
  // Blank shows nothing rather than every delivered order, because this screen
  // acts on ONE order and a full list invites picking the wrong one.
  const foundOrders = searchQuery.trim() ? searchOrders(deliveredOrders, searchQuery) : [];

  const selectOrder = (order: EcommerceOrder) => {
    setSelectedOrder(order);
    setReturnEntries(
      (order.stockItems ?? []).map((item) => ({
        product_id: item.productId,
        product_name: item.productName,
        quantity: 0,
        ordered: item.quantity,
        unit_price: item.unitPrice,
        // The cost the goods left at. Returning them at today's average would
        // silently move inventory value that never actually moved.
        unit_cost: item.unitCost ?? 0,
      })),
    );
  };

  const updateReturnQty = (product_id: string, qty: number) => {
    setReturnEntries((prev) =>
      prev.map((e) =>
        e.product_id === product_id
          ? // Never more than were bought — returning 5 of an order of 2 would
            // invent stock out of nothing.
            { ...e, quantity: Math.min(Math.max(0, qty), e.ordered) }
          : e,
      ),
    );
  };

  const exchangeProduct = products.find((p) => p.id === exchange_product_id);
  const totalReturnValue = returnEntries.reduce((s, e) => s + e.quantity * e.unit_price, 0);
  const exchangeTotal = exchangeProduct ? productPrice(exchangeProduct) * exchangeQty : 0;
  const priceDiff = exchangeTotal - totalReturnValue;

  const handleReturn = async () => {
    if (!selectedOrder) return;
    const itemsToReturn = returnEntries.filter((e) => e.quantity > 0);
    if (itemsToReturn.length === 0) {
      toast.error("اختر منتج واحد على الأقل للإرجاع");
      return;
    }

    const returned_items = itemsToReturn.map((e) => ({
      product_id: e.product_id,
      product_name: e.product_name,
      quantity: e.quantity,
      refund_amount: e.quantity * e.unit_price,
    }));

    const returnLineItems = itemsToReturn.map((e) => ({
      productId: e.product_id,
      quantity: e.quantity,
      unitPrice: e.unit_price,
      unitCost: e.unit_cost,
    }));

    // LTV comes down for the CRM customer this order belongs to, matched the
    // same way the delivery matched it.
    const key = selectedOrder.customerPhone?.trim() || selectedOrder.customerName?.trim();
    const customer = useCustomerStore
      .getState()
      .customers.find((c) => (c.phone?.trim() || c.name?.trim()) === key);

    if (exchangeMode && (!exchange_product_id || exchangeQty <= 0)) {
      toast.error("اختر المنتج البديل وحدد الكمية");
      return;
    }
    if (exchangeMode && exchangeQty > qtyOf(exchange_product_id)) {
      toast.error(
        `الكمية المطلوبة من "${exchangeProduct?.name ?? ""}" أكبر من المخزون (${qtyOf(exchange_product_id)})`
      );
      return;
    }

    setIsWorking(true);
    

    try {
      // ONE event for the return: the six lines. Stock comes back at the cost
      // it left at, the refund leaves the till, revenue and COGS reverse, the
      // courier's fee is an expense, and the customer's LTV comes down.
      await appendEvent({
        kind: "return_confirmed",
        actor: "مرتجعات",
        refType: "ecommerce_order",
        refId: selectedOrder.orderNumber,
        payload: {
          customerName: selectedOrder.customerName,
          type: exchangeMode ? "exchange" : "return",
          itemCount: itemsToReturn.length,
        },
        lines: buildReturnConfirmedLines({
          items: returnLineItems,
          refundAmount: exchangeMode ? 0 : totalReturnValue,
          wallet,
          revenueAmount: totalReturnValue,
          returnFee: 0,
          customerId: customer?.id,
          channel: "ecommerce",
        }),
      });
    } catch (e) {
      toast.error(
        `لم يُسجَّل المرتجع ولم يتغيّر المخزون. ${e instanceof Error ? e.message : String(e)}`
      );
      setIsWorking(false);
      return;
    }

    if (exchangeMode) {
      // The replacement going out is genuinely a second business event — goods
      // back, then different goods out — so it is its own `sale`. If it fails
      // the return above still stands on its own and stays correct; the
      // message says exactly that so the operator knows what to redo.
      try {
        await appendEvent({
          kind: "sale",
          actor: "مرتجعات",
          refType: "exchange",
          refId: selectedOrder.orderNumber,
          payload: { customerName: selectedOrder.customerName, channel: "exchange" },
          lines: buildSaleLines({
            items: [
              {
                productId: exchange_product_id,
                quantity: exchangeQty,
                unitPrice: productPrice(exchangeProduct),
                unitCost: costOf(exchange_product_id),
              },
            ],
            wallet,
            customerId: customer?.id,
            channel: "exchange",
          }),
        });
      } catch (e) {
        // The return already happened and the goods are back on the shelf, so
        // it stays. What must not happen is the replacement being forgotten:
        // record the return WITH the outstanding replacement on it, so the
        // obligation survives this dialog, this screen and this session.
        addReturnRecord({
          original_order_id: selectedOrder.id,
          type: "exchange",
          customer_name: selectedOrder.customerName,
          customer_phone: selectedOrder.customerPhone,
          governorate: selectedOrder.governorate ?? "",
          returned_items,
          pending_replacement: {
            product_id: exchange_product_id,
            product_name: exchangeProduct?.name || "",
            quantity: exchangeQty,
            price: productPrice(exchangeProduct),
          },
          financial_difference: -totalReturnValue,
          processed_by: "owner",
          notes: notes.trim(),
        });
        refreshStock();
        toast.error(
          `تم تسجيل الإرجاع، لكن المنتج البديل لم يُسجَّل. العملية مسجّلة كـ "بديل معلّق" تحت — لازم تسجّله كبيع. ${e instanceof Error ? e.message : String(e)}`
        );
        setIsWorking(false);
        setSelectedOrder(null);
        setReturnEntries([]);
        return;
      }
    }

    addReturnRecord({
      original_order_id: selectedOrder.id,
      type: exchangeMode ? "exchange" : "return",
      customer_name: selectedOrder.customerName,
      customer_phone: selectedOrder.customerPhone,
      governorate: selectedOrder.governorate ?? "",
      returned_items,
      ...(exchangeMode
        ? {
            exchanged_item: {
              product_id: exchange_product_id,
              product_name: exchangeProduct?.name || "",
              quantity: exchangeQty,
              price: productPrice(exchangeProduct),
            },
          }
        : {}),
      financial_difference: exchangeMode ? priceDiff : -totalReturnValue,
      processed_by: "owner",
      notes: notes.trim(),
    });

    refreshStock();
    toast.success(
      exchangeMode
        ? `تمت عملية الاستبدال بنجاح! ${
            priceDiff >= 0
              ? `العميل يدفع فرق ${priceDiff.toLocaleString("ar-EG")} ج.م`
              : `للعميل مسترد ${Math.abs(priceDiff).toLocaleString("ar-EG")} ج.م`
          }`
        : `تم إرجاع ${itemsToReturn.length} منتج/منتجات — رجعت للمخزون واتسجّل المسترد`
    );

    setIsWorking(false);
    setSelectedOrder(null);
    setSearchQuery("");
    setReturnEntries([]);
    setExchangeMode(false);
    setExchangeProductId("");
    setExchangeQty(1);
    setNotes("");
    
  };

  // Phase F: PDF export of the return/exchange log.
  const handleExportPdf = () => {
    const records = useBusinessStore.getState().returnRecords;
    printTableAsPdf({
      title: "سجل المرتجعات والاستبدال",
      columns: [
        { label: "التاريخ", accessor: (r: ReturnRecord) => format(new Date(r.created_at), "dd/MM/yyyy HH:mm") },
        { label: "النوع", accessor: (r: ReturnRecord) => (r.type === "return" ? "إرجاع" : "استبدال"), align: "center" },
        { label: "العميل", accessor: (r: ReturnRecord) => r.customer_name },
        { label: "الهاتف", accessor: (r: ReturnRecord) => r.customer_phone, align: "center" },
        { label: "عدد المنتجات", accessor: (r: ReturnRecord) => String(r.returned_items.length), align: "center" },
        {
          label: "قيمة الإرجاع",
          accessor: (r: ReturnRecord) =>
            r.returned_items.reduce((s, i) => s + i.refund_amount, 0).toLocaleString("ar-EG") + " ج.م",
          align: "center",
        },
        {
          label: "المنتج البديل",
          accessor: (r: ReturnRecord) => r.exchanged_item?.product_name ?? "—",
        },
        {
          label: "فرق السعر",
          accessor: (r: ReturnRecord) => r.financial_difference.toLocaleString("ar-EG") + " ج.م",
          align: "center",
        },
      ],
      rows: records,
      footer: `إجمالي العمليات: ${records.length}`,
    });
  };

  return (
    <div className="space-y-6 w-full">
      <Tabs defaultValue="direct" className="w-full">
        <TabsList className="w-full max-w-md mx-auto mb-6 grid grid-cols-2">
          <TabsTrigger value="direct">إرجاع مباشر (طلبات مستلمة)</TabsTrigger>
          <TabsTrigger value="courier">مرتجعات شركات الشحن</TabsTrigger>
        </TabsList>
        
        <TabsContent value="direct" className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div
            className="size-10 rounded-xl flex items-center justify-center"
            style={{ background: "var(--gradient-primary)" }}
          >
            <RotateCcw className="size-5 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-3xl font-display font-bold leading-tight">المرتجعات والاستبدال</h2>
            <p className="text-muted-foreground mt-1">
              إرجاع أو استبدال المنتجات مع التحديث التلقائي للمخزون
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={handleExportPdf}
          className="gap-2"
          disabled={useBusinessStore.getState().returnRecords.length === 0}
        >
          <Printer className="size-4" />
          تصدير PDF
        </Button>
      </div>

      {/* Outstanding replacements. An exchange writes two events; if the
          replacement sale failed, the return still stands and the shop owes a
          replacement. This list is stored on the return record, so it survives
          closing the dialog, leaving the screen and restarting the app —
          unlike the message below it, which is only for the action just taken. */}
      {pendingReplacements.length > 0 && (
        <div className="rounded-xl p-4 border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="size-5 text-amber-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">
                بدائل معلّقة — لسه متسجلتش كبيع ({pendingReplacements.length})
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-400 mt-1">
                الإرجاع اتسجّل والبضاعة رجعت المخزن، لكن المنتج البديل لسه محتاج يتسجّل كبيع في
                نقاط البيع. لو مسجلتوش، العميل خد المنتج والنظام مش عارف.
              </p>
              <ul className="mt-2 space-y-1">
                {pendingReplacements.map((rec) => (
                  <li key={rec.id} className="text-xs text-amber-900 dark:text-amber-300">
                    • {rec.customer_name} — {rec.pending_replacement?.product_name} ×{" "}
                    {rec.pending_replacement?.quantity} —{" "}
                    {new Date(rec.created_at).toLocaleDateString("ar-EG")}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      

      {/* Unified Search */}
      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-sm font-semibold text-muted-foreground tracking-wide">بحث موحد</p>
        {/* One field, all three targets, results as you type — the shared
            component every order lookup uses. The mode picker it replaces made
            the user declare what they were about to type before typing it. */}
        <OrderSearch
          value={searchQuery}
          onChange={setSearchQuery}
          resultCount={foundOrders.length}
          totalCount={deliveredOrders.length}
          placeholder="ابحث عن الأوردر برقمه أو اسم العميل أو تليفونه..."
        />

        {foundOrders.length > 0 && (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {foundOrders.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => selectOrder(order)}
                className={cn(
                  "w-full text-right p-3 rounded-xl border transition-all",
                  selectedOrder?.id === order.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted",
                )}
              >
                <p className="font-medium text-sm">{order.customerName}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {order.orderNumber} — {order.customerPhone} — {order.items.length} منتج —{" "}
                  {(order.totalAmount + order.shippingFee).toLocaleString("ar-EG")} ج.م
                </p>
              </button>
            ))}
          </div>
        )}

        {deliveredOrders.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            مفيش أوردرات متسلّمة لسه — المرتجع بيبقى لأوردر اتسلّم فعلاً.
          </p>
        )}
      </div>

      {/* Selected Order Items */}
      {selectedOrder && (
        <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-muted-foreground tracking-wide">
              منتجات الطلب
            </p>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={exchangeMode}
                onChange={() => {
                  setExchangeMode(!exchangeMode);
                  setExchangeProductId("");
                }}
                className="rounded border-input"
              />
              <span className="flex items-center gap-1">
                <ArrowLeftRight className="size-3.5" />
                استبدال بمنتج آخر
              </span>
            </label>
          </div>

          <div className="space-y-2">
            {returnEntries.map((entry) => {
              return (
                <div
                  key={entry.product_id}
                  className="flex items-center justify-between p-3 rounded-xl border border-border bg-muted/30"
                >
                  <div className="flex-1">
                    <p className="text-sm font-medium">{entry.product_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatMoney(entry.unit_price)} / للقطعة
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">الكمية للإرجاع:</span>
                    <input
                      type="number"
                      min="0"
                      // The ceiling for a return is what was ORDERED, not what
                      // is in stock — a customer can send back the two shirts
                      // they bought whether or not the shelf has any today.
                      // The old expression mixed the order line with stored
                      // stock, which was both the wrong quantity and the wrong
                      // source. `updateReturnQty` already clamps to this.
                      max={entry.ordered}
                      value={entry.quantity}
                      onChange={(e) =>
                        updateReturnQty(entry.product_id, parseInt(e.target.value) || 0)
                      }
                      className="w-16 h-8 text-center rounded border border-input bg-background text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Exchange section */}
          {exchangeMode && (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-4 space-y-4">
              <p className="text-sm font-semibold">اختر المنتج البديل</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">المنتج الجديد</label>
                  {/* Was a dropdown filtered on `p.stock_qty > 0`. Since
                      nothing ever wrote `stock_qty`, that read `undefined > 0`
                      → false for every product, so this list was ALWAYS empty
                      and the exchange flow could not be completed at all.
                      Now the shared search, with stock from the ledger. */}
                  {exchangeProduct ? (
                    <div className="flex items-center justify-between gap-2 h-10 rounded-md border border-input bg-background px-3 text-sm">
                      <span className="truncate">
                        {exchangeProduct.name} — {formatMoney(productPrice(exchangeProduct))}
                      </span>
                      <button
                        type="button"
                        onClick={() => setExchangeProductId("")}
                        className="text-xs text-destructive hover:underline shrink-0"
                      >
                        تغيير
                      </button>
                    </div>
                  ) : (
                    <ProductSearch
                      products={products}
                      qtyOf={qtyOf}
                      onSelect={(p) => setExchangeProductId(p.id)}
                      placeholder="ابحث عن المنتج البديل..."
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">الكمية</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setExchangeQty(Math.max(1, exchangeQty - 1))}
                      className="size-8 rounded border border-input bg-background flex items-center justify-center hover:bg-accent"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min="1"
                      value={exchangeQty}
                      onChange={(e) => setExchangeQty(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-16 h-8 text-center rounded border border-input bg-background text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                      type="button"
                      onClick={() => setExchangeQty(exchangeQty + 1)}
                      className="size-8 rounded border border-input bg-background flex items-center justify-center hover:bg-accent"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">فرق المنتج</label>
                  <p
                    className={cn(
                      "text-lg font-bold",
                      priceDiff >= 0
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-green-600 dark:text-green-400",
                    )}
                  >
                    {priceDiff >= 0 ? "" : "−"}
                    {Math.abs(priceDiff).toLocaleString()} ج.م
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {priceDiff >= 0 ? "العميل يدفع الفرق" : "مسترد للعميل"}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">ملاحظات (اختياري)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="أضف ملاحظات عن عملية الإرجاع أو الاستبدال..."
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <Button onClick={handleReturn} className="w-full" size="lg" disabled={isWorking}>
            {isWorking ? (
              <Loader2 className="h-4 w-4 animate-spin ml-2" />
            ) : exchangeMode ? (
              <ArrowLeftRight className="size-4 ml-2" />
            ) : (
              <RotateCcw className="size-4 ml-2" />
            )}
            {isWorking ? "جاري التأكيد..." : exchangeMode ? "تأكيد الاستبدال وحساب الفرق" : "تأكيد الإرجاع وإعادة المخزون"}
          </Button>
        </div>
      )}

      {/* Recent Returns */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <p className="text-sm font-semibold text-muted-foreground tracking-wide mb-4">
          سجل المرتجعات والاستبدال
        </p>
        {useBusinessStore.getState().returnRecords.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="لا توجد عمليات إرجاع أو استبدال حتى الآن"
            className="py-12"
          />
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {[...useBusinessStore.getState().returnRecords]
              .reverse()
              .slice(0, 20)
              .map((rec) => (
                <div
                  key={rec.id}
                  className="flex items-center justify-between p-3 rounded-xl border border-border bg-muted/20 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {rec.type === "return" ? "إرجاع" : "استبدال"} — {rec.customer_name}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {rec.returned_items.length} منتج —{" "}
                      {rec.returned_items.reduce((s, i) => s + i.refund_amount, 0).toLocaleString()}{" "}
                      ج.م
                      {rec.type === "exchange" &&
                        rec.exchanged_item &&
                        ` ← ${rec.exchanged_item.product_name}`}
                      {rec.pending_replacement && (
                        <span className="mr-2 text-amber-700 font-medium">
                          — بديل معلّق: {rec.pending_replacement.product_name} ×{" "}
                          {rec.pending_replacement.quantity}
                        </span>
                      )}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(rec.created_at).toLocaleDateString("ar-EG")}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
      </TabsContent>
      <TabsContent value="courier" className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-6">
            <p className="text-sm font-semibold text-muted-foreground tracking-wide mb-4">
              تأكيد استلام مرتجع شحن
            </p>
            {returnedOrders.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="مفيش أوردرات معلقة في حالة مرتجع حاليا"
                className="py-12"
              />
            ) : (
              <div className="space-y-3">
                {returnedOrders.map((o) => (
                  <div key={o.id} className="p-4 rounded-xl border flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{o.customerName}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {o.orderNumber} — {o.customerPhone}
                      </p>
                    </div>
                    <Button onClick={() => setConfirmDialog({ open: true, orderId: o.id })} variant="outline" size="sm">
                      تأكيد استلام بالمخزن
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
      
      <Dialog open={confirmDialog.open} onOpenChange={(open) => !open && setConfirmDialog({ open: false, orderId: "" })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>تأكيد استلام مرتجع الشحن</DialogTitle>
            <DialogDescription>
              العملية دي هترجع منتجات الأوردر للمخزن عشان تتباع تاني.
              <br />
              عشان نضمن إنك بتأكد الأوردر الصح، اكتب اسم العميل ({orders.find(o => o.id === confirmDialog.orderId)?.customerName}) بالظبط:
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <Input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder="اسم العميل"
              autoFocus
            />
            
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog({ open: false, orderId: "" })} disabled={isWorking}>
              إلغاء
            </Button>
            <Button onClick={handleConfirmCourierReturn} disabled={isWorking}>
              {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isWorking ? "جاري التأكيد..." : "تأكيد واسترجاع للمخزن"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
