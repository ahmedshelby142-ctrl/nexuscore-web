import { getSupabaseClient } from "@/lib/supabase";
import { getSyncIdentity } from "@/services/api/storeContext";
import { assertFiniteLines } from "./ledger/money";

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
): Promise<T> {
  JSON.stringify(input, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("قيمة رقمية غير صالحة");
    return value;
  });
  const sb = getSupabaseClient();
  const identity = await getSyncIdentity();
  if (!sb || !identity) throw new Error("لا يوجد اتصال بمتجر مسجل");
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
        const { data, error } = await sb.rpc("record_financial_command", {
          p_id: op.id,
          p_store: identity.storeId,
          p_device: identity.deviceId,
          p_command: op.command,
          p_input: op.input,
        });
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
          throw new Error(`تعذّر تأكيد العملية: ${error.message}`);
        }
        last = error instanceof Error ? error.message : String(error);
        op.uncertain = true;
        if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, JSON.stringify(op));
      }
    }
    throw new Error(
      `لم يصل تأكيد العملية. أعد المحاولة للتحقق من نفس العملية دون تكرارها. ${last}`,
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

/** Ledger-only input retains the existing shared builders and EGP semantics. */
export async function appendFinancialEvent(
  event: import("./ledger/types").NewEvent,
): Promise<string> {
  assertFiniteLines(event.kind, event.lines);
  const result = await runFinancialCommand<{ eventId: string }>(
    "ledger",
    event,
    `ledger:${event.kind}`,
  );
  return result.eventId;
}
