import { useState, useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { FileDown, CheckCircle2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { DevRoleSwitcher } from "@/components/auth/DevRoleSwitcher";
import { useAuthStore } from "@/store/useAuthStore";
import { useThemeStore } from "@/store/useThemeStore";
import { useBusinessStore } from "@/store/useBusinessStore";
import { balances } from "@/lib/ledger";
import { fetchPnl, periodWindow, channelLabel } from "@/lib/ledger/reports";
import { Button } from "@/components/ui/button";
import { BUSINESS_TYPE_LABELS } from "@/types";
import { useOnline } from "@/hooks/useOnline";
import { Wifi, WifiOff, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

const HEADER_TITLES: Record<string, string> = {
  retail: "لوحة تحكم المحل التجاري",
  ecommerce: "لوحة تحكم المتجر الإلكتروني",
};

export function Layout() {
  const { businessType, operationMode } = useAuthStore();
  const { sidebarCollapsed, toggleSidebar } = useThemeStore();
  const { wholesaleInvoices, transactions } = useBusinessStore();
  const online = useOnline();
  const [refreshing, setRefreshing] = useState(false);

  const refreshFromCloud = async () => {
    setRefreshing(true);
    try {
      const { hydrateAll } = await import("@/services/cloudHydrate");
      await hydrateAll();
    } finally {
      setRefreshing(false);
    }
  };
  const [exporting, setExporting] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);

  useEffect(() => {
    const current = location.pathname;
    const prev = prevPathRef.current;

    if (current === "/pos" && prev !== "/pos") {
      useThemeStore.setState({ sidebarCollapsed: true });
    } else if (current !== "/pos" && prev === "/pos") {
      useThemeStore.setState({ sidebarCollapsed: false });
    }

    prevPathRef.current = current;
  }, [location.pathname]);

  const headerTitle = HEADER_TITLES[businessType] || "لوحة التحكم";

  /**
   * تقرير نهاية الوردية — today, from the ledger.
   *
   * It used to sum the `transactions` store (which a POS sale has not written
   * since the ledger conversion), the raw `expenses` array, and two shipping
   * counters nothing writes — so the shift report and التقارير المالية could
   * describe the same day differently. Both now run the same `fetchPnl`
   * query; this one just fixes the window to today.
   */
  const handleEodExport = async () => {
    setExporting(true);
    setExportDone(false);

    const today = periodWindow("day");
    let report;
    try {
      report = await fetchPnl(balances, today);
    } catch (e) {
      // Better a visibly failed export than a text file full of zeros that
      // reads as a day with no business.
      setExporting(false);
      alert(`تعذّر تصدير التقرير: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const money = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ج.م`;
    const lines = [
      "═══════════════════════════════════════════",
      "           تقرير نهاية الوردية الشامل          ",
      "═══════════════════════════════════════════",
      "",
      `تاريخ التقرير: ${new Date().toLocaleDateString("ar-EG")}`,
      `نوع النشاط: ${BUSINESS_TYPE_LABELS[businessType]}`,
      `وضع التشغيل: ${operationMode === "offline_local" ? "محلي أوفلاين" : "سحابي متصل"}`,
      "",
      "─────────── ملخص المبيعات ───────────",
      ...report.salesByChannel.map((c) => `${channelLabel(c.subjectId)}: ${money(c.amount)}`),
      `إجمالي المبيعات (بعد المرتجعات): ${money(report.netSales)}`,
      `المرتجعات (مطروحة فوق): ${money(report.returns)}`,
      "",
      "─────────── ملخص التكاليف ───────────",
      `تكلفة البضاعة المباعة: ${money(report.cogs)}`,
      `المصروفات والرواتب: ${money(report.opex)}`,
      `عمولات ومصاريف الشحن: ${money(report.shipping)}`,
      `المشتريات (نقدية بقت مخزون، مش مصروف): ${money(report.purchases)}`,
      "",
      "─────────── صافي الربح ───────────",
      `صافي ربح اليوم: ${money(report.netProfit)}`,
      "",
      `عدد فواتير الجملة: ${wholesaleInvoices.length}`,
      `عدد معاملات نقاط البيع: ${transactions.length}`,
      "",
      "═══════════════════════════════════════════",
      "    تم التصدير بنجاح — جميع الحقوق محفوظة © NexusCore",
      "═══════════════════════════════════════════",
    ].join("\n");

    const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `تقرير_نهاية_الوردية_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setTimeout(() => {
      setExporting(false);
      setExportDone(true);
      setTimeout(() => setExportDone(false), 4000);
    }, 800);
  };

  return (
    <div className="flex w-full h-screen bg-background overflow-hidden">
      {/* Sidebar — direct flex child */}
      <Sidebar />

      {/* Main Content Area — fills remaining width */}
      <div className="flex-1 flex flex-col min-w-0 w-full">
        {/* Header */}
        <header className="flex-shrink-0 border-b border-border bg-card px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Mobile toggle hint — visible only on small screens */}
              <button
                onClick={toggleSidebar}
                aria-label={sidebarCollapsed ? "فتح القائمة" : "طي القائمة"}
                aria-expanded={!sidebarCollapsed}
                className="lg:hidden size-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
              >
                {sidebarCollapsed ? (
                  <PanelRightOpen className="size-4" />
                ) : (
                  <PanelRightClose className="size-4" />
                )}
              </button>
              <h1 className="text-2xl font-display font-bold">{headerTitle}</h1>
            </div>
            <div className="flex items-center gap-3">
              {operationMode === "offline_local" && (
                <>
                  {exportDone ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 rounded-lg px-3 py-1.5">
                      <CheckCircle2 className="size-3.5" />
                      تم تصدير التقرير
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleEodExport}
                      disabled={exporting}
                      className="text-xs gap-1.5"
                    >
                      <FileDown className="size-3.5" />
                      {exporting ? "جاري التصدير..." : "إغلاق الوردية وتصدير التقرير الشامل"}
                    </Button>
                  )}
                </>
              )}
              {import.meta.env.DEV && <DevRoleSwitcher />}
              
              {/* Connection indicator.
                  There is no "pending" state any more: every write is awaited
                  against Supabase, so a change has either landed or the user
                  was already told it did not. What still matters is whether
                  the next write CAN land. */}
              {operationMode !== "offline_local" && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refreshFromCloud()}
                    disabled={refreshing}
                    className="text-xs gap-1.5 h-8 bg-blue-50/50 hover:bg-blue-50 dark:bg-blue-950/20 dark:hover:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300"
                  >
                    <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
                    تحديث من السحابة
                  </Button>
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/50 border border-border text-xs font-medium h-8">
                    {online ? (
                      <>
                        <Wifi className="size-3.5 text-green-500" />
                        <span className="text-green-600 dark:text-green-400">متصل</span>
                      </>
                    ) : (
                      <>
                        <WifiOff className="size-3.5 text-red-500" />
                        <span className="text-muted-foreground">غير متصل</span>
                      </>
                    )}
                  </div>
                </div>
              )}

              <span className="text-sm text-muted-foreground">النسخة 1.0.0</span>
            </div>
          </div>
        </header>

        {/* Dynamic Content — clean spacious padding */}
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
