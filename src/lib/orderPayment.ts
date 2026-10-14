import { runFinancialCommand, resolvePendingFinancialCommand } from "@/lib/financialCommand";
import { getSyncIdentity } from "@/services/api/storeContext";
import { fromRemoteRow } from "@/services/api/fieldMapping";
import { useOrderStore } from "@/store/useOrderStore";
import type { EcommerceOrder } from "@/types";

interface Result { eventId: string; order: any; amountPiastres: number; replayed: boolean }
const SCOPE = "order_payment";

async function publish(result: Result, storeId: string): Promise<Result> {
  try {
    const saved = fromRemoteRow("orders", result.order) as EcommerceOrder;
    if (result.order.store_id === storeId && (await getSyncIdentity())?.storeId === storeId) {
      useOrderStore.setState(state => {
        const current = state.orders.find(o => o.id === saved.id);
        if (current && Number(current.updated_at ?? 0) > Number(saved.updated_at ?? 0)) return state;
        return { orders: state.orders.some(o => o.id === saved.id)
          ? state.orders.map(o => o.id === saved.id ? saved : o) : [saved, ...state.orders] };
      });
    }
  } catch (error) {
    // The returned command proves commitment. A cache failure must not be
    // presented as uncertain money or invite a second payment identity.
    console.warn("تم تسجيل الدفعة؛ حدّث الصفحة لإعادة قراءة الطلب.", error);
  }
  return result;
}

export async function resolvePendingOrderPayment(): Promise<Result | undefined> {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const result = await resolvePendingFinancialCommand<Result>(SCOPE);
  return result ? publish(result, identity.storeId) : undefined;
}

export async function commitOrderPayment(order: EcommerceOrder, amount: number, wallet: string): Promise<Result> {
  const identity = await getSyncIdentity();
  if (!identity) throw new Error("لا يوجد متجر مسجل");
  const result = await runFinancialCommand<Result>("order_payment", {
    orderId: order.id, amount, wallet, expectedDeposit: order.depositAmount, expectedCod: order.expectedCod,
  }, SCOPE, identity.storeId);
  return publish(result, identity.storeId);
}
