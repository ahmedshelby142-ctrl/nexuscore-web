import { createFileRoute } from "@tanstack/react-router";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Header } from "@/components/dashboard/Header";
import { KpiCards } from "@/components/dashboard/KpiCards";
import { ProfitChart } from "@/components/dashboard/ProfitChart";
import { PartnershipCard } from "@/components/dashboard/PartnershipCard";
import { TransactionsTable } from "@/components/dashboard/TransactionsTable";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "لوميير — لوحة تحكم التجزئة والجملة" },
      { name: "description", content: "تحليلات ومالية وحصص شركاء لإدارة أعمال التجزئة والجملة." },
      { property: "og:title", content: "لوميير — لوحة تحكم التجزئة والجملة" },
      { property: "og:description", content: "تحليلات ومالية وحصص شركاء لإدارة أعمال التجزئة والجملة." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen flex bg-background text-foreground font-sans">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <main className="flex-1 px-6 lg:px-8 py-6 space-y-6 animate-fade-in">
          <KpiCards />
          <ProfitChart />
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            <div className="lg:col-span-2">
              <PartnershipCard />
            </div>
            <div className="lg:col-span-3">
              <TransactionsTable />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
