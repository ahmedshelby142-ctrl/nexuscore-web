import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getSupabaseClient } from "@/lib/supabase";
import { getActiveStoreId } from "@/services/api/storeContext";

export interface StoreSettings {
  storeName: string;
  storeLogoUrl: string;
  phoneNumber: string;
  address: string;
  taxNumber: string;
  vatRate: number;
}

/**
 * Whether the values above are the SERVER's. Not persisted — a status restored
 * from localStorage would vouch for a read that never happened this session.
 *
 * `idle` (never pulled) and `failed` mean the fields hold either a cached copy
 * or the defaults, and pushing them would overwrite the real store name, phone,
 * address and tax number with whatever that is. `pushSettings` refuses both.
 */
export type SettingsStatus = "idle" | "loading" | "ready" | "failed";

interface SettingsState extends StoreSettings {
  settingsStatus: SettingsStatus;
  settingsError: string | null;
  updateSettings: (settings: Partial<StoreSettings>) => void;
  pushSettings: () => Promise<void>;
  pullSettings: () => Promise<void>;
}

const defaultSettings: StoreSettings = {
  storeName: "محلي",
  storeLogoUrl: "",
  phoneNumber: "",
  address: "",
  taxNumber: "",
  vatRate: 0,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      settingsStatus: "idle" as SettingsStatus,
      settingsError: null,

      updateSettings: (settings) => {
        set((state) => ({ ...state, ...settings }));
        // `pushSettings` existed and worked; nothing called it on an edit, so
        // the VAT rate, store name and logo changed on one device and on no
        // other. Fire-and-forget: the settings screen must not wait on the
        // network, and a failure leaves the local edit intact for the next push.
        void get().pushSettings().catch((e) =>
          console.error("Failed to push store settings:", e),
        );
      },

      pushSettings: async () => {
        const sb = getSupabaseClient();
        if (!sb) return;

        // No session means no store to update. Returning is right: the local
        // edit stays, and the next push after login carries it.
        const storeId = await getActiveStoreId();
        if (!storeId) return;

        const state = get();

        // Every field goes out, so every field must be the server's to begin
        // with. `updateSettings` pushes on each keystroke: after a pull that
        // failed, typing one letter used to send the defaults — «محلي» and
        // blanks — over the real store identity.
        if (state.settingsStatus !== "ready") {
          throw new Error(
            "إعدادات المحل لسه ما اتقرتش من السحابة، فمش هتتحفظ عشان متمسحش البيانات الحقيقية.",
          );
        }

        // Match the stores table snake_case schema
        const payload = {
          name: state.storeName,
          logo_url: state.storeLogoUrl,
          phone: state.phoneNumber,
          address: state.address,
          tax_number: state.taxNumber,
          vat_rate: state.vatRate
        };

        const { error } = await sb
          .from("stores")
          .update(payload)
          .eq("id", storeId);

        if (error) {
          console.error("Failed to push store settings:", error);
        }
      },

      pullSettings: async () => {
        const sb = getSupabaseClient();
        if (!sb) return;

        const storeId = await getActiveStoreId();
        if (!storeId) return;

        set({ settingsStatus: "loading", settingsError: null });
        const { data, error } = await sb
          .from("stores")
          .select("name, logo_url, phone, address, tax_number, vat_rate")
          .eq("id", storeId)
          .single();

        if (error) {
          if (error.code !== "PGRST116") { // Ignore no rows returned initially
            console.error("Failed to pull store settings:", error);
            set({ settingsStatus: "failed", settingsError: error.message });
            return;
          }
          // No row: nothing on the server to protect, so the form is safe.
          set({ settingsStatus: "ready" });
          return;
        }

        if (data) {
          set({
            storeName: data.name || "",
            storeLogoUrl: data.logo_url || "",
            phoneNumber: data.phone || "",
            address: data.address || "",
            taxNumber: data.tax_number || "",
            vatRate: data.vat_rate || 0,
          });
        }
        set({ settingsStatus: "ready", settingsError: null });
      }
    }),
    {
      name: "nexuscore-settings-storage",
      // The six settings only — never the load status (see `SettingsStatus`).
      partialize: (s) => ({
        storeName: s.storeName,
        storeLogoUrl: s.storeLogoUrl,
        phoneNumber: s.phoneNumber,
        address: s.address,
        taxNumber: s.taxNumber,
        vatRate: s.vatRate,
      }),
    }
  )
);
