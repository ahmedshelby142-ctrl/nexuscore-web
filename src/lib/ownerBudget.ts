import { getSupabaseClient } from "@/lib/supabase";
import { getActiveStoreId } from "@/services/api/storeContext";
import type { OwnerBudget } from "./ledger/ownerDraw";

async function context() {
  const client = getSupabaseClient();
  const storeId = await getActiveStoreId();
  if (!client || !storeId) throw new Error("لا يوجد اتصال بمتجر مسجل");
  return { client, storeId };
}

/** Backend absence is unconfigured. Browser-local settings are never imported. */
export async function readOwnerBudget(): Promise<OwnerBudget | null> {
  const { client, storeId } = await context();
  const { data, error } = await client
    .from("owner_budgets")
    .select("budget_limit,period_type,started_at")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data
    ? {
        limit: Number(data.budget_limit),
        periodType: data.period_type,
        startedAt: new Date(data.started_at).getTime(),
      }
    : null;
}

/** Explicit settings save; retrying the same value has no monetary effect. */
export async function saveOwnerBudget(budget: OwnerBudget): Promise<void> {
  if (
    !Number.isFinite(budget.limit) ||
    budget.limit <= 0 ||
    !Number.isFinite(budget.startedAt) ||
    !["monthly", "open"].includes(budget.periodType)
  )
    throw new Error("بيانات الميزانية غير صالحة");
  const { client, storeId } = await context();
  const { error } = await client
    .from("owner_budgets")
    .upsert(
      {
        store_id: storeId,
        budget_limit: budget.limit,
        period_type: budget.periodType,
        started_at: new Date(budget.startedAt).toISOString(),
      },
      { onConflict: "store_id" },
    );
  if (error) throw new Error(error.message);
  window.dispatchEvent(new Event("owner-budget-changed"));
}

/** Removes only the setting, never a draw or any ledger history. */
export async function clearOwnerBudget(): Promise<void> {
  const { client, storeId } = await context();
  const { error } = await client.from("owner_budgets").delete().eq("store_id", storeId);
  if (error) throw new Error(error.message);
  window.dispatchEvent(new Event("owner-budget-changed"));
}
