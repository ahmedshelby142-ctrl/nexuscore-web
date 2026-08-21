import { useEffect, useMemo, useRef, useState } from "react";
import { Fragment } from "react";
import { formatMoney } from "@/lib/math";
import {
  Truck,
  Wallet,
  Coins,
  ArrowLeftRight,
  History,
  FileText,
  ChevronDown,
  ChevronUp,
  Printer,
} from "lucide-react";
import { useCourierStore } from "@/store/useCourierStore";
import { useOrderStore } from "@/store/useOrderStore";
import { useBalances } from "@/lib/ledger/useBalances";
import { appendEvent, events } from "@/lib/ledger";
import { buildCourierBatchSettlementLines } from "@/lib/ledger/orders";
import { batchSummary, courierIdOf, unsettledDeliveries } from "@/lib/courierBatch";
import { generateCourierPdf } from "@/lib/pdfGenerator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { CourierSettlementReport } from "./CourierSettlementReport";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LedgerEvent } from "@/lib/ledger/types";
import type { WalletType } from "@/types";
import { WALLET_LABELS } from "@/types";

/** One row of the settlement history, read back from the ledger. */
interface SettlementRow {
  id: string;
  courierId: string;
  courierName: string;
  orderCount: number;
  codTotal: number;
  netReceived: number;
  expectedFees: number;
  expectedNet: number;
  shortfall: number;
  orderNumbers: string[];
  at: Date;
}

function readSettlement(event: LedgerEvent): SettlementRow {
  const payload = event.payload as Record<string, unknown>;
  const num = (key: string) => (typeof payload[key] === "number" ? (payload[key] as number) : 0);
  return {
    id: event.id,
    courierId: String(payload.courierId ?? ""),
    courierName: String(payload.courierName ?? "شركة شحن"),
    orderCount: num("orderCount"),
    codTotal: num("codTotal"),
    netReceived: num("netReceived"),
    expectedFees: num("expectedFees"),
    expectedNet: num("expectedNet"),
    shortfall: num("shortfall"),
    orderNumbers: Array.isArray(payload.orderNumbers) ? payload.orderNumbers.map(String) : [],
    at: new Date(event.occurredAt),
  };
}

