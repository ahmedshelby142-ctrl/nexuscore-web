import { runFinancialCommand, resolvePendingFinancialCommand } from "@/lib/financialCommand";
import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { useOrderStore } from "@/store/useOrderStore";
import { useCustomerStore } from "@/store/useCustomerStore";
import {operationalSource} from "@/services/operationalSource";

const SCOPE = "ledger:courier_settlement";
export interface CourierBatchResult {
  eventId: string;
  orderIds: string[];
  codPiastres: number;
  feePiastres: number;
  netPiastres: number;
  shortfallPiastres: number;
  replayed: boolean;
  closedOrderIds?: string[];
  closedClaimIds?: string[];
}
export interface CourierObligation {
  orderId: string; orderNumber: string; courierId: string;
  codPiastres: number; feePiastres: number; reviewReason?: string | null;
}
export async function readCourierObligations(): Promise<CourierObligation[]> {
  const sb = getSupabaseClient(), identity = await getSyncIdentity();
  if (!sb || !identity) throw new Error("لا يوجد متجر مسجل");
  const { data, error } = await sb.rpc("read_courier_obligations", { p_store: identity.storeId });
  if (error) throw new Error("تعذّر قراءة المستحقات الفعلية للمندوب. حدّث العرض قبل التسوية.");
  if ((await getSyncIdentity())?.storeId !== identity.storeId) throw new Error("تغيّر المتجر أثناء القراءة");
  return data as CourierObligation[];
}
async function refreshOrders<T extends { orderIds: string[]; customer?: any }>(result: T, storeId: string) {
  // A legacy pending ledger-only transfer must never be mistaken for an
  // atomic batch, or automatically stamped against a different selection.
  if (!Array.isArray(result.orderIds))
    throw new Error("تم تأكيد حركة تسوية سابقة؛ يلزم مراجعة إغلاق طلباتها قبل تسوية جديدة.");
  try {
    const sb = getSupabaseClient(), identity = await getSyncIdentity();
    if (!sb || !identity || identity.storeId !== storeId) return result;
    const { data, error } = await sb.from(operationalSource("orders")).select("*")
      .eq("store_id", identity.storeId).in("id", result.orderIds);
    if (error) throw error;
    if ((await getSyncIdentity())?.storeId !== identity.storeId) return result;
    const rows = new Map((data ?? []).map(row => [row.id, fromRemoteRow("orders", row)]));
    useOrderStore.setState(state => ({ orders: state.orders.map(order => {
      const saved = rows.get(order.id);
      return saved && Number(saved.updated_at ?? 0) >= Number(order.updated_at ?? 0) ? saved : order;
    }) }));
    if (result.customer?.id && result.customer.store_id === storeId) {
      // Read the current row: a replay's original counter snapshot may predate
      // another legitimate return or delivery. This read cannot move money.
      const reply = await sb.from("customers").select("*").eq("store_id", storeId).eq("id", result.customer.id).single();
      if (reply.error) throw reply.error;
      if ((await getSyncIdentity())?.storeId !== storeId || !reply.data) return result;
      const saved = fromRemoteRow("customers", reply.data);
      useCustomerStore.setState(state => ({ customers: state.customers.map(customer =>
        customer.id === saved.id && Number(saved.updated_at ?? 0) >= Number(customer.updated_at ?? 0) ? saved : customer) }));
    }
  } catch (error) {
    // The financial command already committed. Never resubmit it or report
    // that no balance moved because an optional read/cache refresh failed.
    console.warn("تم تسجيل التسوية؛ حدّث الصفحة لإعادة قراءة الطلبات.", error);
  }
  return result;
}
export async function resolvePendingCourierBatch() {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const prior = await resolvePendingFinancialCommand<CourierBatchResult>(SCOPE);
  return prior ? refreshOrders(prior, identity.storeId) : undefined;
}
export async function commitCourierBatch(input: {
  courierId: string; courierName: string; orderIds: string[]; wallet: string; netReceived: number;
  allocations?: { orderId: string; codPiastres: number; feePiastres: number; expectedCodPiastres?: number; expectedFeePiastres?: number }[];
  claimIds?: string[];
}) {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const result = await runFinancialCommand<CourierBatchResult>("courier_batch", input, SCOPE, identity.storeId);
  return refreshOrders(result, identity.storeId);
}

export interface OrderDeliveryResult { eventId: string; orderIds: string[]; settlementEventId: string | null; replayed: boolean; customer?: any }
export async function resolvePendingOrderDelivery() {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const prior = await resolvePendingFinancialCommand<OrderDeliveryResult>("order_delivery");
  return prior ? refreshOrders(prior, identity.storeId) : undefined;
}
export async function commitOrderDelivery(input: { orderId: string; settle: boolean; wallet: string; netReceived: number }) {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  return refreshOrders(await runFinancialCommand<OrderDeliveryResult>("order_delivery", input, "order_delivery", identity.storeId), identity.storeId);
}
