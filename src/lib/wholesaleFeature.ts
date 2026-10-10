/** Cloud-owned store setting. Never persist this state in browser storage. */
export const wholesaleFeatureDefaults = {
  wholesaleEnabled: false,
  wholesaleStatus: "idle" as "idle" | "loading" | "ready" | "saving" | "failed",
  wholesaleError: null as string | null,
  wholesaleStoreId: null as string | null,
};

type State = typeof wholesaleFeatureDefaults;
export function createWholesaleFeatureActions(
  get: () => State,
  set: (state: Partial<State>) => void,
  deps: { client: () => any; storeId: () => Promise<string | null>; isAdmin: () => boolean },
) {
  let generation = 0;
  let pending: Promise<void> | null = null;
  const resetWholesaleFeature = () => {
    generation++;
    pending = null;
    set({ ...wholesaleFeatureDefaults });
  };
  const pullWholesaleFeature = (): Promise<void> => {
    if (pending) return pending;
    if (get().wholesaleStatus === "saving") return Promise.resolve();
    const request = ++generation;
    set({ wholesaleEnabled: false, wholesaleStatus: "loading", wholesaleError: null, wholesaleStoreId: null });
    const task = (async () => {
      try {
        const sb = deps.client();
        const storeId = await deps.storeId();
        if (!sb || !storeId) throw new Error("تعذّر تحديد المحل الحالي.");
        const { data, error } = await sb.from("stores").select("wholesale_enabled").eq("id", storeId).single();
        if (error) throw error;
        if (!data) throw new Error("تعذّر قراءة إعداد مبيعات الجملة.");
        if (request !== generation) return;
        set({ wholesaleEnabled: data.wholesale_enabled === true, wholesaleStatus: "ready", wholesaleStoreId: storeId });
      } catch {
        if (request === generation) set({ wholesaleEnabled: false, wholesaleStatus: "failed", wholesaleError: "تعذّر تحميل إعداد مبيعات الجملة. أعد المحاولة." });
      } finally {
        if (request === generation) pending = null;
      }
    })();
    pending = task;
    return task;
  };
  const saveWholesaleFeature = async (enabled: boolean) => {
    if (!deps.isAdmin()) throw new Error("تعديل مبيعات الجملة متاح لمدير المحل فقط.");
    const state = get();
    if (state.wholesaleStatus !== "ready" || !state.wholesaleStoreId) return;
    const request = ++generation;
    // Synchronous gate closes the same-tick double-toggle window.
    set({ wholesaleStatus: "saving", wholesaleError: null });
    try {
      const storeId = await deps.storeId();
      if (request !== generation) return;
      if (storeId !== state.wholesaleStoreId) throw new Error("تغير المحل الحالي.");
      const sb = deps.client();
      if (!sb) throw new Error("لا يوجد اتصال بالسحابة.");
      const { data, error } = await sb.from("stores").update({ wholesale_enabled: enabled }).eq("id", storeId).select("wholesale_enabled").single();
      if (error) throw error;
      if (!data || data.wholesale_enabled !== enabled) throw new Error("لم يتم تأكيد الحفظ.");
      if (request === generation) set({ wholesaleEnabled: enabled, wholesaleStatus: "ready" });
    } catch {
      // An uncertain save must be re-read, never advertised as the old value.
      if (request === generation) set({ wholesaleEnabled: false, wholesaleStatus: "failed", wholesaleError: "تعذّر تأكيد حفظ إعداد مبيعات الجملة. أعد تحميل الإعداد قبل المحاولة." });
    }
  };
  return { resetWholesaleFeature, pullWholesaleFeature, saveWholesaleFeature };
}
