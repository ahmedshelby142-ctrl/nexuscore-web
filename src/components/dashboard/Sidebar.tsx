import { LayoutDashboard, ShoppingCart, Package, Users, Globe, Settings, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { label: "نظرة عامة", icon: LayoutDashboard, active: true },
  { label: "نقاط البيع (POS)", icon: ShoppingCart },
  { label: "المخازن", icon: Package },
  { label: "الشركاء والمالية", icon: Users },
  { label: "ربط المتجر الإلكتروني", icon: Globe },
  { label: "الإعدادات", icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="hidden lg:flex w-64 shrink-0 flex-col border-l border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2 px-6 py-6 border-b border-sidebar-border">
        <div className="size-9 rounded-xl flex items-center justify-center" style={{ background: "var(--gradient-primary)" }}>
          <Sparkles className="size-5 text-primary-foreground" />
        </div>
        <div>
          <h1 className="font-display text-xl font-bold leading-none">لوميير</h1>
          <p className="text-[10px] tracking-widest text-muted-foreground mt-1">منظومة إدارة التجزئة</p>
        </div>
      </div>
      <nav className="flex-1 px-3 py-5 space-y-1">
        {nav.map((item) => (
          <button
            key={item.label}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
              item.active
                ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            )}
          >
            <item.icon className="size-4" />
            <span className="flex-1 text-right">{item.label}</span>
            {item.active && <span className="size-1.5 rounded-full bg-primary" />}
          </button>
        ))}
      </nav>
      <div className="m-4 p-4 rounded-xl border border-sidebar-border" style={{ background: "var(--gradient-soft)" }}>
        <p className="font-display text-base font-bold">تحتاج مساعدة؟</p>
        <p className="text-xs text-muted-foreground mt-1">فريق الدعم متاح على مدار الساعة لخدمتك.</p>
        <button className="mt-3 text-xs font-medium text-primary hover:underline">← تواصل مع الدعم</button>
      </div>
    </aside>
  );
}