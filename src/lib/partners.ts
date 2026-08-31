/**
 * شريك and مساهم — one list, two kinds.
 *
 * ## Why one entity
 *
 * There used to be three implementations of the same three fields: a "partner"
 * in `useBusinessStore`, a "shareholder" in `useFinancialStore`, and a third
 * server-backed shareholder screen behind a dead route. Same shape, different
 * label, no real distinction — and because each list validated its own
 * ownership total against 100%, a shop could hand out 200%.
 *
 * There is one list now. The difference is what a person DOES, recorded as a
 * `kind`:
 *   - **شريك (working)** — works in the business, may draw against their share,
 *     may be tied to a user login.
 *   - **مساهم (investor)** — capital only: owns a %, earns a share, no draws
 *     and no system access implied.
 *
 * Profit share is the same arithmetic for both. The difference shows up at
 * distribution time, where a working partner's draws are an ADVANCE.
 */

import type { Partner, PartnerKind } from "@/types";

/** Archived (مؤرشف): removed from the business, record kept for past reports. */
export function isPartnerArchived(partner: Pick<Partner, "deleted_at">): boolean {
  return partner.deleted_at != null;
}

/**
 * The people who still hold a claim on the business.
 *
 * An archived part-owner is NOT one of them: they no longer take a share of
 * future profit, their percentage is free for someone else, and their capital
 * is no longer an active contribution. What survives is their history, which
 * is read from the ledger and from past distribution records — not from this
 * list.
 */
export function activePartners<T extends Pick<Partner, "status" | "deleted_at">>(
  partners: T[],
): T[] {
  return partners.filter((p) => !isPartnerArchived(p) && p.status !== "inactive");
}

/** Ownership already committed, optionally ignoring one person (an edit). */
export function totalOwnership(
  partners: Pick<Partner, "id" | "equityPercentage" | "status" | "deleted_at">[],
  excludeId?: string,
): number {
  return activePartners(partners)
    .filter((p) => p.id !== excludeId)
    .reduce((total, p) => total + (p.equityPercentage || 0), 0);
}

/**
 * Can this percentage be given out? The check the two separate lists could not
 * make: a shop has one 100%, not one per screen.
 */
export function ownershipFits(
  partners: Pick<Partner, "id" | "equityPercentage" | "status" | "deleted_at">[],
  percentage: number,
  excludeId?: string,
): boolean {
  return totalOwnership(partners, excludeId) + percentage <= 100;
}

/** What this share of the period's profit is worth, before any advance. */
export function grossShare(percentage: number, netProfit: number): number {
  return (percentage / 100) * netProfit;
}

/**
 * What is actually payable at distribution.
 *
 * A working partner who has been drawing money through the period has already
 * received part of their share. Paying the full percentage on top would pay
 * them twice — so draws taken in the period are deducted. The result is
 * allowed to go NEGATIVE: that is a partner who drew more than they earned,
 * and hiding it behind a zero would be the same lie as a stored balance.
 */
export function netPayable(gross: number, drawsTaken: number): number {
  return gross - drawsTaken;
}

/** The three numbers a distribution row shows: gross, advance, net. */
export function distributionFor(
  partner: Pick<Partner, "id" | "name" | "kind" | "equityPercentage">,
  netProfit: number,
  drawsTaken: number,
): { gross: number; draws: number; net: number } {
  const gross = grossShare(partner.equityPercentage, netProfit);
  // Only a working partner draws. An investor's "draws" are structurally zero,
  // so the same call is safe for both and the rule lives in one place.
  const draws = partner.kind === "working" ? drawsTaken : 0;
  return { gross, draws, net: netPayable(gross, draws) };
}

/** Kinds that may take an `owner_draw`. */
export function canDraw(kind: PartnerKind): boolean {
  return kind === "working";
}

/**
 * May this part-owner be really deleted, or only archived?
 *
 * Same question the product screen asks, one entity over: has the ledger — or
 * a recorded distribution — ever mentioned them? Deleting someone with history
 * would orphan an `owner_draw` line and blank their name out of a past
 * dividend report. Someone registered by mistake and never paid anything has
 * no history and is genuinely deletable.
 *
 * Takes the COUNTS rather than the raw data so the rule is testable without a
 * ledger and without a store: rows from `ledgerRowsFor(partnerId)`, and how
 * many past distributions name them.
 */
export function partnerRemovalMode(
  ledgerRows: unknown[],
  distributionsInvolving: number,
): "delete" | "archive" {
  return ledgerRows.length > 0 || distributionsInvolving > 0 ? "archive" : "delete";
}

/** How many recorded distributions paid this person. */
export function countDistributionsFor(
  ledger: { partnerDistributions: { partnerId: string }[] }[],
  partnerId: string,
): number {
  return ledger.filter((record) =>
    record.partnerDistributions.some((d) => d.partnerId === partnerId),
  ).length;
}
