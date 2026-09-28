import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useBusinessStore } from "./useBusinessStore";
import { useCustomerStore } from "./useCustomerStore";
import { useCourierStore } from "./useCourierStore";
import { useFinancialStore } from "./useFinancialStore";
import type {
  EcommerceOrder,
  NewEcommerceOrder,
  EcommerceOrderItem,
  EcommerceOrderStatus,
  WalletType,
  SyncAction,
} from "@/types";
import { writeThrough } from "@/services/cloudData";
import { nextDocumentNumber } from "@/services/documentNumber";
import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { fromRemoteRow, toRemoteRow } from "@/services/api/fieldMapping";
import { prepareEvent, type NewEvent } from "@/lib/ledger";


/**
 * An order line as the entry screen has it — no `id` yet, and a bundle is
 * still one line rather than its components.
 */
export type OrderItemInput = Omit<EcommerceOrderItem, "id"> & {
  bundleId?: string;
  bundleName?: string;
  sku?: string;
};

type CreateEcommerceOrder = Omit<
  NewEcommerceOrder,
  // `items` too: the input lines have no ids yet (`OrderItemInput`), and
  // intersecting them with the stored `EcommerceOrderItem[]` demanded ids the
  // caller cannot have.
  "id" | "orderNumber" | "status" | "createdAt" | "updatedAt" | "revenueLogged" | "stockItems" | "items"
> & {
  /**
   * The order number, when the caller has already allocated it.
   *
   * It needs to be allocatable BEFORE this call because `order_placed` is
   * appended to the ledger first — that event reserves the stock and banks the
   * deposit — and a ledger event that cannot name its document is a movement
   * nobody can trace. Every other event in an order's life carries
   * `refId: orderNumber`; this is what lets the opening one carry it too.
   *
   * Optional so the جملة caller, which appends no `order_placed` and so needs
   * no link, is unaffected — `addOrder` draws its number from the same counter
   * on its behalf.
   */
  orderNumber?: string;
  items: OrderItemInput[];
  status?: EcommerceOrderStatus;
  /**
   * The expanded per-product lines (bundles already broken out) that the
   * caller appended to the ledger. Passed in rather than recomputed so the
   * document and the `order_placed` event describe the same movement.
   */
  stockItems: EcommerceOrderItem[];
  /** Cost of those units, from the ledger's weighted average. */
  cogsAmount: number;
};

interface OrderState {
  syncQueue: SyncAction[];
  flushSyncQueue: () => Promise<void>;
  orders: EcommerceOrder[];
  addOrder: (
    order: CreateEcommerceOrder,
  ) => Promise<{ success: true; order: EcommerceOrder } | { success: false; reason: string }>;
  /**
   * Write an online order AND its `order_placed` in one database transaction
   * (`place_order`, migration 045). See the method for the retry contract.
   */
  placeOrder: (
    order: CreateEcommerceOrder & { orderNumber: string },
    placement: NewEvent,
  ) => Promise<PlaceOrderResult>;
  /**
   * Confirm a returned online order in ONE database transaction
   * (`confirm_order_return`, migration 050). See the method.
   */
  /** Cancel a pending order in ONE transaction (`cancel_order`, 051). */
  cancelOrder: (input: {
    orderId: string;
    cause: "customer" | "courier" | "shop";
    event: NewEvent;
  }) => Promise<EcommerceOrder>;
  confirmOrderReturn: (input: {
    orderId: string;
    cause: "customer" | "courier" | "shop";
    movement: "return" | "exchange";
    events: NewEvent[];
    customerId?: string | null;
  }) => Promise<EcommerceOrder>;
  updateOrderStatus: (id: string, status: EcommerceOrderStatus) => Promise<void>;
  updateOrder: (id: string, updates: Partial<EcommerceOrder>) => Promise<void>;
}

