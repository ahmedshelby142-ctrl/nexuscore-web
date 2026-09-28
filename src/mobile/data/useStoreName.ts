/**
 * The shop's name, for the "who is writing" line of a WhatsApp draft.
 *
 * Read from `stores.name` (readable by every member of the store). NOT
 * `useSettingsStore.storeName`: mobile never pulls settings, so that holds the
 * local default «محلي» — a name the shop never chose. On failure this is
 * `null` and the message simply leaves the line out.
 */
import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase";
import { getActiveStoreId } from "@/services/api/storeContext";

let cached: { storeId: string; name: Promise<string | null> } | null = null;

async function readStoreName(): Promise<string | null> {
  const storeId = await getActiveStoreId();
  const sb = getSupabaseClient();
  if (!storeId || !sb) return null;
  // Keyed on the store: a sign-in to another shop must not inherit this name.
  if (cached?.storeId !== storeId) {
    cached = {
      storeId,
      name: Promise.resolve(sb.from("stores").select("name").eq("id", storeId).maybeSingle()).then(
        ({ data, error }) => (error ? null : String(data?.name ?? "").trim() || null),
      ),
    };
    // A failed read is not remembered; the next screen asks again.
    void cached.name.then((name) => {
      if (name === null) cached = null;
    });
  }
  return cached.name;
}

export function useStoreName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void readStoreName()
      .then((n) => {
        if (active) setName(n);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return name;
}
