/**
 * Is this password already in a public breach corpus?
 *
 * Supabase offers this as a project setting, but only on a paid plan — the
 * advisor flags `auth_leaked_password_protection` as disabled and the toggle is
 * behind Pro. This is the same check, done in the client, for nothing.
 *
 * ## k-Anonymity: what actually leaves the browser
 *
 * The password is NEVER sent anywhere, and neither is its full hash. The flow
 * is Troy Hunt's range API:
 *
 *   1. SHA-1 the password locally.                → 40 uppercase hex chars
 *   2. Send the FIRST FIVE characters only.       → e.g. "5BAA6"
 *   3. The server answers with every suffix it holds under that prefix —
 *      typically 400-900 of them — and we match locally.
 *
 * The server therefore learns that someone, somewhere, checked a password whose
 * hash begins with those five characters. Roughly one in a million hashes share
 * a prefix, so the set is far too large to identify a password from, and the
 * response is identical whether the password is in it or not.
 *
 * `Add-Padding: true` asks the API to pad every response to a uniform size with
 * decoy entries, so an observer watching the encrypted connection cannot infer
 * anything from the response length either. The decoys always carry a count of
 * zero, which is why the match below requires a count above zero — without that
 * check the padding itself would produce false positives, and a user would be
 * told their perfectly good password was breached.
 *
 * SHA-1 is not a security choice here and does not need to be a good hash: it
 * is the index the corpus is published under. Nothing is stored, and the value
 * never leaves this function.
 *
 * ## This fails OPEN, on purpose
 *
 * A third-party outage must not stop people signing up. Every failure —
 * network, timeout, an unexpected body, no Web Crypto — returns `false` and
 * warns to the console. The only thing that returns `true` is a real match in a
 * successful response.
 *
 * That is the right trade for an ADVISORY check. It is not an authentication
 * boundary and must never be treated as one: Supabase still owns password
 * policy, and this only stops a user picking `password123` on their way in.
 */

/** How long to wait before giving up and letting the user through. */
const TIMEOUT_MS = 3_000;

const RANGE_API = "https://api.pwnedpasswords.com/range/";

export interface LeakedPasswordOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number;
}

/**
 * SHA-1 of `text`, as 40 uppercase hex characters.
 *
 * `crypto.subtle` needs a secure context — https, or localhost in development.
 * It is absent in an http deployment and in some embedded webviews, which is a
 * deployment fault rather than a user's, so the caller treats a throw here the
 * same as a network failure.
 */
async function sha1Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable (a secure context is required)");

  const digest = await subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * `true` when the password appears in a known breach, `false` when it is not
 * found OR the check could not be completed.
 *
 * A caller must therefore read `false` as "no reason to object", never as
 * "verified safe".
 */
export async function checkLeakedPassword(
  password: string,
  options: LeakedPasswordOptions = {},
): Promise<boolean> {
  // Nothing to check, and hashing an empty string would query a real prefix for
  // no reason. Length is the form's business, not this function's.
  if (!password) return false;

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    controller = new AbortController();
    timer = setTimeout(() => controller?.abort(), timeoutMs);

    const response = await doFetch(`${RANGE_API}${prefix}`, {
      method: "GET",
      headers: { "Add-Padding": "true" },
      signal: controller.signal,
      // The corpus is public and identical for everyone; there is nothing to
      // authenticate and no cookie that should ride along.
      credentials: "omit",
      cache: "no-store",
    });

    if (!response.ok) {
      console.warn(
        `[security] Breach check skipped: the range API answered ${response.status}. ` +
          "Sign-up continues — this check is advisory.",
      );
      return false;
    }

    const body = await response.text();

    for (const line of body.split("\n")) {
      // Each line is "SUFFIX:COUNT". Padding entries carry a count of 0 and are
      // not real matches; treating them as one would reject a good password.
      const separator = line.indexOf(":");
      if (separator < 0) continue;

      const candidate = line.slice(0, separator).trim();
      if (candidate.toUpperCase() !== suffix) continue;

      const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
      return Number.isFinite(count) && count > 0;
    }

    return false;
  } catch (error) {
    // Includes the abort from `timeoutMs`. Deliberately swallowed: a slow or
    // unreachable third party must not stop someone opening an account.
    //
    // Nothing about the password — not the password, not its hash, not the
    // prefix — is written to the log.
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    console.warn(`[security] Breach check skipped: ${reason}. Sign-up continues.`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The one message a user ever sees from this check. */
export const LEAKED_PASSWORD_MESSAGE =
  "This password has appeared in a data breach and is not secure. Please choose a different password.";

/**
 * The same message in Arabic, for the screens that are written in it.
 *
 * Every other error on the login screen is Arabic; dropping one English
 * sentence into that form reads as a crash rather than as advice, and the
 * people using this app are not all reading English.
 */
export const LEAKED_PASSWORD_MESSAGE_AR =
  "كلمة المرور دي ظهرت في تسريب بيانات معروف ومش آمنة. اختار كلمة مرور تانية.";
