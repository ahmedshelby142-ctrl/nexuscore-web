import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useBusinessStore } from "./useBusinessStore";
import { useCustomerStore } from "./useCustomerStore";
import { useCourierStore } from "./useCourierStore";
import { useFinancialStore } from "./useFinancialStore";
import type {
  EcommerceOrder,
  EcommerceOrderItem,
  EcommerceOrderStatus,
  WalletType,
  SyncAction,
} from "@/types";
import { writeThrough } from "@/services/cloudData";


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
  EcommerceOrder,
  "id" | "orderNumber" | "status" | "createdAt" | "updatedAt" | "revenueLogged" | "stockItems"
> & {
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
  updateOrderStatus: (id: string, status: EcommerceOrderStatus) => Promise<void>;
  updateOrder: (id: string, updates: Partial<EcommerceOrder>) => Promise<void>;
}

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
  order: EcommerceOrder,
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
        const now = new Date();
        const orderId = crypto.randomUUID();
        const order: EcommerceOrder = {
          ...orderData,
          id: orderId,
          orderNumber: `ECO-${Date.now()}`,
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

      // Moves the order document between states. It moves NO money and NO
      // stock: each transition's effect is the ledger event the caller appends
      // first (`order_delivered`, `order_returned_pending`). The courier
      // receivable is a ledger line now, not a row in the financial store, so
      // there is one answer to "what does this courier owe us".
      updateOrderStatus: async (id, status) => {
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
