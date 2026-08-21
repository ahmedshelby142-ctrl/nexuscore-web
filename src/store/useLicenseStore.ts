import { create } from "zustand";
import type { LicenseRecord, LicensePlan, LicenseAuditEvent } from "@/types";
import { getPlanDefinition } from "@/types";
import type { IntegrityCheckResult } from "@/lib/licenseIntegrity";

interface LicenseState {
  license: LicenseRecord | null;
  lastVerifiedAt: Date | null;
  trialGranted: boolean;
  lastIntegrity: IntegrityCheckResult | null;

  setLicense: (license: LicenseRecord | null) => void;
  setVerifiedAt: (when: Date) => void;
  appendAudit: (event: Omit<LicenseAuditEvent, "id" | "timestamp">) => void;
  clear: () => void;

  verifyIntegrity: () => Promise<IntegrityCheckResult>;

  isActive: () => boolean;
  isExpired: () => boolean;
  daysUntilExpiry: () => number | null;
  currentPlan: () => LicensePlan;
  hasFeature: (feature: string) => boolean;
  ensureActivePlan: (machineId: string) => void;
}

const mockLicense: LicenseRecord = {
  id: "unlimited-license",
  license_key: "UNLIMITED",
  plan: "enterprise",
  customer_name: "Admin",
  max_branches: 9999,
  max_users: 9999,
  cloud_enabled: true,
  mobile_enabled: true,
  features: getPlanDefinition("enterprise").features as unknown as string[],
  expires_at: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000), // +100 years
  activated_at: new Date(),
  machine_id: "local",
  cache_ttl_days: 9999,
  status: "active",
  signature: "mock",
  audit: []
};

export const useLicenseStore = create<LicenseState>()((set, get) => ({
  license: mockLicense,
  lastVerifiedAt: new Date(),
  trialGranted: true,
  lastIntegrity: { valid: true },

  setLicense: () => {},
  setVerifiedAt: () => {},
  appendAudit: () => {},
  clear: () => {},

  verifyIntegrity: async () => ({ valid: true }),

  isActive: () => true,
  isExpired: () => false,
  daysUntilExpiry: () => 9999,
  currentPlan: () => "enterprise",
  hasFeature: () => true,
  ensureActivePlan: () => {},
}));
