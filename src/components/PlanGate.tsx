import { Lock, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { useFeatureStore } from "@/store/useFeatureStore";
import { useLicenseStore } from "@/store/useLicenseStore";
import { getPlanDefinition } from "@/types";
import type { GatedFeature } from "@/types";
import { Button } from "@/components/ui/button";

/**
 * Inline "upgrade required" badge. Pages can wrap an area with this
 * to make the plan limitation visible (without hiding the feature).
 *
 * Usage:
 *   <PlanGate feature="backups.scheduled">
 *     <Button>Create scheduled backup</Button>
 *   </PlanGate>
 *
 * When the feature is locked, the children are replaced with a
 * friendly upgrade card. When it is allowed, children render
 * normally and the gate is invisible.
 */
export function PlanGate({
  feature,
  children,
  fallback,
}: {
  feature: GatedFeature;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const isAllowed = useFeatureStore((s) => s.isPlanFeatureEnabled(feature));
  if (isAllowed) return <>{children}</>;
  if (fallback) return <>{fallback}</>;
  return <UpgradeCard feature={feature} />;
}

export function UpgradeCard({ feature }: { feature: GatedFeature }) {
  const currentPlan = useLicenseStore((s) => s.currentPlan());
  const currentDef = getPlanDefinition(currentPlan);
  // Find the first plan that covers this feature and is an upgrade.
  // We import the catalog dynamically to avoid a circular import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PLAN_CATALOG } = require("@/types") as typeof import("@/types");
  const upgradeTarget = PLAN_CATALOG.find(
    (p) => p.features.includes(feature) && p.id !== currentPlan,
  );
  return (
    <div className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-5 flex items-start gap-3">
      <div className="size-10 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center shrink-0">
        <Lock className="size-5 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-sm">ميزة مقيّدة بالخطة الحالية ({currentDef.nameAr})</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          هذه الميزة متاحة في خطة أعلى. يمكنك الترقية من شاشة الترخيص.
        </p>
        <Button asChild size="sm" variant="outline" className="mt-3">
          <Link to="/license">
            <Sparkles className="size-3.5 ml-1.5" />
            {upgradeTarget ? `الترقية إلى ${upgradeTarget.nameAr}` : "عرض الخطط"}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Read-only helper to decide whether to show an inline "PRO" badge
 * next to a feature. Use in lists, cards, etc.
 */
export function useIsFeatureLocked(feature: GatedFeature): boolean {
  return useFeatureStore((s) => s.isLockedByPlan(feature));
}
