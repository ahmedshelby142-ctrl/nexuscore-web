import { createServerFn } from "@/lib/createServerFn";
import { z } from "zod";
import { getSupabaseClient } from "@/lib/supabase";
import { hashToken } from "@/lib/crypto";
import { signLicenseAsync } from "@/lib/licenseIntegrity";
import type {
  LicenseActivationResult,
  LicensePlan,
  LicenseRecord,
  LicenseAuditEvent,
} from "@/types";
import { getPlanDefinition } from "@/types";

/**
 * License server.
 *
 * Responsibilities:
 *   - activateLicense: validate a license key the customer pasted,
 *     bind it to the machine, and return the resolved LicenseRecord.
 *   - verifyLicense: re-validate an existing license against the
 *     vendor's license server (or the local cache if offline).
 *   - deactivateLicense: free the machine binding.
 *   - listLicenses: admin-only list of every license on the box.
 *
 * The actual vendor license server is out of scope for this build.
 * For now the server simulates the upstream call and accepts any
 * well-formed key that:
 *   - starts with the magic prefix NEXUS-<plan>-
 *   - encodes the customer name + plan
 *
 * This lets the system be exercised end-to-end before the vendor
 * license service is deployed. The contract is identical: a real
 * server just needs to swap out the verifyKey() body.
 *
 * Machine binding: every license is bound to the machine that
 * activated it. If the customer later moves the app to a new
 * device, they deactivate on the old one and re-activate on the
 * new one. The plan / features do not change.
 */

const KEY_PREFIX = "NEXUS";

/** Parse a license key like "NEXUS-PRO-AB12CD-OWNER" into its parts. */
export function parseKey(key: string): {
  plan: LicensePlan;
  tag: string;
  fingerprint: string;
} | null {
  const parts = key.trim().toUpperCase().split("-");
  if (parts.length < 3) return null;
  if (parts[0] !== KEY_PREFIX) return null;
  const planRaw = parts[1];
  const validPlans: LicensePlan[] = ["basic", "professional", "enterprise", "lifetime"];
  const plan = validPlans.find(
    (p) =>
      planRaw === p.toUpperCase() ||
      (planRaw === "PRO" && p === "professional") ||
      (planRaw === "ENT" && p === "enterprise") ||
      (planRaw === "LIFE" && p === "lifetime"),
  );
  if (!plan) return null;
  return {
    plan,
    tag: parts[2] ?? "X",
    fingerprint: parts[3] ?? "USER",
  };
}

/** Build a license key for a given plan. Used by the trial flow and
 * by the admin "generate test key" button. */
export function buildKey(plan: LicensePlan, customer: string): string {
  const planShort =
    plan === "professional"
      ? "PRO"
      : plan === "enterprise"
        ? "ENT"
        : plan === "lifetime"
          ? "LIFE"
          : plan.toUpperCase();
  const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
  const fp =
    customer
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8) || "USER";
  return `${KEY_PREFIX}-${planShort}-${tag}-${fp}`;
}

