import {
  TrendingUp,
  Users,
  DollarSign,
  Download,
  FileText,
  Inbox,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useBusinessStore } from "@/store/useBusinessStore";
import { getPartnerEarnings } from "@/services/financeService";
import { generateFinancialPdf } from "@/lib/pdfGenerator";
import { Button } from "@/components/ui/button";

export function ProfitDashboard() {
  const { partnerLedger, partners, partnershipEnabled } = useBusinessStore();

  // Calculate total profit from all transactions
  const totalProfit = partnerLedger.reduce((sum, record) => sum + record.netProfit, 0);

  // Calculate total revenue
  const totalRevenue = partnerLedger.reduce((sum, record) => sum + record.totalRevenue, 0);

  // Calculate total cost
  const totalCost = partnerLedger.reduce((sum, record) => sum + record.totalCost, 0);

  // Calculate partner earnings summary
  const partnerEarnings = partners.map((partner) => {
    const earnings = getPartnerEarnings(partner.id, partnerLedger);
    return {
      ...partner,
      ...earnings,
    };
  });

  // Export to CSV
  const exportToCSV = () => {
    if (partnerLedger.length === 0) {
      alert("لا توجد بيانات للتصدير");
      return;
    }

    const headers = [
      "Transaction ID",
      "Date",
      "Total Revenue",
      "Total Cost",
      "Net Profit",
      "Partner",
      "Equity %",
      "Share Amount",
    ];

    const rows = partnerLedger.flatMap((record) => {
      if (record.partnerDistributions.length === 0) {
        return [
          [
            record.transactionId,
            new Date(record.timestamp).toLocaleDateString("ar-EG"),
            record.totalRevenue.toFixed(2),
            record.totalCost.toFixed(2),
            record.netProfit.toFixed(2),
            "Owner",
            "100",
            record.netProfit.toFixed(2),
          ],
        ];
      }

      return record.partnerDistributions.map((dist) => [
        record.transactionId,
        new Date(record.timestamp).toLocaleDateString("ar-EG"),
        record.totalRevenue.toFixed(2),
        record.totalCost.toFixed(2),
        record.netProfit.toFixed(2),
        dist.partnerName,
        dist.equityPercentage,
        dist.shareAmount.toFixed(2),
      ]);
    });

    const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

    const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.setAttribute("href", url);
    link.setAttribute("download", `profit_ledger_${new Date().toISOString().split("T")[0]}.csv`);
    link.style.visibility = "hidden";

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Export to PDF (using centralized pdfGenerator)
  const exportToPDF = () => {
    if (partnerLedger.length === 0) {
      alert("لا توجد بيانات للتصدير");
      return;
    }

    // Build flat expense rows from partner ledger
    const expenseRows = partnerLedger.flatMap((record) => {
      const date = new Date(record.timestamp);
      return [
        {
          category: "إيراد",
          amount: record.totalRevenue,
          description: `معاملة ${record.transactionId.slice(0, 8)}`,
          date,
        },
        {
          category: "تكلفة",
          amount: record.totalCost,
          description: `تكلفة البضاعة`,
          date,
        },
      ];
    });

    generateFinancialPdf({
      companyName: "تقرير الأرباح والتوزيع",
      reportDate: new Date(),
      financialSummary: {
        totalSales: totalRevenue,
        totalExpenses: totalCost,
        netProfit: totalProfit,
        shippingProfit: 0,
      },
      walletBalances: [],
      shareholderDistributions: partners.map((partner) => {
        const earnings = getPartnerEarnings(partner.id, partnerLedger);
        return {
          name: partner.name,
          capitalContributed: partner.capitalContribution,
          sharePercentage: partner.equityPercentage,
          drawsTaken: 0,
          currentShare: earnings.totalEarnings,
        };
      }),
      expenses: expenseRows,
    });
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-4">
            <div
              className="size-10 rounded-xl flex items-center justify-center"
              style={{ background: "var(--gradient-primary)" }}
            >
              <DollarSign className="size-5 text-primary-foreground" />
            </div>
            <span className="text-xs text-muted-foreground">إجمالي</span>
          </div>
          <p className="text-2xl font-bold">{totalProfit.toLocaleString()} ج.م</p>
          <p className="text-sm text-muted-foreground mt-1">صافي الربح</p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="size-10 rounded-xl flex items-center justify-center bg-green-100">
              <TrendingUp className="size-5 text-green-600" />
            </div>
            <span className="text-xs text-muted-foreground">إيرادات</span>
          </div>
          <p className="text-2xl font-bold">{totalRevenue.toLocaleString()} ج.م</p>
          <p className="text-sm text-muted-foreground mt-1">إجمالي المبيعات</p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="size-10 rounded-xl flex items-center justify-center bg-red-100">
              <DollarSign className="size-5 text-red-600" />
            </div>
            <span className="text-xs text-muted-foreground">تكاليف</span>
          </div>
          <p className="text-2xl font-bold">{totalCost.toLocaleString()} ج.م</p>
          <p className="text-sm text-muted-foreground mt-1">تكلفة البضاعة</p>
        </div>
      </div>

      {/* Partnership Status */}
      {!partnershipEnabled && (
        <div className="rounded-2xl border border-orange-200 bg-orange-50 p-6">
          <div className="flex items-start gap-3">
            <Users className="size-5 text-orange-600 mt-0.5" />
            <div>
              <p className="font-semibold text-orange-900">نظام الشراكة غير مفعّل</p>
              <p className="text-sm text-orange-700 mt-1">
                قم بتفعيل نظام الشراكة من الإعدادات لتتبع توزيع الأرباح بين الشركاء
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Partner Earnings */}
      {partnershipEnabled && partnerEarnings.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="size-10 rounded-xl flex items-center justify-center bg-purple-100">
              <Users className="size-5 text-purple-600" />
            </div>
            <div>
              <p className="text-xs tracking-wider text-muted-foreground">الشركاء</p>
              <h3 className="font-display text-xl font-bold mt-1">أرباح الشركاء</h3>
            </div>
          </div>

          <div className="space-y-4">
            {partnerEarnings.map((partner) => (
              <div
                key={partner.id}
                className="flex items-center justify-between p-4 rounded-xl border border-border bg-muted/50"
              >
                <div className="flex-1">
                  <p className="font-medium">{partner.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {partner.equityPercentage}% حصة الأسهم
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold">{partner.totalEarnings.toLocaleString()} ج.م</p>
                  <p className="text-xs text-muted-foreground">{partner.transactionCount} معاملة</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Profit Ledger */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl flex items-center justify-center bg-blue-100">
              <TrendingUp className="size-5 text-blue-600" />
            </div>
            <div>
              <p className="text-xs tracking-wider text-muted-foreground">السجل المالي</p>
              <h3 className="font-display text-xl font-bold mt-1">دفتر الأرباح</h3>
            </div>
          </div>

          {/* Export Buttons */}
          <div className="flex items-center gap-2">
            <Button
              onClick={exportToCSV}
              variant="outline"
              size="sm"
              disabled={partnerLedger.length === 0}
            >
              <Download className="size-4 ml-2" />
              تصدير CSV
            </Button>
            <Button
              onClick={exportToPDF}
              variant="outline"
              size="sm"
              disabled={partnerLedger.length === 0}
            >
              <FileText className="size-4 ml-2" />
              تصدير PDF
            </Button>
          </div>
        </div>

          {partnerLedger.length === 0 ? (
            <div className="py-12">
              <EmptyState icon={Inbox} title="لا توجد معاملات مسجلة بعد" />
            </div>
          ) : (
          <div className="space-y-4">
            {partnerLedger
              .slice()
              .reverse()
              .map((record) => (
                <div
                  key={record.transactionId}
                  className="p-4 rounded-xl border border-border bg-muted/30"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {record.transactionId.slice(0, 8)}...
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(record.timestamp).toLocaleDateString("ar-EG")}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">الربح:</span>
                      <span className="font-semibold text-green-600">
                        {record.netProfit.toLocaleString()} ج.م
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4 text-sm mb-3">
                    <div>
                      <p className="text-muted-foreground">الإيراد</p>
                      <p className="font-medium">{record.totalRevenue.toLocaleString()} ج.م</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">التكلفة</p>
                      <p className="font-medium">{record.totalCost.toLocaleString()} ج.م</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">صافي الربح</p>
                      <p className="font-medium text-green-600">
                        {record.netProfit.toLocaleString()} ج.م
                      </p>
                    </div>
                  </div>

                  {record.partnerDistributions.length > 0 && (
                    <div className="border-t border-border pt-3">
                      <p className="text-xs text-muted-foreground mb-2">توزيع الأرباح:</p>
                      <div className="space-y-1">
                        {record.partnerDistributions.map((dist) => (
                          <div
                            key={dist.partnerId}
                            className="flex items-center justify-between text-sm"
                          >
                            <span className="text-muted-foreground">{dist.partnerName}</span>
                            <span className="font-medium">
                              {dist.equityPercentage}% = {dist.shareAmount.toLocaleString()} ج.م
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
