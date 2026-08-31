import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "navy" | "pink" | "dark";

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const themeColors = {
  navy: {
    primary: "#1e3a8a",
    bg: "#f8fafc",
  },
  pink: {
    primary: "#db2777",
    bg: "#fdf2f8",
  },
  dark: {
    primary: "#6366f1",
    bg: "#0f172a",
  },
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "navy",
      setTheme: (theme: Theme) => {
        set({ theme });
        applyTheme(theme);
      },
    }),
    {
      name: "theme-storage",
    },
  ),
);

function applyTheme(theme: Theme) {
  const colors = themeColors[theme];
  const root = document.documentElement;

  root.style.setProperty("--primary-color", colors.primary);
  root.style.setProperty("--bg-color", colors.bg);

  // Apply additional theme-specific styles
  if (theme === "dark") {
    root.style.setProperty("--text-color", "#f8fafc");
    root.style.setProperty("--border-color", "#334155");
  } else {
    root.style.setProperty("--text-color", "#0f172a");
    root.style.setProperty("--border-color", "#e2e8f0");
  }
}

// Initialize theme on app load
export function initializeTheme() {
  const theme = useThemeStore.getState().theme;
  applyTheme(theme);
}
