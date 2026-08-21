/**
 * Machine fingerprint.
 *
 * Used for license binding. The fingerprint is computed once per
 * browser / device, persisted in localStorage, and sent with every
 * license activation / verification call. The server compares it
 * against the bound value stored in the license record.
 *
 * Important properties:
 *   - Stable across reloads (persisted in localStorage).
 *   - Stable across network changes (computed from device hints, not IP).
 *   - Not personally identifying on its own (no name, no email).
 *   - Resists trivial "clear localStorage to reset license" attacks by
 *     mixing in browser-stable signals.
 *
 * The component signals are intentionally weak (no canvas fingerprint,
 * no audio fingerprint) to keep this useful without creeping into
 * stalkerware territory. Enterprise installs that need stronger
 * binding can add server-side device attestation on top.
 */

const STORAGE_KEY = "machine-fingerprint-v1";

interface FingerprintComponents {
  userAgent: string;
  language: string;
  platform: string;
  hardwareConcurrency: number;
  screenWidth: number;
  screenHeight: number;
  colorDepth: number;
  timezone: string;
  timezoneOffset: number;
}

function collect(): FingerprintComponents {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const screen = typeof window !== "undefined" ? window.screen : null;
  return {
    userAgent: nav?.userAgent ?? "",
    language: nav?.language ?? "",
    platform: nav?.platform ?? "",
    hardwareConcurrency: nav?.hardwareConcurrency ?? 0,
    screenWidth: screen?.width ?? 0,
    screenHeight: screen?.height ?? 0,
    colorDepth: screen?.colorDepth ?? 0,
    timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "",
    timezoneOffset: new Date().getTimezoneOffset(),
  };
}

async function hashComponents(components: FingerprintComponents): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify(components));
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

let cached: string | null = null;

/** Get (or compute) the persistent machine fingerprint. */
export async function getMachineFingerprint(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) {
      cached = stored;
      return stored;
    }
  } catch {
    // localStorage may be disabled; fall through to in-memory only.
  }
  const fp = await hashComponents(collect());
  cached = fp;
  try {
    localStorage.setItem(STORAGE_KEY, fp);
  } catch {
    // ignore
  }
  return fp;
}

/** Force-regenerate the fingerprint (admin escape hatch). */
export async function resetMachineFingerprint(): Promise<string> {
  cached = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return getMachineFingerprint();
}
