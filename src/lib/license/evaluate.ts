/**
 * Is this store allowed to trade right now?
 *
 * Pure, no imports, no clock of its own — `nowMs` is always passed in. That is
 * what lets `scripts/check_license_gate.mjs` drive every branch (expiry, the
 * moment of expiry, a revoked licence, a rolled-back clock) without a database
 * or a fake timer.
 *
 * ## The two failures this has to tell apart
 *
 * A lockout screen is the harshest thing this app can do to a shop, so the
 * verdict distinguishes "you have not paid" from "we could not check":
 *
 *   expired / unlicensed → their side. Lock, and say why.
 *   unverified           → our side (our outage, our missing row). Still locks,
 *                          but says something different, because telling a
 *                          paying shop their licence expired when in fact our
 *                          server was down is a support call and a lost
 *                          customer.
 *
 * The one thing this must never do is grant access because a check failed
 * softly — a protection system that fails open is not a protection system.
 */

export type LicenseVerdict = "ok" | "expired" | "unlicensed" | "unverified";

export interface LicenseRow {
  license_key: string;
  plan_type: "BASIC" | "PRO";
  /** ISO-8601 from Postgres `timestamptz`. */
  valid_until: string;
  status: "active" | "expired";
}

export interface LicenseDecision {
  verdict: LicenseVerdict;
  /** Whole days remaining; negative once past. `null` when there is no date. */
  daysLeft: number | null;
  /** Arabic, shown on the lockout screen. The UI never builds its own copy. */
  messageAr: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateLicense(
  row: LicenseRow | null | undefined,
  nowMs: number,
  /**
   * From `runClockCheck()`. Only consulted when the verdict rests on a CACHED
   * row: a fresh server row was judged against the server's own `now()`, so
   * the local clock cannot buy time. Offline, the local clock is all we have,
   * and winding it back is the classic way to extend an expired licence.
   */
  opts: { fromCache?: boolean; clockRolledBack?: boolean } = {},
): LicenseDecision {
  if (!row) {
    return {
      verdict: "unlicensed",
      daysLeft: null,
      messageAr: "لا يوجد ترخيص مسجّل لهذا المتجر.",
    };
  }

  const expiresAt = Date.parse(row.valid_until);
  if (!Number.isFinite(expiresAt)) {
    // Malformed date. This is our data error, not their non-payment — but a
    // licence we cannot read is not a licence we can honour.
    return {
      verdict: "unverified",
      daysLeft: null,
      messageAr: "تعذّر قراءة تاريخ انتهاء الترخيص. تواصل مع الدعم الفني.",
    };
  }

  const daysLeft = Math.floor((expiresAt - nowMs) / DAY_MS);

  // An explicit revoke outranks the date: it is how a licence is killed early.
  if (row.status === "expired") {
    return { verdict: "expired", daysLeft, messageAr: "تم إيقاف ترخيص هذا المتجر." };
  }

  if (opts.fromCache && opts.clockRolledBack) {
    return {
      verdict: "unverified",
      daysLeft,
      messageAr: "ساعة الجهاز غير مضبوطة. وصّل الجهاز بالإنترنت للتحقق من الترخيص.",
    };
  }

  if (nowMs >= expiresAt) {
    return { verdict: "expired", daysLeft, messageAr: "انتهت صلاحية ترخيص المتجر." };
  }

  return { verdict: "ok", daysLeft, messageAr: "الترخيص ساري." };
}

/** Does this verdict allow the business screens to render? */
export function isUsable(v: LicenseVerdict): boolean {
  return v === "ok";
}

/**
 * Warn before the shop is locked out, so expiry is never a surprise on a
 * Saturday morning. Null once expired — by then the lockout speaks for itself.
 */
export function renewalWarning(d: LicenseDecision): string | null {
  if (d.verdict !== "ok" || d.daysLeft === null || d.daysLeft > 14) return null;
  if (d.daysLeft <= 0) return "ينتهي ترخيص المتجر اليوم.";
  if (d.daysLeft === 1) return "ينتهي ترخيص المتجر غداً.";
  return `ينتهي ترخيص المتجر خلال ${d.daysLeft} يوم.`;
}
