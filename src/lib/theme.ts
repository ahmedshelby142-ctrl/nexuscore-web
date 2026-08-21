import {
  useThemeStore,
  type ThemeMode,
  type ColorPreset,
  type CustomHexColors,
} from "@/store/useThemeStore";

// ── Hex colour helpers ──────────────────────────────────────────

function hexToRgb(hex: string) {
  const c = hex.replace("#", "");
  return {
    r: parseInt(c.slice(0, 2), 16),
    g: parseInt(c.slice(2, 4), 16),
    b: parseInt(c.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number) {
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

function lighten(hex: string, pct: number) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * pct, g + (255 - g) * pct, b + (255 - b) * pct);
}

function darken(hex: string, pct: number) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - pct), g * (1 - pct), b * (1 - pct));
}

function toOklch(hex: string): string {
  return `#${hex.replace("#", "")}`;
}

// ── Preset definitions ──────────────────────────────────────────
// Each preset defines { light: vars, dark: vars }.
// Empty object = fall through to :root / .dark in styles.css

type Vars = Record<string, string>;
type PresetDef = Record<ThemeMode, Vars>;

const presets: Record<Exclude<ColorPreset, "custom">, PresetDef> = {
  /* ── Fashion ────────────────────────────────────────────
     Jet Black + sleek neutrals — للأزياء والموضة            */
  fashion: {
    light: {
      "--background": "#fafafa",
      "--foreground": "#1a1a1a",
      "--card": "#ffffff",
      "--card-foreground": "#1a1a1a",
      "--popover": "#ffffff",
      "--popover-foreground": "#1a1a1a",
      "--primary": "#1a1a1a",
      "--primary-foreground": "#ffffff",
      "--primary-glow": "#404040",
      "--secondary": "#f0f0f0",
      "--secondary-foreground": "#1a1a1a",
      "--muted": "#f5f5f5",
      "--muted-foreground": "#737373",
      "--accent": "#6b7280",
      "--accent-foreground": "#1a1a1a",
      "--destructive": "#dc2626",
      "--success": "#16a34a",
      "--border": "#e5e5e5",
      "--input": "#e5e5e5",
      "--ring": "#1a1a1a",
      "--chart-1": "#1a1a1a",
      "--chart-2": "#404040",
      "--chart-3": "#6b7280",
      "--chart-4": "#9ca3af",
      "--chart-5": "#d4d4d4",
      "--sidebar": "#ffffff",
      "--sidebar-foreground": "#1a1a1a",
      "--sidebar-primary": "#1a1a1a",
      "--sidebar-primary-foreground": "#ffffff",
      "--sidebar-accent": "#f5f5f5",
      "--sidebar-accent-foreground": "#1a1a1a",
      "--sidebar-border": "#e5e5e5",
      "--sidebar-ring": "#1a1a1a",
      "--gradient-primary": "linear-gradient(135deg, #1a1a1a, #404040)",
      "--gradient-soft": "linear-gradient(180deg, #ffffff, #f5f5f5)",
      "--shadow-soft": "0 4px 24px -8px rgba(26,26,26,0.12)",
      "--shadow-elegant": "0 10px 40px -12px rgba(26,26,26,0.18)",
    },
    dark: {
      "--background": "#111111",
      "--foreground": "#f5f5f5",
      "--card": "#1a1a1a",
      "--card-foreground": "#f5f5f5",
      "--popover": "#1a1a1a",
      "--popover-foreground": "#f5f5f5",
      "--primary": "#e5e5e5",
      "--primary-foreground": "#111111",
      "--primary-glow": "#a3a3a3",
      "--secondary": "#2a2a2a",
      "--secondary-foreground": "#f5f5f5",
      "--muted": "#1a1a1a",
      "--muted-foreground": "#a3a3a3",
      "--accent": "#6b7280",
      "--accent-foreground": "#f5f5f5",
      "--destructive": "#ef4444",
      "--success": "#4ade80",
      "--border": "rgba(245,245,245,0.10)",
      "--input": "rgba(245,245,245,0.15)",
      "--ring": "#e5e5e5",
      "--chart-1": "#e5e5e5",
      "--chart-2": "#a3a3a3",
      "--chart-3": "#6b7280",
      "--chart-4": "#404040",
      "--chart-5": "#2a2a2a",
      "--sidebar": "#1a1a1a",
      "--sidebar-foreground": "#f5f5f5",
      "--sidebar-primary": "#e5e5e5",
      "--sidebar-primary-foreground": "#111111",
      "--sidebar-accent": "#2a2a2a",
      "--sidebar-accent-foreground": "#f5f5f5",
      "--sidebar-border": "rgba(245,245,245,0.08)",
      "--sidebar-ring": "#e5e5e5",
      "--gradient-primary": "linear-gradient(135deg, #e5e5e5, #a3a3a3)",
      "--gradient-soft": "linear-gradient(180deg, #1a1a1a, #2a2a2a)",
      "--shadow-soft": "0 4px 24px -8px rgba(200,200,200,0.12)",
      "--shadow-elegant": "0 10px 40px -12px rgba(150,150,150,0.15)",
    },
  },

  /* ── Glamour ──────────────────────────────────────────
     Rose Gold + Burgundy — للمكياج والإكسسوارات            */
  glamour: {
    light: {
      "--background": "#fef8f5",
      "--foreground": "#2d1b1b",
      "--card": "#ffffff",
      "--card-foreground": "#2d1b1b",
      "--popover": "#ffffff",
      "--popover-foreground": "#2d1b1b",
      "--primary": "#800020",
      "--primary-foreground": "#ffffff",
      "--primary-glow": "#b34444",
      "--secondary": "#f5e6e0",
      "--secondary-foreground": "#2d1b1b",
      "--muted": "#fdf0ea",
      "--muted-foreground": "#8a6b6b",
      "--accent": "#d4a5b8",
      "--accent-foreground": "#2d1b1b",
      "--destructive": "#dc2626",
      "--success": "#16a34a",
      "--border": "#f0ddd6",
      "--input": "#f0ddd6",
      "--ring": "#800020",
      "--chart-1": "#800020",
      "--chart-2": "#d4a5b8",
      "--chart-3": "#e0a96d",
      "--chart-4": "#b34444",
      "--chart-5": "#f5c4b8",
      "--sidebar": "#fffaf7",
      "--sidebar-foreground": "#2d1b1b",
      "--sidebar-primary": "#800020",
      "--sidebar-primary-foreground": "#ffffff",
      "--sidebar-accent": "#fdf0ea",
      "--sidebar-accent-foreground": "#2d1b1b",
      "--sidebar-border": "#f0ddd6",
      "--sidebar-ring": "#800020",
      "--gradient-primary": "linear-gradient(135deg, #800020, #d4a5b8)",
      "--gradient-soft": "linear-gradient(180deg, #fffaf7, #fdf0ea)",
      "--shadow-soft": "0 4px 24px -8px rgba(128,0,32,0.15)",
      "--shadow-elegant": "0 10px 40px -12px rgba(128,0,32,0.22)",
    },
    dark: {
      "--background": "#1a0a0a",
      "--foreground": "#f5e8e6",
      "--card": "#2d1212",
      "--card-foreground": "#f5e8e6",
      "--popover": "#2d1212",
      "--popover-foreground": "#f5e8e6",
      "--primary": "#d4a5b8",
      "--primary-foreground": "#1a0a0a",
      "--primary-glow": "#e0a96d",
      "--secondary": "#3d1a1a",
      "--secondary-foreground": "#f5e8e6",
      "--muted": "#2d1212",
      "--muted-foreground": "#b89898",
      "--accent": "#e0a96d",
      "--accent-foreground": "#1a0a0a",
      "--destructive": "#ef4444",
      "--success": "#4ade80",
      "--border": "rgba(245,232,230,0.10)",
      "--input": "rgba(245,232,230,0.15)",
      "--ring": "#d4a5b8",
      "--chart-1": "#d4a5b8",
      "--chart-2": "#e0a96d",
      "--chart-3": "#b34444",
      "--chart-4": "#800020",
      "--chart-5": "#c98a98",
      "--sidebar": "#2d1212",
      "--sidebar-foreground": "#f5e8e6",
      "--sidebar-primary": "#d4a5b8",
      "--sidebar-primary-foreground": "#1a0a0a",
      "--sidebar-accent": "#3d1a1a",
      "--sidebar-accent-foreground": "#f5e8e6",
      "--sidebar-border": "rgba(245,232,230,0.08)",
      "--sidebar-ring": "#d4a5b8",
      "--gradient-primary": "linear-gradient(135deg, #d4a5b8, #e0a96d)",
      "--gradient-soft": "linear-gradient(180deg, #2d1212, #3d1a1a)",
      "--shadow-soft": "0 4px 24px -8px rgba(212,165,184,0.20)",
      "--shadow-elegant": "0 10px 40px -12px rgba(180,120,130,0.25)",
    },
  },

  /* ── Nexus Enterprise ─────────────────────────────────
     Deep Navy + Nexus Cyan — للمصانع والشركات (الافتراضي)   */
  nexus_enterprise: {
    light: {
      "--background": "#f8fafc",
      "--foreground": "#0f172a",
      "--card": "#ffffff",
      "--card-foreground": "#0f172a",
      "--popover": "#ffffff",
      "--popover-foreground": "#0f172a",
      "--primary": "#06b6d4",
      "--primary-foreground": "#ffffff",
      "--primary-glow": "#48d1e0",
      "--secondary": "#0f172a",
      "--secondary-foreground": "#ffffff",
      "--muted": "#f1f5f9",
      "--muted-foreground": "#64748b",
      "--accent": "#64748b",
      "--accent-foreground": "#0f172a",
      "--destructive": "#dc2626",
      "--success": "#16a34a",
      "--border": "#e2e8f0",
      "--input": "#e2e8f0",
      "--ring": "#06b6d4",
      "--chart-1": "#06b6d4",
      "--chart-2": "#0f172a",
      "--chart-3": "#64748b",
      "--chart-4": "#48d1e0",
      "--chart-5": "#94a3b8",
      "--sidebar": "#ffffff",
      "--sidebar-foreground": "#0f172a",
      "--sidebar-primary": "#06b6d4",
      "--sidebar-primary-foreground": "#ffffff",
      "--sidebar-accent": "#f1f5f9",
      "--sidebar-accent-foreground": "#0f172a",
      "--sidebar-border": "#e2e8f0",
      "--sidebar-ring": "#06b6d4",
      "--gradient-primary": "linear-gradient(135deg, #06b6d4, #0f172a)",
      "--gradient-soft": "linear-gradient(180deg, #ffffff, #f1f5f9)",
      "--shadow-soft": "0 4px 24px -8px rgba(6,182,212,0.18)",
      "--shadow-elegant": "0 10px 40px -12px rgba(15,23,42,0.25)",
    },
    dark: {
      "--background": "#0b1121",
      "--foreground": "#f1f5f9",
      "--card": "#131c2e",
      "--card-foreground": "#f1f5f9",
      "--popover": "#131c2e",
      "--popover-foreground": "#f1f5f9",
      "--primary": "#22d3ee",
      "--primary-foreground": "#0b1121",
      "--primary-glow": "#06b6d4",
      "--secondary": "#1e293b",
      "--secondary-foreground": "#f1f5f9",
      "--muted": "#131c2e",
      "--muted-foreground": "#94a3b8",
      "--accent": "#64748b",
      "--accent-foreground": "#f1f5f9",
      "--destructive": "#ef4444",
      "--success": "#4ade80",
      "--border": "rgba(241,245,249,0.10)",
      "--input": "rgba(241,245,249,0.15)",
      "--ring": "#22d3ee",
      "--chart-1": "#22d3ee",
      "--chart-2": "#06b6d4",
      "--chart-3": "#64748b",
      "--chart-4": "#1e293b",
      "--chart-5": "#94a3b8",
      "--sidebar": "#131c2e",
      "--sidebar-foreground": "#f1f5f9",
      "--sidebar-primary": "#22d3ee",
      "--sidebar-primary-foreground": "#0b1121",
      "--sidebar-accent": "#1e293b",
      "--sidebar-accent-foreground": "#f1f5f9",
      "--sidebar-border": "rgba(241,245,249,0.08)",
      "--sidebar-ring": "#22d3ee",
      "--gradient-primary": "linear-gradient(135deg, #22d3ee, #06b6d4)",
      "--gradient-soft": "linear-gradient(180deg, #131c2e, #1e293b)",
      "--shadow-soft": "0 4px 24px -8px rgba(34,211,238,0.20)",
      "--shadow-elegant": "0 10px 40px -12px rgba(6,182,212,0.25)",
    },
  },

  /* ── Wholesale ─────────────────────────────────────────
     Emerald Green + warm gray — للجملة والتوزيع            */
  wholesale: {
    light: {
      "--background": "#f8faf7",
      "--foreground": "#1a2e1a",
      "--card": "#ffffff",
      "--card-foreground": "#1a2e1a",
      "--popover": "#ffffff",
      "--popover-foreground": "#1a2e1a",
      "--primary": "#047857",
      "--primary-foreground": "#ffffff",
      "--primary-glow": "#34d399",
      "--secondary": "#e8f0e8",
      "--secondary-foreground": "#1a2e1a",
      "--muted": "#f0f7f0",
      "--muted-foreground": "#6b7280",
      "--accent": "#78716c",
      "--accent-foreground": "#1a2e1a",
      "--destructive": "#dc2626",
      "--success": "#16a34a",
      "--border": "#e0e7e0",
      "--input": "#e0e7e0",
      "--ring": "#047857",
      "--chart-1": "#047857",
      "--chart-2": "#34d399",
      "--chart-3": "#78716c",
      "--chart-4": "#6b7280",
      "--chart-5": "#a8a29e",
      "--sidebar": "#ffffff",
      "--sidebar-foreground": "#1a2e1a",
      "--sidebar-primary": "#047857",
      "--sidebar-primary-foreground": "#ffffff",
      "--sidebar-accent": "#f0f7f0",
      "--sidebar-accent-foreground": "#1a2e1a",
      "--sidebar-border": "#e0e7e0",
      "--sidebar-ring": "#047857",
      "--gradient-primary": "linear-gradient(135deg, #047857, #34d399)",
      "--gradient-soft": "linear-gradient(180deg, #ffffff, #f0f7f0)",
      "--shadow-soft": "0 4px 24px -8px rgba(4,120,87,0.15)",
      "--shadow-elegant": "0 10px 40px -12px rgba(4,120,87,0.22)",
    },
    dark: {
      "--background": "#0d1a0d",
      "--foreground": "#f0f7f0",
      "--card": "#152515",
      "--card-foreground": "#f0f7f0",
      "--popover": "#152515",
      "--popover-foreground": "#f0f7f0",
      "--primary": "#10b981",
      "--primary-foreground": "#0d1a0d",
      "--primary-glow": "#34d399",
      "--secondary": "#1a301a",
      "--secondary-foreground": "#f0f7f0",
      "--muted": "#152515",
      "--muted-foreground": "#a8a29e",
      "--accent": "#78716c",
      "--accent-foreground": "#f0f7f0",
      "--destructive": "#ef4444",
      "--success": "#4ade80",
      "--border": "rgba(240,247,240,0.10)",
      "--input": "rgba(240,247,240,0.15)",
      "--ring": "#10b981",
      "--chart-1": "#10b981",
      "--chart-2": "#34d399",
      "--chart-3": "#78716c",
      "--chart-4": "#1a301a",
      "--chart-5": "#6b7280",
      "--sidebar": "#152515",
      "--sidebar-foreground": "#f0f7f0",
      "--sidebar-primary": "#10b981",
      "--sidebar-primary-foreground": "#0d1a0d",
      "--sidebar-accent": "#1a301a",
      "--sidebar-accent-foreground": "#f0f7f0",
      "--sidebar-border": "rgba(240,247,240,0.08)",
      "--sidebar-ring": "#10b981",
      "--gradient-primary": "linear-gradient(135deg, #10b981, #34d399)",
      "--gradient-soft": "linear-gradient(180deg, #152515, #1a301a)",
      "--shadow-soft": "0 4px 24px -8px rgba(16,185,129,0.20)",
      "--shadow-elegant": "0 10px 40px -12px rgba(16,185,129,0.25)",
    },
  },
};