export type PlaceOrderResult =
  | { success: true; order: EcommerceOrder; replayed: boolean }
  /**
   * `definite`: the database answered and refused, so its transaction rolled
   * back and NOTHING exists. When false the answer never arrived — the order
   * may or may not have been placed, and only a retry with the SAME number can
   * tell (it returns the existing order instead of placing a second one).
   */
  | { success: false; reason: string; definite: boolean };

/**
 * Expand an order's lines into the products that actually leave the shelf:
 * a bundle becomes its components, a plain product stays itself.
 *
 * Exported because the caller needs these exact rows to build the
 * `order_placed` ledger lines before the order document is recorded.
 */
/**
 * Send one order to the cloud and commit what came back.
 *
 * The FULL merged record goes out, never the caller's partial patch — upserting
 * `{id, status}` alone would blank every other column.
 *
 * Throws on failure, having committed nothing. That is the point: an order that
 * did not reach the database must not sit on screen looking as if it did.
 */
async function saveOrder(
  set: (fn: (state: any) => any) => void,
  // A new order may leave the defaulted columns to Postgres; what comes back
  // (and what the store keeps) is the full stored row.
  order: NewEcommerceOrder,
): Promise<EcommerceOrder> {
  const saved = (await writeThrough("orders", order)) as EcommerceOrder;
  set((state: any) => {
    const at = state.orders.findIndex((o: EcommerceOrder) => o.id === saved.id);
    if (at < 0) return { orders: [saved, ...state.orders] };
    const next = state.orders.slice();
    next[at] = { ...next[at], ...saved };
    return { orders: next };
  });
  return saved;
}

/**
 * The document both `addOrder` and `placeOrder` write: ids, timestamps, and
 * the customer found or created for it. One builder, so the two paths cannot
 * describe the same order differently.
 */
async function buildNewOrder(orderData: CreateEcommerceOrder, orderNumber: string): Promise<NewEcommerceOrder> {
  const now = new Date();
  const order: NewEcommerceOrder = {
    ...orderData,
    id: crypto.randomUUID(),
    orderNumber,
    status: orderData.status || "pending",
    items: orderData.items.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
      sku: item.sku ?? "",
    })),
    createdAt: now,
    updatedAt: now,
    // Epoch-ms sync clock, distinct from `updatedAt` above. What the
    // inbound pull filters and compares on.
    updated_at: Date.now(),
    revenueLogged: false,
  };

  // Find-or-create the person, and put THEIR ID on the order. The id
  // is what `order_delivered` keys `customer_ltv` to, and what قاعدة
  // العملاء filters this order's history by — so a second order from the
  // same phone lands on the same record instead of opening a new one.
  // Reference data: no ledger event, nothing here moves money.
  order.customerId = await useCustomerStore.getState().upsertCustomerFromOrder(order);
  return order;
}

/** The database's refusals, in the operator's language. */
function returnErrorMessage(message: string): string {
  if (message.includes("NEXUS_RETURN_ALREADY_CONFIRMED")) return "المرتجع ده اتأكد استلامه قبل كده.";
  if (message.includes("NEXUS_CAUSE_NOT_AUTHORISED"))
    return "تسجيل سبب المرتجع على المندوب أو المتجر للمدير أو المحاسب فقط.";
  if (message.includes("NEXUS_ORDER_NOT_RETURNED")) return "الطلب مش في حالة مرتجع.";
  if (message.includes("NEXUS_CAUSE_REQUIRED")) return "اختار سبب المرتجع الأول.";
  if (message.includes("NEXUS_ORDER_ALREADY_CANCELLED")) return "الطلب ده اتلغى قبل كده.";
  if (message.includes("NEXUS_ORDER_NOT_CANCELLABLE"))
    return "الطلب خرج من المحل — مش ممكن يتلغي. لو رجع، سجّله كمرتجع.";
  return message;
}

