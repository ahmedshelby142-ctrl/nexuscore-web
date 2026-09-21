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
      // ── Module switches: ON by default ───────────────────────────────────
      //
      // `returnsEnabled` and `ecommerceSyncEnabled` are not preferences in the
      // way the other three are — `Sidebar.useNavItems` filters the navigation
      // on them, so `false` does not disable a feature, it DELETES the link to
      // a finished, authorized screen.
      //
      // Defaulting them to `false` meant every fresh browser opened NexusCore
      // with no "المرتجعات والاستبدال" and no "ربط المتجر الإلكتروني" in the
      // menu. `/returns` is complete — it writes `return_confirmed` events and
      // is authorized by `write_return_records` — and it was reachable only by
      // typing the URL. Clearing site data re-hid it. Every new machine hid it
      // again, because this store is per-browser `localStorage` and nothing
      // syncs it.
      //
      // A shop that does not take returns can still switch it off in
      // الإعدادات → عام. That is a shop making a choice; the old default was
      // the app making it for them, silently, on every device.
      returnsEnabled: true,
      ecommerceSyncEnabled: true,

      // These three gate copy and behaviour inside screens the user already
      // reached, never access to a screen. Off is a safe default for them: an
      // un-chosen setting should not start imposing rules on a till.
      shippingTrackingEnabled: false,
      salesCommissionsEnabled: false,
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
    {
      name: "feature-storage",
      /**
       * A new default does nothing on its own.
       *
       * `persist` rehydrates over the initializer, so every browser that has
       * ever opened this app still holds `{"returnsEnabled":false,
       * "ecommerceSyncEnabled":false}` from the old default and would keep both
       * modules hidden forever. The fix has to reach the stored blob.
       *
       * The two values are forced rather than merged because the old `false`
       * carries no information: it is what the store wrote on first run, so
       * "the admin switched this off" and "nobody ever touched this" are the
       * same byte and cannot be told apart. Between restoring a hidden module
       * and honouring a choice that may never have been made, restoring wins —
       * a visible module a shop ignores costs nothing, an invisible one costs
       * them the feature.
       *
       * Once. `version: 1` means a deliberate switch-off after this ships is
       * preserved like any other setting.
       */
      version: 1,
      migrate: (persisted, from) => {
        const state = (persisted ?? {}) as Partial<FeatureState>;
        if (from < 1) {
          return { ...state, returnsEnabled: true, ecommerceSyncEnabled: true };
        }
        return state;
      },
    },
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
