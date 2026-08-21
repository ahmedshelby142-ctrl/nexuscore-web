import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getSupabaseClient } from "@/lib/supabase";
import { safeInvoke, isDesktop } from "@/lib/tauri";

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
      },

      pushSettings: async () => {
        const sb = getSupabaseClient();
        if (!sb) return;
        
        let identity: any = { store_provisional: true };
        if (isDesktop) {
          identity = await safeInvoke("ledger_identity", {
            candidateStoreId: "dummy",
            candidateDeviceId: "dummy",
          });
        }
        
        if (identity && identity.store_provisional && isDesktop) return;

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
          .eq("id", identity.store_id);

        if (error) {
          console.error("Failed to push store settings:", error);
        }
      },

      pullSettings: async () => {
        const sb = getSupabaseClient();
        if (!sb) return;

        let identity: any = { store_provisional: true };
        if (isDesktop) {
          identity = await safeInvoke("ledger_identity", {
            candidateStoreId: "dummy",
            candidateDeviceId: "dummy",
          });
        }
        
        if (identity && identity.store_provisional && isDesktop) return;

        const { data, error } = await sb
          .from("stores")
          .select("name, logo_url, phone, address, tax_number, vat_rate")
          .eq("id", identity.store_id)
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
