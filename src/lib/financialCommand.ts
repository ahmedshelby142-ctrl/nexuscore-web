import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { assertFiniteLines } from "./ledger/money.ts";

/** Only retry metadata lives here. Balances and committed results live in Postgres. */
type Pending = { id: string; command: string; input: unknown; uncertain?: boolean };
const pending = new Map<string, Pending>();
const running = new Map<string, Promise<any>>();
const PREFIX = "nexus-financial-pending:";
const stable = (value: any): any =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stable(value[k])]),
        )
      : value;
const signature = (value: unknown) => JSON.stringify(stable(JSON.parse(JSON.stringify(value))));

function markPending() {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-pwa-unsaved", String(pending.size > 0));
  }
}

/**
 * A logical command keeps its event ID and original request until resolved.
 * A lost response is retried automatically once. Later retries (including a
 * page reload) use the same session-scoped envelope, never a new monetary ID.
 * A changed draft first resolves the old request and asks for review; it is
 * never silently substituted for an uncertain operation.
 */
export async function runFinancialCommand<T>(
  command: string,
  input: unknown,
  scope = command,
  expectedStoreId?: string,
): Promise<T> {
  JSON.stringify(input, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("قيمة رقمية غير صالحة");
    return value;
  });
  const sb = getSupabaseClient();
  const identity = await getSyncIdentity();
  if (!sb || !identity) throw new Error("لا يوجد اتصال بمتجر مسجل");
  if (expectedStoreId && identity.storeId !== expectedStoreId)
    throw new Error("تغيّر المتجر؛ راجع البيانات قبل إرسال العملية.");
  const key = PREFIX + identity.storeId + ":" + scope;
  if (running.has(key)) {
    const active = pending.get(key);
    if (active && signature(active.input) !== signature(input))
      throw new Error("انتظر تأكيد العملية الجارية قبل تغيير بياناتها.");
    return running.get(key);
  }
  let op = pending.get(key);
  if (!op && typeof sessionStorage !== "undefined") {
    const saved = sessionStorage.getItem(key);
    if (saved) op = JSON.parse(saved);
  }
  const request = JSON.parse(JSON.stringify(input));
  const changed = !!op && (op.command !== command || signature(op.input) !== signature(request));
  op ??= { id: crypto.randomUUID(), command, input: request };
  pending.set(key, op);
  // Fail before sending if retry identity cannot be retained across reload.
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, JSON.stringify(op));
  markPending();
  const clear = () => {
    pending.delete(key);
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(key);
    markPending();
  };
  const execute = async () => {
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rpc =
          op.command === "cashier_shift"
            ? "record_cashier_shift"
            : op.command === "document_number"
            ? "record_document_number"
            : op.command === "order_place"
            ? "place_order"
            : op.command === "product_catalog"
              ? "record_product_catalog"
            : op.command === "product_archive"
              ? "record_product_archive"
            : op.command === "product_import"
              ? "record_product_import"
            : op.command === "order_cancel"
              ? "record_order_cancel"
            : op.command === "exchange_credit_refund"
              ? "record_exchange_credit_refund"
            : op.command === "order_payment"
              ? "record_order_payment"
            : op.command === "pos_sale"
              ? "record_pos_sale"
            : op.command === "stock_event"
              ? "record_stock_command"
            : op.command === "order_delivery"
              ? "record_order_delivery"
              : op.command === "pos_exchange"
                ? "record_pos_exchange"
              : op.command === "courier_batch"
                ? "record_courier_batch"
              : op.command === "cod_service_fee"
                ? "record_cod_service_fee"
              : op.command === "asset_deactivate"
                ? "deactivate_fixed_asset"
              : op.command === "asset_record"
                ? "record_asset_command"
              : op.command === "asset_opening_date"
                ? "correct_opening_asset_date"
              : op.command === "order_edit"
                ? "record_order_edit"
                : op.command === "bundle_edit"
                  ? "record_bundle_edit"
                  : op.command === "exchange_place"
                    ? "record_exchange_place"
                    : op.command === "exchange_return"
                      ? "record_exchange_return"
                : "record_financial_command";
        const { data, error } = await sb.rpc(
          rpc,
          op.command === "order_place"
            ? {
                p_order: (op.input as any).order,
                p_event: (op.input as any).event,
              }
            : {
                p_id: op.id,
                p_store: identity.storeId,
                p_device: identity.deviceId,
                p_command: op.command,
                p_input: op.input,
              },
        );
        if (error) {
          last = error.message;
          // A SQL rejection is definite for this attempt. Retain the identity
          // after an earlier uncertain attempt: it may still have committed.
          const definite = /^(22|23|42|P0001)/.test(error.code ?? "");
          if (definite && !op.uncertain) clear();
          if (definite) throw Object.assign(new Error(error.message), { definite: true });
          op.uncertain = true;
          if (typeof sessionStorage !== "undefined")
            sessionStorage.setItem(key, JSON.stringify(op));
          continue;
        }
        if ((op.command==="asset_record"||op.command==="asset_deactivate"||op.command==="asset_opening_date") &&
          (!data?.asset || data.asset.id!==(op.command==="asset_record"?op.id:(op.input as any).assetId) || data.asset.store_id!==identity.storeId))
          throw new Error("لم يصل تأكيد صالح لمستند الأصل؛ أعد قراءة نفس العملية.");
        if(op.command==="cod_service_fee"&&(!data?.order||data.order.id!==(op.input as any).orderId||data.order.store_id!==identity.storeId))
          throw new Error("لم يصل تأكيد صالح لتصحيح رسوم التحصيل؛ أعد قراءة نفس العملية.");
        if(op.command==="cashier_shift"&&(data?.requestId!==op.id||data?.action!==(op.input as any).action))
          throw new Error("لم يصل تأكيد صالح لإجراء الوردية؛ تحقّق من نفس المحاولة دون تكرار الإقفال أو التسليم.");
        if(op.command==="cashier_shift"&&data?.rejected===true){
          // The server persisted a negative receipt. The original ID can NEVER commit later.
          op.uncertain=false;clear();
          throw Object.assign(new Error(String(data.code??"NEXUS_SHIFT_INVALID")),{definite:true});
        }
        clear();
        if (changed)
          throw Object.assign(
            new Error("تم التأكد من تسجيل العملية السابقة. راجع السجل قبل تسجيل عملية جديدة."),
            { resolved: true },
          );
        return data as T;
      } catch (error: any) {
        if (error.resolved) throw error;
        if (error.definite) {
          // Keep the envelope on a payload/authorization rejection; never
          // turn an unknown previous commit into a fresh ID automatically.
          throw Object.assign(new Error(`تعذّر تأكيد العملية: ${error.message}`), {
            definite: !op.uncertain,
          });
        }
        last = error instanceof Error ? error.message : String(error);
        op.uncertain = true;
        if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, JSON.stringify(op));
      }
    }
    throw Object.assign(
      new Error(`لم يصل تأكيد العملية. أعد المحاولة للتحقق من نفس العملية دون تكرارها. ${last}`),
      { definite: false },
    );
  };
  const promise = execute().finally(() => running.delete(key));
  running.set(key, promise);
  return promise;
}