export function expandStockItems(items: OrderItemInput[]) {
  const products = useBusinessStore.getState().products;
  const productMap = new Map(products.map((product) => [product.id, product]));
  const stockItems: EcommerceOrderItem[] = [];

  for (const item of items) {
    const bundle = item.bundleId ? productMap.get(item.bundleId) : undefined;
    if (bundle && bundle.isBundle && bundle.bundleItems) {
      for (const component of bundle.bundleItems) {
        const product = productMap.get(component.productId);
        stockItems.push({
          id: crypto.randomUUID(),
          productId: component.productId,
          productName: product?.name || component.productId,
          sku: product?.sku || "",
          quantity: component.quantity * item.quantity,
          unitPrice: 0,
          variantName: component.variantName,
          bundleId: bundle.id,
          bundleName: item.bundleName || bundle.name,
        });
      }
      continue;
    }

    const product = productMap.get(item.productId);
    stockItems.push({
      id: crypto.randomUUID(),
      productId: item.productId,
      productName: product?.name || item.productName || "",
      sku: product?.sku || item.sku || "",
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      // Carried, not dropped: the first is what every restock path keys on,
      // the second is what تقرير النواقص sums.
      variantName: item.variantName,
      shortfall: item.shortfall,
      bundleId: item.bundleId,
      bundleName: item.bundleName,
    });
  }

  return stockItems;
}

/**
 * Transitions already on the wire.
 *
 * Module-level, not per-component: the same order row is rendered by several
 * screens and each holds its own React state, so a component-scoped flag would
 * not see a duplicate raised from anywhere else.
 */
const statusInFlight = new Set<string>();

