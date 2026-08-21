import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  partnershipEnabled: boolean;
  togglePartnership: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      partnershipEnabled: false,
      togglePartnership: (enabled: boolean) => set({ partnershipEnabled: enabled }),
    }),
    {
      name: "settings-storage",
    },
  ),
);
