/**
 * The licence state a MANAGER row is in, and which buttons that state allows.
 *
 * Split out of the service for the same reason `key.ts` is, so
 * `scripts/check_license_admin.mjs` can drive every state and every action set
 * without pulling Supabase or React into the test runner.
 *
 * ## Why this is not `evaluateLicense`
 *
 * They answer different questions and must be allowed to differ.
 * `evaluateLicense` answers "may this shop trade right now", which needs a
 * clock policy, a cache, and a story for what happens when the server cannot
 * be reached. This answers "what should the manager row say, and what may the
 * system owner do to it" — no cache, no offline, no clock tampering, because
 * the owner is looking at a row that was read from the server a second ago.
 *
 * Collapsing the two is what produced the original bug: when one function
 * answered both questions, EXPIRED and SUSPENDED had to be the same row,
 * because the gate only cared that neither could trade.
 */

export type LicenseState = "ACTIVE" | "EXPIRED" | "SUSPENDED" | "UNLICENSED";

export type LicenseAction = "activate" | "extend" | "suspend" | "reactivate";

/** The subset of a manager row this decision reads. */
export interface StatefulLicense {
  license_key: string | null;
  valid_until: string | null;
  status: string | null;
}

/**
 * Status first, then the date.
 *
 * The order matters in both directions: a suspension takes effect while the
 * paid period is still running, and a licence whose date has passed is expired
 * even though its status still says `active` — nothing writes that status when
 * a date rolls by, and nothing should. Expiry is what the calendar does; the
 * status column is what the owner did.
 */
export function licenseState(r: StatefulLicense, nowMs: number = Date.now()): LicenseState {
  if (!r.license_key || !r.valid_until) return "UNLICENSED";
  if (r.status === "suspended") return "SUSPENDED";
  if (r.status === "expired") return "EXPIRED";
  if (Date.parse(r.valid_until) <= nowMs) return "EXPIRED";
  return "ACTIVE";
}

/**
 * Which actions apply to a store in this state.
 *
 * The screen renders exactly this and nothing else, so a contradictory pair —
 * "Reactivate" on a licence that was never suspended, "Suspend" on one already
 * off — cannot be clicked. Every one of these RPCs raises for a nonsensical
 * call anyway; this is what stops the owner discovering that by pressing the
 * button and reading a Postgres error.
 *
 * SUSPENDED deliberately offers only `reactivate`. Extending a suspended
 * licence would quietly switch the shop back on, which is the one mistake this
 * screen must not make easy: suspension is a deliberate act, and undoing it
 * should be one too.
 */
export function actionsFor(state: LicenseState): LicenseAction[] {
  switch (state) {
    case "ACTIVE":
      return ["extend", "suspend"];
    case "EXPIRED":
      // `activate` re-issues with a new key; `extend` keeps the existing one.
      return ["extend", "activate"];
    case "SUSPENDED":
      return ["reactivate"];
    case "UNLICENSED":
      return ["activate"];
  }
}