export function CourierLedgerPage() {
  const accounts = useCourierStore((s) => s.accounts);
  const orders = useOrderStore((s) => s.orders);
  const updateOrder = useOrderStore((s) => s.updateOrder);

  // Both sides of every courier, derived. `receivable_courier` is the COD they
  // are carrying for us; `payable_courier` is the fees we owe them. Neither is
  // stored on the courier record any more.
  const owedToUs = useBalances("receivable_courier");
  const owedToThem = useBalances("payable_courier");
  const { amountOf: expenseOf, refresh: refreshExpense } = useBalances("expense");
  const returnFeesBorne = expenseOf("shipping_return");

  // §3.9 drill-down BY FEE TYPE. Not three accounts, and not a compound
  // `courier:return` subject — the same two accounts, narrowed to the lines one
  // KIND of event wrote, which `BalanceQuery.kind` already does in SQL.
  //   delivery = payable_courier written by order_delivered
  //   exchange = receivable_courier written by return_confirmed (the customer
  //              pays it; the courier collects it on our behalf)
  //   return   = the rest of what return_confirmed put on payable_courier
  const feeDelivery = useBalances("payable_courier", "order_delivered");
  const feeReturnish = useBalances("payable_courier", "return_confirmed");
  const feeExchange = useBalances("receivable_courier", "return_confirmed");

  const [history, setHistory] = useState<SettlementRow[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyTick, setHistoryTick] = useState(0);

  const [printSettlement, setPrintSettlement] = useState<SettlementRow | null>(null);

  useEffect(() => {
    if (printSettlement) {
      const timer = setTimeout(() => {
        window.print();
      }, 100);
      const onFocus = () => {
        setPrintSettlement(null);
        window.removeEventListener("focus", onFocus);
      };
      window.addEventListener("focus", onFocus);
      return () => {
        clearTimeout(timer);
        window.removeEventListener("focus", onFocus);
      };
    }
  }, [printSettlement]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await events({ kind: "courier_settlement", limit: 50 });
        if (!cancelled) {
          setHistory(rows.map(readSettlement));
          setHistoryError(null);
        }
      } catch (e) {
        // An empty list must not stand in for a failed read — "no settlements
        // yet" and "we could not look" are different answers.
        if (!cancelled) setHistoryError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [historyTick]);

  /**
   * The couriers on screen are the ones the ORDERS actually name, merged with
   * any added by hand.
   *
   * The list used to come from the courier store alone, whose rows are written
   * by `recordOrderCod` — which nothing has ever called. So the table sat empty
   * under "سيتم إنشاء الحساب تلقائياً عند تسليم أول طلب COD", a promise nothing
   * kept, while the ledger held real balances for those couriers all along.
   */
  const couriers = useMemo(() => {
    const found = new Map<string, { id: string; name: string; phone?: string }>();
    for (const account of accounts) {
      found.set(account.id, { id: account.id, name: account.name, phone: account.phone });
    }
    for (const order of orders) {
      const id = courierIdOf(order);
      if (!found.has(id)) {
        found.set(id, { id, name: order.courierName || "شركة الشحن الافتراضية" });
      }
    }
    return [...found.values()];
  }, [accounts, orders]);

  const openByCourier = useMemo(() => {
    const map = new Map<string, number>();
    for (const order of unsettledDeliveries(orders)) {
      const id = courierIdOf(order);
      map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  }, [orders]);

  const [expanded, setExpanded] = useState<string | null>(null);

  // ── Batch settlement (تسوية دفعة) ────────────────────────────────────────
  const [batchCourier, setBatchCourier] = useState<{ id: string; name: string } | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [received, setReceived] = useState("");
  const [wallet, setWallet] = useState<WalletType>("inStoreSafe");
  const [isWorking, setIsWorking] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  /**
   * Claimed synchronously, before the first `await` — the guard §3.8 needed for
   * exactly the same reason. `isWorking` is React state, and a second click can
   * be dispatched before the re-render that disables the button; a duplicated
   * settlement would clear the receivable twice and book the deposit twice.
   */
  const writing = useRef(false);

  const openOrders = useMemo(
    () => (batchCourier ? unsettledDeliveries(orders, batchCourier.id) : []),
    [orders, batchCourier],
  );
  const tickedOrders = useMemo(
    () => openOrders.filter((order) => ticked[order.id]),
    [openOrders, ticked],
  );
  const summary = batchSummary(tickedOrders, parseFloat(received) || 0);

  const openBatch = (courier: { id: string; name: string }) => {
    setBatchCourier(courier);
    setTicked({});
    setReceived("");
    setBatchError(null);
  };

  const confirmBatch = async () => {
    if (!batchCourier || writing.current) return;
    // Re-read from the store: this dialog can sit open while an order is
    // settled elsewhere, and a stale list would clear a receivable twice.
    const live = unsettledDeliveries(useOrderStore.getState().orders, batchCourier.id).filter(
      (order) => ticked[order.id],
    );
    if (live.length === 0) {
      setBatchError("علّم الطلبات اللي فلوسها وصلت في التحويلة دي.");
      return;
    }
    const net = parseFloat(received);
    if (!Number.isFinite(net) || net < 0) {
      setBatchError("اكتب المبلغ اللي وصل فعلاً بالجنيه.");
      return;
    }

    writing.current = true;
    setIsWorking(true);
    setBatchError(null);
    const settlementId = crypto.randomUUID();
    try {
      // ONE event for the whole transfer, never one per order: the courier made
      // one payment, and the books should show one payment.
      await appendEvent({
        kind: "courier_settlement",
        actor: "حسابات الشحن",
        refType: "courier_batch",
        refId: settlementId,
        payload: {
          courierId: batchCourier.id,
          courierName: batchCourier.name,
          orderCount: live.length,
          orderNumbers: live.map((order) => order.orderNumber),
          codTotal: live.reduce((sum, order) => sum + order.expectedCod, 0),
          expectedFees: summary.expectedFees,
          expectedNet: summary.expectedNet,
          netReceived: net,
          shortfall: summary.shortfall,
          wallet,
        },
        lines: buildCourierBatchSettlementLines({
          courierId: batchCourier.id,
          wallet,
          orders: live.map((order) => ({
            orderId: order.id,
            cod: order.expectedCod,
            fee: order.courierFee ?? order.shippingFee ?? 0,
          })),
          netReceived: net,
          expectedFees: summary.expectedFees,
        }),
      });

      // The documents follow the ledger. Only the orders in THIS batch are
      // stamped — everything left unticked stays open for the next transfer.
      for (const order of live) {
        updateOrder(order.id, { codSettledAt: new Date(), codSettlementId: settlementId });
      }

      owedToUs.refresh();
      owedToThem.refresh();
      refreshExpense();
      feeDelivery.refresh();
      feeReturnish.refresh();
      feeExchange.refresh();
      setHistoryTick((t) => t + 1);
      setBatchCourier(null);
    } catch (e) {
      setBatchError(
        `التسوية متسجلتش ومفيش رصيد اتغيّر. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      writing.current = false;
      setIsWorking(false);
    }
  };

  const handleExportPdf = () => {
    generateCourierPdf({
      companyName: "نظام حلقة واحدة",
      reportDate: new Date(),
      accounts: couriers.map((courier) => ({
        name: courier.name,
        phone: courier.phone ?? "",
        // The same derived numbers the screen shows, so the printout agrees.
        totalExpectedCod: owedToUs.amountOf(courier.id),
        cashReceived: history
          .filter((row) => row.courierId === courier.id)
          .reduce((sum, row) => sum + row.netReceived, 0),
        commissionFees: owedToThem.amountOf(courier.id),
        remainingBalance: owedToUs.amountOf(courier.id) - owedToThem.amountOf(courier.id),
        orderIds: orders.filter((o) => courierIdOf(o) === courier.id).map((o) => o.orderNumber),
        settlements: history
          .filter((row) => row.courierId === courier.id)
          .map((row) => ({
            amount: row.netReceived,
            note: `${row.orderCount} طلب — محصّل ${formatMoney(row.codTotal)}`,
            createdAt: row.at,
          })),
      })),
      totals: {
        expectedCod: owedToUs.total,
        cashReceived: history.reduce((sum, row) => sum + row.netReceived, 0),
        fees: owedToThem.total,
        remaining: owedToUs.total - owedToThem.total,
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-display font-bold">حسابات شركات الشحن</h1>
          <p className="text-muted-foreground mt-1">
            فلوس العملاء اللي لسه مع المندوب، العمولات اللي ليه، وتسوية التحويلة أول ما توصل
          </p>
        </div>
        <Button variant="outline" onClick={handleExportPdf} className="shrink-0">
          <FileText className="size-4 ml-2" /> تصدير PDF
        </Button>
      </div>

      {/* Every card says WHO owes WHOM, in words. "مستحق للمندوبين" and
          "الصافي (لنا − عليهم)" were unreadable to the person who has to act on
          them: the direction of the money was the missing half. */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Truck className="size-4" /> فلوس لسه مع المندوبين
          </div>
          <p className="text-2xl font-bold mt-3">{formatMoney(owedToUs.total)}</p>
          <p className="text-xs text-muted-foreground mt-2">
            محصّلينها من العملاء ولسه ما وصلتش خزنتك
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Coins className="size-4" /> عمولات هيخصموها
          </div>
          <p className="text-2xl font-bold mt-3 text-amber-600">{formatMoney(owedToThem.total)}</p>
          <p className="text-xs text-muted-foreground mt-2">
            بتتخصم من التحويلة — مش هتدفعها من الخزنة
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Wallet className="size-4" /> شحن مرتجعات دفعناه
          </div>
          {/* The ONLY shipping our shop pays for. Delivery and exchange fees
              are the customer's and pass through — they never land here. */}
          <p className="text-2xl font-bold mt-3 text-red-600">{formatMoney(returnFeesBorne)}</p>
          <p className="text-xs text-muted-foreground mt-2">
            ده الشحن الوحيد اللي بيتحسب خسارة علينا
          </p>
        </div>
        <div className="rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-6">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <ArrowLeftRight className="size-4" /> المفروض يوصلك في الآخر
          </div>
          <p className="text-2xl font-bold mt-3 text-amber-700 dark:text-amber-300">
            {formatMoney(owedToUs.total - owedToThem.total)}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            اللي معاهم ناقص عمولاتهم — ده المتوقع في التحويلة الجاية
          </p>
        </div>
      </div>

      {(owedToUs.error || owedToThem.error) && (
        <div className="rounded-lg p-3 bg-red-50 border border-red-200">
          <p className="text-sm font-medium text-red-900">
            تعذّرت قراءة أرصدة الشحن — الأرقام فوق مش مضمونة دلوقتي.
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right px-4">شركة الشحن</TableHead>
              <TableHead className="text-center px-4">فلوسنا اللي معاه</TableHead>
              <TableHead className="text-center px-4">عمولاته علينا</TableHead>
              <TableHead className="text-center px-4">المفروض يوصلنا منه</TableHead>
              <TableHead className="text-center px-4">طلبات لسه مفتوحة</TableHead>
              <TableHead className="text-center px-4">تسوية</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {couriers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-12">
                  لا توجد شركات شحن بعد. أول طلب أونلاين بمندوب هيظهر هنا.
                </TableCell>
              </TableRow>
            ) : (
              couriers.map((courier) => {
                const theirs = owedToThem.amountOf(courier.id);
                const ours = owedToUs.amountOf(courier.id);
                const exchange = feeExchange.amountOf(courier.id);
                const returns = feeReturnish.amountOf(courier.id) - exchange;
                const openCount = openByCourier.get(courier.id) ?? 0;
                return (
                  <Fragment key={courier.id}>
                    <TableRow>
                      <TableCell className="px-4">
                        <button
                          className="flex items-center gap-2 text-right"
                          onClick={() => setExpanded(expanded === courier.id ? null : courier.id)}
                        >
                          {expanded === courier.id ? (
                            <ChevronUp className="size-4" />
                          ) : (
                            <ChevronDown className="size-4" />
                          )}
                          <span>
                            <span className="font-medium block">{courier.name}</span>
                            {courier.phone && (
                              <span className="text-xs text-muted-foreground">{courier.phone}</span>
                            )}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="text-center px-4 font-mono">
                        {formatMoney(ours)}
                      </TableCell>
                      <TableCell className="text-center px-4 font-mono text-amber-600">
                        {formatMoney(theirs)}
                      </TableCell>
                      <TableCell
                        className={
                          "text-center px-4 font-mono font-bold " +
                          (ours - theirs >= 0 ? "text-green-600" : "text-red-600")
                        }
                      >
                        {formatMoney(ours - theirs)}
                      </TableCell>
                      <TableCell className="text-center px-4">
                        <Badge variant="outline">{openCount} طلب</Badge>
                      </TableCell>
                      <TableCell className="text-center px-4">
                        <Button
                          size="sm"
                          disabled={openCount === 0}
                          onClick={() => openBatch(courier)}
                        >
                          <Wallet className="size-4 ml-2" />
                          تسوية دفعة
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expanded === courier.id && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/30 px-6 py-4">
                          <p className="text-sm font-medium mb-3">العمولات دي جاية منين؟</p>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                            <div className="rounded-xl border bg-card p-3">
                              <p className="text-muted-foreground text-xs">توصيل للعملاء</p>
                              <p className="font-mono font-bold mt-1">
                                {formatMoney(feeDelivery.amountOf(courier.id))}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                العميل دفعها مع الطلب — بتعدّي مننا للمندوب
                              </p>
                            </div>
                            <div className="rounded-xl border bg-card p-3">
                              <p className="text-muted-foreground text-xs">رجّع بضاعة</p>
                              <p className="font-mono font-bold mt-1 text-red-600">
                                {formatMoney(returns)}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                دي اللي المحل بيدفعها من جيبه
                              </p>
                            </div>
                            <div className="rounded-xl border bg-card p-3">
                              <p className="text-muted-foreground text-xs">استبدال</p>
                              <p className="font-mono font-bold mt-1">{formatMoney(exchange)}</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                العميل دفعها برضه — بيحصّلها المندوب لينا
                              </p>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Batch settlement dialog ─────────────────────────────────────── */}
      <Dialog open={batchCourier !== null} onOpenChange={(open) => !open && setBatchCourier(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>تسوية دفعة — {batchCourier?.name}</DialogTitle>
            <DialogDescription>
              علّم الطلبات اللي التحويلة دي غطّتها واكتب المبلغ اللي وصل فعلاً. أي طلب متعلّمش يفضل
              مفتوح للتحويلة الجاية.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4 py-2">
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setTicked(
                    tickedOrders.length === openOrders.length
                      ? {}
                      : Object.fromEntries(openOrders.map((order) => [order.id, true])),
                  )
                }
              >
                {tickedOrders.length === openOrders.length ? "إلغاء التحديد" : "علّم الكل"}
              </Button>
              <span className="text-sm text-muted-foreground">
                {tickedOrders.length} من {openOrders.length} طلب
              </span>
            </div>

            <div className="rounded-xl border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead className="text-right px-3">الطلب</TableHead>
                    <TableHead className="text-right px-3">العميل</TableHead>
                    <TableHead className="text-center px-3">محصّل (COD)</TableHead>
                    <TableHead className="text-center px-3">العمولة</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openOrders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell className="px-3">
                        <Checkbox
                          checked={Boolean(ticked[order.id])}
                          onCheckedChange={(value) =>
                            setTicked((current) => ({ ...current, [order.id]: Boolean(value) }))
                          }
                        />
                      </TableCell>
                      <TableCell className="px-3 font-mono text-xs">{order.orderNumber}</TableCell>
                      <TableCell className="px-3">{order.customerName}</TableCell>
                      <TableCell className="px-3 text-center font-mono">
                        {formatMoney(order.expectedCod)}
                      </TableCell>
                      <TableCell className="px-3 text-center font-mono text-xs text-amber-600">
                        {formatMoney(order.courierFee ?? order.shippingFee ?? 0)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="net-received">المبلغ الفعلي المستلم (التحويل)</Label>
                <Input
                  id="net-received"
                  type="number"
                  min={0}
                  value={received}
                  onChange={(e) => setReceived(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-1">
                <Label>نزل في أنهي خزنة / حساب؟</Label>
                <Select value={wallet} onValueChange={(v) => setWallet(v as WalletType)}>
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

            {/* Real-time 5-point comparison & reconciliation */}
            <div className="rounded-xl border bg-muted/40 p-4 space-y-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">إجمالي التحصيل (Total COD):</span>
                <span className="font-mono font-bold">{formatMoney(summary.codTotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">العمولات والمصاريف المتوقعة (Expected Fees):</span>
                <span className="font-mono font-bold text-amber-600">
                  {formatMoney(summary.expectedFees)}
                </span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="font-medium">الصافي المتوقع (Expected Net):</span>
                <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                  {formatMoney(summary.expectedNet)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium">المبلغ الفعلي المستلم (Actual Received):</span>
                <span className="font-mono font-bold">{formatMoney(summary.netReceived)}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="font-medium">الفارق / العجز (Difference / Shortfall):</span>
                <span
                  className={
                    "font-mono font-bold text-base " +
                    (summary.shortfall > 0
                      ? "text-red-600 dark:text-red-400"
                      : summary.shortfall === 0
                        ? "text-green-600"
                        : "text-emerald-600")
                  }
                >
                  {formatMoney(Math.abs(summary.shortfall))}
                  {summary.shortfall > 0 && " (عجز)"}
                  {summary.shortfall < 0 && " (زيادة)"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground pt-1">
                {summary.shortfall > 0
                  ? "تنبيه: يوجد عجز في التحويل مقارنة بالصافي المتوقع. سيتم تسجيل الفارق كبند عجز تحصيل (مصروفات) لضمان مطابقة الخزينة دون إخفاء العجز."
                  : summary.shortfall === 0
                    ? "المبلغ المستلم يطابق تماماً الصافي المتوقع بعد خصم العمولات."
                    : "المبلغ المستلم أكبر من الصافي المتوقع للطلبات المحددة."}
              </p>
            </div>

            {batchError && (
              <div className="rounded-lg p-3 bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-900">{batchError}</p>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setBatchCourier(null)}>
              إلغاء
            </Button>
            <Button
              onClick={() => void confirmBatch()}
              disabled={isWorking || tickedOrders.length === 0}
            >
              <Wallet className="size-4 ml-2" />
              سجّل التحويلة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The history is read back from the LEDGER, not from a store list, so a
          settlement on screen is a settlement that actually moved money. */}
      {(history.length > 0 || historyError) && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-4">
            <History className="size-5 text-muted-foreground" />
            <h2 className="font-display text-xl font-bold">التحويلات اللي اتسجّلت</h2>
          </div>
          {historyError ? (
            <p className="text-sm text-red-700">تعذّرت قراءة سجل التحويلات.</p>
          ) : (
            <div className="space-y-3">
              {history.map((row) => (
                <div
                  key={row.id}
                  className="rounded-xl border bg-muted/30 p-4 flex items-center justify-between gap-3"
                >
                  <div>
                    <p className="font-medium">{row.courierName}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.at.toLocaleString("ar-EG")}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {row.orderCount} طلب — محصّل {formatMoney(row.codTotal)} · خصم{" "}
                      {formatMoney(row.codTotal - row.netReceived)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => setPrintSettlement(row)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Printer className="size-4 ml-2" />
                      طباعة كشف الحساب
                    </Button>
                    <Badge variant="outline">{formatMoney(row.netReceived)}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {printSettlement && (
        <CourierSettlementReport
          settlement={printSettlement}
          orders={orders
            .filter((o) => o.codSettlementId === printSettlement.id)
            .map((o) => ({
              orderNumber: o.orderNumber,
              expectedCod: o.expectedCod,
              fee: o.courierFee ?? o.shippingFee ?? 0,
            }))}
        />
      )}
    </div>
  );
}