// ── Custom colour variable generation ──────────────────────────

function buildCustomVars(c: CustomHexColors, mode: ThemeMode): Vars {
  const isDark = mode === "dark";
  const bg = isDark ? darken(c.secondary, 0.6) : "#f8fafc";
  const fg = isDark ? "#f0f2f5" : "#1e293b";
  const card = isDark ? darken(c.secondary, 0.3) : "#ffffff";
  const border = isDark ? `rgba(240,242,255,0.10)` : `rgba(0,0,0,0.08)`;

  return {
    "--background": bg,
    "--foreground": fg,
    "--card": card,
    "--card-foreground": fg,
    "--popover": card,
    "--popover-foreground": fg,
    "--primary": c.primary,
    "--primary-foreground": "#ffffff",
    "--primary-glow": lighten(c.primary, 0.2),
    "--secondary": c.secondary,
    "--secondary-foreground": isDark ? "#ffffff" : "#ffffff",
    "--muted": isDark ? darken(c.secondary, 0.2) : lighten(c.secondary, 0.75),
    "--muted-foreground": isDark ? "#a0a4ac" : "#6b7078",
    "--accent": c.accent,
    "--accent-foreground": isDark ? "#ffffff" : "#1e293b",
    "--destructive": isDark ? "#ff6b6b" : "#dc2626",
    "--destructive-foreground": "#ffffff",
    "--success": isDark ? "#4ade80" : "#16a34a",
    "--border": border,
    "--input": isDark ? `rgba(240,242,255,0.15)` : `rgba(0,0,0,0.10)`,
    "--ring": c.primary,
    "--chart-1": c.primary,
    "--chart-2": c.accent,
    "--chart-3": darken(c.primary, 0.2),
    "--chart-4": lighten(c.accent, 0.2),
    "--chart-5": lighten(c.primary, 0.3),
    "--sidebar": isDark ? darken(c.secondary, 0.3) : lighten(c.secondary, 0.85),
    "--sidebar-foreground": fg,
    "--sidebar-primary": c.primary,
    "--sidebar-primary-foreground": "#ffffff",
    "--sidebar-accent": isDark ? darken(c.secondary, 0.15) : lighten(c.secondary, 0.7),
    "--sidebar-accent-foreground": fg,
    "--sidebar-border": border,
    "--sidebar-ring": c.primary,
    "--gradient-primary": `linear-gradient(135deg, ${c.primary}, ${c.accent})`,
    "--gradient-soft": isDark
      ? `linear-gradient(180deg, ${darken(c.secondary, 0.3)}, ${darken(c.secondary, 0.15)})`
      : `linear-gradient(180deg, ${lighten(c.secondary, 0.85)}, ${lighten(c.secondary, 0.7)})`,
    "--shadow-soft": `0 4px 24px -8px ${c.primary}33`,
    "--shadow-elegant": `0 10px 40px -12px ${c.secondary}44`,
  };
}

