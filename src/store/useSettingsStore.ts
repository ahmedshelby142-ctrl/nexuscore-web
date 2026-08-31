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

interface SettingsState extends StoreSettings {
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

        const { data, error } = await sb
          .from("stores")
          .select("name, logo_url, phone, address, tax_number, vat_rate")
          .eq("id", storeId)
          .single();

        if (error) {
          if (error.code !== "PGRST116") { // Ignore no rows returned initially
            console.error("Failed to pull store settings:", error);
          }
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
      }
    }),
    {
      name: "nexuscore-settings-storage",
    }
  )
);
