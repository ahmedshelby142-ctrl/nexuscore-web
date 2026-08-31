import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { BackupRecord, BackupBundle } from "@/types";

/**
 * Backup & restore index.
 *
 * The full backup payload (a JSON dump of every store) lives in a
 * downloaded file. This store keeps only the *metadata* about each
 * backup so the admin can see what's available, restore from a
 * previously-downloaded file, or delete a backup entry.
 *
 * Workflow:
 *   1. Admin clicks "إنشاء نسخة احتياطية" → createBackup() server fn
 *      dumps every store, returns a BackupBundle.
 *   2. The browser downloads the bundle as a .json file.
 *   3. The metadata (filename, size, store count, sanitized flag,
 *      checksum) is appended to `backups[]` and persisted.
 *   4. To restore, the admin uploads a previously-downloaded file.
 *      The file is parsed, validated against the checksum, and
 *      restored on confirmation. The original metadata record is
 *      kept as the audit trail.
 */

interface BackupState {
  backups: BackupRecord[];

  /** Add a metadata record (called after a successful backup create). */
  record: (record: BackupRecord) => void;

  /** Remove a backup from the index (does NOT delete the file). */
  remove: (id: string) => void;

  /** Mark a backup as "restored at <date>" for the audit log. */
  markRestored: (id: string, restoredAt: Date) => void;

  clear: () => void;
}

export const useBackupStore = create<BackupState>()(
  persist(
    (set) => ({
      backups: [],
      record: (record) => set((state) => ({ backups: [record, ...state.backups].slice(0, 100) })),
      remove: (id) => set((state) => ({ backups: state.backups.filter((b) => b.id !== id) })),
      markRestored: (id, restoredAt) =>
        set((state) => ({
          backups: state.backups.map((b) =>
            b.id === id
              ? { ...b, notes: `${b.notes ?? ""}\nrestored_at: ${restoredAt.toISOString()}` }
              : b,
          ),
        })),
      clear: () => set({ backups: [] }),
    }),
    { name: "backup-storage" },
  ),
);

// ── Bundle-format helpers (client-side; the server fn uses these too) ───

/**
 * A canonical list of every Zustand-persisted store in the app.
 * Adding a new store that should be included in backups is a one-line
 * change here. The order is significant for round-trip stability.
 */
export const BACKUP_STORE_KEYS = [
  "auth-storage-v2",
  "business-storage",
  "financial-storage",
  "order-storage",
  "courier-storage",
  "customer-storage",
  "bundle-storage",
  "feature-storage",
  "theme-storage",
  "subscription-storage",
  "audit-storage",
  "branch-storage",
  "integrations-storage",
  "backup-storage",
] as const;

export type BackupStoreKey = (typeof BACKUP_STORE_KEYS)[number];

/** Fields that MUST be scrubbed when `sanitized` is true. */
const SENSITIVE_KEYS = [
  "password",
  "password_hash",
  "password_salt",
  "apiKey",
  "api_key",
  "hmacSecret",
  "hmac_secret",
  "webhookSecret",
  "webhook_secret",
  "secret",
  "licenseKey",
  "license_key",
  "token",
  "sessionToken",
  "session_token",
] as const;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 0 ? "***" : "";
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        SENSITIVE_KEYS.some((sk) => k.toLowerCase() === sk.toLowerCase()) ||
        k.toLowerCase().endsWith("password") ||
        k.toLowerCase().includes("secret") ||
        k.toLowerCase().endsWith("token")
      ) {
        out[k] = "***";
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Build a BackupBundle from the current localStorage state. */
export async function buildBackupBundle(opts: {
  appName: string;
  sanitized: boolean;
}): Promise<BackupBundle> {
  const data: Record<string, unknown> = {};
  for (const key of BACKUP_STORE_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      data[key] = opts.sanitized ? redact(JSON.parse(raw)) : JSON.parse(raw);
    } catch {
      // Skip stores we cannot parse — never let one corrupt store
      // crash the whole backup.
    }
  }
  // Stable serialisation for the checksum.
  const stable = JSON.stringify(data, Object.keys(data).sort());
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(stable) as BufferSource);
  const checksum = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    version: "1.0.0",
    created_at: new Date(),
    app_name: opts.appName,
    stores: BACKUP_STORE_KEYS.slice(),
    sanitized: opts.sanitized,
    data,
    checksum,
  };
}

/** Validate a parsed bundle and return an error string, or null on success. */
export async function validateBundle(bundle: BackupBundle): Promise<string | null> {
  if (!bundle || typeof bundle !== "object") return "ملف النسخة الاحتياطية غير صالح";
  if (!bundle.data || typeof bundle.data !== "object") return "بيانات النسخة فارغة";
  if (!bundle.checksum || typeof bundle.checksum !== "string") return "Checksum مفقود";
  if (!Array.isArray(bundle.stores)) return "قائمة المتاجر مفقودة";

  const stable = JSON.stringify(bundle.data, Object.keys(bundle.data).sort());
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(stable) as BufferSource);
  const expected = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (expected !== bundle.checksum) {
    return "Checksum غير متطابق — الملف تالف أو تم التلاعب به";
  }
  return null;
}

/** Apply a bundle's data to localStorage. Returns a list of keys written. */
export function applyBundle(bundle: BackupBundle): string[] {
  const written: string[] = [];
  for (const [key, value] of Object.entries(bundle.data)) {
    if (!BACKUP_STORE_KEYS.includes(key as BackupStoreKey)) {
      // Ignore unknown keys to avoid a hostile bundle from writing
      // arbitrary localStorage entries.
      continue;
    }
    localStorage.setItem(key, JSON.stringify(value));
    written.push(key);
  }
  return written;
}

/** Trigger a browser download of a bundle as a JSON file. */
export async function downloadBundle(bundle: BackupBundle, filename: string) {
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
