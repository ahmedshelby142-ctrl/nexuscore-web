import { createFileRoute } from "@tanstack/react-router";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Header } from "@/components/dashboard/Header";
import { ExecutiveDashboard } from "@/components/dashboard/ExecutiveDashboard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NexusCore — لوحة تحكم التجزئة والجملة" },
      { name: "description", content: "تحليلات ومالية وحصص شركاء لإدارة أعمال التجزئة والجملة." },
      { property: "og:title", content: "NexusCore — لوحة تحكم التجزئة والجملة" },
      {
        property: "og:description",
        content: "تحليلات ومالية وحصص شركاء لإدارة أعمال التجزئة والجملة.",
      },
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
          {/* The four display-only fakes that used to live here are deleted;
              this renders the one real dashboard. NOTE: this TanStack route is
              not what the app serves — `App.tsx` (react-router) is. */}
          <ExecutiveDashboard />
        </main>
      </div>
    </div>
  );
}
