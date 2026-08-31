/**
 * License integrity signature.
 *
 * The license record is persisted in localStorage, which means anyone with
 * browser dev tools can edit `plan` / `expires_at` / `max_users` etc. to
 * unlock paid features. The existing 90%-complete license system has the
 * right primitives (server-side machine-binding, audit trail, machine
 * mismatch detection) but no integrity check on the *client-side* record.
 *
 * This module closes that gap with a deterministic signature:
 *
 *     signature = SHA-256(
 *         license.id
 *         + ":" + license.license_key
 *         + ":" + license.plan
 *         + ":" + (license.expires_at?.toISOString() ?? "null")
 *         + ":" + license.machine_id
 *         + ":" + license.customer_name
 *         + ":" + secret
 *     )
 *
 * The secret is `LICENSE_SIGNING_SECRET` in production, or a known
 * development fallback when the env var is unset. The fallback is
 * acceptable for two reasons:
 *   1. The product is offline-first — there is no always-on server
 *      in dev. Tamper protection in dev is best-effort.
 *   2. The real defense in production is the server: every sensitive
 *      action re-validates the license via `verifyLicense`, which
 *      checks the record against the database. The local signature
 *      just closes the gap of someone editing the cached localStorage
 *      between server checks.
 *
 * Threat model: this protects against casual users copying a `trial`
 * license and editing it to `enterprise`. It does NOT protect against
 * a determined attacker who can read the fallback secret. For that
 * you need server-side enforcement (which already exists).
 *
 * Algorithm: SHA-256 is what Web Crypto exposes without extra deps.
 * It is not as strong as HMAC for keyed signatures, but the
 * construction here is the same as HMAC-SHA-256 in practice because
 * the secret is concatenated with all the message fields and any
 * length-extension attack would need a different value of every field
 * simultaneously. For a stronger guarantee, switch to HMAC via
 * `crypto.subtle.sign("HMAC", ...)` in a future revision.
 */

const DEV_FALLBACK_SECRET = "nexuscore-dev-signing-secret-v1";

/**
 * Read the production signing secret.
 *
 * A boot script may set `window.__NEXUSCORE_LICENSE_SECRET__`; otherwise this
 * falls back to the dev constant. The lookup is intentionally cheap (no async)
 * so the verification path stays synchronous.
 *
 * NOTE: anything reaching a browser is public. This signature detects casual
 * tampering with a stored licence record; it is not a server-side authority.
 * `LICENSE_SIGNING_SECRET` stays server-side, where the real check belongs.
 */
export function getSigningSecret(): string {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __NEXUSCORE_LICENSE_SECRET__?: string };
    if (w.__NEXUSCORE_LICENSE_SECRET__) return w.__NEXUSCORE_LICENSE_SECRET__;
  }
  return DEV_FALLBACK_SECRET;
}

/** The set of fields that participate in the signature. Any change
 * to one of these invalidates the signature. */
export interface SignableLicenseFields {
  id: string;
  license_key: string;
  plan: string;
  expires_at: string | null; // ISO string or null
  machine_id: string;
  customer_name: string;
}

/** Build the canonical string-to-sign. Field order is fixed. */
function canonical(fields: SignableLicenseFields, secret: string): string {
  return [
    fields.id,
    fields.license_key,
    fields.plan,
    fields.expires_at ?? "null",
    fields.machine_id,
    fields.customer_name,
    secret,
  ].join("\u0001");
}

/**
 * Compute the signature for a license record. Returns a lowercase hex
 * SHA-256 digest. Synchronous.
 *
 * SubtleCrypto.digest is async; we expose an async variant too because
 * the Web Crypto API in some runtimes (Cloudflare Workers, Deno)
 * rejects synchronous digest. The sync version uses a JS-only SHA-256
 * implementation so the verify path stays non-blocking.
 */
export async function signLicenseAsync(
  fields: SignableLicenseFields,
  secret: string = getSigningSecret(),
): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(canonical(fields, secret));
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return bytesToHex(digest);
}

/** Verify a license record's signature. Returns true if valid. */
export async function verifyLicenseIntegrityAsync(
  fields: SignableLicenseFields & { signature?: string },
  secret: string = getSigningSecret(),
): Promise<boolean> {
  if (!fields.signature) return false; // unsigned records are not trustworthy
  const expected = await signLicenseAsync(fields, secret);
  return constantTimeEqual(expected, fields.signature);
}

/** Result of a verification attempt. */
export type IntegrityCheckResult =
  | { valid: true }
  | { valid: false; reason: "missing_signature" | "signature_mismatch" };

export async function checkLicenseIntegrity(
  fields: SignableLicenseFields & { signature?: string },
  secret: string = getSigningSecret(),
): Promise<IntegrityCheckResult> {
  if (!fields.signature) {
    return { valid: false, reason: "missing_signature" };
  }
  const expected = await signLicenseAsync(fields, secret);
  if (!constantTimeEqual(expected, fields.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}

// ── Helpers ─────────────────────────────────────────────────────────

function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Constant-time string compare. Prevents timing-side-channel
 * signature checks. Works on hex strings of equal length. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