// ── Public API ─────────────────────────────────────────────────

const VALID_PRESETS = new Set(["fashion", "glamour", "nexus_enterprise", "wholesale", "custom"]);

function sanitizePreset(raw: string): ColorPreset {
  return VALID_PRESETS.has(raw) ? (raw as ColorPreset) : "nexus_enterprise";
}

function sanitizeMode(raw: string): ThemeMode {
  return raw === "light" || raw === "dark" ? raw : "light";
}

export function applyTheme(mode: ThemeMode, preset: ColorPreset, customColors: CustomHexColors) {
  const root = document.documentElement;
  const safeMode = sanitizeMode(mode);
  const safePreset = sanitizePreset(preset);

  // Toggle dark class
  if (safeMode === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }

  // Remove any preset data attribute
  root.removeAttribute("data-preset");

  // Determine variables to inject (safe fallback chain)
  let vars: Vars;
  if (safePreset === "custom") {
    vars = buildCustomVars(customColors, safeMode);
    root.setAttribute("data-preset", "custom");
  } else {
    vars = presets[safePreset]?.[safeMode] ?? presets["nexus_enterprise"][safeMode];
    root.setAttribute("data-preset", presets[safePreset] ? safePreset : "nexus_enterprise");
  }

  // Apply to DOM
  Object.entries(vars).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}

