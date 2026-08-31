import { useEffect, useState } from "react";
import { useThemeStore, type ThemeMode, type ColorPreset } from "@/store/useThemeStore";
import { applyTheme, PRESET_META } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

const modeOptions: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "فاتح" },
  { value: "dark", label: "داكن" },
];

interface ThemeSwitcherProps {
  /** Hide preset cards and custom color section — dark/light toggle only */
  simplified?: boolean;
}

export function ThemeSwitcher({ simplified }: ThemeSwitcherProps) {
  const { mode, preset, customColors, setMode, setPreset, setCustomColors } = useThemeStore();
  const isCustom = preset === "custom";
  const [previewIndex, setPreviewIndex] = useState(0);

  useEffect(() => {
    applyTheme(mode, preset, customColors);
  }, [mode, preset, customColors]);

  const handleCustomChange = (field: keyof typeof customColors, value: string) => {
    setCustomColors({ ...customColors, [field]: value });
  };

  const previewLabels = ["أزرار", "قوائم", "تنبيهات"];

  return (
    <div className="space-y-6">
      {/* ── Mode toggle ─────────────────────────────────── */}
      <div>
        <p className="text-sm font-semibold mb-3">
          السمة الأساسية — {mode === "dark" ? "داكن 🌙" : "فاتح ☀️"}
        </p>
        <div className="flex gap-2">
          {modeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setMode(opt.value)}
              className={cn(
                "relative px-5 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                mode === opt.value
                  ? "bg-primary text-primary-foreground shadow-[0_0_12px_var(--shadow-soft)]"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Preset cards (hidden in simplified mode) ──────── */}
      {!simplified && (
        <div>
          <p className="text-sm font-semibold mb-3">قوالب هوية النشاط التجاري</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {PRESET_META.map((p) => {
              const selected = preset === p.value;
              return (
                <button
                  key={p.value}
                  onClick={() => setPreset(p.value as ColorPreset)}
                  className={cn(
                    "group relative flex items-center gap-3.5 rounded-xl border p-4 text-right transition-all duration-300 min-h-[4.5rem]",
                    selected
                      ? [
                          "border-[var(--ring)]",
                          "bg-[var(--primary)]/[0.06]",
                          "shadow-[0_0_20px_var(--shadow-soft)]",
                          "ring-1 ring-[var(--ring)]",
                        ].join(" ")
                      : [
                          "border-border",
                          "bg-card",
                          "hover:border-[var(--primary)]/30 hover:bg-muted/40",
                          "shadow-sm",
                        ].join(" "),
                  )}
                >
                  {/* Swatch */}
                  <div
                    className="size-11 rounded-xl shrink-0 border border-border/40 overflow-hidden"
                    style={{ background: p.swatchBg }}
                  >
                    {p.value === "custom" && (
                      <div className="flex h-full items-center justify-center text-[11px] font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">
                        A
                      </div>
                    )}
                  </div>

                  {/* Label + sublabel */}
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        "text-sm font-semibold leading-tight",
                        selected ? "text-[var(--primary)]" : "text-foreground",
                      )}
                    >
                      {p.label}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      {p.sublabel}
                    </p>
                  </div>

                  {/* Active indicator */}
                  {selected ? (
                    <span className="size-2.5 rounded-full bg-[var(--ring)] shrink-0 shadow-[0_0_8px_var(--ring)]" />
                  ) : (
                    <span className="size-2 rounded-full bg-border shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Custom hex colour pickers (hidden in simplified) ── */}
      {!simplified && isCustom && (
        <div className="rounded-xl border border-[var(--ring)]/40 bg-[var(--primary)]/[0.04] p-5 space-y-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">التخصيص الحر للألوان</p>
            <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2.5 py-1 rounded-full border border-border/50">
              Custom Mixing Mode
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {(["primary", "secondary", "accent"] as const).map((field) => {
              const labels = {
                primary: "اللون الأساسي — للأزرار والروابط",
                secondary: "اللون الثانوي — للقوائم والترويسات",
                accent: "لون التنبيهات — للإشعارات ونسب الأرباح",
              };
              return (
                <div key={field} className="space-y-2">
                  <Label className="text-xs font-medium flex items-center gap-2">
                    <span
                      className="size-3 rounded-full border border-border/50"
                      style={{ backgroundColor: customColors[field] }}
                    />
                    {labels[field]}
                  </Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={customColors[field]}
                      onChange={(e) => handleCustomChange(field, e.target.value)}
                      className="size-9 rounded-lg border border-border cursor-pointer bg-transparent p-0.5 shrink-0"
                    />
                    <input
                      type="text"
                      value={customColors[field]}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (/^#[0-9a-fA-F]{6}$/.test(v)) handleCustomChange(field, v);
                      }}
                      className="flex h-9 w-full rounded-md border border-border bg-background px-2.5 text-xs font-mono tracking-wider text-left direction-ltr"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Live preview bar */}
          <div
            className="h-11 rounded-xl flex items-center justify-center gap-4 text-sm font-medium shadow-inner"
            style={{
              background: `linear-gradient(135deg, ${customColors.primary}, ${customColors.accent})`,
              color: "#ffffff",
              textShadow: "0 1px 3px rgba(0,0,0,0.25)",
            }}
          >
            <span>معاينة حية</span>
            <span className="opacity-40">|</span>
            {previewLabels.map((l, i) => (
              <button
                key={l}
                onClick={() => setPreviewIndex(i)}
                className={cn(
                  "px-2 py-0.5 rounded text-xs transition-all",
                  previewIndex === i ? "bg-white/20" : "opacity-70 hover:opacity-100",
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Footer tip */}
      <p className="text-xs text-muted-foreground">
        {simplified
          ? "يمكنك التبديل بين الوضع الفاتح والداكن فقط. قوالب الهوية يتحكم بها مدير النظام."
          : "يتم حفظ جميع التفضيلات تلقائياً في المتصفح وتطبيقها فوراً."}
      </p>
    </div>
  );
}
