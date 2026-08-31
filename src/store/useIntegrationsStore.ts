import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  PaymobConfig,
  ShippingConfig,
  OnlineOrderIntakeConfig,
  OnlineOrderPayload,
} from "@/types";

/**
 * Secure-by-default configuration store for external integrations.
 *
 * Design notes:
 * - Paymob / Shipping / Online-Order keys are stored in the same
 *   localStorage as other app state. In production deploys, the server
 *   should override these via env vars (PAYMOB_API_KEY, SHIPPING_API_KEY,
 *   ONLINE_ORDER_API_KEY) — see src/lib/api/integrations.server.ts and
 *   the README for the precedence order.
 * - "Secret" fields are *masked* in the UI before being shown, so this
 *   module never logs the raw key to the console or to PDF reports.
 * - The store exposes `markVerified()` so the UI can show a verified
 *   checkmark after a successful test call (server-side).
 * - Toggling `enabled` is a runtime-only switch. The keys themselves
 *   are kept so users can disable a service without losing config.
 */

const DEFAULT_PAYMOB: PaymobConfig = {
  enabled: false,
  environment: "sandbox",
  apiKey: "",
  publicKey: "",
  integrationId: "",
  hmacSecret: "",
  callbackUrl: "",
  acceptedMethods: ["card", "wallet"],
  verified: false,
};

const DEFAULT_SHIPPING: ShippingConfig = {
  enabled: false,
  provider: "bosta",
  environment: "sandbox",
  apiKey: "",
  storeId: "",
  webhookSecret: "",
  webhookUrl: "",
  autoTrack: true,
  autoCreateShipment: false,
  verified: false,
};

const DEFAULT_ONLINE_ORDER: OnlineOrderIntakeConfig = {
  enabled: false,
  source: "custom_webstore",
  storeUrl: "",
  apiKey: "",
  apiSecret: "",
  webhookSecret: "",
  webhookUrl: "",
  pushStatusUpdates: true,
  allowAutoIngest: true,
  pollEnabled: false,
  pollIntervalMinutes: 15,
  verified: false,
};

interface IntegrationsState {
  paymob: PaymobConfig;
  shipping: ShippingConfig;
  onlineOrderIntake: OnlineOrderIntakeConfig;

  /** Recent webhook payloads, kept in-memory for the audit log. */
  recentIntakePayloads: OnlineOrderPayload[];

  // ── Paymob actions ─────────────────────────────────────────────
  updatePaymob: (patch: Partial<PaymobConfig>) => void;
  togglePaymob: (enabled: boolean) => void;
  markPaymobVerified: (verified: boolean) => void;
  resetPaymob: () => void;

  // ── Shipping actions ───────────────────────────────────────────
  updateShipping: (patch: Partial<ShippingConfig>) => void;
  toggleShipping: (enabled: boolean) => void;
  markShippingVerified: (verified: boolean) => void;
  resetShipping: () => void;

  // ── Online order intake actions ─────────────────────────────────
  updateOnlineOrderIntake: (patch: Partial<OnlineOrderIntakeConfig>) => void;
  toggleOnlineOrderIntake: (enabled: boolean) => void;
  markOnlineOrderIntakeVerified: (verified: boolean) => void;
  resetOnlineOrderIntake: () => void;

  // ── Intake payload log ──────────────────────────────────────────
  recordIntakePayload: (payload: OnlineOrderPayload) => void;

  // ── Diagnostics ─────────────────────────────────────────────────
  hasAnyKeyConfigured: () => boolean;
  getActiveProviders: () => Array<"paymob" | "shipping" | "onlineOrder">;
}

/**
 * Mask any secret-looking field for safe display in the UI / logs.
 * Returns a string with the middle hidden, leaving only first 4 and last 2 chars.
 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.max(4, value.length - 6))}${value.slice(-2)}`;
}

export const useIntegrationsStore = create<IntegrationsState>()(
  persist(
    (set, get) => ({
      paymob: DEFAULT_PAYMOB,
      shipping: DEFAULT_SHIPPING,
      onlineOrderIntake: DEFAULT_ONLINE_ORDER,
      recentIntakePayloads: [],

      updatePaymob: (patch) => set((state) => ({ paymob: { ...state.paymob, ...patch } })),
      togglePaymob: (enabled) => set((state) => ({ paymob: { ...state.paymob, enabled } })),
      markPaymobVerified: (verified) =>
        set((state) => ({
          paymob: {
            ...state.paymob,
            verified,
            lastVerifiedAt: verified ? new Date() : state.paymob.lastVerifiedAt,
          },
        })),
      resetPaymob: () => set({ paymob: DEFAULT_PAYMOB }),

      updateShipping: (patch) => set((state) => ({ shipping: { ...state.shipping, ...patch } })),
      toggleShipping: (enabled) => set((state) => ({ shipping: { ...state.shipping, enabled } })),
      markShippingVerified: (verified) =>
        set((state) => ({
          shipping: {
            ...state.shipping,
            verified,
            lastVerifiedAt: verified ? new Date() : state.shipping.lastVerifiedAt,
          },
        })),
      resetShipping: () => set({ shipping: DEFAULT_SHIPPING }),

      updateOnlineOrderIntake: (patch) =>
        set((state) => ({
          onlineOrderIntake: { ...state.onlineOrderIntake, ...patch },
        })),
      toggleOnlineOrderIntake: (enabled) =>
        set((state) => ({
          onlineOrderIntake: { ...state.onlineOrderIntake, enabled },
        })),
      markOnlineOrderIntakeVerified: (verified) =>
        set((state) => ({
          onlineOrderIntake: {
            ...state.onlineOrderIntake,
            verified,
            lastVerifiedAt: verified ? new Date() : state.onlineOrderIntake.lastVerifiedAt,
          },
        })),
      resetOnlineOrderIntake: () => set({ onlineOrderIntake: DEFAULT_ONLINE_ORDER }),

      recordIntakePayload: (payload) =>
        set((state) => ({
          recentIntakePayloads: [payload, ...state.recentIntakePayloads].slice(0, 100),
        })),
      clearIntakePayloads: () => set({ recentIntakePayloads: [] }),

      hasAnyKeyConfigured: () => {
        const s = get();
        return s.paymob.enabled || s.shipping.enabled || s.onlineOrderIntake.enabled;
      },

      getActiveProviders: () => {
        const s = get();
        const out: Array<"paymob" | "shipping" | "onlineOrder"> = [];
        if (s.paymob.enabled) out.push("paymob");
        if (s.shipping.enabled) out.push("shipping");
        if (s.onlineOrderIntake.enabled) out.push("onlineOrder");
        return out;
      },
    }),
    {
      name: "integrations-storage",
      partialize: (state) => ({
        paymob: state.paymob,
        shipping: state.shipping,
        onlineOrderIntake: state.onlineOrderIntake,
        // recentIntakePayloads is intentionally NOT persisted; it is
        // rebuilt on next session from the audit log.
      }),
    },
  ),
);
