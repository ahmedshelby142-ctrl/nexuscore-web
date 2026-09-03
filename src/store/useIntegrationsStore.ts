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
 * - NO SECRET IS STORED. `apiKey`, `apiSecret`, `hmacSecret` and
 *   `webhookSecret` are blanked by `partialize` on the way to localStorage
 *   and by `merge` on the way back, so a key typed into the form lives only
 *   in memory for that tab and is gone on reload.
 *
 *   The header that used to sit here said the server overrides these via
 *   env vars "in production deploys — see integrations.server.ts". That was
 *   not true of any deployment this app has: `createServerFn` is a shim that
 *   runs so-called server functions in the BROWSER, and those functions have
 *   no call sites. There is no server, so there was no override and no
 *   isolation — only clear-text keys on disk.
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

/**
 * The fields that must never reach disk.
 *
 * `publicKey` and `integrationId` are not here on purpose: Paymob's public key
 * is designed to ship to the browser, and the integration id is an account
 * identifier, not a credential. Blanking those would break the form for no
 * security gain.
 */
const PAYMOB_SECRETS = ["apiKey", "hmacSecret"] as const;
const SHIPPING_SECRETS = ["apiKey", "webhookSecret"] as const;
const ONLINE_ORDER_SECRETS = ["apiKey", "apiSecret", "webhookSecret"] as const;

/**
 * Blank the secrets an EARLIER build already wrote to disk.
 *
 * `partialize` stops new ones being written and `merge` keeps them out of
 * memory, but neither rewrites what is already there: zustand only persists on
 * the next state change, so a key stored by a previous version would sit in
 * localStorage until someone happened to touch the integrations form again.
 *
 * Called once at boot from `main.tsx` — not from this module's import — so the
 * cleanup happens on every load, including the screens that never open the
 * integrations store at all.
 */
export function purgeStoredIntegrationSecrets(): void {
  const KEY = "integrations-storage";
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const state = parsed?.state;
    if (!state) return;

    let touched = false;
    const scrub = (section: string, keys: readonly string[]) => {
      const cfg = state[section];
      if (!cfg || typeof cfg !== "object") return;
      for (const k of keys) {
        if (cfg[k]) {
          cfg[k] = "";
          touched = true;
        }
      }
    };
    scrub("paymob", PAYMOB_SECRETS);
    scrub("shipping", SHIPPING_SECRETS);
    scrub("onlineOrderIntake", ONLINE_ORDER_SECRETS);

    if (touched) {
      localStorage.setItem(KEY, JSON.stringify(parsed));
      // Deliberately loud, and deliberately without the value: whoever ran
      // this build should know a credential WAS on this disk and needs
      // rotating, and no log line may carry the key itself.
      console.warn(
        "[integrations] cleared integration secrets that a previous build had " +
          "stored in localStorage. Rotate those credentials with the provider.",
      );
    }
  } catch {
    // A corrupt or blocked store is not worth crashing the boot for.
  }
}

function stripSecrets<T extends object>(config: T, keys: readonly string[]): T {
  const out = { ...config } as Record<string, unknown>;
  for (const k of keys) if (k in out) out[k] = "";
  return out as T;
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
      // Secrets are stripped on the way OUT and on the way BACK IN.
      //
      // Every field named here was previously written to localStorage in
      // clear text — a Paymob live secret key, the HMAC key that authenticates
      // its webhooks, and the courier's API secret, all readable by any script
      // that ever runs on this origin, and by anyone with the machine.
      //
      // There is nowhere safe to put them in this deployment: `createServerFn`
      // is a shim that runs "server" functions in the BROWSER, so
      // `integrations.server.ts` and its `process.env` reads provide no
      // isolation whatever. And nothing needs them — every provider client in
      // `lib/api/integrations/` is a scaffold that makes no network call at
      // all. So the safe amount of secret material to keep on the client is
      // none, and losing it costs no working feature.
      //
      // `merge` also scrubs what a previous version already wrote, so the
      // exposure clears itself on the next load rather than waiting for the
      // user to press إعادة التعيين.
      partialize: (state) => ({
        paymob: stripSecrets(state.paymob, PAYMOB_SECRETS),
        shipping: stripSecrets(state.shipping, SHIPPING_SECRETS),
        onlineOrderIntake: stripSecrets(state.onlineOrderIntake, ONLINE_ORDER_SECRETS),
        // recentIntakePayloads is intentionally NOT persisted; it is
        // rebuilt on next session from the audit log.
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        return {
          ...current,
          ...p,
          paymob: stripSecrets({ ...current.paymob, ...(p.paymob as object) }, PAYMOB_SECRETS),
          shipping: stripSecrets({ ...current.shipping, ...(p.shipping as object) }, SHIPPING_SECRETS),
          onlineOrderIntake: stripSecrets(
            { ...current.onlineOrderIntake, ...(p.onlineOrderIntake as object) },
            ONLINE_ORDER_SECRETS,
          ),
        };
      },
    },
  ),
);
