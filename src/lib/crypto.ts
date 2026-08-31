/**
 * Password hashing utilities.
 *
 * Uses the Web Crypto API (available in Node 18+, Deno, Bun, Cloudflare
 * Workers, and modern browsers). The algorithm is PBKDF2-SHA256 with
 * 100,000 iterations and a 16-byte random salt — comparable in
 * strength to bcrypt at cost factor 10 with no external dependency.
 *
 * Format of the stored hash (text):
 *   "pbkdf2$100000$<salt-hex>$<hash-hex>"
 *
 * The salt is unique per user and stored alongside the hash. We do
 * NOT use bcrypt to keep the dependency surface to zero (no native
 * bindings) and to keep the same code path on every runtime.
 */

const ALG = "PBKDF2";
const HASH = "SHA-256";
const ITERATIONS = 100_000;
const KEY_LEN = 32; // bytes
const SALT_LEN = 16; // bytes
const PREFIX = "pbkdf2";

const enc = new TextEncoder();

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const arr = b instanceof Uint8Array ? b : new Uint8Array(b);
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password) as BufferSource,
    { name: ALG },
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: ALG, salt: salt as BufferSource, iterations, hash: HASH },
    key,
    KEY_LEN * 8,
  );
}

/** Hash a plaintext password, returning the storable string. */
export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 4) {
    throw new Error("Password must be at least 4 characters");
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const derivedBits = await pbkdf2(password, salt, ITERATIONS);
  return `${PREFIX}$${ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(derivedBits)}`;
}

/** Verify a plaintext password against a stored hash. Constant-time compare. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== PREFIX) return false;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1000) return false;
    const salt = hexToBytes(parts[2]);
    const expected = hexToBytes(parts[3]);
    const actual = new Uint8Array(await pbkdf2(password, salt, iterations));
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

/** Generate a cryptographically random opaque session token. */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

/** Hash a token for at-rest storage. (The raw token is the user-facing
 * bearer; the hash goes into the DB so a DB leak does not leak sessions.) */
export async function hashToken(token: string): Promise<string> {
  const derived = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return bytesToHex(derived);
}