/** Resolve an unfinished product opening before a caller creates another product. */
export async function resolvePendingOpeningBalance(): Promise<void> {
  const identity = await getSyncIdentity();
  if (!identity || typeof sessionStorage === "undefined") return;
  const prefix = PREFIX + identity.storeId + ":ledger:stock_adjustment";
  const keys = Object.keys(sessionStorage).filter((key) => key.startsWith(prefix));
  for (const key of keys) {
    const op: Pending = JSON.parse(sessionStorage.getItem(key)!);
    await runFinancialCommand(
      op.command,
      op.input,
      key.slice((PREFIX + identity.storeId + ":").length),
    );
  }
  if (keys.length)
    throw new Error(
      "تم تأكيد الرصيد الافتتاحي السابق. حدّث قائمة المنتجات وراجعها قبل إنشاء منتج آخر.",
    );
}

/** Resolve the original till request before rechecking stock or code limits. */
export async function resolvePendingFinancialEvent(kind: string): Promise<string | null> {
  const result = await resolvePendingFinancialCommand<{ eventId: string }>(`ledger:${kind}`);
  return result?.eventId ?? null;
}

/** Replay the saved envelope before draft/status/stock prechecks can block it. */
export async function resolvePendingFinancialCommand<T>(scope: string): Promise<T | null> {
  const identity = await getSyncIdentity();
  if (!identity) return null;
  const key = PREFIX + identity.storeId + ":" + scope;
  const saved = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key);
  const op: Pending | undefined = pending.get(key) ?? (saved ? JSON.parse(saved) : undefined);
  if (!op) return null;
  return runFinancialCommand<T>(op.command, op.input, scope);
}

/** Ledger-only input retains the existing shared builders and EGP semantics. */
export interface FinancialReceipt { eventId: string; documentNumber?: string; sourceDocumentNumber?: string }
export function appendFinancialEvent(event: import("./ledger/types").NewEvent): Promise<string>;
export function appendFinancialEvent(event: import("./ledger/types").NewEvent, options: { receipt: true }): Promise<FinancialReceipt>;
export async function appendFinancialEvent(
  event: import("./ledger/types").NewEvent,
  options?: { receipt: true },
): Promise<string | FinancialReceipt> {
  assertFiniteLines(event.kind, event.lines);
  const result = await runFinancialCommand<FinancialReceipt>(
    event.kind === "sale" && event.refType === "pos_sale" ? "pos_sale"
      : event.lines.some(line => line.account === "stock") && event.refType !== "opening_balance"
        ? "stock_event" : "ledger",
    event,
    `ledger:${event.kind}`,
  );
  return options?.receipt ? result : result.eventId;
}