export function initializeTheme() {
  const state = useThemeStore.getState();
  const safePreset = sanitizePreset(state.preset);
  const safeMode = sanitizeMode(state.mode);

  // Repair persisted store if it held stale data
  if (safePreset !== state.preset || safeMode !== state.mode) {
    useThemeStore.setState({ preset: safePreset, mode: safeMode });
  }

  applyTheme(safeMode, safePreset, state.customColors);
}

// ── Metadata for the preset picker UI ─────────────────────────

export interface PresetMeta {
  value: ColorPreset;
  label: string;
  sublabel: string;
  /** CSS background value for the swatch preview */
  swatchBg: string;
  /** Secondary colour for a two-tone preview */
  swatchAccent: string;
}

export const PRESET_META: PresetMeta[] = [
  {
    value: "fashion",
    label: "أزياء وموضة (Fashion)",
    sublabel: "أسود جيت أنيق — للملابس والإكسسوارات",
    swatchBg: "#1a1a1a",
    swatchAccent: "#6b7280",
  },
  {
    value: "glamour",
    label: "جمال ومكياج (Glamour)",
    sublabel: "ذهبي وردي + عنّابي فاخر — لمستحضرات التجميل",
    swatchBg: "#800020",
    swatchAccent: "#d4a5b8",
  },
  {
    value: "nexus_enterprise",
    label: "مؤسسات متكاملة (Enterprise)",
    sublabel: "أزرق بحري عميق + سيان — للمصانع والشركات",
    swatchBg: "#06b6d4",
    swatchAccent: "#0f172a",
  },
  {
    value: "wholesale",
    label: "جملة وتوزيع (Wholesale)",
    sublabel: "زمردي + رمادي دافئ — للجملة والتدفق النقدي",
    swatchBg: "#047857",
    swatchAccent: "#78716c",
  },
  {
    value: "custom",
    label: "تخصيص حر (Custom)",
    sublabel: "خلط الألوان حسب هويتك",
    swatchBg: "conic-gradient(#1a1a1a, #800020, #06b6d4, #047857, #1a1a1a)",
    swatchAccent: "#666",
  },
];

export { presets };
