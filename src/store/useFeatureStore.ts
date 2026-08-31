import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useLicenseStore } from "./useLicenseStore";

/**
 * Plan-aware feature store.
 *
 * The original `useFeatureStore` (persisted feature flags) is still
 * the source of truth for **user-controlled** toggles (returns on/off,
 * deposit mandatory, e-commerce sync on/off). The license is the
 * source of truth for **plan-gated** features (e.g. "scheduled
 * backups" requires enterprise / lifetime).
 *
 * `isPlanFeatureEnabled(feature)` returns true only when BOTH:
 *   1. The license plan covers the feature (see `planCoversFeature`).
 *   2. The user has the relevant feature flag turned on (where
 *      applicable).
 *
 * When the trial is active the gating is permissive — every plan
 * feature is allowed — so the buyer can try everything for 30 days.
 * When the trial expires the gating snaps to whatever plan the
 * customer has actually purchased.
 */

type FeatureFlagKey =
  | "returnsEnabled"
  | "shippingTrackingEnabled"
  | "salesCommissionsEnabled"
  | "ecommerceSyncEnabled"
  | "depositMandatory";

interface FeatureState {
  returnsEnabled: boolean;
  shippingTrackingEnabled: boolean;
  salesCommissionsEnabled: boolean;
  ecommerceSyncEnabled: boolean;
  depositMandatory: boolean;
  toggleReturns: () => void;
  toggleShippingTracking: () => void;
  toggleSalesCommissions: () => void;
  toggleEcommerceSync: () => void;
  toggleDepositMandatory: () => void;

  /**
   * Is a plan-gated feature both licensed AND user-enabled?
   * Reads the current license on every call so the answer is
   * always in sync with the plan.
   */
  isPlanFeatureEnabled: (feature: string) => boolean;
  /** True when a feature is plan-gated and the current plan does
   * not cover it. Used by the UI to show a "upgrade required" badge. */
  isLockedByPlan: (feature: string) => boolean;
}

export const useFeatureStore = create<FeatureState>()(
  persist(
    (set, get) => ({
      returnsEnabled: false,
      shippingTrackingEnabled: false,
      salesCommissionsEnabled: false,
      ecommerceSyncEnabled: false,
      depositMandatory: false,
      toggleReturns: () => set((s) => ({ returnsEnabled: !s.returnsEnabled })),
      toggleShippingTracking: () =>
        set((s) => ({ shippingTrackingEnabled: !s.shippingTrackingEnabled })),
      toggleSalesCommissions: () =>
        set((s) => ({ salesCommissionsEnabled: !s.salesCommissionsEnabled })),
      toggleEcommerceSync: () => set((s) => ({ ecommerceSyncEnabled: !s.ecommerceSyncEnabled })),
      toggleDepositMandatory: () => set((s) => ({ depositMandatory: !s.depositMandatory })),

      isPlanFeatureEnabled: (feature) => {
        const license = useLicenseStore.getState();
        // No license = trial mode is permissive.
        if (license.isActive()) {
          return license.hasFeature(feature);
        }
        // Fallback: if no license is active at all, allow the
        // feature so the user can see the screens before
        // activation. The license page will gently prompt them.
        return true;
      },
      isLockedByPlan: (feature) => {
        const license = useLicenseStore.getState();
        if (!license.isActive()) return false;
        return !license.hasFeature(feature);
      },
    }),
    { name: "feature-storage" },
  ),
);

// ── Mapping from the existing flag store to plan features ────────

/**
 * Each user-toggled feature is bound to a plan feature. The UI reads
 * this when it needs to explain "this toggle is gated by your plan".
 */
export const FEATURE_FLAG_TO_PLAN: Record<FeatureFlagKey, string> = {
  returnsEnabled: "returns.advanced",
  shippingTrackingEnabled: "courier.advanced",
  salesCommissionsEnabled: "reports.advanced",
  ecommerceSyncEnabled: "ecommerce.advanced",
  depositMandatory: "returns.advanced",
};