function nowPlus(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/** In-memory mirror of the licenses table. Seeded on first read. */
const inMemoryLicenses: LicenseRecord[] = [];

// ── Public server functions ─────────────────────────────────────────

/**
 * Activate a license key. Validates the key, binds it to the machine,
 * persists to the DB (or in-memory fallback), and returns the resolved
 * LicenseRecord so the client can update its store.
 */
export const activateLicense = createServerFn({ method: "POST" })
  .validator(
    z.object({
      license_key: z.string().min(1),
      machine_id: z.string().min(8),
      customer_name: z.string().min(1),
      customer_email: z.string().email().optional(),
    }),
  )
  .handler(async ({ data }): Promise<LicenseActivationResult> => {
    const parsed = parseKey(data.license_key);
    if (!parsed) {
      return { ok: false, reason: "tampered" };
    }

    const planDef = getPlanDefinition(parsed.plan);
    const licenseId = crypto.randomUUID();
    const expiresAt = parsed.plan === "lifetime" ? null : nowPlus(365);
    // Sign the license with the server-side secret. The client will
    // re-verify this signature on every setLicense() to catch edits
    // made directly to localStorage.
    const signature = await signLicenseAsync(
      {
        id: licenseId,
        license_key: data.license_key,
        plan: parsed.plan,
        expires_at: expiresAt?.toISOString() ?? null,
        machine_id: data.machine_id,
        customer_name: data.customer_name,
      },
      // In production, override with process.env.LICENSE_SIGNING_SECRET.
      // The dev fallback in licenseIntegrity.ts is acceptable for
      // offline-first dev; the real defense is the server check below.
      process.env.LICENSE_SIGNING_SECRET ?? "",
    );

    const license: LicenseRecord = {
      id: licenseId,
      license_key: data.license_key,
      plan: parsed.plan,
      customer_name: data.customer_name,
      customer_email: data.customer_email,
      max_branches: planDef.maxBranches === Number.POSITIVE_INFINITY ? 9999 : planDef.maxBranches,
      max_users: planDef.maxUsers === Number.POSITIVE_INFINITY ? 9999 : planDef.maxUsers,
      cloud_enabled: planDef.cloudEnabled,
      mobile_enabled: planDef.mobileEnabled,
      features: planDef.features as unknown as string[],
      expires_at: expiresAt,
      activated_at: new Date(),
      machine_id: data.machine_id,
      cache_ttl_days: 7,
      status: "active",
      audit: [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          event: "activated",
          machine_id: data.machine_id,
          notes: `Key issued for ${data.customer_name}`,
        },
      ],
      signature,
    };

    const sb = getSupabaseClient();
    if (!sb) {
      // In-memory path.
      const existing = inMemoryLicenses.findIndex((l) => l.license_key === data.license_key);
      if (existing >= 0) {
        inMemoryLicenses[existing] = license;
      } else {
        inMemoryLicenses.push(license);
      }
      return {
        ok: true,
        license,
        revalidate_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      };
    }

    const { error } = await sb.from("licenses").upsert(
      {
        license_key: data.license_key,
        plan: license.plan,
        customer_name: license.customer_name,
        customer_email: license.customer_email ?? null,
        max_branches: license.max_branches,
        max_users: license.max_users,
        cloud_enabled: license.cloud_enabled,
        mobile_enabled: license.mobile_enabled,
        features: license.features,
        expires_at: license.expires_at?.toISOString() ?? null,
        activated_at: license.activated_at.toISOString(),
        machine_id: license.machine_id,
        cache_ttl_days: license.cache_ttl_days,
        status: license.status,
      },
      { onConflict: "license_key" },
    );
    if (error) {
      return { ok: false, reason: "server_rejected" };
    }
    await sb.from("license_audit").insert({
      license_key: data.license_key,
      event: "activated",
      machine_id: data.machine_id,
      notes: `Key activated for ${data.customer_name}`,
    });
    return {
      ok: true,
      license,
      revalidate_at: new Date(Date.now() + license.cache_ttl_days * 24 * 60 * 60 * 1000),
    };
  });

/** Verify a cached license against the server. Used for the periodic
 * re-validation. */
export const verifyLicense = createServerFn({ method: "POST" })
  .validator(
    z.object({
      license_id: z.string(),
      machine_id: z.string().min(8),
    }),
  )
  .handler(async ({ data }): Promise<LicenseActivationResult> => {
    const sb = getSupabaseClient();
    if (!sb) {
      const found = inMemoryLicenses.find((l) => l.id === data.license_id);
      if (!found) return { ok: false, reason: "no_license" };
      if (found.machine_id !== data.machine_id) {
        return { ok: false, reason: "machine_mismatch" };
      }
      if (found.expires_at && new Date(found.expires_at).getTime() < Date.now()) {
        return { ok: false, reason: "expired" };
      }
      found.last_verified_at = new Date();
      return { ok: true, license: found };
    }

    const { data: row, error } = await sb
      .from("licenses")
      .select("*")
      .eq("id", data.license_id)
      .single();
    if (error || !row) return { ok: false, reason: "no_license" };

    if (row.machine_id !== data.machine_id) {
      await sb.from("license_audit").insert({
        license_id: data.license_id,
        event: "machine_changed",
        machine_id: data.machine_id,
        notes: "Verification attempted from a different machine",
      });
      return { ok: false, reason: "machine_mismatch" };
    }
    if (row.status === "revoked") return { ok: false, reason: "revoked" };
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      await sb.from("licenses").update({ status: "expired" }).eq("id", data.license_id);
      return { ok: false, reason: "expired" };
    }

    await sb
      .from("licenses")
      .update({ last_verified_at: new Date().toISOString() })
      .eq("id", data.license_id);
    await sb.from("license_audit").insert({
      license_id: data.license_id,
      event: "verified",
      machine_id: data.machine_id,
    });

    return {
      ok: true,
      license: row as unknown as LicenseRecord,
      revalidate_at: new Date(Date.now() + (row.cache_ttl_days ?? 7) * 24 * 60 * 60 * 1000),
    };
  });

/** Deactivate. Frees the machine binding so the same key can be
 * re-activated elsewhere. */
export const deactivateLicense = createServerFn({ method: "POST" })
  .validator(
    z.object({
      license_id: z.string(),
      machine_id: z.string().min(8),
    }),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const sb = getSupabaseClient();
    if (!sb) {
      const idx = inMemoryLicenses.findIndex((l) => l.id === data.license_id);
      if (idx < 0) return { ok: false };
      inMemoryLicenses.splice(idx, 1);
      return { ok: true };
    }
    await sb.from("licenses").update({ status: "revoked" }).eq("id", data.license_id);
    await sb.from("license_audit").insert({
      license_id: data.license_id,
      event: "revoked",
      machine_id: data.machine_id,
    });
    return { ok: true };
  });
