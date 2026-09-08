import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavItems, useSidebarLogout } from "@/components/dashboard/Sidebar";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import logoLight from "@/assets/logo-light.png";
import logoDark from "@/assets/logo-dark.png";
import { useThemeStore } from "@/store/useThemeStore";

/**
 * Navigation for phones — the drawer the header button was already pretending
 * to open.
 *
 * ## The defect this fixes
 *
 * The sidebar is `hidden lg:flex`, so below 1024px it does not render at all.
 * The header still showed a hamburger, labelled فتح القائمة, wired to
 * `toggleSidebar()` — which flips `sidebarCollapsed`, a value only the desktop
 * `<aside>` reads. On a phone the button was focusable, looked live, and did
 * nothing: a real user could reach a screen and have no way off it.
 *
 * ## Why it shares `useNavItems()` rather than listing routes itself
 *
 * The permission matrix is not duplicated here, deliberately. `useNavItems()`
 * filters with `canAccess`, the same function `RequireAccess` uses in the
 * router, plus the business profile and feature flags. A hand-kept copy in the
 * drawer is exactly how a till operator ends up shown an ADMIN route — and
 * "shown" is where that failure starts, even though RLS would still refuse the
 * write. Nothing here is a guard; the guards are unchanged and still upstream.
 *
 * ## RTL
 *
 * The document is `dir="rtl"` and the desktop sidebar sits on the right, so the
 * drawer opens from the right to match. `side="right"` is physical, which is
 * what we want — the panel should appear where the sidebar lives.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navItems = useNavItems();
  const signOut = useSidebarLogout();
  const mode = useThemeStore((s) => s.mode);
  const logoSrc = mode === "dark" ? logoDark : logoLight;

  // Close on navigation. The item's own onClick covers a tap, but this also
  // catches a browser back/forward and any programmatic redirect — a route
  // guard bouncing the user, say — so the drawer can never be left hanging
  // over a screen it did not open.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/*
        `SheetTrigger`, not a bare button with an onClick. Radix only
        learns which element opened the dialog through the trigger, and that
        ref is what it returns focus to on close. Wired by hand, closing the
        drawer dropped focus onto <body> — a keyboard user was put back at the
        top of the document every time they dismissed the menu. Verified: focus
        now lands back on the hamburger.
      */}
      <SheetTrigger
        aria-label="فتح القائمة"
        className="lg:hidden size-9 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
      >
        <Menu className="size-5" />
      </SheetTrigger>

      <SheetContent
        side="right"
        dir="rtl"
        closeLabel="إغلاق القائمة"
        // p-0 because the panel manages its own sections; w-[280px] keeps it
        // inside a 320px viewport with the overlay still visible behind it.
        className="w-[280px] max-w-[85vw] p-0 flex flex-col gap-0 bg-sidebar"
      >
        <div className="flex items-center gap-3 border-b border-sidebar-border px-5 py-4 pt-14">
          <img src={logoSrc} alt="" className="size-8 object-contain shrink-0" />
          <div className="min-w-0 text-right">
            <SheetTitle className="text-base font-display">NexusCore</SheetTitle>
            <SheetDescription className="text-[11px] leading-relaxed">
              التنقل بين شاشات المنظومة
            </SheetDescription>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {navItems.map((item) => {
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "w-full flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="flex-1 text-right truncate">{item.label}</span>
                {active && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border px-3 py-3">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="w-full flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-red-500/80 hover:text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="size-4 shrink-0" />
            <span className="flex-1 text-right">تسجيل الخروج</span>
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
