import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "light" | "dark";

/** Business identity presets — 4 industry verticals */
export type ColorPreset = "fashion" | "glamour" | "nexus_enterprise" | "wholesale" | "custom";

export interface CustomHexColors {
  primary: string;
  secondary: string;
  accent: string;
}

const defaultCustom: CustomHexColors = {
  primary: "#06b6d4",
  secondary: "#0f172a",
  accent: "#64748b",
};

interface ThemeState {
  mode: ThemeMode;
  preset: ColorPreset;
  customColors: CustomHexColors;
  sidebarCollapsed: boolean;
  setMode: (mode: ThemeMode) => void;
  setPreset: (preset: ColorPreset) => void;
  setCustomColors: (colors: CustomHexColors) => void;
  toggleSidebar: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: "light",
      preset: "nexus_enterprise",
      customColors: { ...defaultCustom },
      sidebarCollapsed: false,
      setMode: (mode) => set({ mode }),
      setPreset: (preset) => set({ preset }),
      setCustomColors: (colors) => set({ customColors: colors }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    { name: "theme-storage" },
  ),
);
