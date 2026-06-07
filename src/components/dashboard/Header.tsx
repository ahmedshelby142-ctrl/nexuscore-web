import { Bell, Search, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function Header() {
  const [mode, setMode] = useState<"Retail" | "Wholesale">("Retail");
  return (
    <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-md border-b border-border">
      <div className="flex items-center gap-4 px-8 py-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Dashboard</p>
          <h2 className="font-display text-2xl font-semibold">Overview</h2>
        </div>

        <div className="flex-1 max-w-sm ml-8 hidden md:block">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              placeholder="Search orders, products, partners…"
              className="w-full pl-9 pr-4 py-2 text-sm rounded-full bg-muted border border-transparent focus:border-primary/40 focus:bg-card outline-none transition"
            />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-4">
          {/* Mode toggle */}
          <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-muted border border-border">
            <span className="text-xs font-medium text-muted-foreground hidden sm:inline">Business Mode</span>
            <div className="flex bg-card rounded-full p-0.5 shadow-inner">
              {(["Retail", "Wholesale"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn(
                    "px-3 py-1 text-xs font-semibold rounded-full transition-all duration-300",
                    mode === m ? "text-primary-foreground shadow-sm" : "text-muted-foreground"
                  )}
                  style={mode === m ? { background: "var(--gradient-primary)" } : undefined}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <button className="relative size-10 rounded-full hover:bg-muted flex items-center justify-center transition">
            <Bell className="size-4" />
            <span className="absolute top-2 right-2 size-2 rounded-full bg-primary ring-2 ring-background" />
          </button>

          <button className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full hover:bg-muted transition">
            <div className="size-8 rounded-full flex items-center justify-center text-primary-foreground font-semibold text-sm" style={{ background: "var(--gradient-primary)" }}>
              SA
            </div>
            <div className="text-left hidden md:block">
              <p className="text-xs font-semibold leading-tight">Sienna Aldine</p>
              <p className="text-[10px] text-muted-foreground">Admin</p>
            </div>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
        </div>
      </div>
    </header>
  );
}