export const useOrderStore = create<OrderState>()(
  persist(
    (set, get) => ({
      syncQueue: [],
      // No-op: nothing queues any more, every write is awaited.
      flushSyncQueue: async () => {},
      orders: [],

      // Records the order document only. Stock is NOT touched here — the
      // `order_placed` event the caller appends reserves it — and the cost
      // comes in from the ledger's weighted average rather than being guessed
      // at 65% of retail, which is what the old `productCost()` fallback did.
      addOrder: async (orderData) => {

        // Allocated by Postgres when the caller has not already drawn one —
        // the same counter `FJ-`, `FM-` and `SP-` come from (migration 016),
        // now with an `ecommerce_order` sequence and a unique index behind it
        // (migration 042).
        //
        // It used to be `ECO-${Date.now()}`: a DEVICE clock reading, so a till
        // set a day back issued numbers that sorted before yesterday's orders,
        // two tills in the same millisecond produced the same document number,
        // and nothing in the database said no. Read down a phone it was
        // thirteen digits of nothing.
        //
        // Failing here refuses the order rather than falling back to a local
        // guess, for the reason `nextDocumentNumber` gives: a number two
        // documents might share is worse than a document that was not created.
        // Reported as a `reason`, not thrown — the جملة caller does not wrap
        // this call, and an unhandled rejection there would be silence.
        let orderNumber: string;
        try {
          orderNumber = orderData.orderNumber || (await nextDocumentNumber("ecommerce_order", "ECO-"));
        } catch (e) {
          return {
            success: false as const,
            reason: e instanceof Error ? e.message : String(e),
          };
        }

        const order = await buildNewOrder(orderData, orderNumber);

        // Nothing lands in `orders` until Supabase has the row. `saveOrder`
        // both writes and commits, so there is no window where the screen shows
        // an order the database never accepted.
        try {
          const saved = await saveOrder(set, order);
          return { success: true as const, order: saved };
        } catch (e) {
          return {
            success: false as const,
            reason: e instanceof Error ? e.message : String(e),
          };
        }
      },

      /**
       * An online order and its placement, as ONE database transaction.
       *
       * `order_placed` (stock out + the deposit in) used to be appended BEFORE
       * this order row was written, in a separate request — so the deposit
       * reached the ledger with no document to be measured against, and a
       * refused row left money and a reservation behind with nothing pointing
       * at them (21 such events in production). `place_order` inserts the row
       * and appends the event together, and `ledger_validate_event` (046)
       * refuses a deposit the row does not account for. Either both exist or
       * neither does.
       *
       * The caller owns the number and must reuse it on retry: the RPC is
       * idempotent on (store, orderNumber), so a retry after a lost answer
       * returns the order that was already placed (`replayed`) instead of a
       * second order and a second deposit.
       */
      placeOrder: async (orderData, placement) => {
        const sb = getSupabaseClient();
        const identity = await getSyncIdentity();
        if (!sb || !identity) {
          return { success: false as const, reason: "لا يوجد اتصال بالسحابة", definite: true };
        }
        try {
          const order = await buildNewOrder(orderData, orderData.orderNumber);
          const p_order = toRemoteRow("orders", order, {
            storeId: identity.storeId,
            deviceId: identity.deviceId,
            stamp: Date.now(),
          });
          const p_event = await prepareEvent(placement);
          const { data, error } = await sb.rpc("place_order", { p_order, p_event });
          if (error) {
            // A PostgREST/Postgres error carries a code: the server answered,
            // and its transaction is gone. No code means the request itself
            // failed and the outcome is unknown.
            return { success: false as const, reason: error.message, definite: Boolean(error.code) };
          }
          const saved = fromRemoteRow("orders", (data as any).order) as EcommerceOrder;
          set((state: any) => {
            const at = state.orders.findIndex((o: EcommerceOrder) => o.id === saved.id);
            if (at < 0) return { orders: [saved, ...state.orders] };
            const next = state.orders.slice();
            next[at] = { ...next[at], ...saved };
            return { orders: next };
          });
          return { success: true as const, order: saved, replayed: (data as any).replayed === true };
        } catch (e) {
          // Thrown before or during the request — nothing confirms either way.
          return { success: false as const, reason: e instanceof Error ? e.message : String(e), definite: false };
        }
      },

      /**
       * The return confirmation, all or nothing.
       *
       * It used to be three requests — the ledger event(s), the customer's
       * wasted trip, then the order's `returnConfirmedAt` + `return_cause`.
       * When the last one was refused (a role that may not record a courier or
       * shop cause) the ledger had already moved while the order still looked
       * unconfirmed, and a second press booked the return a second time.
       * `confirm_order_return` stamps the order under a row lock, appends the
       * events and counts the trip together; any refusal rolls all of it back,
       * and a repeat is refused with `NEXUS_RETURN_ALREADY_CONFIRMED`.
       *
       * Throws on any failure, having committed nothing locally.
       */
      /**
       * A pending order called off, all or nothing (`cancel_order`, 051):
       * status, cause and the `order_cancelled` event in one transaction under
       * a row lock. It used to be three requests; a failure between them left
       * stock and money moved behind an order still showing «pending», and a
       * second press booked it again. A repeat is refused with
       * `NEXUS_ORDER_ALREADY_CANCELLED`. Throws, having committed nothing.
       */
      cancelOrder: async ({ orderId, cause, event }) => {
        const sb = getSupabaseClient();
        if (!sb) throw new Error("لا يوجد اتصال بالسحابة");
        const p_event = await prepareEvent(event);
        const { data, error } = await sb.rpc("cancel_order", {
          p_order_id: orderId,
          p_cause: cause,
          p_event,
        });
        // The cause-trigger codes pass through raw: the cancel dialog words
        // them for a cancellation, not a return.
        if (error) {
          const m = error.message;
          throw new Error(
            m.includes("NEXUS_ORDER_ALREADY_CANCELLED") || m.includes("NEXUS_ORDER_NOT_CANCELLABLE")
              ? returnErrorMessage(m)
              : m,
          );
        }
        const saved = fromRemoteRow("orders", (data as any).order) as EcommerceOrder;
        set((state: any) => ({
          orders: state.orders.map((o: EcommerceOrder) => (o.id === saved.id ? { ...o, ...saved } : o)),
        }));
        return saved;
      },

      confirmOrderReturn: async ({ orderId, cause, movement, events, customerId }) => {
        const sb = getSupabaseClient();
        if (!sb) throw new Error("لا يوجد اتصال بالسحابة");
        const p_events: Awaited<ReturnType<typeof prepareEvent>>[] = [];
        for (const event of events) p_events.push(await prepareEvent(event));
        const { data, error } = await sb.rpc("confirm_order_return", {
          p_order_id: orderId,
          p_cause: cause,
          p_movement: movement,
          p_events,
          p_customer_id: customerId ?? null,
        });
        if (error) throw new Error(returnErrorMessage(error.message));
        const saved = fromRemoteRow("orders", (data as any).order) as EcommerceOrder;
        set((state: any) => ({
          orders: state.orders.map((o: EcommerceOrder) => (o.id === saved.id ? { ...o, ...saved } : o)),
        }));
        const customer = (data as any).customer;
        if (customer) {
          const row = fromRemoteRow("customers", customer) as any;
          useCustomerStore.setState((state: any) => ({
            customers: state.customers.map((c: any) => (c.id === row.id ? { ...c, ...row } : c)),
          }));
        }
        return saved;
      },

      // Moves the order document between states. It moves NO money and NO
      // stock: each transition's effect is the ledger event the caller appends
      // first (`order_delivered`, `order_returned_pending`). The courier
      // receivable is a ledger line now, not a row in the financial store, so
      // there is one answer to "what does this courier owe us".
      updateOrderStatus: async (id, status) => {
        // `updateOrderStatus` is called BARE from onClick — `onClick={() =>
        // updateOrderStatus(order.id, "shipped")}` — so there is no handler for
        // a submit gate to sit on. Three clicks on تسليم للمندوب sent three
        // PATCHes. The guard therefore lives here, where all four call sites
        // share it, keyed by the transition rather than the order: the same
        // order legitimately moves shipped → delivered later, and only a
        // REPEAT of the identical move is dropped.
        const key = id + ":" + status;
        if (statusInFlight.has(key)) return;
        statusInFlight.add(key);
        try {
        set((state) => {
          const order = state.orders.find((item) => item.id === id);
          if (!order) return state;

          // Keep the courier receivable ROW for the shipping screen's
          // per-courier drill-down (§3.9) — it is a document, not a balance.
          if (status === "shipped" && order.status !== "shipped") {
            useFinancialStore.getState().createCourierReceivable({
              orderId: order.id,
              courierId: order.courierId || "default",
              courierName: order.courierName || "غير محدد",
              orderTotal: order.totalAmount,
              courierFee: order.courierFee,
              amountDue: order.totalAmount - order.courierFee,
              status: "pending",
            });
          }

          return {
            orders: state.orders.map((item) =>
              item.id === id
                ? {
                    ...item,
                    status,
                    updatedAt: new Date(),
                    updated_at: Date.now(),
                    revenueLogged:
                      status === "delivered"
                        ? true
                        : status === "returned"
                          ? false
                          : item.revenueLogged,
                  }
                : item,
            ),
          };
        });

        // An order's STATUS is the e-commerce flow. Without this the document
        // moved to "shipped" on one device and stayed "pending" on every other
        // one — the local write happened, the push never did.
        //
        // The `set` above is kept because a status change also fires the
        // courier-receivable side effect, and the transition has to be visible
        // to it. `saveOrder` then reconciles against the row Postgres stored.
        const order = get().orders.find((o) => o.id === id);
        if (order) await saveOrder(set, order);
        } finally {
          statusInFlight.delete(key);
        }
      },

      updateOrder: async (id, updates) => {
        const current = get().orders.find((o) => o.id === id);
        if (!current) return;
        await saveOrder(set, {
          ...current,
          ...updates,
          updatedAt: new Date(),
          updated_at: Date.now(),
        });
      },
    }),
    {
      name: "order-storage",
      // Orders are owned by Supabase and hydrated from it on boot. Persisting
      // them would put the stale-cache problem straight back.
      partialize: () => ({}),
    },
  ),
);
