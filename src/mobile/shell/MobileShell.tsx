import { Outlet } from "react-router-dom";
import { useState } from "react";
import { MobileBottomNav } from "./MobileBottomNav";
import { MobileMoreSheet } from "./MobileMoreSheet";

export function MobileShell() {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="mobile-shell" dir="rtl">
      {/* Mobile AppBar is now handled per-screen for dynamic context */}
      <main className="mobile-content" style={{ paddingBlockStart: "0", paddingInline: "0" }}>
        <Outlet />
      </main>
      <MobileBottomNav onOpenMore={() => setMoreOpen(true)} />
      <MobileMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </div>
  );
}
