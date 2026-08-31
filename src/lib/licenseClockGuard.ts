/**
 * License clock-skew guard.
 *
 * Detects when the user's wall clock is rolled back (a common way to
 * extend a 30-day trial) or wildly wrong (a clock six months in the
 * future can confuse expiry checks). The guard stores a single
 * "last-seen" timestamp in localStorage on every app start. If the
 * new timestamp is more than `ROLLBACK_THRESHOLD_MS` before the
 * stored one, the user is asked to re-verify with the server.
 *
 * This is a soft check — a determined attacker can edit the localStorage
 * value too. The defense is layered: the server-side `verifyLicense`
 * fn in `src/lib/api/licenseServer.ts` also enforces expiry, so a
 * rolled-back clock is caught at the next verification window.
 */

const STORAGE_KEY = "license-clock-anchor-v1";
const ROLLBACK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const FUTURE_DRIFT_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 min — don't write on every tick

export type ClockState = "ok" | "rolled_back" | "far_future" | "first_seen" | "missing";

export interface ClockCheckResult {
  state: ClockState;
  /** The stored "last seen" timestamp (epoch ms). 0 if never seen. */
  lastSeen: number;
  /** How far the new time differs from the stored one (positive = future). */
  driftMs: number;
  /** Human-readable Arabic message for the UI. */
  messageAr: string;
}

function readAnchor(): number {
  try {
    if (typeof localStorage === "undefined") return 0;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeAnchor(now: number): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, String(now));
    }
  } catch {
    // ignore
  }
}

/**
 * Run the clock check. Call this on app boot. Returns the result and
 * persists the new anchor (rate-limited so we don't thrash localStorage
 * on every render).
 */
export function runClockCheck(now: number = Date.now()): ClockCheckResult {
  const lastSeen = readAnchor();
  // Throttle: only write if at least PERSIST_INTERVAL_MS has passed.
  const shouldWrite = lastSeen === 0 || now - lastSeen > PERSIST_INTERVAL_MS;

  if (lastSeen === 0) {
    if (shouldWrite) writeAnchor(now);
    return {
      state: "first_seen",
      lastSeen: 0,
      driftMs: 0,
      messageAr: "أول تشغيل على هذا الجهاز",
    };
  }

  const driftMs = now - lastSeen;

  if (driftMs < -ROLLBACK_THRESHOLD_MS) {
    // Clock went backward by more than 24h.
    return {
      state: "rolled_back",
      lastSeen,
      driftMs,
      messageAr: `تم رصد تراجع في ساعة الجهاز بمقدار ${formatDuration(-driftMs)}. يرجى التحقق من التاريخ والوقت قبل المتابعة.`,
    };
  }

  if (driftMs > FUTURE_DRIFT_THRESHOLD_MS && lastSeen > 0) {
    // Clock jumped forward by more than 24h between runs. Likely
    // a clock reset, not cheating.
    if (shouldWrite) writeAnchor(now);
    return {
      state: "far_future",
      lastSeen,
      driftMs,
      messageAr: `ساعة الجهاز متقدمة بمقدار ${formatDuration(driftMs)}.`,
    };
  }

  if (shouldWrite) writeAnchor(now);
  return {
    state: "ok",
    lastSeen,
    driftMs,
    messageAr: "الساعة تبدو طبيعية",
  };
}

/** Reset the anchor — used after a successful re-verification so
 * the next boot starts from a known-good baseline. */
export function resetClockAnchor(now: number = Date.now()): void {
  writeAnchor(now);
}

function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / (60 * 60 * 1000));
  if (hours < 24) return `${hours} ساعة`;
  const days = Math.floor(hours / 24);
  return `${days} يوم`;
}
